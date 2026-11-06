'use strict';

/**
 * The native Obsidian plugin src/native-plugins/markport-sync against a real
 * server: its sync rules (pure helpers), and its LinkSync engine end to end,
 * running in an in-memory stand-in for Obsidian's vault while a "web
 * session" edits the same server vault through /api/fs.
 *
 * main.js does require('obsidian'), which only exists inside Obsidian, so a
 * minimal stand-in is served for that one module name.
 */

const assert = require('assert/strict');
const fsp = require('fs/promises');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');
const test = require('node:test');
const WebSocket = require('ws');

const { createApp } = require('../index');
const attachWatchServer = require('../api/watch');

// ── a stand-in for Obsidian ─────────────────────────────────────────────────

class TAbstractFile { constructor(p) { this.path = p; } }
class TFolder extends TAbstractFile { constructor(p) { super(p); this.children = []; } }
class TFile extends TAbstractFile { constructor(p) { super(p); this.stat = { mtime: 0, size: 0 }; } }

const notices = [];
const fakeObsidian = {
  TAbstractFile, TFile, TFolder,
  Notice: class { constructor(msg) { notices.push(msg); } },
  Modal: class { constructor(app) { this.app = app; this.contentEl = {}; } open() {} close() {} },
  Setting: class {},
  PluginSettingTab: class { constructor(app) { this.app = app; } },
  Plugin: class { constructor(app, manifest) { this.app = app; this.manifest = manifest; } },
  Platform: { isMobile: false },
  async requestUrl({ url, method, headers, body, contentType }) {
    const h = Object.assign({}, headers);
    if (contentType) h['Content-Type'] = contentType;
    const res = await fetch(url, { method, headers: h, body });
    const buf = await res.arrayBuffer();
    const text = Buffer.from(buf).toString('utf8');
    return {
      status: res.status,
      arrayBuffer: buf,
      text,
      get json() { return JSON.parse(text); },
    };
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') return fakeObsidian;
  return originalLoad.call(this, request, ...rest);
};
const pluginPath = path.resolve(__dirname, '..', '..', '..', 'native-plugins', 'markport-sync', 'main.js');
const MarkportSyncPlugin = require(pluginPath);
Module._load = originalLoad;
const H = MarkportSyncPlugin.helpers;

// An in-memory vault with Obsidian's API shape. Like Obsidian it fires
// create/modify/delete for the plugin's own writes too.
function fakeVault() {
  const items = new Map();   // path → TFile | TFolder
  const data = new Map();    // path → ArrayBuffer
  const handlers = { create: [], modify: [], delete: [], rename: [], raw: [] };
  // The config folder (.obsidian): not vault items, only reachable through
  // the adapter, as in Obsidian.
  const rawFiles = new Map();   // path → { buf, mtime }
  const rawDirs = new Set();
  let clock = 1700000000000;
  const fire = (ev, ...args) => handlers[ev].forEach((fn) => fn(...args));
  const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  function link(f) {
    items.set(f.path, f);
    const parent = items.get(parentOf(f.path));
    if (parent) parent.children.push(f);
  }
  function unlinkItem(f) {
    items.delete(f.path);
    data.delete(f.path);
    const parent = items.get(parentOf(f.path));
    if (parent) parent.children = parent.children.filter((c) => c !== f);
  }
  function setData(f, buf) {
    data.set(f.path, buf);
    f.stat = { mtime: (clock += 1000), size: buf.byteLength };
  }
  const vault = {
    on(ev, fn) { handlers[ev].push(fn); return { ev, fn }; },
    getAbstractFileByPath: (p) => items.get(p) || null,
    getAllLoadedFiles: () => [...items.values()],
    async createFolder(p) {
      if (items.has(p)) throw new Error('Folder already exists.');
      if (parentOf(p) && !items.has(parentOf(p))) throw new Error('Parent missing');
      const f = new TFolder(p); link(f); fire('create', f); return f;
    },
    async createBinary(p, buf) {
      if (items.has(p)) throw new Error('File already exists.');
      if (parentOf(p) && !items.has(parentOf(p))) throw new Error('Parent missing: ' + p);
      const f = new TFile(p); link(f); setData(f, buf); fire('create', f); return f;
    },
    async modifyBinary(f, buf) { setData(f, buf); fire('modify', f); },
    async readBinary(f) { return data.get(f.path).slice(0); },
    async delete(f) { unlinkItem(f); fire('delete', f); },
    async trash(f) { unlinkItem(f); fire('delete', f); },
    configDir: '.obsidian',
    adapter: {
      async stat(p) {
        const f = items.get(p);
        if (f && f.stat) return { type: 'file', mtime: f.stat.mtime, size: f.stat.size };
        const r = rawFiles.get(p);
        if (r) return { type: 'file', mtime: r.mtime, size: r.buf.byteLength };
        return rawDirs.has(p) ? { type: 'folder', mtime: 0, size: 0 } : null;
      },
      async exists(p) { return items.has(p) || rawFiles.has(p) || rawDirs.has(p); },
      async mkdir(p) { rawDirs.add(p); },
      async list(dir) {
        const kids = (all) => [...all].filter((k) => k.startsWith(dir + '/') && !k.slice(dir.length + 1).includes('/'));
        return { files: kids(rawFiles.keys()), folders: kids(rawDirs) };
      },
      async readBinary(p) { return rawFiles.get(p).buf.slice(0); },
      async writeBinary(p, buf) {
        for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) {
          if (!rawDirs.has(p.slice(0, i))) throw new Error('Parent missing: ' + p);
        }
        rawFiles.set(p, { buf: buf.slice(0), mtime: (clock += 1000) });
        fire('raw', p);
      },
      async trashLocal(p) {
        const r = rawFiles.get(p);
        rawFiles.delete(p);
        rawFiles.set('.trash/' + p, r);
        fire('raw', p);
      },
      async remove(p) { rawFiles.delete(p); fire('raw', p); },
    },
    // as Obsidian or another plugin changing a setting
    async _writeConfig(p, text) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) rawDirs.add(parts.slice(0, i).join('/'));
      await vault.adapter.writeBinary(p, new TextEncoder().encode(text).buffer);
    },
    _config: (p) => (rawFiles.has(p) ? Buffer.from(rawFiles.get(p).buf).toString('utf8') : null),
    // test helpers, as a user would act in Obsidian
    _text: (p) => (data.has(p) ? Buffer.from(data.get(p)).toString('utf8') : null),
    async _write(p, text) {
      const buf = new TextEncoder().encode(text).buffer;
      const f = items.get(p);
      if (f) return vault.modifyBinary(f, buf);
      return vault.createBinary(p, buf);
    },
    async _rename(oldPath, newPath) {
      const f = items.get(oldPath);
      const buf = data.get(oldPath);
      unlinkItem(f);
      f.path = newPath; link(f); data.set(newPath, buf);
      fire('rename', f, oldPath);
    },
  };
  return vault;
}

