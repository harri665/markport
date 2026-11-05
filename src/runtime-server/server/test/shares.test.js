/**
 * Sharing: owner login, share-link scoping, static share pages.
 *
 * The security property under test: a share link reaches exactly the shared
 * note or folder (plus attachments its notes embed, read-only) and nothing
 * else - not sibling files, not other vaults, not the owner's settings or
 * plugins, not the owner-only APIs.
 */

const assert = require('assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createApp } = require('../index');

const PASSWORD = 'owner-secret';

async function start(t, { password = PASSWORD } = {}) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'markport-shares-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const vaults = path.join(tmp, 'vaults');
  const main = path.join(vaults, 'Main');
  const write = async (rel, data) => {
    const abs = path.join(main, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data);
  };
  await write('Projects/Alpha/Plan.md', '# Plan\n\nSee [[Notes]] and [[Secret]].\n\n![[diagram.png]]\n\n<script>alert(1)</script><img src=x onerror="alert(2)">\n\n> [!tip] Heads up\n> Callout body\n\n- [x] done\n- [ ] todo\n\n==marked== #tag\n');
  await write('Projects/Alpha/Notes.md', 'Alpha notes');
  await write('Projects/Alpha/Sub/Deep.md', 'deep');
  await write('Projects/Beta.md', 'beta, sibling of Alpha');
  await write('Secret.md', 'top secret');
  await write('attachments/diagram.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await write('attachments/unrelated.png', Buffer.from([1, 2, 3]));
  await write('.obsidian/app.json', '{"owner":true}');
  await write('.obsidian/appearance.json', '{"cssTheme":"Neat","accentColor":"#ff0000"}');
  await write('.obsidian/themes/Neat/theme.css', 'body{--neat:1}');
  await write('.obsidian/plugins/evil/main.js', 'owner plugin');
  await fsp.mkdir(path.join(vaults, 'Other'), { recursive: true });
  await fsp.writeFile(path.join(vaults, 'Other', 'other.md'), 'other vault');

  const app = createApp({
    registryPath: path.join(tmp, 'data', 'registry.json'),
    vaultPath: main,
    vaultsDir: vaults,
    ownerPassword: password,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ids = app.locals.vaultRegistry.list();
  const vaultId = Object.keys(ids).find((id) => path.basename(ids[id].path) === 'Main');
  const otherVaultId = Object.keys(ids).find((id) => path.basename(ids[id].path) === 'Other');
  return { tmp, main, base, app, vaultId, otherVaultId };
}

// Minimal cookie jar per "browser".
function client(base) {
  const jar = new Map();
  async function req(url, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ');
    const res = await fetch(base + url, Object.assign({}, opts, { headers, redirect: 'manual' }));
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/Max-Age=0/.test(c) || !v) jar.delete(k); else jar.set(k, v);
    }
    return res;
  }
  return {
    jar,
    get: (url) => req(url),
    json: (method, url, body) => req(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    form: (url, fields) => req(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }),
    put: (url, body) => req(url, { method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body }),
    del: (url) => req(url, { method: 'DELETE' }),
  };
}

async function owner(base) {
  const c = client(base);
  const res = await c.form('/login', { password: PASSWORD, next: '/' });
  assert.equal(res.status, 303);
  return c;
}

async function createShare(ownerClient, body) {
  const res = await ownerClient.json('POST', '/api/shares', body);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).share;
}

const enc = encodeURIComponent;

