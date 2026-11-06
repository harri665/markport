'use strict';

/**
 * Markport Sync - the native Obsidian app (desktop or mobile) as one more
 * session on a Markport server.
 *
 * Each server vault you link is mirrored into a folder of this vault (or
 * into the whole vault) and kept in step both ways, live:
 *
 *   server → here   the server's /api/watch WebSocket pushes every change
 *                   made by a Markport tab, another device, or anything
 *                   that touches the server's files; the plugin fetches it.
 *   here → server   this vault's create/modify/delete/rename events are
 *                   sent through the same /api/fs the web client uses, so
 *                   open Markport tabs see them within a second.
 *
 * Plus a full comparison (GET /api/fs/tree against the last-synced state)
 * on start, on every reconnect and every few minutes, which catches
 * anything made while offline.
 *
 * Rules, per file, comparing each side with what was last synced (base):
 *
 *   only one side changed        copy it to the other side
 *   both changed, same bytes     nothing to do
 *   both changed, different      .md/.txt: three-way merge with the last
 *                                synced text when it is known and the
 *                                edits don't overlap; otherwise the
 *                                server's version wins and this device's
 *                                version is kept next to it as
 *                                "name (conflict <device> <date>).md"
 *   deleted on one side,         delete on the other side: into the
 *   unchanged on the other       server's .trash/ folder, or into this
 *                                vault's trash (as set in Obsidian)
 *   deleted on one side,         the changed copy is restored to the side
 *   changed on the other         that deleted it
 *
 * Nothing is ever deleted without a base: a first sync, a re-link or a
 * changed folder only ever adds files. A full comparison that would delete
 * more than a few files asks first.
 *
 * Hidden paths (.obsidian, .trash, dotfiles) are not synced as notes. With
 * "Sync settings and plugins" on, the link that syncs this whole vault also
 * keeps .obsidian in step - see "Settings and plugins" in LinkSync - on
 * every full comparison rather than live (the server's watcher doesn't
 * report hidden paths).
 *
 * The plugin is plain CommonJS with no build step, like the plugins in
 * src/plugins/. It is not one of those system plugins (Markport itself
 * doesn't need it); copy it into the vault, see README.md.
 */

const obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
  serverUrl: '',
  token: '',
  tokenExpiresAt: 0,
  deviceName: '',
  intervalMin: 5,
  // [{ vaultId, name, folder }]  folder '' = this whole vault
  links: [],
  // Also sync .obsidian (settings, plugins, themes, snippets) with the server
  // vault linked to this whole vault.
  syncConfig: false,
};

const MERGE_EXT = /\.(md|txt)$/i;
const MAX_MERGE_BYTES = 1024 * 1024;
const MAX_REMEMBERED_TEXTS = 300;
const MASS_DELETE_MIN = 10;
const MASS_DELETE_SHARE = 0.25;
const PARALLEL = 4;

// Settings and plugins: the server's name for the folder. This vault's may
// differ (Obsidian lets you rename it): app.vault.configDir.
const CONFIG = '.obsidian';
// Never synced: each device's window layout.
const CONFIG_SKIP = ['workspace.json', 'workspace-mobile.json'];
const COMMUNITY = CONFIG + '/community-plugins.json';
// Markport's own plugins, served to every server vault from the repo. The
// server's /api/fs/tree adds any others it serves the same way.
const SYSTEM_PLUGINS_FALLBACK = ['markport-clipper', 'markport-root-folder', 'markport-share', 'obsidian-web-layout'];

// Synced with every link that covers the whole vault, even with "Sync
// settings and plugins" off: the image library's shared state (tags, notes,
// folder folds, favorites, smart folders), which the clipper picks up live.
const ALWAYS_CONFIG = [CONFIG + '/plugins/markport-clipper/data.json'];

// ── Pure helpers (exported for tests) ───────────────────────────────────────

function normalizeServerUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

function normalizeFolder(f) {
  return String(f || '').replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean).join('/');
}

function isHidden(rel) {
  return String(rel).split('/').some((s) => s.startsWith('.'));
}

// Server-relative path → path in this vault.
function toLocal(folder, rel) {
  return folder ? (rel ? folder + '/' + rel : folder) : rel;
}

// Path in this vault → server-relative path, or null when it isn't inside
// the link's folder.
function toRel(folder, localPath) {
  if (!folder) return localPath;
  if (localPath === folder) return '';
  return localPath.startsWith(folder + '/') ? localPath.slice(folder.length + 1) : null;
}

function under(prefix, rel) {
  return !prefix || rel === prefix || rel.startsWith(prefix + '/');
}

// What a local note or folder is on the server, for sharing: { link, rel }
// with rel the path inside that server vault ('' = the whole server vault),
// or null when it isn't in a linked folder (or is hidden, so never synced).
// localPath is Obsidian's TAbstractFile.path; the vault root is '/'.
function shareTarget(links, localPath) {
  const p = localPath === '/' ? '' : String(localPath || '');
  for (const link of links) {
    const rel = toRel(link.folder, p);
    if (rel !== null && !isHidden(rel)) return { link, rel };
  }
  return null;
}

// Whether a path in the server's .obsidian is synced. Not: dotfiles, the
// window layout, this plugin's own folder (its token and links belong to
// this device), and the code of Markport's system plugins - the server
// serves those itself, and a copy uploaded into the vault would pin an old
// version there. Their data.json (settings, the clipper's image library)
// is synced.
function configSynced(rel, systemIds, selfId) {
  if (typeof rel !== 'string' || !rel.startsWith(CONFIG + '/')) return false;
  const sub = rel.slice(CONFIG.length + 1);
  if (!sub || sub.split('/').some((x) => !x || x.startsWith('.'))) return false;
  if (CONFIG_SKIP.includes(sub)) return false;
  const m = /^plugins\/([^/]+)(?:\/(.*))?$/.exec(sub);
  if (m) {
    if (m[1] === selfId) return false;
    if ((systemIds || []).includes(m[1])) return m[2] === 'data.json';
  }
  return true;
}

// community-plugins.json lists the enabled plugins. The server leaves
// Markport's system plugins out of the file (they are always on there), so
// for those ids each device keeps its own choice.
function parseIdList(buf) {
  try {
    const v = JSON.parse(new TextDecoder().decode(buf));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null;
  } catch (_) {
    return null;
  }
}

function idListBytes(list) {
  return new TextEncoder().encode(JSON.stringify(list, null, 2)).buffer;
}

// What to upload: this device's list without the system ids.
function communityForServer(localBuf, systemIds) {
  const list = parseIdList(localBuf);
  return list ? idListBytes(list.filter((id) => !systemIds.includes(id))) : localBuf;
}

// What to write here: the server's list, plus the system ids this device had on.
function communityForHere(remoteBuf, localBuf, systemIds) {
  const remote = parseIdList(remoteBuf);
  if (!remote) return remoteBuf;
  const local = (localBuf && parseIdList(localBuf)) || [];
  const out = remote.filter((id) => !systemIds.includes(id));
  for (const id of local) if (systemIds.includes(id) && !out.includes(id)) out.push(id);
  return idListBytes(out);
}

function sameIdLists(a, b, systemIds) {
  const x = parseIdList(a);
  const y = parseIdList(b);
  if (!x || !y) return false;
  const norm = (l) => [...new Set(l.filter((id) => !systemIds.includes(id)))].sort().join('\n');
  return norm(x) === norm(y);
}