// ── the pure rules ──────────────────────────────────────────────────────────

test('decide: one changed side wins; nothing is deleted without a base', () => {
  const base = { rm: 10, rs: 1, lm: 20, ls: 1 };
  const same = { mtime: 20, size: 1 };
  const remoteSame = { mtime: 10, size: 1 };
  const changed = { mtime: 99, size: 2 };
  assert.equal(H.decide(base, same, remoteSame), 'none');
  assert.equal(H.decide(base, changed, remoteSame), 'upload');
  assert.equal(H.decide(base, same, changed), 'download');
  assert.equal(H.decide(base, changed, changed), 'compare');
  assert.equal(H.decide(base, same, null), 'delete-local');
  assert.equal(H.decide(base, changed, null), 'upload', 'deleted there but edited here: restore');
  assert.equal(H.decide(base, null, remoteSame), 'delete-remote');
  assert.equal(H.decide(base, null, changed), 'download', 'deleted here but edited there: restore');
  assert.equal(H.decide(base, null, null), 'forget');
  assert.equal(H.decide(null, same, null), 'upload');
  assert.equal(H.decide(null, null, remoteSame), 'download');
  assert.equal(H.decide(null, same, remoteSame), 'compare');
});

test('merge3 merges separate edits and refuses overlapping ones', () => {
  const base = 'title\n\nalpha\nbeta\ngamma\n';
  assert.equal(H.merge3(base, 'title\n\nALPHA\nbeta\ngamma\n', 'title\n\nalpha\nbeta\ngamma\ndelta\n'),
    'title\n\nALPHA\nbeta\ngamma\ndelta\n');
  assert.equal(H.merge3(base, 'intro\ntitle\n\nalpha\nbeta\ngamma\n', 'title\n\nalpha\nbeta\nGAMMA\n'),
    'intro\ntitle\n\nalpha\nbeta\nGAMMA\n');
  assert.equal(H.merge3(base, 'title\n\nalpha\nB1\ngamma\n', 'title\n\nalpha\nB2\ngamma\n'), null);
  assert.equal(H.merge3(base, 'title\n\nalpha\nX\ngamma\n', 'title\n\nalpha\nX\ngamma\n'), 'title\n\nalpha\nX\ngamma\n');
  assert.equal(H.merge3(base, base, 'changed'), 'changed');
});