test('without the owner password nothing but the login is reachable', async (t) => {
  const { base, vaultId } = await start(t);
  const anon = client(base);
  assert.equal((await anon.get('/')).status, 303);
  assert.match((await anon.get('/')).headers.get('location'), /^\/login/);
  assert.equal((await anon.get('/vault/' + vaultId)).status, 303);
  assert.equal((await anon.get('/api/fs/read?vault=' + vaultId + '&path=Secret.md&encoding=utf8')).status, 401);
  assert.equal((await anon.get('/api/fs/readdir?vault=' + vaultId + '&path=')).status, 401);
  assert.equal((await anon.get('/api/bootstrap?vault=' + vaultId)).status, 401);
  assert.equal((await anon.json('POST', '/api/proxy-request', { url: 'https://github.com/' })).status, 401);
  assert.equal((await anon.json('POST', '/api/shares', { vault: vaultId, path: 'Secret.md', permission: 'edit' })).status, 401);
  assert.deepEqual(await (await anon.get('/api/vaults/list')).json(), {});

  const bad = await anon.form('/login', { password: 'nope' });
  assert.equal(bad.status, 401);

  const me = await owner(base);
  const read = await me.get('/api/fs/read?vault=' + vaultId + '&path=Secret.md&encoding=utf8');
  assert.equal(await read.text(), 'top secret');
  assert.ok(Object.keys(await (await me.get('/api/vaults/list')).json()).includes(vaultId));
});

test('a folder share reaches only that folder', async (t) => {
  const { base, main, vaultId, otherVaultId } = await start(t);
  const me = await owner(base);
  const share = await createShare(me, { vault: vaultId, path: 'Projects/Alpha', permission: 'edit' });
  const fsUrl = (op, p, extra = '') => '/api/fs/' + op + '?vault=' + share.id + '&path=' + enc(p) + extra;

  const guest = client(base);
  // No grant yet: the share vault is closed.
  assert.equal((await guest.get(fsUrl('readdir', ''))).status, 401);
  // Opening the link grants access.
  const page = await guest.get('/s/' + share.id);
  assert.equal(page.status, 200);

  const names = (await (await guest.get(fsUrl('readdir', ''))).json()).map((e) => e.name).sort();
  assert.deepEqual(names, ['.obsidian', 'Linked files', 'Notes.md', 'Plan.md', 'Sub'].sort());
  assert.equal(await (await guest.get(fsUrl('read', 'Notes.md', '&encoding=utf8'))).text(), 'Alpha notes');
  assert.equal(await (await guest.get(fsUrl('read', 'Sub/Deep.md', '&encoding=utf8'))).text(), 'deep');

  // Escapes.
  for (const p of ['../Beta.md', '../../Secret.md', 'Sub/../../Beta.md', '/../../Secret.md', '..\\..\\Secret.md']) {
    const res = await guest.get(fsUrl('read', p, '&encoding=utf8'));
    assert.ok(res.status === 403 || res.status === 404, p + ' → ' + res.status);
    assert.doesNotMatch(await res.text(), /top secret|beta, sibling/);
  }
  // The owner's real vault and other vaults stay closed to the guest.
  assert.equal((await guest.get('/api/fs/read?vault=' + vaultId + '&path=Secret.md&encoding=utf8')).status, 401);
  assert.equal((await guest.get('/api/fs/read?vault=' + otherVaultId + '&path=other.md&encoding=utf8')).status, 401);
  assert.equal((await guest.get('/api/fs/read?path=Secret.md&encoding=utf8')).status, 401);
  assert.deepEqual(Object.keys(await (await guest.get('/api/vaults/list')).json()), [share.id]);

  // Settings: private per share; the owner's plugins are invisible.
  assert.equal((await guest.get(fsUrl('read', '.obsidian/app.json', '&encoding=utf8'))).status, 200);
  assert.doesNotMatch(await (await guest.get(fsUrl('read', '.obsidian/app.json', '&encoding=utf8'))).text(), /owner/);
  assert.equal((await guest.get(fsUrl('read', '.obsidian/plugins/evil/main.js', '&encoding=utf8'))).status, 404);
  assert.equal((await guest.put(fsUrl('write', '.obsidian/plugins/x/main.js', '&encoding=utf8'), 'code')).status, 403);
  assert.equal((await guest.put(fsUrl('write', '.obsidian/community-plugins.json', '&encoding=utf8'), '["x"]')).status, 403);
  // ...but the owner's theme is visible, read-only.
  assert.equal(await (await guest.get(fsUrl('read', '.obsidian/themes/Neat/theme.css', '&encoding=utf8'))).text(), 'body{--neat:1}');
  // Obsidian's startup write of appearance.json is accepted and dropped.
  assert.equal((await guest.put(fsUrl('write', '.obsidian/appearance.json', '&encoding=utf8'), '{}')).status, 200);
  assert.match(fs.readFileSync(path.join(main, '.obsidian', 'appearance.json'), 'utf8'), /Neat/);
  assert.equal((await guest.put(fsUrl('write', '.obsidian/themes/Neat/theme.css', '&encoding=utf8'), 'x')).status, 403);
  assert.equal((await guest.put(fsUrl('write', '.obsidian/workspace.json', '&encoding=utf8'), '{}')).status, 200);

  // Writes: inside yes, outside no.
  assert.equal((await guest.put(fsUrl('write', 'New.md', '&encoding=utf8'), 'hello')).status, 200);
  assert.equal(await (await me.get('/api/fs/read?vault=' + vaultId + '&path=Projects/Alpha/New.md&encoding=utf8')).text(), 'hello');
  assert.equal((await guest.put(fsUrl('write', '../Escaped.md', '&encoding=utf8'), 'x')).status, 403);
  assert.equal((await guest.json('POST', '/api/fs/rename', { vault: share.id, oldPath: 'Notes.md', newPath: '../Notes.md' })).status, 403);
  assert.equal((await guest.json('POST', '/api/fs/copy', { vault: share.id, src: '../../Secret.md', dest: 'Stolen.md' })).status, 403);
  assert.ok(!fs.existsSync(path.join(main, 'Projects', 'Escaped.md')));
  assert.ok(!fs.existsSync(path.join(main, 'Projects', 'Alpha', 'Stolen.md')));

  // Linked attachments are readable, other files in their folder are not.
  assert.equal((await guest.get(fsUrl('read', 'Linked files/diagram.png'))).status, 200);
  assert.equal((await guest.get(fsUrl('read', 'Linked files/unrelated.png'))).status, 404);
  assert.equal((await guest.put(fsUrl('write', 'Linked files/diagram.png'), 'x')).status, 403);

  // Deletions go to the share's own trash, outside the vault.
  assert.equal((await guest.json('POST', '/api/fs/rename', { vault: share.id, oldPath: 'New.md', newPath: '.trash/New.md' })).status, 200);
  assert.equal((await me.get('/api/fs/stat?vault=' + vaultId + '&path=Projects/Alpha/New.md')).status, 404);
  assert.equal((await me.get('/api/fs/stat?vault=' + vaultId + '&path=.trash/New.md')).status, 404);
});