// Two links may not share files.
function foldersOverlap(a, b) {
  return a === b || a === '' || b === '' || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function sameStat(a, b) {
  return !!a && !!b && Math.abs(a.mtime - b.mtime) < 2 && a.size === b.size;
}

/**
 * What to do with one file.
 *   base   { rm, rs, lm, ls }  remote/local mtime+size at the last sync, or null
 *   local  { mtime, size }     or null when the file is not here
 *   remote { mtime, size }     or null when it is not on the server
 */
function decide(base, local, remote) {
  const localChanged = !!local && (!base || !sameStat(local, { mtime: base.lm, size: base.ls }));
  const remoteChanged = !!remote && (!base || !sameStat(remote, { mtime: base.rm, size: base.rs }));
  if (local && remote) {
    if (!localChanged && !remoteChanged) return 'none';
    if (localChanged && !remoteChanged) return 'upload';
    if (!localChanged && remoteChanged) return 'download';
    return 'compare';
  }
  if (local) return base && !localChanged ? 'delete-local' : 'upload';
  if (remote) return base && !remoteChanged ? 'delete-remote' : 'download';
  return base ? 'forget' : 'none';
}

function pad(n) { return String(n).padStart(2, '0'); }

function conflictPath(rel, device, date) {
  const slash = rel.lastIndexOf('/');
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : '';
  const name = rel.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const stamp = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  const who = String(device || 'Obsidian').replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'Obsidian';
  return dir + stem + ' (conflict ' + who + ' ' + stamp + ')' + ext;
}

function trashPath(rel, date) {
  return '.trash/' + rel + (date ? ' ' + date.getTime() : '');
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// Changed regions between two line arrays: [{ oStart, oEnd, aStart, aEnd }].
// null when the inputs are too big to diff here.
function diffHunks(o, a) {
  const n = o.length;
  const m = a.length;
  let pre = 0;
  while (pre < n && pre < m && o[pre] === a[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && o[n - 1 - suf] === a[m - 1 - suf]) suf++;
  const N = n - pre - suf;
  const M = m - pre - suf;
  if (N === 0 && M === 0) return [];
  if (N === 0 || M === 0) return [{ oStart: pre, oEnd: pre + N, aStart: pre, aEnd: pre + M }];
  if (N * M > 2e6) return null;
  const W = M + 1;
  const dp = new Uint32Array((N + 1) * W);   // LCS length of o[i..], a[j..]
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i * W + j] = o[pre + i] === a[pre + j]
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const hunks = [];
  let i = 0;
  let j = 0;
  let start = null;
  while (i < N || j < M) {
    if (i < N && j < M && o[pre + i] === a[pre + j]) {
      if (start) { hunks.push({ oStart: pre + start[0], oEnd: pre + i, aStart: pre + start[1], aEnd: pre + j }); start = null; }
      i++; j++;
    } else {
      if (!start) start = [i, j];
      if (j >= M || (i < N && dp[(i + 1) * W + j] >= dp[i * W + j + 1])) i++;
      else j++;
    }
  }
  if (start) hunks.push({ oStart: pre + start[0], oEnd: pre + N, aStart: pre + start[1], aEnd: pre + M });
  return hunks;
}

/**
 * Line-based three-way merge. Returns the merged text, or null when both
 * sides changed the same (or adjacent) lines differently.
 */
function merge3(baseText, localText, remoteText) {
  if (localText === remoteText) return localText;
  if (localText === baseText) return remoteText;
  if (remoteText === baseText) return localText;
  const o = baseText.split('\n');
  const sides = [localText.split('\n'), remoteText.split('\n')];
  const hl = diffHunks(o, sides[0]);
  const hr = diffHunks(o, sides[1]);
  if (!hl || !hr) return null;
  const all = hl.map((h) => Object.assign({ side: 0 }, h))
    .concat(hr.map((h) => Object.assign({ side: 1 }, h)))
    .sort((x, y) => x.oStart - y.oStart || x.oEnd - y.oEnd);
  const out = [];
  let pos = 0;
  let k = 0;
  while (k < all.length) {
    const group = [all[k]];
    const gStart = all[k].oStart;
    let gEnd = all[k].oEnd;
    k++;
    while (k < all.length && all[k].oStart <= gEnd) {
      group.push(all[k]);
      gEnd = Math.max(gEnd, all[k].oEnd);
      k++;
    }
    for (let x = pos; x < gStart; x++) out.push(o[x]);
    // Each side's text for the base range [gStart, gEnd).
    const texts = [0, 1].map((side) => {
      const hs = group.filter((h) => h.side === side);
      if (!hs.length) return null;
      const src = sides[side];
      const t = [];
      let p = gStart;
      for (const h of hs) {
        for (let x = p; x < h.oStart; x++) t.push(o[x]);
        for (let x = h.aStart; x < h.aEnd; x++) t.push(src[x]);
        p = h.oEnd;
      }
      for (let x = p; x < gEnd; x++) t.push(o[x]);
      return t;
    });
    let chosen;
    if (!texts[0]) chosen = texts[1];
    else if (!texts[1]) chosen = texts[0];
    else if (texts[0].join('\n') === texts[1].join('\n')) chosen = texts[0];
    else return null;
    for (const line of chosen) out.push(line);
    pos = gEnd;
  }
  for (let x = pos; x < o.length; x++) out.push(o[x]);
  return out.join('\n');
}

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function vaultName(entry, id) {
  const p = entry && typeof entry.path === 'string' ? entry.path : '';
  return p.split(/[\\/]/).filter(Boolean).pop() || id;
}

// Run fn over items, a few at a time.
async function pool(items, n, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ── One server vault ↔ one folder here ──────────────────────────────────────

class LinkSync {
  constructor(plugin, link) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.link = link;
    this.folder = link.folder;
    this.vaultId = link.vaultId;
    this.state = plugin.stateFor(link);
    this.queue = Promise.resolve();
    this.pendingOps = 0;
    this.timers = new Map();
    this.texts = new Map();   // rel → last synced text (for merges), most recent last
    this.ws = null;
    this.retries = 0;
    this.reconnectTimer = null;
    this.stopped = false;
    this.status = 'connecting';
    this.lastError = '';
    this.lastFullSync = 0;
  }

  // ── plumbing ──

  setStatus(status, error) {
    this.status = status;
    if (error !== undefined) this.lastError = error;
    this.plugin.refreshStatus();
  }

  run(label, fn) {
    this.pendingOps++;
    this.plugin.refreshStatus();
    const p = this.queue.then(() => (this.stopped ? undefined : fn())).catch((err) => this.fail(label, err));
    this.queue = p.finally(() => { this.pendingOps--; this.plugin.refreshStatus(); });
    return this.queue;
  }

  fail(label, err) {
    console.error('[markport-sync]', this.link.name, label, err);
    if (err instanceof HttpError && err.status === 401) {
      this.plugin.authProblem();
      return;
    }
    this.setStatus(this.ws && this.ws.readyState === 1 ? 'live' : 'offline', label + ': ' + (err && err.message || err));
  }

  later(key, delay, label, fn) {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.run(label, fn);
    }, delay));
  }

  schedulePath(rel, delay) {
    if (rel == null || isHidden(rel)) return;
    this.later('p:' + rel, delay, rel, () => this.syncPath(rel));
  }

  scheduleReconcile(delay, prefix) {
    const p = prefix || '';
    this.later('r:' + p, delay, p ? 'sync ' + p : 'full sync', () => this.reconcile(p));
  }

  api(method, endpoint, opts = {}) {
    const query = Object.assign({ vault: this.vaultId }, opts.query);
    return this.plugin.request(method, 'fs/' + endpoint, Object.assign({}, opts, { query }));
  }

  post(endpoint, body) {
    return this.api('POST', endpoint, {
      json: Object.assign({ vault: this.vaultId, client: this.plugin.clientId }, body),
    });
  }

  rememberText(rel, buf) {
    if (!MERGE_EXT.test(rel) || !buf || buf.byteLength > MAX_MERGE_BYTES) return;
    this.texts.delete(rel);
    this.texts.set(rel, new TextDecoder().decode(buf));
    if (this.texts.size > MAX_REMEMBERED_TEXTS) this.texts.delete(this.texts.keys().next().value);
  }

  // ── WebSocket ──

  start() {
    this.connect();
    // A full comparison runs when the socket opens; if the server can't be
    // reached it runs anyway, so local work is checked against the last
    // state, and fails quietly until the socket is back.
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.ws) { try { this.ws.close(); } catch (_) { /* closed */ } }
    this.ws = null;
  }

  connect() {
    if (this.stopped || this.plugin.authFailed) return;
    clearTimeout(this.reconnectTimer);
    const s = this.plugin.settings;
    const url = s.serverUrl.replace(/^http/i, 'ws') + '/api/watch?vault=' + encodeURIComponent(this.vaultId) +
      '&client=' + encodeURIComponent(this.plugin.clientId);
    const protocols = s.token ? ['markport', 'markport-token.' + s.token] : ['markport'];
    let ws;
    try { ws = new WebSocket(url, protocols); } catch (err) { this.fail('connect', err); this.reconnectLater(); return; }
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.retries = 0;
      this.setStatus('live', '');
      // Anything may have changed while we were away.
      this.scheduleReconcile(0);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      this.onRemoteEvent(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.setStatus('offline');
      this.reconnectLater();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  reconnectLater() {
    if (this.stopped || this.plugin.authFailed) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, this.retries++));
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  ensureConnected() {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState > 1) { this.retries = 0; this.connect(); }
  }

  onRemoteEvent(msg) {
    if (msg.type === 'error') {
      if (/login/i.test(msg.message || '')) this.plugin.authProblem();
      else this.setStatus(this.status, String(msg.message || 'server error'));
      return;
    }
    // The one hidden file the server reports: the image library's state.
    if (ALWAYS_CONFIG.includes(msg.path)) {
      if (this.syncsConfig()) this.later('config', 1000, 'image library', () => this.reconcileConfig());
      return;
    }
    if (typeof msg.path !== 'string' || !msg.path || isHidden(msg.path)) return;
    if (msg.type === 'add' || msg.type === 'change' || msg.type === 'unlink') {
      this.schedulePath(msg.path, 150);
    } else if (msg.type === 'addDir' || msg.type === 'unlinkDir') {
      this.scheduleReconcile(600, msg.path);
    }
  }

  // ── local side ──

  localFile(rel) {
    const f = this.app.vault.getAbstractFileByPath(toLocal(this.folder, rel));
    if (!f) return null;
    if (f instanceof obsidian.TFolder) return { dir: true, folder: f };
    return { file: f, mtime: f.stat.mtime, size: f.stat.size };
  }

  async ensureFolder(localPath) {
    if (!localPath) return;
    const parts = localPath.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f instanceof obsidian.TFolder) continue;
      if (f) throw new Error(p + ' is a file, expected a folder');
      try { await this.app.vault.createFolder(p); } catch (err) {
        if (!(this.app.vault.getAbstractFileByPath(p) instanceof obsidian.TFolder)) throw err;
      }
    }
  }

  // Write bytes to rel here; returns the new { mtime, size }.
  async writeLocal(rel, buf) {
    const p = toLocal(this.folder, rel);
    const slash = p.lastIndexOf('/');
    if (slash > 0) await this.ensureFolder(p.slice(0, slash));
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof obsidian.TFolder) throw new Error(p + ' is a folder here and a file on the server');
    if (existing) await this.app.vault.modifyBinary(existing, buf);
    else await this.app.vault.createBinary(p, buf);
    const st = await this.app.vault.adapter.stat(p);
    return st ? { mtime: st.mtime, size: st.size } : { mtime: Date.now(), size: buf.byteLength };
  }

  async trashLocal(rel) {
    const f = this.app.vault.getAbstractFileByPath(toLocal(this.folder, rel));
    if (f) {
      if (this.app.fileManager && this.app.fileManager.trashFile) await this.app.fileManager.trashFile(f);
      else await this.app.vault.trash(f, true);
    }
    delete this.state.files[rel];
    this.texts.delete(rel);
  }

  // ── remote side ──

  async remoteStat(rel) {
    try {
      const s = await this.api('GET', 'stat', { query: { path: rel } });
      return s.isDirectory ? { dir: true } : { mtime: s.mtime, size: s.size };
    } catch (err) {
      // Only "no such file" means missing. An unknown vault (removed from
      // the server, or a registry reset) must never read as "every file
      // was deleted there".
      if (err instanceof HttpError && err.status === 404 && err.code !== 'ENOVAULT') return null;
      throw err;
    }
  }

  async download(rel) {
    return this.api('GET', 'read', { query: { path: rel }, binary: true });
  }

  async upload(rel, buf) {
    const r = await this.api('PUT', 'write', {
      query: { path: rel, client: this.plugin.clientId },
      body: buf,
      contentType: 'application/octet-stream',
    });
    if (r && typeof r.mtime === 'number') return { mtime: r.mtime, size: r.size };
    const s = await this.remoteStat(rel);   // older server: no stat in the reply
    return s || { mtime: 0, size: buf.byteLength };
  }

  // Into the server vault's .trash/, like Obsidian's own "move to trash".
  async trashRemote(rel) {
    let target = trashPath(rel);
    if (await this.remoteStat(target)) target = trashPath(rel, new Date());
    try {
      await this.post('rename', { oldPath: rel, newPath: target, overwrite: false });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404 && err.code !== 'ENOVAULT')) throw err;
    }
  }

  // ── applying one decision ──

  async apply(rel, action, local, remote) {
    const st = this.state;
    switch (action) {
      case 'none':
        return;
      case 'forget':
        delete st.files[rel];
        this.texts.delete(rel);
        break;
      case 'upload': {
        const buf = await this.app.vault.readBinary(local.file);
        const r = await this.upload(rel, buf);
        st.files[rel] = { rm: r.mtime, rs: r.size, lm: local.mtime, ls: local.size };
        this.rememberText(rel, buf);
        break;
      }
      case 'download': {
        const buf = await this.download(rel);
        const l = await this.writeLocal(rel, buf);
        st.files[rel] = { rm: remote.mtime, rs: remote.size, lm: l.mtime, ls: l.size };
        this.rememberText(rel, buf);
        break;
      }
      case 'compare':
        await this.resolveBoth(rel, local, remote);
        break;
      case 'delete-local':
        await this.trashLocal(rel);
        break;
      case 'delete-remote':
        await this.trashRemote(rel);
        delete st.files[rel];
        this.texts.delete(rel);
        break;
      default:
        throw new Error('unknown action ' + action);
    }
    this.plugin.saveSoon();
  }

  // Both sides changed since the last sync.
  async resolveBoth(rel, local, remote) {
    const st = this.state;
    const remoteBuf = await this.download(rel);
    const localBuf = await this.app.vault.readBinary(local.file);
    if (sameBytes(remoteBuf, localBuf)) {
      st.files[rel] = { rm: remote.mtime, rs: remote.size, lm: local.mtime, ls: local.size };
      this.rememberText(rel, localBuf);
      return;
    }

    const baseText = this.texts.get(rel);
    if (baseText != null && MERGE_EXT.test(rel)) {
      const dec = new TextDecoder();
      const merged = merge3(baseText, dec.decode(localBuf), dec.decode(remoteBuf));
      if (merged != null) {
        const buf = new TextEncoder().encode(merged).buffer;
        const r = await this.upload(rel, buf);
        const l = await this.writeLocal(rel, buf);
        st.files[rel] = { rm: r.mtime, rs: r.size, lm: l.mtime, ls: l.size };
        this.rememberText(rel, buf);
        return;
      }
    }

    // Keep this device's version next to the server's.
    let copy = conflictPath(rel, this.plugin.deviceName(), new Date());
    for (let n = 2; this.localFile(copy); n++) copy = conflictPath(rel, this.plugin.deviceName() + ' ' + n, new Date());
    const lc = await this.writeLocal(copy, localBuf);
    const rc = await this.upload(copy, localBuf);
    st.files[copy] = { rm: rc.mtime, rs: rc.size, lm: lc.mtime, ls: lc.size };
    const l = await this.writeLocal(rel, remoteBuf);
    st.files[rel] = { rm: remote.mtime, rs: remote.size, lm: l.mtime, ls: l.size };
    this.rememberText(rel, remoteBuf);
    new obsidian.Notice('Markport Sync: "' + rel + '" was changed here and on the server. ' +
      'The server\'s version is kept; yours is saved as "' + copy + '".', 15000);
  }

  // ── one path ──

  async syncPath(rel) {
    const local = this.localFile(rel);
    const remote = await this.remoteStat(rel);
    if ((local && local.dir) || (remote && remote.dir)) {
      // A folder (or a file/folder clash): compare the whole subtree.
      await this.reconcile(rel);
      return;
    }
    await this.apply(rel, decide(this.state.files[rel] || null, local, remote), local, remote);
  }

  // ── full comparison ──

  async reconcile(prefix) {
    prefix = prefix || '';
    if (this.folder && !prefix) await this.ensureFolder(this.folder);
    const tree = await this.api('GET', 'tree', { query: { path: prefix } });
    const remoteFiles = new Map(tree.files.map((f) => [f.path, f]));
    const remoteDirs = new Set(tree.dirs);

    const localFiles = new Map();
    const localDirs = new Set();
    for (const f of this.app.vault.getAllLoadedFiles()) {
      const rel = toRel(this.folder, f.path);
      if (!rel || isHidden(rel) || !under(prefix, rel)) continue;
      if (f instanceof obsidian.TFolder) {
        if (rel !== prefix) localDirs.add(rel);
      } else {
        localFiles.set(rel, { file: f, mtime: f.stat.mtime, size: f.stat.size });
      }
    }

    const st = this.state;
    const paths = new Set([...remoteFiles.keys(), ...localFiles.keys(),
      ...Object.keys(st.files).filter((r) => under(prefix, r))]);
    const plan = [];
    for (const rel of paths) {
      if (isHidden(rel)) continue;
      const local = localFiles.get(rel) || null;
      const remote = remoteFiles.get(rel) || null;
      // A file on one side where the other has a folder: leave both alone.
      if ((local && remoteDirs.has(rel)) || (remote && localDirs.has(rel))) {
        console.warn('[markport-sync] file/folder clash, skipped:', rel);
        continue;
      }
      const action = decide(st.files[rel] || null, local, remote);
      if (action !== 'none') plan.push({ rel, action, local, remote });
    }

    // A full comparison that would delete a lot is more likely a mistake
    // (a moved folder, a restored backup) than intent. Ask.
    const deletes = plan.filter((p) => p.action === 'delete-local' || p.action === 'delete-remote');
    const tracked = Object.keys(st.files).filter((r) => under(prefix, r)).length;
    if (!prefix && deletes.length > MASS_DELETE_MIN && deletes.length > tracked * MASS_DELETE_SHARE) {
      const ok = await this.plugin.confirmDeletes(this.link, deletes);
      if (!ok) {
        // Keep everything: restore each file to the side it is missing from.
        for (const p of deletes) {
          delete st.files[p.rel];
          p.action = p.action === 'delete-local' ? 'upload' : 'download';
        }
      }
    }

    await pool(plan, PARALLEL, async (p) => {
      try { await this.apply(p.rel, p.action, p.local, p.remote); }
      catch (err) { this.fail(p.rel, err); }
    });

    // Folders, including empty ones. Deepest first, so a parent is only
    // removed once its children are gone.
    const dirs = [...new Set([...remoteDirs, ...localDirs, ...Object.keys(st.dirs).filter((d) => under(prefix, d))])]
      .filter((d) => d && d !== prefix && !isHidden(d))
      .sort((a, b) => b.split('/').length - a.split('/').length);
    for (const d of dirs) {
      const here = this.localFile(d);
      const hereDir = !!(here && here.dir);
      const there = remoteDirs.has(d);
      const known = !!st.dirs[d];
      try {
        if (hereDir && there) {
          st.dirs[d] = 1;
        } else if (there && !hereDir) {
          if (here) continue;   // a file here: clash, reported above
          if (known) {
            // Removed here: remove it there too, if it is empty there.
            await this.post('rmdir', { path: d, recursive: false }).catch(() => {});
            delete st.dirs[d];
          } else {
            await this.ensureFolder(toLocal(this.folder, d));
            st.dirs[d] = 1;
          }
        } else if (hereDir && !there) {
          if (known && here.folder.children.length === 0) {
            await this.app.vault.delete(here.folder, true);
            delete st.dirs[d];
          } else {
            await this.post('mkdir', { path: d, recursive: true });
            st.dirs[d] = 1;
          }
        } else {
          delete st.dirs[d];
        }
      } catch (err) {
        this.fail(d, err);
      }
    }

    if (!prefix && this.syncsConfig()) {
      try { await this.reconcileConfig(); } catch (err) { this.fail('settings and plugins', err); }
    }
    if (!prefix) this.lastFullSync = Date.now();
    this.plugin.saveSoon();
  }

  // ── settings and plugins (.obsidian) ──
  //
  // With "Sync settings and plugins" on, the link that syncs this whole
  // vault also compares the server vault's .obsidian with this vault's
  // config folder, file by file, with the same rules as notes, except:
  //
  //   both sides differ and     this device's copy wins: you turn the option
  //   there is no base yet      on from the device whose setup you want. The
  //                             server's copy goes into its .trash/.
  //   both changed since the    the newer one wins; the other side's copy
  //   last sync                 goes into that side's trash. (JSON is not
  //                             merged line by line, and a conflict copy in
  //                             .obsidian would only be clutter.)
  //
  // configSynced() says what is left out. Obsidian reads most of these files
  // at startup, so what arrives from the server is used after a reload.

  // Whole-vault links always compare the files in ALWAYS_CONFIG, and all of
  // .obsidian when "Sync settings and plugins" is on.
  syncsConfig() {
    return this.folder === '';
  }

  syncsAllConfig() {
    return this.syncsConfig() && !!this.plugin.settings.syncConfig;
  }

  configState() {
    if (!this.state.config) this.state.config = { files: {} };
    return this.state.config;
  }

  configAllowed(rel) {
    if (!this.syncsAllConfig()) return ALWAYS_CONFIG.includes(rel);
    return configSynced(rel, this.systemIds || SYSTEM_PLUGINS_FALLBACK, this.plugin.manifest.id);
  }

  // A path in the server's .obsidian → the same file in this vault.
  configLocal(rel) {
    return this.app.vault.configDir + rel.slice(CONFIG.length);
  }

  async listConfigLocal() {
    const adapter = this.app.vault.adapter;
    const root = this.app.vault.configDir;
    const self = CONFIG + '/plugins/' + this.plugin.manifest.id;
    const out = new Map();
    const walk = async (dir) => {
      let listing;
      try { listing = await adapter.list(dir); } catch (_) { return; }
      for (const f of listing.files) {
        const rel = CONFIG + f.slice(root.length);
        if (!this.configAllowed(rel)) continue;
        const st = await adapter.stat(f);
        if (st && st.type !== 'folder') out.set(rel, { mtime: st.mtime, size: st.size });
      }
      for (const d of listing.folders) {
        const rel = CONFIG + d.slice(root.length);
        const name = rel.slice(rel.lastIndexOf('/') + 1);
        if (name.startsWith('.') || rel === self) continue;
        await walk(d);
      }
    };
    await walk(root);
    return out;
  }

  async ensureLocalDir(dir) {
    const adapter = this.app.vault.adapter;
    const parts = dir.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      if (!(await adapter.exists(p))) await adapter.mkdir(p);
    }
  }

  async writeConfigLocal(localPath, buf) {
    const slash = localPath.lastIndexOf('/');
    if (slash > 0) await this.ensureLocalDir(localPath.slice(0, slash));
    await this.app.vault.adapter.writeBinary(localPath, buf);
    const st = await this.app.vault.adapter.stat(localPath);
    return st ? { mtime: st.mtime, size: st.size } : { mtime: Date.now(), size: buf.byteLength };
  }

  async pushConfig(rel, buf) {
    const lp = this.configLocal(rel);
    let body = buf || await this.app.vault.adapter.readBinary(lp);
    if (rel === COMMUNITY) body = communityForServer(body, this.systemIds);
    const r = await this.upload(rel, body);
    const l = await this.app.vault.adapter.stat(lp);
    this.configState().files[rel] = { rm: r.mtime, rs: r.size, lm: l ? l.mtime : 0, ls: l ? l.size : 0 };
  }

  async pullConfig(rel, remote, buf) {
    const lp = this.configLocal(rel);
    let body = buf || await this.download(rel);
    if (rel === COMMUNITY) {
      const adapter = this.app.vault.adapter;
      const localBuf = (await adapter.exists(lp)) ? await adapter.readBinary(lp) : null;
      body = communityForHere(body, localBuf, this.systemIds);
    }
    const l = await this.writeConfigLocal(lp, body);
    this.configState().files[rel] = { rm: remote.mtime, rs: remote.size, lm: l.mtime, ls: l.size };
  }

  // This device's copy of a file about to be replaced, into its .trash/.
  async keepLocalCopy(rel, buf) {
    const lp = this.configLocal(rel);
    await this.writeConfigLocal('.trash/' + lp + ' ' + Date.now(), buf);
  }

  async trashConfigLocal(rel) {
    const adapter = this.app.vault.adapter;
    const lp = this.configLocal(rel);
    if (await adapter.exists(lp)) {
      if (adapter.trashLocal) await adapter.trashLocal(lp);
      else await adapter.remove(lp);
    }
  }

  // Returns true when this vault's config changed.
  async applyConfig({ rel, action, local, remote, base }) {
    const files = this.configState().files;
    switch (action) {
      case 'upload':
        await this.pushConfig(rel);
        return false;
      case 'download':
        await this.pullConfig(rel, remote);
        return true;
      case 'compare': {
        const remoteBuf = await this.download(rel);
        const localBuf = await this.app.vault.adapter.readBinary(this.configLocal(rel));
        const same = rel === COMMUNITY ? sameIdLists(remoteBuf, localBuf, this.systemIds) : sameBytes(remoteBuf, localBuf);
        if (same) {
          files[rel] = { rm: remote.mtime, rs: remote.size, lm: local.mtime, ls: local.size };
          return false;
        }
        // No base yet: with "Sync settings and plugins" this device's setup
        // wins (it was turned on here for that). Otherwise this is only the
        // image library, and a device joining takes the server's - a fresh
        // install must never replace everyone's tags and folders.
        const hereWins = base ? local.mtime >= remote.mtime : this.syncsAllConfig();
        if (hereWins) {
          await this.trashRemote(rel);
          await this.pushConfig(rel, localBuf);
          return false;
        }
        await this.keepLocalCopy(rel, localBuf);
        await this.pullConfig(rel, remote, remoteBuf);
        return true;
      }
      case 'delete-local':
        await this.trashConfigLocal(rel);
        delete files[rel];
        return true;
      case 'delete-remote':
        await this.trashRemote(rel);
        delete files[rel];
        return false;
      case 'forget':
        delete files[rel];
        return false;
      default:
        return false;
    }
  }

  async reconcileConfig() {
    const tree = await this.api('GET', 'tree', { query: { path: CONFIG } });
    // Markport's own plugins count as system plugins even if this server
    // doesn't list them (an older one, or one without them installed).
    this.systemIds = [...new Set(SYSTEM_PLUGINS_FALLBACK.concat(Array.isArray(tree.systemPlugins) ? tree.systemPlugins : []))];
    const remoteFiles = new Map(tree.files.filter((f) => this.configAllowed(f.path)).map((f) => [f.path, f]));
    const localFiles = await this.listConfigLocal();
    const files = this.configState().files;

    const plan = [];
    for (const rel of new Set([...remoteFiles.keys(), ...localFiles.keys(), ...Object.keys(files)])) {
      if (!this.configAllowed(rel)) { delete files[rel]; continue; }
      const local = localFiles.get(rel) || null;
      const remote = remoteFiles.get(rel) || null;
      const base = files[rel] || null;
      const action = decide(base, local, remote);
      if (action !== 'none') plan.push({ rel, action, local, remote, base });
    }

    const deletes = plan.filter((p) => p.action === 'delete-local' || p.action === 'delete-remote');
    const tracked = Object.keys(files).length;
    if (deletes.length > MASS_DELETE_MIN && deletes.length > tracked * MASS_DELETE_SHARE) {
      const ok = await this.plugin.confirmDeletes(this.link, deletes);
      if (!ok) {
        for (const p of deletes) {
          delete files[p.rel];
          p.action = p.action === 'delete-local' ? 'upload' : 'download';
        }
      }
    }

    const changedHere = [];
    await pool(plan, PARALLEL, async (p) => {
      try { if (await this.applyConfig(p)) changedHere.push(p.rel); }
      catch (err) { this.fail(p.rel, err); }
    });
    if (changedHere.length) this.plugin.configArrived(changedHere);
    this.plugin.saveSoon();
  }

  // ── events from this vault ──

  // True when a local event is just our own write landing (the file is
  // exactly as last synced), so there is nothing to send.
  unchangedSinceSync(rel, file) {
    const b = this.state.files[rel];
    return !!b && !!file.stat && sameStat({ mtime: file.stat.mtime, size: file.stat.size }, { mtime: b.lm, size: b.ls });
  }

  onLocalCreate(rel, file) {
    if (file instanceof obsidian.TFolder) {
      if (this.state.dirs[rel]) return;
      this.run('mkdir ' + rel, async () => {
        await this.post('mkdir', { path: rel, recursive: true });
        this.state.dirs[rel] = 1;
        this.plugin.saveSoon();
      });
    } else if (!this.unchangedSinceSync(rel, file)) {
      this.schedulePath(rel, 500);
    }
  }

  onLocalModify(rel, file) {
    if (!this.unchangedSinceSync(rel, file)) this.schedulePath(rel, 800);
  }

  onLocalDelete(rel, file) {
    if (file instanceof obsidian.TFolder) {
      this.run('delete ' + rel, async () => {
        if (await this.remoteStat(rel)) await this.trashRemote(rel);
        this.dropUnder(rel);
        this.plugin.saveSoon();
      });
    } else if (this.state.files[rel] || this.timers.has('p:' + rel)) {
      // Never synced and nothing pending: the server never had it.
      this.schedulePath(rel, 300);
    }
  }

  dropUnder(rel) {
    const st = this.state;
    for (const k of Object.keys(st.files)) if (under(rel, k)) { delete st.files[k]; this.texts.delete(k); }
    for (const k of Object.keys(st.dirs)) if (under(rel, k)) delete st.dirs[k];
  }

  // Rename within this link: rename on the server too, so it stays one
  // file (with its history in other sessions' open tabs) instead of a
  // delete and a new upload.
  onLocalRename(oldRel, newRel, file) {
    const isFolder = file instanceof obsidian.TFolder;
    this.run('rename ' + oldRel, async () => {
      const st = this.state;
      if (!isFolder && st.files[newRel] && !st.files[oldRel]) return;   // moved with its folder
      const known = isFolder ? !!st.dirs[oldRel] : !!st.files[oldRel];
      if (!known) {
        if (isFolder) await this.reconcile(newRel);
        else await this.syncPath(newRel);
        return;
      }
      try {
        await this.post('rename', { oldPath: oldRel, newPath: newRel, overwrite: false });
      } catch (err) {
        if (!(err instanceof HttpError) || (err.status !== 404 && err.status !== 409)) throw err;
        // Gone or taken on the server: compare both places instead.
        if (isFolder) { await this.reconcile(oldRel); await this.reconcile(newRel); }
        else { await this.syncPath(oldRel); await this.syncPath(newRel); }
        return;
      }
      const move = (k) => newRel + k.slice(oldRel.length);
      if (isFolder) {
        for (const k of Object.keys(st.files)) {
          if (under(oldRel, k)) {
            st.files[move(k)] = st.files[k]; delete st.files[k];
            if (this.texts.has(k)) { this.texts.set(move(k), this.texts.get(k)); this.texts.delete(k); }
          }
        }
        for (const k of Object.keys(st.dirs)) if (under(oldRel, k)) { st.dirs[move(k)] = 1; delete st.dirs[k]; }
        st.dirs[newRel] = 1;
      } else {
        st.files[newRel] = st.files[oldRel];
        delete st.files[oldRel];
        if (this.texts.has(oldRel)) { this.texts.set(newRel, this.texts.get(oldRel)); this.texts.delete(oldRel); }
        // Picks up an edit made just before the rename.
        await this.syncPath(newRel);
      }
      this.plugin.saveSoon();
    });
  }

  describe() {
    const parts = [this.status];
    if (this.pendingOps) parts.push(this.pendingOps + ' pending');
    if (this.lastFullSync) parts.push('checked ' + new Date(this.lastFullSync).toLocaleTimeString());
    if (this.lastError) parts.push('last error: ' + this.lastError);
    return parts.join(' · ');
  }
}