test('paths: folders, links that overlap, conflict names', () => {
  assert.equal(H.toLocal('Server/Notes', 'a/b.md'), 'Server/Notes/a/b.md');
  assert.equal(H.toRel('Server/Notes', 'Server/Notes/a/b.md'), 'a/b.md');
  assert.equal(H.toRel('Server/Notes', 'Server/Notesy/a.md'), null);
  assert.equal(H.toRel('', 'a.md'), 'a.md');
  assert.ok(H.foldersOverlap('', 'Work'));
  assert.ok(H.foldersOverlap('Work', 'Work/Sub'));
  assert.ok(!H.foldersOverlap('Work', 'Workshop'));
  assert.ok(H.isHidden('.obsidian/app.json'));
  assert.ok(H.isHidden('a/.trash/x.md'));
  assert.equal(H.normalizeServerUrl('notes.example.com/'), 'https://notes.example.com');
  // Sharing: local path → server vault + path.
  const links = [{ vaultId: 'a', folder: 'Server' }, { vaultId: 'b', folder: 'Other/Box' }];
  assert.deepEqual(H.shareTarget(links, 'Server/Projects/Plan.md'), { link: links[0], rel: 'Projects/Plan.md' });
  assert.deepEqual(H.shareTarget(links, 'Server'), { link: links[0], rel: '' });
  assert.deepEqual(H.shareTarget(links, 'Other/Box/x.md'), { link: links[1], rel: 'x.md' });
  assert.equal(H.shareTarget(links, 'Other/x.md'), null);
  assert.equal(H.shareTarget(links, 'Serverless/x.md'), null);
  assert.equal(H.shareTarget(links, 'Server/.obsidian/app.json'), null);
  assert.equal(H.shareTarget(links, '/'), null);
  assert.deepEqual(H.shareTarget([{ vaultId: 'c', folder: '' }], '/'), { link: { vaultId: 'c', folder: '' }, rel: '' });
  assert.equal(H.conflictPath('dir/My note.md', 'Laptop', new Date(2026, 10, 5, 9, 7, 3)),
    'dir/My note (conflict Laptop 2026-11-05 090703).md');
});

// ── end to end ──────────────────────────────────────────────────────────────

// The system plugins the server serves to every vault.
const repoPluginsDir = path.resolve(__dirname, '..', '..', '..', 'plugins');
const repoPlugin = (rel) => fsp.readFile(path.join(repoPluginsDir, rel), 'utf8');

