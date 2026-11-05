/**
 * What a share can reach.
 *
 * A share is served as a virtual vault whose root is the shared folder (or,
 * for a single note, a root that contains only that note). Every path a share
 * request names goes through Scope.resolve(), which maps it to a real file or
 * refuses it. Nothing outside the shared item is reachable:
 *
 *   <root>/...           the shared folder's own files (dot-files hidden), or
 *                        just the shared note
 *   .obsidian/...        a private settings folder per share
 *                        (<data>/shares/<id>/config), never the owner's;
 *                        themes/, snippets/ and appearance.json are read from
 *                        the owner's vault, read-only, so recipients see the
 *                        owner's look; plugins/ does not exist (no plugin code
 *                        can be planted or run in a share)
 *   .trash/...           <data>/shares/<id>/trash - recipients' deletions go
 *                        here, outside the vault, where the owner can recover them
 *   Linked files/...     read-only: attachments (images, PDFs, audio, video)
 *                        that notes inside the share embed but that live
 *                        elsewhere in the vault, under their vault path
 *
 * Symlinks are resolved and must stay inside the area they belong to.
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CONFIG = '.obsidian';
const TRASH = '.trash';
const LINKED = 'Linked files';
const OWNER_CONFIG = new Set(['themes', 'snippets', 'appearance.json']);
const HIDDEN_CONFIG = new Set(['plugins', 'community-plugins.json']);
const ATTACHMENT_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico',
  'mp3', 'wav', 'm4a', 'ogg', 'flac', '3gp',
  'mp4', 'webm', 'mov', 'mkv', 'ogv',
  'pdf',
]);

const INDEX_TTL_MS = 15000;
const MAX_INDEX_FILES = 50000;
const MAX_NOTES_SCANNED = 5000;
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

function fsError(code, message) {
  return Object.assign(new Error(message), { code });
}

function splitRel(rel) {
  const segs = [];
  for (const s of String(rel == null ? '' : rel).replace(/\\/g, '/').split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') throw fsError('EACCES', 'path escapes the share');
    segs.push(s);
  }
  return segs;
}

function ext(p) {
  const i = p.lastIndexOf('.');
  return i > p.lastIndexOf('/') ? p.slice(i + 1).toLowerCase() : '';
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// realpath of p, or of its nearest existing ancestor joined with the rest.
async function realpathLoose(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      const real = await fsp.realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

async function assertInside(abs, root) {
  const [realAbs, realRoot] = await Promise.all([realpathLoose(abs), realpathLoose(root)]);
  if (!isInside(realAbs, realRoot)) throw fsError('EACCES', 'path escapes the share');
}

// Join a relative link onto a '/'-separated folder; null if it climbs above
// the vault root.
function joinRel(baseDir, rel) {
  const parts = baseDir ? baseDir.split('/') : [];
  for (const s of rel.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(s);
  }
  return parts.join('/');
}

// ── vault-wide file index (for link resolution) ─────────────────────────────

const vaultIndexCache = new Map();   // vaultRoot → { ts, promise }

async function buildVaultIndex(vaultRoot) {
  const files = [];
  async function walk(dirAbs, dirRel) {
    if (files.length >= MAX_INDEX_FILES) return;
    let entries;
    try { entries = await fsp.readdir(dirAbs, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = dirRel ? dirRel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(dirAbs, e.name), rel);
      else if (e.isFile()) { files.push(rel); if (files.length >= MAX_INDEX_FILES) return; }
    }
  }
  await walk(vaultRoot, '');
  const fileSet = new Set(files);
  const byName = new Map();   // lower-case basename → [rel]
  for (const f of files) {
    const name = f.slice(f.lastIndexOf('/') + 1).toLowerCase();
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(f);
  }
  return { files, fileSet, byName };
}

function vaultIndex(vaultRoot) {
  const hit = vaultIndexCache.get(vaultRoot);
  if (hit && Date.now() - hit.ts < INDEX_TTL_MS) return hit.promise;
  const promise = buildVaultIndex(vaultRoot);
  vaultIndexCache.set(vaultRoot, { ts: Date.now(), promise });
  promise.catch(() => vaultIndexCache.delete(vaultRoot));
  return promise;
}

function invalidateVaultIndex(vaultRoot) {
  if (vaultRoot) vaultIndexCache.delete(vaultRoot);
  else vaultIndexCache.clear();
}

// Resolve a link target the way Obsidian does, closely enough: exact vault
// path, then relative to the linking note, then by file name (same folder
// first, then the shortest path). `.md` is optional. Returns a vault-relative
// path or null.
function resolveLinkTarget(index, target, fromRel) {
  let t = String(target || '').trim().replace(/\\/g, '/');
  if (!t) return null;
  while (t.startsWith('/')) t = t.slice(1);
  const fromDir = fromRel && fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  const tryPaths = [t, t + '.md'];
  for (const p of tryPaths) if (index.fileSet.has(p)) return p;
  const rel = joinRel(fromDir, t);
  if (rel) for (const p of [rel, rel + '.md']) if (index.fileSet.has(p)) return p;
  const name = t.slice(t.lastIndexOf('/') + 1).toLowerCase();
  let cands = (index.byName.get(name) || []).concat(index.byName.get(name + '.md') || []);
  if (t.includes('/')) {
    const suffix = t.toLowerCase();
    cands = cands.filter((c) => {
      const lc = c.toLowerCase();
      return lc.endsWith('/' + suffix) || lc.endsWith('/' + suffix + '.md') || lc === suffix || lc === suffix + '.md';
    });
  }
  if (!cands.length) return null;
  const sameDir = cands.find((c) => (c.includes('/') ? c.slice(0, c.lastIndexOf('/')) : '') === fromDir);
  if (sameDir) return sameDir;
  return cands.slice().sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

// Embed targets in a note's markdown: ![[target]] and ![alt](target).
// Fenced and inline code is skipped.
function extractEmbedTargets(markdown) {
  const text = String(markdown)
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const out = [];
  const wiki = /!\[\[([^\]\n]+?)\]\]/g;
  let m;
  while ((m = wiki.exec(text))) out.push(m[1].split('|')[0].split('#')[0]);
  const mdImg = /!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  while ((m = mdImg.exec(text))) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;   // http:, data:, ...
    let decoded = target;
    try { decoded = decodeURI(target); } catch (_) { /* keep raw */ }
    out.push(decoded.split('#')[0]);
  }
  return out.filter(Boolean);
}