// ── Mass-delete confirmation ────────────────────────────────────────────────

class ConfirmDeletesModal extends obsidian.Modal {
  constructor(app, link, deletes, resolve) {
    super(app);
    this.link = link;
    this.deletes = deletes;
    this.resolve = resolve;
    this.answered = false;
  }

  onOpen() {
    const { contentEl } = this;
    const here = this.deletes.filter((d) => d.action === 'delete-local').length;
    const there = this.deletes.length - here;
    contentEl.createEl('h3', { text: 'Markport Sync: delete ' + this.deletes.length + ' files?' });
    contentEl.createEl('p', {
      text: 'Syncing "' + this.link.name + '" would delete ' + here + ' file(s) here and ' + there +
        ' on the server, because they were deleted on the other side since the last sync. ' +
        'Deleted files go to the trash (here) or the vault\'s .trash folder (on the server).',
    });
    const list = contentEl.createEl('ul');
    for (const d of this.deletes.slice(0, 15)) {
      list.createEl('li', { text: d.rel + (d.action === 'delete-local' ? '  (here)' : '  (server)') });
    }
    if (this.deletes.length > 15) list.createEl('li', { text: '… and ' + (this.deletes.length - 15) + ' more' });
    new obsidian.Setting(contentEl)
      .addButton((b) => b.setButtonText('Keep them (copy back)').setCta().onClick(() => this.answer(false)))
      .addButton((b) => b.setButtonText('Delete them').setWarning().onClick(() => this.answer(true)));
  }