test('a note share reaches only that note', async (t) => {
  const { base, vaultId } = await start(t);
  const me = await owner(base);
  const share = await createShare(me, { vault: vaultId, path: 'Projects/Alpha/Plan.md', permission: 'edit' });
  const fsUrl = (op, p, extra = '') => '/api/fs/' + op + '?vault=' + share.id + '&path=' + enc(p) + extra;
  const guest = client(base);
  await guest.get('/s/' + share.id);

  const names = (await (await guest.get(fsUrl('readdir', ''))).json()).map((e) => e.name).sort();
  assert.deepEqual(names, ['.obsidian', 'Linked files', 'Plan.md'].sort());
  assert.equal((await guest.get(fsUrl('read', 'Notes.md', '&encoding=utf8'))).status, 404);
  assert.equal((await guest.get(fsUrl('readdir', 'Sub'))).status, 404);
  assert.equal((await guest.put(fsUrl('write', 'Plan.md', '&encoding=utf8'), 'edited')).status, 200);
  assert.equal(await (await me.get('/api/fs/read?vault=' + vaultId + '&path=Projects/Alpha/Plan.md&encoding=utf8')).text(), 'edited');
  assert.equal((await guest.put(fsUrl('write', 'Other.md', '&encoding=utf8'), 'x')).status, 403);
  assert.equal((await guest.del(fsUrl('unlink', 'Plan.md'))).status, 403);
  assert.equal((await guest.json('POST', '/api/fs/rename', { vault: share.id, oldPath: 'Plan.md', newPath: 'Renamed.md' })).status, 403);
});