// ── Scope ───────────────────────────────────────────────────────────────────

const linkedCache = new Map();   // share id → { ts, key, promise }

class Scope {
  constructor(share, vaultRoot, shareDataRoot) {
    this.share = share;
    this.vaultRoot = path.resolve(vaultRoot);
    const relParts = share.path ? share.path.split('/') : [];
    this.target = path.join(this.vaultRoot, ...relParts);
    this.isFile = share.kind === 'file';
    this.contentRoot = this.isFile ? path.dirname(this.target) : this.target;
    this.fileName = this.isFile ? path.basename(this.target) : null;
    this.dataDir = path.join(shareDataRoot, share.id);
    this.configDir = path.join(this.dataDir, 'config');
    this.trashDir = path.join(this.dataDir, 'trash');
    this.ownerConfigDir = path.join(this.vaultRoot, CONFIG);
    this.canWrite = share.permission === 'edit';
  }

  // Is this vault-relative path part of the share's own content?
  inScope(vaultRel) {
    if (typeof vaultRel !== 'string') return false;
    const segs = vaultRel.split('/');
    if (segs.some((s) => !s || s.startsWith('.'))) return false;
    if (this.isFile) return vaultRel === this.share.path;
    return !this.share.path || vaultRel === this.share.path || vaultRel.startsWith(this.share.path + '/');
  }

  // Vault-relative path → path inside the share's virtual vault (or null).
  toShareRel(vaultRel) {
    if (!this.inScope(vaultRel)) return null;
    if (this.isFile) return this.fileName;
    return this.share.path ? vaultRel.slice(this.share.path.length + 1) : vaultRel;
  }

  // Path inside the share's content → vault-relative path.
  toVaultRel(shareRel) {
    const segs = splitRel(shareRel);
    if (this.isFile) return segs.length === 1 && segs[0] === this.fileName ? this.share.path : null;
    return (this.share.path ? this.share.path.split('/') : []).concat(segs).join('/');
  }