  answer(ok) {
    this.answered = true;
    this.resolve(ok);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.answered) this.resolve(false);
  }
}

// ── The plugin ──────────────────────────────────────────────────────────────

class MarkportSyncPlugin extends obsidian.Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    this.settings.links = (this.settings.links || []).map((l) => Object.assign({}, l));
    this.syncState = data.state || {};
    this.clientId = 'obsidian-' + randomId();
    this.links = new Map();   // vaultId → LinkSync
    this.authFailed = false;
    this.saveTimer = null;
    this.confirming = Promise.resolve();

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('markport-sync-status');
    this.statusEl.onClickEvent(() => this.openSettings());
    this.addSettingTab(new MarkportSyncSettingTab(this.app, this));

    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => this.syncAll() });
    this.addCommand({ id: 'reconnect', name: 'Reconnect to the server', callback: () => this.restartLinks() });

    // Sharing (the server's /api/shares): a link to a synced note or folder,
    // as a read-only page or an editor limited to it. See ShareModal.
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      const shareable = file instanceof obsidian.TFolder || (file instanceof obsidian.TFile && file.extension === 'md');
      if (!shareable || !this.shareTargetFor(file)) return;
      menu.addItem((item) => item
        .setTitle('Share on Markport…')
        .setIcon('share-2')
        .setSection('action')
        .onClick(() => new ShareModal(this.app, this, file).open()));
    }));
    this.addCommand({
      id: 'share-current-note',
      name: 'Share current note on Markport',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md' || !this.shareTargetFor(file)) return false;
        if (!checking) new ShareModal(this.app, this, file).open();
        return true;
      },
    });
    this.addCommand({
      id: 'manage-shared-links',
      name: 'Manage shared links on Markport',
      callback: () => new AllSharesModal(this.app, this).open(),
    });

    this.app.workspace.onLayoutReady(() => {
      // Registered only now: while the vault loads, Obsidian sends a
      // "create" for every file it finds.
      const vault = this.app.vault;
      this.registerEvent(vault.on('create', (f) => this.dispatch(f.path, (l, rel) => l.onLocalCreate(rel, f))));
      this.registerEvent(vault.on('modify', (f) => this.dispatch(f.path, (l, rel) => l.onLocalModify(rel, f))));
      this.registerEvent(vault.on('delete', (f) => this.dispatch(f.path, (l, rel) => l.onLocalDelete(rel, f))));
      this.registerEvent(vault.on('rename', (f, oldPath) => this.onRename(f, oldPath)));
      // Changes in the config folder (settings, plugins), which the events
      // above don't report.
      this.registerEvent(vault.on('raw', (p) => this.onRawChange(p)));
      this.startLinks();
    });

    // Full comparison every few minutes, as a backstop for missed events.
    this.registerInterval(window.setInterval(() => {
      const every = Math.max(1, Number(this.settings.intervalMin) || 5) * 60 * 1000;
      for (const l of this.links.values()) {
        if (l.ws && l.ws.readyState === 1 && Date.now() - l.lastFullSync > every) l.scheduleReconcile(0);
      }
    }, 60 * 1000));
    // Mobile apps lose the socket in the background; laptops when they sleep.
    this.registerDomEvent(window, 'online', () => this.links.forEach((l) => l.ensureConnected()));
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') this.links.forEach((l) => l.ensureConnected());
    });
    this.refreshStatus();
  }

  // A file in this vault's config folder changed: compare settings and
  // plugins with the server a few seconds later (several changes at once,
  // as when Obsidian saves, become one comparison).
  onRawChange(p) {
    const dir = this.app.vault.configDir;
    if (typeof p !== 'string' || !p.startsWith(dir + '/')) return;
    const rel = CONFIG + p.slice(dir.length);
    for (const l of this.links.values()) {
      if (l.syncsConfig() && l.configAllowed(rel)) l.later('config', ALWAYS_CONFIG.includes(rel) ? 1500 : 5000, 'settings and plugins', () => l.reconcileConfig());
    }
  }

  // Settings or plugins came from the server. Obsidian reads most of them
  // at startup, so offer a reload.
  configArrived(paths) {
    // The image library reloads its own state; nothing to restart for that.
    paths = paths.filter((p) => !ALWAYS_CONFIG.includes(p));
    if (!paths.length) return;
    const now = Date.now();
    if (this.lastConfigNotice && now - this.lastConfigNotice < 10000) return;
    this.lastConfigNotice = now;
    const what = paths.length === 1 ? paths[0].slice(CONFIG.length + 1) : paths.length + ' files';
    const n = new obsidian.Notice('Markport Sync: settings or plugins changed on the server (' + what + '). ' +
      'Click here to reload Obsidian and use them.', 20000);
    const el = n && n.noticeEl;
    if (el && el.addEventListener) {
      el.addEventListener('click', () => {
        const cmds = this.app.commands;
        if (cmds && cmds.executeCommandById) cmds.executeCommandById('app:reload');
      });
    }
  }

  onunload() {
    for (const l of this.links.values()) l.stop();
    this.links.clear();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveNow(); }
  }

  // ── settings & state ──

  stateFor(link) {
    let s = this.syncState[link.vaultId];
    // A different folder means none of the recorded state applies. Starting
    // over is safe: without a base nothing is deleted, only copied.
    if (!s || s.folder !== link.folder) {
      s = { folder: link.folder, files: {}, dirs: {} };
      this.syncState[link.vaultId] = s;
    }
    return s;
  }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 1500);
  }

  saveNow() {
    return this.saveData({ settings: this.settings, state: this.syncState })
      .catch((err) => console.error('[markport-sync] save failed', err));
  }

  async saveSettings() {
    await this.saveNow();
  }

  deviceName() {
    if (this.settings.deviceName) return this.settings.deviceName;
    return obsidian.Platform.isMobile ? 'Obsidian mobile' : 'Obsidian desktop';
  }

  openSettings() {
    const s = this.app.setting;
    if (s && s.open) { s.open(); if (s.openTabById) s.openTabById(this.manifest.id); }
  }

  // ── links ──

  startLinks() {
    for (const l of this.links.values()) l.stop();
    this.links.clear();
    if (!this.settings.serverUrl) { this.refreshStatus(); return; }
    for (const link of this.settings.links) {
      const ls = new LinkSync(this, link);
      this.links.set(link.vaultId, ls);
      ls.start();
    }
    this.refreshStatus();
  }

  restartLinks() {
    this.authFailed = false;
    this.startLinks();
  }

  syncAll() {
    if (!this.links.size) { new obsidian.Notice('Markport Sync: no server vaults linked yet.'); return; }
    for (const l of this.links.values()) { l.ensureConnected(); l.scheduleReconcile(0); }
  }

  linkFor(localPath) {
    for (const l of this.links.values()) {
      const rel = toRel(l.folder, localPath);
      if (rel !== null && rel !== '' && !isHidden(rel)) return { l, rel };
    }
    return null;
  }

  dispatch(localPath, fn) {
    const hit = this.linkFor(localPath);
    if (hit) fn(hit.l, hit.rel);
  }

  onRename(file, oldPath) {
    const from = this.linkFor(oldPath);
    const to = this.linkFor(file.path);
    if (from && to && from.l === to.l) { to.l.onLocalRename(from.rel, to.rel, file); return; }
    // Moved between links, or in or out of one: a delete plus a create.
    const isFolder = file instanceof obsidian.TFolder;
    if (from) {
      if (isFolder) from.l.scheduleReconcile(300, '');
      else from.l.schedulePath(from.rel, 300);
    }
    if (to) {
      if (isFolder) to.l.scheduleReconcile(300, to.rel);
      else to.l.schedulePath(to.rel, 300);
    }
  }

  confirmDeletes(link, deletes) {
    // One dialog at a time, even with several links syncing.
    const p = this.confirming.then(() => new Promise((resolve) => {
      new ConfirmDeletesModal(this.app, link, deletes, resolve).open();
    }));
    this.confirming = p.catch(() => {});
    return p;
  }

  authProblem() {
    if (this.authFailed) return;
    this.authFailed = true;
    for (const l of this.links.values()) { l.setStatus('sign-in needed'); }
    new obsidian.Notice('Markport Sync: the server wants a sign-in. Open the plugin\'s settings and sign in again.', 10000);
    this.refreshStatus();
  }

  refreshStatus() {
    if (!this.statusEl) return;
    const all = [...this.links.values()];
    let text;
    if (!this.settings.serverUrl || !all.length) text = 'Markport: not set up';
    else if (this.authFailed) text = 'Markport: sign in';
    else {
      const pending = all.reduce((n, l) => n + l.pendingOps, 0);
      const offline = all.filter((l) => l.status !== 'live').length;
      if (pending) text = 'Markport: syncing ' + pending;
      else if (offline === all.length) text = 'Markport: offline';
      else if (offline) text = 'Markport: ' + (all.length - offline) + '/' + all.length + ' live';
      else text = 'Markport: synced';
    }
    this.statusEl.setText(text);
    if (this.settingTab && this.settingTab.refreshStatusLines) this.settingTab.refreshStatusLines();
  }

  // ── HTTP ──

  async request(method, endpoint, opts = {}) {
    const s = this.settings;
    if (!s.serverUrl) throw new Error('no server URL set');
    const query = Object.assign({}, opts.query);
    if (!query.client) query.client = this.clientId;
    const qs = new URLSearchParams(query).toString();
    const headers = {};
    if (s.token) headers['X-Markport-Token'] = s.token;
    let body = opts.body;
    let contentType = opts.contentType;
    if (opts.json !== undefined) { body = JSON.stringify(opts.json); contentType = 'application/json'; }
    const res = await obsidian.requestUrl({
      url: s.serverUrl + '/api/' + endpoint + (qs ? '?' + qs : ''),
      method,
      headers,
      body,
      contentType,
      throw: false,
    });
    if (res.status >= 400) {
      let msg = 'HTTP ' + res.status;
      let code;
      try { const j = res.json; if (j && j.error) msg = j.error; code = j && j.code; } catch (_) { /* not JSON */ }
      throw new HttpError(res.status, msg, code);
    }
    if (opts.binary) return res.arrayBuffer;
    try { return res.json; } catch (_) { return res.text; }
  }

  async signIn(password) {
    const r = await this.request('POST', 'auth/token', { json: { password } });
    this.settings.token = r.token || '';
    this.settings.tokenExpiresAt = r.expiresAt || 0;
    await this.saveSettings();
    return r;
  }

  async serverVaults() {
    const list = await this.request('GET', 'vaults/list');
    return Object.keys(list || {}).map((id) => ({ id, name: vaultName(list[id], id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async setLinked(vault, folder, on) {
    const links = this.settings.links;
    const i = links.findIndex((l) => l.vaultId === vault.id);
    if (!on) {
      if (i >= 0) links.splice(i, 1);
      delete this.syncState[vault.id];
    } else {
      folder = normalizeFolder(folder);
      if (isHidden(folder)) throw new Error('the folder can\'t be a hidden one');
      const clash = links.find((l) => l.vaultId !== vault.id && foldersOverlap(l.folder, folder));
      if (clash) {
        throw new Error('"' + (folder || 'the whole vault') + '" overlaps the folder of "' + clash.name +
          '" (' + (clash.folder || 'the whole vault') + '). Each server vault needs its own folder.');
      }
      const entry = { vaultId: vault.id, name: vault.name, folder };
      if (i >= 0) links[i] = entry; else links.push(entry);
    }
    await this.saveSettings();
    this.restartLinks();
  }

  // ── sharing ──

  shareTargetFor(file) {
    if (!this.settings.serverUrl) return null;
    return shareTarget(this.settings.links, file.path);
  }

  shareUrl(share) {
    return this.settings.serverUrl + share.url;
  }

  // Local path of a share, for display ('' = the vault root), or null when
  // its server vault isn't linked here.
  shareLocalPath(share) {
    const link = this.settings.links.find((l) => l.vaultId === share.vault);
    return link ? toLocal(link.folder, share.path) : null;
  }

  async listShares(vaultId) {
    return this.request('GET', 'shares', { query: vaultId ? { vault: vaultId } : {} });
  }

  async createShare(file, { permission, password, expiresAt, slug }) {
    const target = this.shareTargetFor(file);
    if (!target) throw new Error('it isn\'t in a folder linked to a Markport vault');
    try {
      const res = await this.request('POST', 'shares', {
        json: { vault: target.link.vaultId, path: target.rel, permission, password: password || null, expiresAt: expiresAt || null, slug: slug || null },
      });
      return res.share;
    } catch (err) {
      // Created here a moment ago and not uploaded yet.
      if (err.status === 404 && /no such file/.test(err.message)) {
        throw new Error('it isn\'t on the server yet. Wait for "Markport: synced" and try again');
      }
      throw err;
    }
  }

  // Set, change or (slug null) remove a share's custom link, /s/<slug>.
  async setShareSlug(id, slug) {
    const res = await this.request('PATCH', 'shares/' + encodeURIComponent(id), { json: { slug: slug || null } });
    return res.share;
  }

  async revokeShare(id) {
    return this.request('DELETE', 'shares/' + encodeURIComponent(id));
  }
}

// ── Sharing UI ──────────────────────────────────────────────────────────────
// The same dialog as the Markport web app's "Share…" (src/plugins/markport-
// share), talking to the server with this plugin's token. The server enforces
// what a link can reach; this is only the owner's UI.

function describeShare(share) {
  const bits = [share.permission === 'edit' ? 'Can edit' : 'View only'];
  if (share.hasPassword) bits.push('password');
  if (share.expiresAt) bits.push((share.expired ? 'expired ' : 'expires ') + new Date(share.expiresAt).toLocaleDateString());
  if (share.missing) bits.push('item missing');
  return bits.join(' · ');
}

async function copyShareLink(plugin, share) {
  const url = plugin.shareUrl(share);
  try {
    await Promise.race([
      navigator.clipboard.writeText(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    new obsidian.Notice('Link copied');
  } catch (_) {
    new obsidian.Notice('Could not copy automatically - copy the link from the dialog.');
  }
}

// The new link, visible and selectable in the dialog - never only on the clipboard.
function renderShareLinkBox(plugin, containerEl, share) {
  const box = containerEl.createDiv();
  box.style.cssText = 'display:flex;gap:8px;margin:0 0 12px;';
  const input = box.createEl('input', { type: 'text' });
  input.style.cssText = 'flex:1;min-width:0;font-family:var(--font-monospace);font-size:var(--font-ui-small);';
  input.value = plugin.shareUrl(share);
  input.readOnly = true;
  input.addEventListener('focus', () => input.select());
  const copy = box.createEl('button', { text: 'Copy' });
  copy.addEventListener('click', () => { input.select(); copyShareLink(plugin, share); });
  return input;
}

function renderShareRows(plugin, containerEl, shares, { showPath, onChange }) {
  containerEl.empty();
  if (!shares.length) {
    containerEl.createEl('p', { text: 'No links yet.', cls: 'setting-item-description' });
    return;
  }
  for (const share of shares) {
    const local = plugin.shareLocalPath(share);
    const setting = new obsidian.Setting(containerEl)
      .setName(showPath ? (local === null ? share.path : (local || '(whole vault)')) : describeShare(share))
      .setDesc(showPath ? describeShare(share) : 'Created ' + new Date(share.createdAt).toLocaleString());
    const urlEl = setting.descEl.createDiv({ text: plugin.shareUrl(share) });
    urlEl.style.cssText = 'font-family:var(--font-monospace);font-size:var(--font-ui-smaller);word-break:break-all;user-select:text;';
    if (share.expired || share.missing) setting.settingEl.style.opacity = '0.55';
    setting.addExtraButton((b) => b.setIcon('copy').setTooltip('Copy link').onClick(() => copyShareLink(plugin, share)));
    setting.addExtraButton((b) => b.setIcon('external-link').setTooltip('Open in browser').onClick(() => window.open(plugin.shareUrl(share))));
    setting.addExtraButton((b) => b.setIcon('pencil').setTooltip('Change custom link').onClick(() => {
      new CustomLinkModal(plugin.app, plugin, share, onChange).open();
    }));
    setting.addExtraButton((b) => b.setIcon('trash-2').setTooltip('Revoke').onClick(async () => {
      try {
        await plugin.revokeShare(share.id);
        new obsidian.Notice('Link revoked');
        onChange();
      } catch (err) {
        new obsidian.Notice('Could not revoke: ' + err.message);
      }
    }));
  }
}

// What the server will make of a typed custom link, for the live preview.
// Validation itself stays on the server.
function previewSlug(input) {
  return String(input || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function addCustomLinkSetting(plugin, containerEl, value, onChange) {
  const setting = new obsidian.Setting(containerEl).setName('Custom link');
  let text;
  const preview = () => {
    const slug = previewSlug(text.getValue());
    setting.setDesc(slug ? plugin.settings.serverUrl + '/s/' + slug : 'Optional. Without one the link uses a random id.');
  };
  setting.addText((t) => {
    text = t;
    t.setPlaceholder('e.g. project-alpha').setValue(value || '').onChange((v) => { onChange(v); preview(); });
  });
  preview();
  setting.descEl.parentElement.createDiv({
    cls: 'setting-item-description',
    text: 'Letters, digits, "-" and "_". Easy to guess, unlike the random link - add a password for anything private.',
  });
  return setting;
}

class CustomLinkModal extends obsidian.Modal {
  constructor(app, plugin, share, onSaved) {
    super(app);
    this.plugin = plugin;
    this.share = share;
    this.onSaved = onSaved;
    this.slug = share.slug || '';
  }

  onOpen() {
    this.titleEl.setText('Custom link');
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Changing or removing it stops the old custom link working. The random link always keeps working.',
    });
    addCustomLinkSetting(this.plugin, this.contentEl, this.slug, (v) => { this.slug = v; });
    new obsidian.Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Remove custom link').setDisabled(!this.share.slug).onClick(() => this.save(null)))
      .addButton((b) => b.setButtonText('Save').setCta().onClick(() => this.save(this.slug)));
  }

  async save(slug) {
    try {
      const share = await this.plugin.setShareSlug(this.share.id, slug && slug.trim() ? slug : null);
      new obsidian.Notice(share.slug ? 'Custom link saved' : 'Custom link removed');
      this.close();
      this.onSaved();
    } catch (err) {
      new obsidian.Notice('Could not save: ' + err.message + signInHint(err));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

function noPasswordWarning(containerEl) {
  containerEl.createEl('p', {
    cls: 'mod-warning',
    text: 'The server has no owner password (MARKPORT_PASSWORD), so anyone who can open it can already open every vault. ' +
      'Links are still limited to what you share, but set a password before sending them outside your network.',
  });
}

function signInHint(err) {
  return err.status === 401 ? ' - sign in again in Settings > Markport Sync.' : '';
}

class ShareModal extends obsidian.Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.isFolder = file instanceof obsidian.TFolder;
    this.permission = 'view';
    this.password = '';
    this.expires = '';
    this.slug = '';
  }

  async onOpen() {
    const target = this.plugin.shareTargetFor(this.file);
    const name = target && !target.rel ? target.link.name : this.file.name.replace(/\.md$/i, '');
    this.titleEl.setText('Share ' + (this.isFolder ? 'folder' : 'note') + ' "' + name + '"');
    this.warningEl = this.contentEl.createDiv();
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: (this.isFolder
        ? 'People with the link can see this folder and everything in it, and nothing else in your vault.'
        : 'People with the link can see this note, and the images and files it embeds, and nothing else in your vault.') +
        ' The link opens on ' + this.plugin.settings.serverUrl + '.',
    });

    this.contentEl.createEl('h4', { text: 'New link' });
    new obsidian.Setting(this.contentEl)
      .setName('Access')
      .setDesc(this.isFolder ? '"Can edit" lets them create, edit, rename and delete notes inside this folder.' : '"Can edit" lets them edit this note.')
      .addDropdown((d) => d.addOption('view', 'View only').addOption('edit', 'Can edit').setValue(this.permission).onChange((v) => { this.permission = v; }));
    new obsidian.Setting(this.contentEl)
      .setName('Password')
      .setDesc('Optional. Recipients enter it once per browser.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.inputEl.autocomplete = 'new-password';
        t.setPlaceholder('No password').onChange((v) => { this.password = v; });
      });
    new obsidian.Setting(this.contentEl)
      .setName('Expires')
      .setDesc('Optional. The link stops working at the end of this day.')
      .addText((t) => {
        t.inputEl.type = 'date';
        t.inputEl.min = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        t.onChange((v) => { this.expires = v; });
      });
    addCustomLinkSetting(this.plugin, this.contentEl, '', (v) => { this.slug = v; });
    new obsidian.Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Create link and copy').setCta().onClick(() => this.create(b)));
    this.createdEl = this.contentEl.createDiv();

    this.contentEl.createEl('h4', { text: 'Links to this ' + (this.isFolder ? 'folder' : 'note') });
    this.listEl = this.contentEl.createDiv();
    await this.refresh();
  }

  async refresh() {
    const target = this.plugin.shareTargetFor(this.file);
    if (!target) { this.listEl.setText('This isn\'t in a folder linked to a Markport vault.'); return; }
    try {
      const res = await this.plugin.listShares(target.link.vaultId);
      this.warningEl.empty();
      if (!res.authEnabled) noPasswordWarning(this.warningEl);
      const mine = res.shares.filter((s) => s.path === target.rel);
      renderShareRows(this.plugin, this.listEl, mine, { showPath: false, onChange: () => this.refresh() });
    } catch (err) {
      this.listEl.setText('Could not load links: ' + err.message + signInHint(err));
    }
  }

  async create(button) {
    let expiresAt = null;
    if (this.expires) {
      const [y, m, d] = this.expires.split('-').map(Number);
      expiresAt = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
      if (!(expiresAt > Date.now())) { new obsidian.Notice('Pick a date in the future'); return; }
    }
    button.setDisabled(true);
    try {
      const share = await this.plugin.createShare(this.file, { permission: this.permission, password: this.password, expiresAt, slug: this.slug.trim() });
      this.createdEl.empty();
      this.createdEl.createEl('p', { cls: 'setting-item-description', text: 'New link - send this to the people you want to share with:' });
      const input = renderShareLinkBox(this.plugin, this.createdEl, share);
      input.focus();
      input.select();
      await copyShareLink(this.plugin, share);
      await this.refresh();
    } catch (err) {
      new obsidian.Notice('Could not create the link: ' + err.message + signInHint(err));
    } finally {
      button.setDisabled(false);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class AllSharesModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    this.titleEl.setText('Shared links on Markport');
    this.warningEl = this.contentEl.createDiv();
    this.listEl = this.contentEl.createDiv();
    await this.refresh();
  }

  async refresh() {
    const linked = this.plugin.settings.links.map((l) => l.vaultId);
    if (!linked.length) { this.listEl.setText('No server vaults are linked yet (Settings > Markport Sync).'); return; }
    try {
      const res = await this.plugin.listShares(null);
      this.warningEl.empty();
      if (!res.authEnabled) noPasswordWarning(this.warningEl);
      const mine = res.shares.filter((s) => linked.includes(s.vault));
      renderShareRows(this.plugin, this.listEl, mine, { showPath: true, onChange: () => this.refresh() });
    } catch (err) {
      this.listEl.setText('Could not load links: ' + err.message + signInHint(err));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}


// ── Settings tab ────────────────────────────────────────────────────────────

class MarkportSyncSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.statusLines = new Map();
    plugin.settingTab = this;
  }

  refreshStatusLines() {
    for (const [id, el] of this.statusLines) {
      const l = this.plugin.links.get(id);
      el.setText(l ? l.describe() : 'not linked');
    }
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    const s = plugin.settings;
    containerEl.empty();
    this.statusLines.clear();

    new obsidian.Setting(containerEl).setName('Server').setHeading();
    new obsidian.Setting(containerEl)
      .setName('Server URL')
      .setDesc('Where your Markport server is, e.g. https://notes.example.com')
      .addText((t) => t.setPlaceholder('https://…').setValue(s.serverUrl).onChange(async (v) => {
        s.serverUrl = normalizeServerUrl(v);
        await plugin.saveSettings();
      }));

    let password = '';
    new obsidian.Setting(containerEl)
      .setName('Sign in')
      .setDesc(s.token
        ? 'Signed in (token valid until ' + new Date(s.tokenExpiresAt).toLocaleDateString() + '). Changing the server password signs every device out.'
        : 'The server\'s MARKPORT_PASSWORD. It is traded for a token once and not stored. Leave empty if the server has no login.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('password').onChange((v) => { password = v; });
      })
      .addButton((b) => b.setButtonText(s.token ? 'Sign in again' : 'Sign in').setCta().onClick(async () => {
        try {
          if (!s.serverUrl) throw new Error('enter the server URL first');
          const r = await plugin.signIn(password);
          new obsidian.Notice(r.authEnabled === false ? 'Markport Sync: the server has no login; connected.' : 'Markport Sync: signed in.');
          plugin.restartLinks();
          this.display();
        } catch (err) {
          new obsidian.Notice('Markport Sync: sign-in failed: ' + err.message);
        }
      }));

    new obsidian.Setting(containerEl)
      .setName('Device name')
      .setDesc('Used in the names of conflict copies.')
      .addText((t) => t.setPlaceholder(plugin.deviceName()).setValue(s.deviceName).onChange(async (v) => {
        s.deviceName = v.trim();
        await plugin.saveSettings();
      }));

    new obsidian.Setting(containerEl)
      .setName('Full check every (minutes)')
      .setDesc('Live changes arrive at once; this re-compares everything as a backstop.')
      .addText((t) => t.setValue(String(s.intervalMin)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (n > 0) { s.intervalMin = n; await plugin.saveSettings(); }
      }));

    const whole = s.links.find((l) => l.folder === '');
    new obsidian.Setting(containerEl)
      .setName('Sync settings and plugins')
      .setDesc(createFragment((f) => {
        f.appendText('Also keep this vault\'s ' + (this.app.vault.configDir || CONFIG) + ' folder in step with the server vault: ' +
          'settings, hotkeys, themes, snippets, and the community plugins with their settings. ' +
          'Only for a server vault synced into this whole vault. Checked on every full comparison, not live. ');
        f.appendText('The first time, this device\'s copy wins wherever they differ (the server\'s goes into its .trash). ' +
          'The window layout and Markport Sync\'s own sign-in stay on each device. Reload Obsidian to use what arrives. ');
        f.appendText('The image library (Markport Clipper: tags, notes, folder folds, favorites) syncs either way.');
        if (!whole) { f.createEl('br'); f.appendText('Link a server vault with an empty folder first.'); }
      }))
      .addToggle((tg) => tg.setValue(!!s.syncConfig).setDisabled(!whole).onChange(async (on) => {
        s.syncConfig = on;
        await plugin.saveSettings();
        if (on) for (const l of plugin.links.values()) { if (l.syncsConfig()) { l.ensureConnected(); l.scheduleReconcile(0); } }
      }));

    new obsidian.Setting(containerEl).setName('Server vaults').setHeading();
    const listEl = containerEl.createDiv();
    const help = containerEl.createEl('p', { cls: 'setting-item-description' });
    help.setText('Turn a vault on to sync it into the folder next to it. Leave the folder empty to sync it into ' +
      'this whole vault (then it must be the only one). Files already in the folder are merged, never deleted.');

    if (!s.serverUrl) { listEl.setText('Enter the server URL and sign in to see its vaults.'); return; }
    listEl.setText('Loading…');
    plugin.serverVaults().then((vaults) => {
      listEl.empty();
      if (!vaults.length) { listEl.setText('The server has no vaults.'); return; }
      const linked = new Map(s.links.map((l) => [l.vaultId, l]));
      // Server vaults that went away but are still linked here.
      for (const l of s.links) if (!vaults.find((v) => v.id === l.vaultId)) vaults.push({ id: l.vaultId, name: l.name + ' (not on the server any more)' });

      new obsidian.Setting(listEl)
        .setName('Sync every vault')
        .setDesc('Link every server vault that isn\'t linked yet, each into a folder named after it.')
        .addButton((b) => b.setButtonText('Link all').onClick(async () => {
          for (const v of vaults) {
            if (plugin.settings.links.find((l) => l.vaultId === v.id)) continue;
            let folder = normalizeFolder(v.name.replace(/[\\/:*?"<>|#^[\]]/g, ' ')) || v.id;
            const taken = (f) => plugin.settings.links.some((l) => foldersOverlap(l.folder, f));
            for (let n = 2; taken(folder); n++) folder = normalizeFolder(v.name) + ' ' + n;
            try { await plugin.setLinked(v, folder, true); } catch (err) { new obsidian.Notice('Markport Sync: ' + v.name + ': ' + err.message); }
          }
          this.display();
        }));

      for (const v of vaults) {
        const link = linked.get(v.id);
        let folder = link ? link.folder : normalizeFolder(v.name);
        const row = new obsidian.Setting(listEl).setName(v.name);
        const statusEl = row.descEl.createDiv();
        this.statusLines.set(v.id, statusEl);
        row.addText((t) => {
          t.setPlaceholder('(whole vault)').setValue(folder).onChange((val) => { folder = val; });
          t.setDisabled(!!link);
          t.inputEl.title = link ? 'Turn sync off to change the folder' : 'Folder in this vault';
        });
        row.addToggle((tg) => tg.setValue(!!link).onChange(async (on) => {
          try {
            await plugin.setLinked(v, folder, on);
          } catch (err) {
            new obsidian.Notice('Markport Sync: ' + err.message, 10000);
          }
          this.display();
        }));
      }
      this.refreshStatusLines();
    }).catch((err) => {
      listEl.setText('Could not load the server\'s vaults: ' + err.message +
        (err.status === 401 ? ' - sign in first.' : ''));
    });
  }
}

module.exports = MarkportSyncPlugin;
module.exports.helpers = {
  normalizeServerUrl, normalizeFolder, isHidden, toLocal, toRel, under, foldersOverlap, shareTarget,
  sameStat, decide, conflictPath, trashPath, sameBytes, diffHunks, merge3, vaultName,
  configSynced, ALWAYS_CONFIG, communityForServer, communityForHere, sameIdLists,
};
module.exports.LinkSync = LinkSync;
module.exports.HttpError = HttpError;