async function waitFor(cond, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setup(t, opts = {}) {
  const folder = opts.folder === undefined ? 'Server' : opts.folder;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'markport-sync-plugin-'));
  require('../system-plugins').init();   // as the server's start does
  const app = createApp({
    registryPath: path.join(tmp, 'registry.json'),
    vaultPath: path.join(tmp, 'default'),
    vaultsDir: path.join(tmp, 'vaults'),
    defaultVaultName: 'Notes',
    ownerPassword: 'pw',
  });
  const server = http.createServer(app);
  attachWatchServer(server, app.locals.vaultRegistry, path.join(tmp, 'default'), {
    isOwner: app.locals.auth.isOwner,
    shareTarget: app.locals.sharing.watchTarget,
    events: app.locals.vaultEvents,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const serverVaultDir = path.join(tmp, 'vaults', 'Notes');
  await fsp.writeFile(path.join(serverVaultDir, 'existing.md'), 'on the server already\n');
  for (const [rel, text] of Object.entries(opts.serverFiles || {})) {
    await fsp.mkdir(path.dirname(path.join(serverVaultDir, rel)), { recursive: true });
    await fsp.writeFile(path.join(serverVaultDir, rel), text);
  }

  // Globals the plugin expects from Obsidian's window.
  const prevWS = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket;
  globalThis.window = globalThis;
  globalThis.document = { visibilityState: 'visible' };

  const vault = fakeVault();
  for (const [p, text] of Object.entries(opts.localConfig || {})) await vault._writeConfig(p, text);
  const intervals = [];
  const fakeApp = Object.assign({ vault, workspace: { onLayoutReady: (fn) => fn(), on: () => ({}), getActiveFile: () => null }, fileManager: null }, opts.app);
  const plugin = new MarkportSyncPlugin(fakeApp, { id: 'markport-sync' });
  let saved = null;
  plugin.loadData = async () => saved;
  plugin.saveData = async (d) => { saved = JSON.parse(JSON.stringify(d)); };
  plugin.addStatusBarItem = () => ({ addClass() {}, onClickEvent() {}, setText(t) { this.text = t; } });
  plugin.addSettingTab = () => {};
  plugin.addCommand = () => {};
  plugin.registerEvent = () => {};
  plugin.registerInterval = (id) => { intervals.push(id); return id; };
  plugin.registerDomEvent = () => {};

  // Sign in and link the server vault into the folder "Server" here.
  const signIn = await (await fetch(baseUrl + '/api/auth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }),
  })).json();
  const token = signIn.token;
  const list = await (await fetch(baseUrl + '/api/vaults/list', { headers: { 'X-Markport-Token': token } })).json();
  const vaultId = Object.keys(list)[0];
  saved = { settings: Object.assign({ serverUrl: baseUrl, token, links: [{ vaultId, name: 'Notes', folder }] }, opts.settings) };

  t.after(async () => {
    plugin.onunload();
    intervals.forEach(clearInterval);
    globalThis.WebSocket = prevWS;
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  // The "web session": edits the same server vault through /api/fs.
  const web = {
    async write(rel, text) {
      const qs = new URLSearchParams({ vault: vaultId, path: rel, encoding: 'utf8', client: 'web-1' });
      const r = await fetch(baseUrl + '/api/fs/write?' + qs, {
        method: 'PUT', headers: { 'X-Markport-Token': token, 'Content-Type': 'text/plain' }, body: text,
      });
      assert.equal(r.status, 200);
    },
    async unlink(rel) {
      const qs = new URLSearchParams({ vault: vaultId, path: rel, client: 'web-1' });
      await fetch(baseUrl + '/api/fs/unlink?' + qs, { method: 'DELETE', headers: { 'X-Markport-Token': token } });
    },
    read: (rel) => fsp.readFile(path.join(serverVaultDir, rel), 'utf8').catch(() => null),
  };

  await plugin.onload();
  const linkSync = plugin.links.get(vaultId);
  // Wire this vault's events to the plugin, as onLayoutReady would.
  vault.on('create', (f) => plugin.dispatch(f.path, (l, rel) => l.onLocalCreate(rel, f)));
  vault.on('modify', (f) => plugin.dispatch(f.path, (l, rel) => l.onLocalModify(rel, f)));
  vault.on('delete', (f) => plugin.dispatch(f.path, (l, rel) => l.onLocalDelete(rel, f)));
  vault.on('rename', (f, oldPath) => plugin.onRename(f, oldPath));
  vault.on('raw', (p) => plugin.onRawChange(p));
  await waitFor(() => linkSync.lastFullSync > 0);
  return { vault, web, plugin, linkSync, serverVaultDir, vaultId, token, baseUrl };
}

test('markport-sync keeps a native vault folder and the server vault in step, live', async (t) => {
  const { vault, web, linkSync, serverVaultDir } = await setup(t);

  // First sync brought the server's note here.
  assert.equal(vault._text('Server/existing.md'), 'on the server already\n');
  assert.equal(linkSync.status, 'live');

  // Written here → on the server.
  await vault._write('Server/from-native.md', 'hello from the app\n');
  await waitFor(async () => (await web.read('from-native.md')) === 'hello from the app\n');

  // Written by a web session → here, pushed over the socket.
  await web.write('existing.md', 'edited in the browser\n');
  await waitFor(() => vault._text('Server/existing.md') === 'edited in the browser\n');
  await web.write('sub/new-in-web.md', 'new\n');
  await waitFor(() => vault._text('Server/sub/new-in-web.md') === 'new\n');

  // Both sides edit the same note, different lines: merged on both sides.
  await vault._write('Server/shared.md', 'one\ntwo\nthree\n');
  await waitFor(async () => (await web.read('shared.md')) === 'one\ntwo\nthree\n');
  await linkSync.queue;
  // Hold the queue so both edits are in place before the plugin looks.
  let release;
  linkSync.run('hold', () => new Promise((r) => { release = r; }));
  await web.write('shared.md', 'one\ntwo\nthree\nfour (web)\n');
  await vault._write('Server/shared.md', 'ONE (app)\ntwo\nthree\n');
  release();
  const merged = 'ONE (app)\ntwo\nthree\nfour (web)\n';
  await waitFor(async () => vault._text('Server/shared.md') === merged && (await web.read('shared.md')) === merged);

  // Same lines edited on both sides: the server's version stays, this
  // device's is kept as a conflict copy on both sides.
  linkSync.run('hold', () => new Promise((r) => { release = r; }));
  await web.write('shared.md', 'ONE (web wins)\ntwo\nthree\nfour (web)\n');
  await vault._write('Server/shared.md', 'ONE (app loses)\ntwo\nthree\nfour (web)\n');
  release();
  await waitFor(() => vault._text('Server/shared.md') === 'ONE (web wins)\ntwo\nthree\nfour (web)\n');
  await linkSync.queue;
  const copies = (await fsp.readdir(serverVaultDir)).filter((n) => n.includes('(conflict'));
  assert.equal(copies.length, 1);
  assert.match(await web.read(copies[0]), /ONE \(app loses\)/);
  assert.ok(notices.some((n) => /conflict/.test(n)));

  // Renamed here → renamed on the server (not a delete plus a new file).
  await vault._rename('Server/from-native.md', 'Server/renamed.md');
  await waitFor(async () => (await web.read('renamed.md')) === 'hello from the app\n' && (await web.read('from-native.md')) === null);

  // Deleted here → into the server vault's .trash, not gone.
  await vault.trash(vault.getAbstractFileByPath('Server/renamed.md'));
  await waitFor(async () => (await web.read('renamed.md')) === null);
  assert.equal(await web.read('.trash/renamed.md'), 'hello from the app\n');

  // Deleted in the browser → removed here.
  await web.unlink('existing.md');
  await waitFor(() => vault.getAbstractFileByPath('Server/existing.md') === null);

  // Nothing left to do, and a full re-check agrees.
  await linkSync.queue;
  await linkSync.reconcile('');
  const tree = (await fsp.readdir(serverVaultDir)).filter((n) => !n.startsWith('.')).sort();
  const here = vault.getAllLoadedFiles().filter((f) => f instanceof TFile && f.path.startsWith('Server/') && !f.path.slice(7).includes('/'))
    .map((f) => f.path.slice(7)).sort();
  assert.deepEqual(here, tree.filter((n) => n.endsWith('.md')));
});

test('configSynced: which parts of .obsidian are synced', () => {
  const sys = ['markport-clipper', 'markport-share'];
  assert.ok(H.configSynced('.obsidian/app.json', sys, 'markport-sync'));
  assert.ok(H.configSynced('.obsidian/plugins/dataview/main.js', sys, 'markport-sync'));
  assert.ok(H.configSynced('.obsidian/themes/Minimal/theme.css', sys, 'markport-sync'));
  assert.ok(H.configSynced('.obsidian/plugins/markport-clipper/data.json', sys, 'markport-sync'), 'system plugin settings sync');
  assert.ok(!H.configSynced('.obsidian/plugins/markport-clipper/main.js', sys, 'markport-sync'), 'system plugin code does not');
  assert.ok(!H.configSynced('.obsidian/plugins/markport-sync/data.json', sys, 'markport-sync'), 'own token and links stay here');
  assert.ok(!H.configSynced('.obsidian/workspace.json', sys, 'markport-sync'));
  assert.ok(!H.configSynced('.obsidian/workspace-mobile.json', sys, 'markport-sync'));
  assert.ok(!H.configSynced('.obsidian/plugins/x/.git/HEAD', sys, 'markport-sync'));
  assert.ok(!H.configSynced('notes/app.json', sys, 'markport-sync'));
  assert.equal(H.systemCodeId('.obsidian/plugins/markport-clipper/main.js', sys), 'markport-clipper');
  assert.equal(H.systemCodeId('.obsidian/plugins/markport-clipper/data.json', sys), null, 'settings sync both ways instead');
  assert.equal(H.systemCodeId('.obsidian/plugins/dataview/main.js', sys), null);
  assert.equal(H.systemCodeId('.obsidian/plugins/markport-share/.hidden', sys), null);
  const enc = (v) => new TextEncoder().encode(JSON.stringify(v)).buffer;
  const dec = (b) => JSON.parse(new TextDecoder().decode(b));
  assert.deepEqual(dec(H.communityForServer(enc(['dataview', 'markport-clipper']), sys)), ['dataview']);
  assert.deepEqual(dec(H.communityForHere(enc(['dataview', 'tasks', 'markport-share']), enc(['markport-clipper', 'old']), sys)),
    ['dataview', 'tasks', 'markport-clipper']);
  assert.ok(H.sameIdLists(enc(['a', 'markport-clipper']), enc(['a']), sys));
  assert.ok(!H.sameIdLists(enc(['a']), enc(['b']), sys));
});

test('settings and plugins sync with the server vault when the option is on', async (t) => {
  const { vault, web, plugin, linkSync, serverVaultDir } = await setup(t, {
    folder: '',
    settings: { syncConfig: true },
    serverFiles: {
      '.obsidian/app.json': '{"server":true}',
      '.obsidian/workspace.json': '{"layout":"server"}',
      '.obsidian/plugins/tasks/main.js': 'tasks code from the server',
    },
    localConfig: {
      '.obsidian/app.json': '{"local":true}',
      '.obsidian/workspace.json': '{"layout":"here"}',
      '.obsidian/community-plugins.json': '["dataview","markport-clipper"]',
      '.obsidian/plugins/dataview/main.js': 'dataview code',
      '.obsidian/plugins/markport-clipper/main.js': 'clipper code here',
      '.obsidian/plugins/markport-clipper/data.json': '{"library":{}}',
      '.obsidian/plugins/markport-sync/data.json': '{"token":"secret"}',
    },
  });
  const server = (rel) => fsp.readFile(path.join(serverVaultDir, rel), 'utf8').catch(() => null);
  await linkSync.queue;

  // First sync: this device's copy wins where both had one; the server's is in its trash.
  assert.equal(await server('.obsidian/app.json'), '{"local":true}');
  assert.equal(await server('.trash/.obsidian/app.json'), '{"server":true}');
  assert.equal(await server('.obsidian/plugins/dataview/main.js'), 'dataview code');
  assert.equal(vault._config('.obsidian/plugins/tasks/main.js'), 'tasks code from the server');
  // The window layout and this plugin's own settings stay on each side.
  assert.equal(await server('.obsidian/workspace.json'), '{"layout":"server"}');
  assert.equal(vault._config('.obsidian/workspace.json'), '{"layout":"here"}');
  assert.equal(await server('.obsidian/plugins/markport-sync/data.json'), null);
  // Markport's own plugins: their settings travel both ways, their code
  // only from the server - this device's old copy is replaced, never uploaded.
  assert.equal(await server('.obsidian/plugins/markport-clipper/data.json'), '{"library":{}}');
  assert.equal(await server('.obsidian/plugins/markport-clipper/main.js'), null);
  assert.equal(vault._config('.obsidian/plugins/markport-clipper/main.js'), await repoPlugin('markport-clipper/main.js'));
  assert.deepEqual(JSON.parse(await server('.obsidian/community-plugins.json')), ['dataview']);

  // Changed in Markport: arrives here on the next full comparison. The
  // system plugin this device had on stays on.
  await web.write('.obsidian/app.json', '{"web":2}');
  await web.write('.obsidian/community-plugins.json', '["dataview","tasks"]');
  notices.length = 0;
  plugin.lastConfigNotice = 0;   // at most one reload notice every 10 s
  await linkSync.run('full', () => linkSync.reconcile(''));
  assert.equal(vault._config('.obsidian/app.json'), '{"web":2}');
  assert.deepEqual(JSON.parse(vault._config('.obsidian/community-plugins.json')), ['dataview', 'tasks', 'markport-clipper']);
  assert.ok(notices.some((n) => /reload Obsidian/.test(n)));

  // Changed here: sent a few seconds later, without waiting for the full check.
  await vault._writeConfig('.obsidian/hotkeys.json', '{"editor:save":[]}');
  await waitFor(async () => (await server('.obsidian/hotkeys.json')) === '{"editor:save":[]}', 10000);

  // Removed here: into the server vault's trash.
  await vault.adapter.trashLocal('.obsidian/plugins/dataview/main.js');
  await linkSync.run('full', () => linkSync.reconcile(''));
  assert.equal(await server('.obsidian/plugins/dataview/main.js'), null);
  assert.equal(await server('.trash/.obsidian/plugins/dataview/main.js'), 'dataview code');
});

test('Markport\'s own plugins are installed on a new device and kept up to date', async (t) => {
  const enabled = [];
  const { vault, web, linkSync, serverVaultDir } = await setup(t, {
    folder: '',
    settings: { syncConfig: true },
    app: { plugins: { async loadManifests() {}, async enablePluginAndSave(id) { enabled.push(id); } } },
  });
  await linkSync.queue;
  // Markport's own plugins: the ones in src/plugins.
  const ids = (await fsp.readdir(repoPluginsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(ids.includes('markport-clipper') && ids.includes('markport-root-folder'));

  // A fresh vault gets every file of each, as the server serves it, and turns each on once.
  for (const id of ids) {
    for (const name of await fsp.readdir(path.join(repoPluginsDir, id))) {
      if (name.startsWith('.')) continue;
      assert.equal(vault._config('.obsidian/plugins/' + id + '/' + name), await repoPlugin(id + '/' + name), id + '/' + name);
    }
  }
  assert.deepEqual([...enabled].sort(), [...ids].sort());
  // Third-party plugins the server serves from vendor/plugins are left to each device.
  for (const id of require('../system-plugins').getSystemPluginIds()) {
    if (!ids.includes(id)) assert.equal(vault._config('.obsidian/plugins/' + id + '/manifest.json'), null, id);
  }
  // Nothing of it went into the server vault.
  assert.deepEqual(await fsp.readdir(path.join(serverVaultDir, '.obsidian', 'plugins')).catch(() => []), []);

  // Changed or removed here: put back. Uninstalled: back, but not turned on again.
  await vault._writeConfig('.obsidian/plugins/markport-root-folder/main.js', 'edited here');
  await vault.adapter.remove('.obsidian/plugins/markport-root-folder/manifest.json');
  await linkSync.run('full', () => linkSync.reconcile(''));
  assert.equal(vault._config('.obsidian/plugins/markport-root-folder/main.js'), await repoPlugin('markport-root-folder/main.js'));
  assert.equal(vault._config('.obsidian/plugins/markport-root-folder/manifest.json'), await repoPlugin('markport-root-folder/manifest.json'));
  assert.equal(enabled.filter((id) => id === 'markport-root-folder').length, 1);
  assert.equal(await web.read('.obsidian/plugins/markport-root-folder/main.js'), null);
});

test('settings and plugins stay apart unless the option is on', async (t) => {
  const { vault, linkSync, serverVaultDir } = await setup(t, {
    folder: '',
    serverFiles: { '.obsidian/app.json': '{"server":true}' },
    localConfig: { '.obsidian/app.json': '{"local":true}', '.obsidian/plugins/dataview/main.js': 'x' },
  });
  await linkSync.queue;
  assert.equal(await fsp.readFile(path.join(serverVaultDir, '.obsidian/app.json'), 'utf8'), '{"server":true}');
  assert.equal(vault._config('.obsidian/app.json'), '{"local":true}');
  assert.equal(await fsp.readFile(path.join(serverVaultDir, '.obsidian/plugins/dataview/main.js'), 'utf8').catch(() => null), null);
});

test('an unknown vault on the server never reads as "everything was deleted"', async (t) => {
  const { vault, linkSync } = await setup(t);
  assert.ok(vault.getAbstractFileByPath('Server/existing.md'));
  linkSync.vaultId = 'no-such-vault';
  await linkSync.run('check', () => linkSync.syncPath('existing.md'));
  await linkSync.run('full', () => linkSync.reconcile(''));
  assert.ok(vault.getAbstractFileByPath('Server/existing.md'), 'the local copy is still there');
});

test('markport-sync shares a synced note or folder, scoped like the web app', async (t) => {
  const { vault, plugin } = await setup(t);
  const base = plugin.settings.serverUrl;
  await vault.createFolder('Server/Projects');
  await vault._write('Server/Projects/Plan.md', 'the plan\n');
  await vault._write('Server/Private.md', 'keep out\n');
  await waitFor(async () => (await fetch(base + '/api/fs/stat?vault=' + plugin.settings.links[0].vaultId + '&path=Projects/Plan.md',
    { headers: { 'X-Markport-Token': plugin.settings.token } })).status === 200);

  // Not in a linked folder, or not synced: no share.
  assert.equal(plugin.shareTargetFor(new TFile('Elsewhere/x.md')), null);
  await assert.rejects(plugin.createShare(new TFile('Server/never-synced.md'), { permission: 'view' }), /isn't on the server yet/);

  // A note: the share is made for its path inside the server vault.
  const note = await plugin.createShare(vault.getAbstractFileByPath('Server/Projects/Plan.md'), { permission: 'view' });
  assert.equal(note.path, 'Projects/Plan.md');
  assert.equal(plugin.shareLocalPath(note), 'Server/Projects/Plan.md');
  assert.match(plugin.shareUrl(note), new RegExp('^' + base + '/s/[0-9a-f]{32}$'));
  const page = await fetch(plugin.shareUrl(note));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /the plan/);
  assert.doesNotMatch(html, /keep out/);

  // A folder, with edit and a password: the recipient gets only that folder.
  const folder = await plugin.createShare(vault.getAbstractFileByPath('Server/Projects'), { permission: 'edit', password: 'guest' });
  assert.equal(folder.path, 'Projects');
  assert.equal(folder.hasPassword, true);

  // Custom links: set at creation, renamed, removed.
  const named = await plugin.createShare(vault.getAbstractFileByPath('Server/Projects/Plan.md'), { permission: 'view', slug: 'The Plan' });
  assert.equal(plugin.shareUrl(named), base + '/s/the-plan');
  assert.match(await (await fetch(base + '/s/the-plan')).text(), /the plan/);
  const renamed = await plugin.setShareSlug(named.id, 'plan-v2');
  assert.equal(plugin.shareUrl(renamed), base + '/s/plan-v2');
  assert.equal((await fetch(base + '/s/the-plan')).status, 404);
  const plain = await plugin.setShareSlug(named.id, null);
  assert.equal(plugin.shareUrl(plain), base + '/s/' + named.id);
  await assert.rejects(plugin.createShare(vault.getAbstractFileByPath('Server/Projects/Plan.md'), { permission: 'view', slug: 'x' }), /3-64 characters/);
  await plugin.revokeShare(named.id);
  assert.equal((await fetch(plugin.shareUrl(folder), { redirect: 'manual' })).status, 401);

  const listed = await plugin.listShares(plugin.settings.links[0].vaultId);
  assert.deepEqual(listed.shares.map((s) => s.id).sort(), [note.id, folder.id].sort());

  await plugin.revokeShare(note.id);
  assert.equal((await fetch(plugin.shareUrl(note))).status, 404);

  // Signed out (no token): the server refuses to make or list shares.
  plugin.settings.token = '';
  await assert.rejects(plugin.listShares(null), (err) => err.status === 401);
});