test('view-only shares cannot write and have no editor', async (t) => {
  const { base, vaultId } = await start(t);
  const me = await owner(base);
  const share = await createShare(me, { vault: vaultId, path: 'Projects/Alpha', permission: 'view' });
  const guest = client(base);
  const page = await guest.get('/s/' + share.id);
  assert.doesNotMatch(await page.text(), /Open in editor/);
  assert.equal((await guest.put('/api/fs/write?vault=' + share.id + '&path=Notes.md&encoding=utf8', 'x')).status, 403);
  assert.equal((await guest.put('/api/fs/write?vault=' + share.id + '&path=.obsidian/workspace.json&encoding=utf8', 'x')).status, 403);
  const editor = await guest.get('/vault/' + share.id);
  assert.equal(editor.status, 303);
  assert.match(editor.headers.get('location'), new RegExp('^/s/' + share.id));
  assert.deepEqual(await (await guest.get('/api/vaults/list')).json(), {});
});

test('password, expiry and revocation', async (t) => {
  const { base, vaultId, app } = await start(t);
  const me = await owner(base);
  const share = await createShare(me, { vault: vaultId, path: 'Projects/Alpha', permission: 'edit', password: 'letmein' });
  assert.equal(share.hasPassword, true);
  const guest = client(base);

  const locked = await guest.get('/s/' + share.id);
  assert.equal(locked.status, 401);
  assert.match(await locked.text(), /Password required/);
  assert.equal((await guest.get('/api/fs/readdir?vault=' + share.id + '&path=')).status, 401);
  assert.equal((await guest.get('/s/' + share.id + '/raw/Notes.md')).status, 401);

  assert.equal((await guest.form('/s/' + share.id + '/unlock', { password: 'wrong', next: '/s/' + share.id })).status, 401);
  const ok = await guest.form('/s/' + share.id + '/unlock', { password: 'letmein', next: 'https://evil.example/' });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/s/' + share.id);   // no open redirect
  assert.equal((await guest.get('/api/fs/readdir?vault=' + share.id + '&path=')).status, 200);
  // The editor opens straight away now.
  assert.equal((await guest.get('/vault/' + share.id)).status, 200);

  // Expiry.
  app.locals.sharing.shares.shares[share.id].expiresAt = Date.now() - 1000;
  assert.equal((await guest.get('/s/' + share.id)).status, 410);
  assert.equal((await guest.get('/api/fs/readdir?vault=' + share.id + '&path=')).status, 410);
  app.locals.sharing.shares.shares[share.id].expiresAt = null;

  // Revocation.
  assert.equal((await me.del('/api/shares/' + share.id)).status, 200);
  assert.equal((await guest.get('/s/' + share.id)).status, 404);
  assert.equal((await guest.get('/api/fs/readdir?vault=' + share.id + '&path=')).status, 401);
});

