'use strict';

/**
 * Several sessions on one vault: changes made through /api/fs reach every
 * other session's /api/watch socket at once, but not the session that made
 * them, and disk's later report of the same change (chokidar) is not sent a
 * second time. Plus what the native plugin markport-sync relies on: API
 * tokens, /api/fs/tree, and write responses carrying mtime/size.
 */

const assert = require('assert/strict');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const WebSocket = require('ws');

const { createApp } = require('../index');
const attachWatchServer = require('../api/watch');

const PASSWORD = 'correct horse';

async function start(t) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'markport-live-'));
  const app = createApp({
    registryPath: path.join(tmp, 'registry.json'),
    vaultPath: path.join(tmp, 'default'),
    vaultsDir: path.join(tmp, 'vaults'),
    defaultVaultName: 'Notes',
    ownerPassword: PASSWORD,
  });
  const server = http.createServer(app);
  attachWatchServer(server, app.locals.vaultRegistry, path.join(tmp, 'default'), {
    isOwner: app.locals.auth.isOwner,
    shareTarget: app.locals.sharing.watchTarget,
    events: app.locals.vaultEvents,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const tokenRes = await fetch(baseUrl + '/api/auth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  const { token } = await tokenRes.json();
  const headers = { 'X-Markport-Token': token };
  const list = await (await fetch(baseUrl + '/api/vaults/list', { headers })).json();
  const vaultId = Object.keys(list)[0];
  const vaultDir = list[vaultId].path;

  function api(method, endpoint, query, body, contentType) {
    const qs = new URLSearchParams(Object.assign({ vault: vaultId }, query)).toString();
    const h = Object.assign({}, headers);
    if (contentType) h['Content-Type'] = contentType;
    return fetch(baseUrl + '/api/fs/' + endpoint + '?' + qs, { method, headers: h, body });
  }

  // A watch socket for one session, collecting what it is sent.
  async function session(client) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/watch?vault=${vaultId}&client=${client}`,
      ['markport', 'markport-token.' + token]);
    sockets.push(ws);
    const got = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await waitFor(() => got.some((m) => m.type === 'hello'));
    return { ws, got, changes: () => got.filter((m) => !['hello', 'ready'].includes(m.type)) };
  }

  return { baseUrl, token, headers, vaultId, vaultDir, api, session };
}

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('API tokens: issued for the password, accepted instead of the login cookie', async (t) => {
  const { baseUrl, headers } = await start(t);
  const wrong = await fetch(baseUrl + '/api/auth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }),
  });
  assert.equal(wrong.status, 401);
  // An owner-only route (anonymous /api/vaults/list is answered with the
  // share vaults the caller holds, so it can't tell the two apart).
  const url = baseUrl + '/api/vaults/storage';
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers })).status, 200);
  const bearer = { Authorization: 'Bearer ' + headers['X-Markport-Token'] };
  assert.equal((await fetch(url, { headers: bearer })).status, 200);
  const forged = '9999999999999.' + 'A'.repeat(43);
  assert.equal((await fetch(url, { headers: { 'X-Markport-Token': forged } })).status, 401);
  const status = await (await fetch(baseUrl + '/api/auth/status', { headers })).json();
  assert.equal(status.owner, true);
});

test('a write reaches the other sessions at once, not the writer, and only once', async (t) => {
  const { api, session } = await start(t);
  const a = await session('A');
  const b = await session('B');
  // Let chokidar finish its initial scan so it reports the write from disk too.
  await sleep(500);

  const res = await api('PUT', 'write', { path: 'note.md', encoding: 'utf8', client: 'A' }, 'hello', 'text/plain');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.size, 5);
  assert.equal(typeof body.mtime, 'number');

  await waitFor(() => b.changes().length > 0, 1000);
  assert.deepEqual(b.changes()[0], { type: 'add', path: 'note.md' });

  // Long enough for chokidar's awaitWriteFinish to report the same write.
  await sleep(1500);
  assert.deepEqual(a.changes(), [], 'the writer is not told about its own write');
  assert.equal(b.changes().length, 1, 'disk reporting the same write is not sent again');

  const stat = await (await api('GET', 'stat', { path: 'note.md' })).json();
  assert.equal(stat.mtime, body.mtime);
  assert.equal(stat.size, body.size);
});

test('a change made outside the API still reaches every session', async (t) => {
  const { vaultDir, session } = await start(t);
  const a = await session('A');
  await sleep(500);
  await fsp.writeFile(path.join(vaultDir, 'external.md'), 'from a shell');
  await waitFor(() => a.changes().some((m) => m.path === 'external.md'), 5000);
});

test('rename, folders and deletes are pushed too', async (t) => {
  const { api, session } = await start(t);
  const b = await session('B');
  const json = (o) => JSON.stringify(Object.assign({ client: 'A' }, o));
  await api('POST', 'mkdir', {}, json({ path: 'dir', recursive: true }), 'application/json');
  await api('PUT', 'write', { path: 'dir/x.md', encoding: 'utf8', client: 'A' }, 'x', 'text/plain');
  const r = await api('POST', 'rename', {}, json({ oldPath: 'dir/x.md', newPath: 'dir/y.md' }), 'application/json');
  assert.equal(r.status, 200);
  await waitFor(() => b.changes().some((m) => m.type === 'add' && m.path === 'dir/y.md'));
  const types = b.changes().map((m) => m.type + ' ' + m.path);
  assert.ok(types.includes('addDir dir'));
  assert.ok(types.includes('unlink dir/x.md'));

  // overwrite:false refuses to replace an existing target.
  await api('PUT', 'write', { path: 'dir/z.md', encoding: 'utf8', client: 'A' }, 'z', 'text/plain');
  const clash = await api('POST', 'rename', {}, json({ oldPath: 'dir/y.md', newPath: 'dir/z.md', overwrite: false }), 'application/json');
  assert.equal(clash.status, 409);

  // The web client sends rmdir as POST with a JSON body.
  const rm = await api('POST', 'rmdir', {}, json({ path: 'dir', recursive: true }), 'application/json');
  assert.equal(rm.status, 200);
  await waitFor(() => b.changes().some((m) => m.type === 'unlinkDir' && m.path === 'dir'));
  const root = await api('POST', 'rmdir', {}, json({ path: '', recursive: true }), 'application/json');
  assert.notEqual(root.status, 200, 'the vault root is never removed');
});

test('/api/fs/tree lists every file and folder, without hidden ones', async (t) => {
  const { api, vaultDir } = await start(t);
  await fsp.mkdir(path.join(vaultDir, 'a', 'b'), { recursive: true });
  await fsp.mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, 'a', 'b', 'n.md'), 'abc');
  await fsp.writeFile(path.join(vaultDir, '.obsidian', 'app.json'), '{}');
  await fsp.writeFile(path.join(vaultDir, 'a', '.hidden'), '');
  const tree = await (await api('GET', 'tree', {})).json();
  assert.deepEqual(tree.dirs.sort(), ['a', 'a/b']);
  assert.deepEqual(tree.files.map((f) => [f.path, f.size]), [['a/b/n.md', 3]]);
  const sub = await (await api('GET', 'tree', { path: 'a/b' })).json();
  assert.deepEqual(sub.files.map((f) => f.path), ['a/b/n.md']);
});

test('a buffered (coalesced) write is what stat, read and tree report', async (t) => {
  const { api } = await start(t);
  await api('PUT', 'write', { path: 'busy.md', encoding: 'utf8' }, 'one', 'text/plain');
  const second = await (await api('PUT', 'write', { path: 'busy.md', encoding: 'utf8' }, 'second', 'text/plain')).json();
  const stat = await (await api('GET', 'stat', { path: 'busy.md' })).json();
  assert.equal(stat.size, 6);
  assert.equal(stat.mtime, second.mtime);
  assert.equal(await (await api('GET', 'read', { path: 'busy.md', encoding: 'utf8' })).text(), 'second');
  const tree = await (await api('GET', 'tree', {})).json();
  assert.equal(tree.files.find((f) => f.path === 'busy.md').size, 6);
  // Deleting it drops the buffered write instead of letting it re-create the file.
  assert.equal((await api('DELETE', 'unlink', { path: 'busy.md' })).status, 200);
  assert.equal((await api('GET', 'stat', { path: 'busy.md' })).status, 404);
});

test('a watch socket without login or token is refused', async (t) => {
  const { baseUrl, vaultId } = await start(t);
  const ws = new WebSocket(baseUrl.replace('http', 'ws') + '/api/watch?vault=' + vaultId);
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  await new Promise((resolve) => ws.once('close', resolve));
  assert.equal(got[0].type, 'error');
});