  // The share's private settings folder, with Obsidian told to move deleted
  // notes to the share's .trash (outside the vault) instead of destroying them.
  async ensureConfig() {
    await fsp.mkdir(this.configDir, { recursive: true });
    try {
      await fsp.writeFile(path.join(this.configDir, 'app.json'), JSON.stringify({ trashOption: 'local' }, null, 2), { flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  async exists() {
    try {
      const st = await fsp.stat(this.target);
      return this.isFile ? st.isFile() : st.isDirectory();
    } catch (_) { return false; }
  }

  async hasRealLinkedDir() {
    if (this.isFile) return false;
    try { return (await fsp.stat(path.join(this.contentRoot, LINKED))).isDirectory(); } catch (_) { return false; }
  }

  // Attachments outside the share that notes inside it embed, flattened to
  // their file names so the share never reveals the folders above it:
  //   { byName: Map(name → vault path), byVault: Map(vault path → name), size }
  // Same-named files from different folders get " (2)", " (3)", ...
  async linked() {
    const set = await this.linkedFiles();
    const byName = new Map();
    const byVault = new Map();
    for (const rel of [...set].sort()) {
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      let name = base;
      for (let n = 2; byName.has(name.toLowerCase()); n++) {
        const dot = base.lastIndexOf('.');
        name = dot > 0 ? base.slice(0, dot) + ' (' + n + ')' + base.slice(dot) : base + ' (' + n + ')';
      }
      byName.set(name.toLowerCase(), { name, rel });
      byVault.set(rel, name);
    }
    return { byName, byVault, size: byVault.size };
  }

  async linkedFiles() {
    const key = this.share.path + '|' + this.share.kind;
    const hit = linkedCache.get(this.share.id);
    if (hit && hit.key === key && Date.now() - hit.ts < INDEX_TTL_MS) return hit.promise;
    const promise = (async () => {
      const index = await vaultIndex(this.vaultRoot);
      const notes = index.files.filter((f) => f.toLowerCase().endsWith('.md') && this.inScope(f)).slice(0, MAX_NOTES_SCANNED);
      const linked = new Set();
      for (const note of notes) {
        let text;
        try {
          const abs = path.join(this.vaultRoot, ...note.split('/'));
          const st = await fsp.stat(abs);
          if (st.size > MAX_NOTE_BYTES) continue;
          text = await fsp.readFile(abs, 'utf8');
        } catch (_) { continue; }
        for (const t of extractEmbedTargets(text)) {
          const r = resolveLinkTarget(index, t, note);
          if (r && !this.inScope(r) && ATTACHMENT_EXT.has(ext(r))) linked.add(r);
        }
      }
      return linked;
    })();
    linkedCache.set(this.share.id, { ts: Date.now(), key, promise });
    promise.catch(() => linkedCache.delete(this.share.id));
    return promise;
  }

  /**
   * Map a share-relative path to a real location, or throw ENOENT/EACCES.
   * op: 'read' | 'write' (create/overwrite a file) | 'mkdir' | 'delete' | 'rename'
   * Returns { area, abs } where area is one of
   *   root, content, config-root, config, owner-config, trash, linked, linked-dir
   */
  async resolve(rel, op) {
    const segs = splitRel(rel);
    const writing = op !== 'read';
    const deny = (msg) => fsError('EACCES', msg || 'not allowed in this share');
    const missing = () => fsError('ENOENT', 'no such file in this share: ' + segs.join('/'));
    if (writing && !this.canWrite) throw deny('this share is read-only');

    if (segs.length === 0) {
      if (writing) throw deny();
      return { area: 'root', abs: this.contentRoot };
    }

    const top = segs[0];
    if (top === CONFIG) {
      const rest = segs.slice(1);
      if (rest.length === 0) {
        if (op !== 'read' && op !== 'mkdir') throw deny();
        return { area: 'config-root', abs: this.configDir };
      }
      if (HIDDEN_CONFIG.has(rest[0])) throw writing ? deny('plugins are disabled in shares') : missing();
      if (OWNER_CONFIG.has(rest[0])) {
        // Obsidian rewrites appearance.json on startup; accept and drop it
        // rather than show the recipient an error. The owner's file is untouched.
        if (op === 'write' && rest.length === 1 && rest[0] === 'appearance.json') return { area: 'discard', abs: null };
        if (writing) throw deny('appearance is set by the vault owner');
        const abs = path.join(this.ownerConfigDir, ...rest);
        await assertInside(abs, this.ownerConfigDir);
        return { area: 'owner-config', abs };
      }
      const abs = path.join(this.configDir, ...rest);
      await assertInside(abs, this.configDir);
      return { area: 'config', abs };
    }
    if (top === TRASH) {
      const abs = path.join(this.trashDir, ...segs.slice(1));
      await assertInside(abs, this.trashDir);
      return { area: segs.length === 1 ? 'trash-root' : 'trash', abs };
    }
    if (segs.some((s) => s.startsWith('.'))) throw writing ? deny() : missing();

    if (top === LINKED && !(await this.hasRealLinkedDir())) {
      if (writing) throw deny('linked files are read-only');
      if (segs.length === 1) return { area: 'linked-dir', abs: null };
      const hit = segs.length === 2 && (await this.linked()).byName.get(segs[1].toLowerCase());
      if (!hit || hit.name !== segs[1]) throw missing();
      const abs = path.join(this.vaultRoot, ...hit.rel.split('/'));
      await assertInside(abs, this.vaultRoot);
      return { area: 'linked', abs };
    }

    if (this.isFile) {
      if (segs.length !== 1 || segs[0] !== this.fileName) throw writing ? deny('only the shared note is accessible') : missing();
      if (op !== 'read' && op !== 'write') throw deny('the shared note cannot be renamed or deleted');
      await assertInside(this.target, this.vaultRoot);
      return { area: 'content', abs: this.target };
    }

    const abs = path.join(this.contentRoot, ...segs);
    await assertInside(abs, this.contentRoot);
    return { area: 'content', abs };
  }

  /**
   * The whole visible tree in /api/bootstrap's `dirs` shape:
   * { '<dir rel>': [{ name, isFile, isDirectory, isSymbolicLink, mtime, size }] }
   * The client builds Obsidian's file list from this. Settings and trash are
   * left out (Obsidian reads those by path).
   */
  async tree(maxEntries = MAX_INDEX_FILES) {
    const dirs = {};
    let count = 0;
    // Parents must come before their children: the client flattens this map
    // in key order, and Obsidian drops files whose folder it hasn't seen yet.
    const walk = async (rel) => {
      const entries = await this.list(rel);
      const out = [];
      dirs[rel] = out;
      const subdirs = [];
      for (const e of entries) {
        if (!rel && (e.name === CONFIG || e.name === TRASH)) continue;
        if (++count > maxEntries) break;
        let st = null;
        if (e.abs) { try { st = await fsp.stat(e.abs); } catch (_) { continue; } }
        const isDir = st ? st.isDirectory() : true;
        out.push({ name: e.name, isFile: !isDir, isDirectory: isDir, isSymbolicLink: false, mtime: st ? st.mtimeMs : Date.now(), size: st ? st.size : 0 });
        if (isDir) subdirs.push(rel ? rel + '/' + e.name : e.name);
      }
      for (const d of subdirs) await walk(d);
    };
    await walk('');
    return dirs;
  }

  /**
   * Directory listing for a share-relative directory.
   * Returns [{ name, abs }] (abs null = synthetic directory).
   */
  async list(rel) {
    const r = await this.resolve(rel, 'read');
    const readdir = async (dir, filter) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
      return entries.filter((e) => !filter || filter(e.name)).map((e) => ({ name: e.name, abs: path.join(dir, e.name) }));
    };
    switch (r.area) {
      case 'root': {
        let out;
        if (this.isFile) {
          out = (await this.exists()) ? [{ name: this.fileName, abs: this.target }] : [];
        } else {
          out = await readdir(this.contentRoot, (n) => !n.startsWith('.'));
        }
        await this.ensureConfig();
        out.push({ name: CONFIG, abs: this.configDir });
        try { await fsp.access(this.trashDir); out.push({ name: TRASH, abs: this.trashDir }); } catch (_) { /* none yet */ }
        if (!out.some((e) => e.name === LINKED) && !(await this.hasRealLinkedDir()) && (await this.linkedFiles()).size > 0) out.push({ name: LINKED, abs: null });
        return out;
      }
      case 'config-root': {
        const own = await readdir(this.configDir, (n) => !HIDDEN_CONFIG.has(n) && !OWNER_CONFIG.has(n));
        const owner = await readdir(this.ownerConfigDir, (n) => OWNER_CONFIG.has(n));
        return own.concat(owner);
      }
      case 'linked-dir':
        return [...(await this.linked()).byName.values()].map(({ name, rel }) => ({ name, abs: path.join(this.vaultRoot, ...rel.split('/')) }));
      case 'content':
        return readdir(r.abs, (n) => !n.startsWith('.'));
      case 'config':
      case 'owner-config':
      case 'trash':
      case 'trash-root':
        return readdir(r.abs);
      case 'linked':
        throw fsError('ENOTDIR', 'not a directory');
      default:
        return [];
    }
  }
}

module.exports = {
  Scope,
  CONFIG,
  TRASH,
  LINKED,
  ATTACHMENT_EXT,
  vaultIndex,
  invalidateVaultIndex,
  resolveLinkTarget,
  extractEmbedTargets,
  splitRel,
  ext,
  fsError,
};