test('the static page renders Obsidian markdown and links only inside the share', async (t) => {
  const { base, vaultId } = await start(t);
  const me = await owner(base);
  const share = await createShare(me, { vault: vaultId, path: 'Projects/Alpha', permission: 'edit' });
  const guest = client(base);
  const res = await guest.get('/s/' + share.id + '/n/Plan.md');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.doesNotMatch(res.headers.get('content-security-policy'), /script-src/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const html = await res.text();
  assert.match(html, new RegExp('<a class="internal-link" href="/s/' + share.id + '/n/Notes.md">Notes</a>'));
  assert.match(html, /<span class="internal-link is-unresolved">Secret<\/span>/);
  assert.match(html, new RegExp('src="/s/' + share.id + '/raw/Linked%20files/diagram.png"'));
  assert.match(html, /class="callout" data-callout="tip"/);
  assert.match(html, /task-list-item is-checked/);
  assert.match(html, /<mark>marked<\/mark>/);
  assert.match(html, /<a class="tag">#tag<\/a>/);
  assert.doesNotMatch(html, /<script|onerror|alert\(/);
  assert.doesNotMatch(html, /top secret|beta, sibling|Projects/);
  assert.match(html, /Open in editor/);
  assert.match(html, new RegExp('/s/' + share.id + '/theme.css'));

  const img = await guest.get('/s/' + share.id + '/raw/Linked%20files/diagram.png');
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await guest.get('/s/' + share.id + '/raw/Linked%20files/unrelated.png')).status, 404);
  const escape = await guest.get('/s/' + share.id + '/raw/..%2F..%2FSecret.md');
  assert.ok(escape.status === 403 || escape.status === 404, String(escape.status));
  assert.doesNotMatch(await escape.text(), /top secret/);
  assert.equal((await guest.get('/s/' + share.id + '/n/..%2F..%2FSecret.md')).status, 404);
  assert.equal(await (await guest.get('/s/' + share.id + '/theme.css')).text(), '/* themes/Neat/theme.css */\nbody{--neat:1}');

  const edit = await guest.get('/s/' + share.id + '/edit?note=Plan.md');
  assert.equal(edit.status, 303);
  assert.equal(edit.headers.get('location'), '/vault/' + share.id + '/Plan.md');
});

test('the share follows an owner rename, and bootstrap never covers the vault', async (t) => {
  const { base, vaultId } = await start(t);
  const me = await owner(base);
  const share = await createShare(me, { vault: vaultId, path: 'Projects/Alpha', permission: 'edit' });
  const mv = await me.json('POST', '/api/fs/rename', { vault: vaultId, oldPath: 'Projects', newPath: 'Work' });
  assert.equal(mv.status, 200);
  const list = await (await me.get('/api/shares?vault=' + vaultId)).json();
  assert.equal(list.shares[0].path, 'Work/Alpha');

  const guest = client(base);
  assert.equal((await guest.get('/s/' + share.id)).status, 200);
  const boot = await (await guest.get('/api/bootstrap?vault=' + share.id + '&full=1')).json();
  assert.equal(boot.disabled, true);
  assert.deepEqual(Object.keys(boot.electron['vault-list']), [share.id]);
  assert.deepEqual(boot.dirs[''].map((e) => e.name).sort(), ['Linked files', 'Notes.md', 'Plan.md', 'Sub']);
  assert.deepEqual(boot.dirs['Sub'].map((e) => e.name), ['Deep.md']);
  // Parent folders before their contents (the client relies on key order).
  const keys = Object.keys(boot.dirs);
  assert.ok(keys.indexOf('') < keys.indexOf('Sub'));
  assert.deepEqual(boot.dirs['Linked files'].map((e) => e.name), ['diagram.png']);
  assert.ok(!boot.dirs[''].some((e) => e.name.startsWith('.')));
  assert.doesNotMatch(JSON.stringify(boot), /Main|vaults/);
});

test('a symlink inside a shared folder cannot reach outside it', async (t) => {
  const { base, vaultId, main } = await start(t);
  try {
    await fsp.symlink(path.join(main, 'Secret.md'), path.join(main, 'Projects', 'Alpha', 'link.md'));
  } catch (err) {
    t.skip('symlinks not available here: ' + err.code);
    return;
  }
  const me = await owner(base);
  const share = await createShare(me, { vault: vaultId, path: 'Projects/Alpha', permission: 'edit' });
  const guest = client(base);
  await guest.get('/s/' + share.id);
  const res = await guest.get('/api/fs/read?vault=' + share.id + '&path=link.md&encoding=utf8');
  assert.equal(res.status, 403);
  assert.doesNotMatch(await res.text(), /top secret/);
});

test('without MARKPORT_PASSWORD the app stays open but shares are still scoped', async (t) => {
  const { base, vaultId } = await start(t, { password: '' });
  const anyone = client(base);
  assert.equal((await anyone.get('/api/fs/read?vault=' + vaultId + '&path=Secret.md&encoding=utf8')).status, 200);
  const share = await createShare(anyone, { vault: vaultId, path: 'Projects/Alpha/Notes.md', permission: 'view' });
  const guest = client(base);
  await guest.get('/s/' + share.id);
  assert.equal((await guest.get('/api/fs/read?vault=' + share.id + '&path=../../Secret.md&encoding=utf8')).status, 403);
  const listed = await (await anyone.get('/api/shares?vault=' + vaultId)).json();
  assert.equal(listed.authEnabled, false);
});
