const assert = require('assert/strict');
const fsp = require('fs').promises;
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const WebSocket = require('ws');

const { createApp } = require('../index');
const attachWatchServer = require('../api/watch');
const { attachNodeBridgeProcServer } = require('../api/node-bridge');

async function start(t, nodeBridge) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'markport-bridge-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const vaultPath = path.join(tmp, 'vault');
  await fsp.mkdir(vaultPath);
  const app = createApp({
    clientPath: path.join(tmp, 'client'), obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'registry.json'), vaultPath, vaultsDir: null, nodeBridge,
  });
  const server = http.createServer(app);
  attachWatchServer(server, app.locals.vaultRegistry, vaultPath);
  attachNodeBridgeProcServer(server, nodeBridge);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }));
  const host = `127.0.0.1:${server.address().port}`;
  return { tmp, vaultPath, host, base: `http://${host}`, registry: app.locals.vaultRegistry };
}

function call(base, mod, fn, args, headers) {
  return fetch(base + '/api/node-bridge/call', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'X-Markport-Bridge': '1' }, headers),
    body: JSON.stringify({ mod, fn, args }),
  });
}

test('bridge is off unless enabled', async (t) => {
  const { base } = await start(t, false);
  assert.deepEqual(await (await fetch(base + '/api/node-bridge/info')).json(), { enabled: false });
  assert.equal((await call(base, 'fs', 'existsSync', ['/'])).status, 404);
});

test('calls need the bridge header and a same-origin Origin', async (t) => {
  const { base } = await start(t, true);
  const noHeader = await fetch(base + '/api/node-bridge/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mod: 'fs', fn: 'existsSync', args: ['/'] }),
  });
  assert.equal(noHeader.status, 403);
  assert.equal((await call(base, 'fs', 'existsSync', ['/'], { Origin: 'https://evil.example' })).status, 403);
});

test('info reports os/env and the vault path, without secrets', async (t) => {
  process.env.MARKPORT_TEST_SECRET = 'nope';
  t.after(() => delete process.env.MARKPORT_TEST_SECRET);
  const { base, registry, vaultPath } = await start(t, true);
  const { id } = registry.open(vaultPath, false);
  const info = await (await fetch(base + '/api/node-bridge/info?vault=' + id)).json();
  assert.equal(info.enabled, true);
  assert.equal(info.vaultPath, vaultPath);
  assert.equal(info.os.homedir, os.homedir());
  assert.equal(info.env.MARKPORT_TEST_SECRET, undefined);
});

test('fs round-trips buffers, stats, dirents and errors', async (t) => {
  const { base, tmp } = await start(t, true);
  const file = path.join(tmp, 'a.bin');
  const bytes = Buffer.from([0, 1, 2, 250, 255]);
  let r = await (await call(base, 'fs', 'writeFileSync', [file, { $b: bytes.toString('base64') }])).json();
  assert.deepEqual(r, { ok: { $u: 1 } });

  r = await (await call(base, 'fs.promises', 'readFile', [file])).json();
  assert.equal(Buffer.from(r.ok.$b, 'base64').compare(bytes), 0);

  r = await (await call(base, 'fs', 'statSync', [file])).json();
  assert.equal(r.ok.$stat.t, 'f');
  assert.equal(r.ok.$stat.size, 5);

  r = await (await call(base, 'fs', 'readdirSync', [tmp, { withFileTypes: true }])).json();
  assert.ok(r.ok.some((d) => d.$dirent && d.$dirent.name === 'a.bin' && d.$dirent.t === 'f'));

  r = await (await call(base, 'fs', 'readFileSync', [path.join(tmp, 'missing')])).json();
  assert.equal(r.err.$e.code, 'ENOENT');
});

test('stateful or unknown functions are refused', async (t) => {
  const { base } = await start(t, true);
  for (const [mod, fn] of [['fs', 'watch'], ['fs', 'createReadStream'], ['fs', 'constructor'], ['child_process', 'spawn'], ['net', 'connect']]) {
    assert.equal((await call(base, mod, fn, [])).status, 400, `${mod}.${fn}`);
  }
});

function procSocket(host, origin) {
  return new WebSocket(`ws://${host}/api/node-bridge/proc`, { headers: { Origin: origin || `http://${host}` } });
}

test('spawned processes stream stdin/stdout and report exit', async (t) => {
  const { host } = await start(t, true);
  const ws = procSocket(host);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const out = [];
  const exited = new Promise((resolve) => ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.op === 'stdout') out.push(Buffer.from(m.data, 'base64').toString());
    if (m.op === 'exit') resolve(m);
  }));
  ws.send(JSON.stringify({ op: 'spawn', id: 1, cmd: process.execPath, args: ['-e', 'process.stdin.on("data",d=>process.stdout.write("got:"+d));process.stdin.on("end",()=>process.exit(7))'] }));
  ws.send(JSON.stringify({ op: 'stdin', id: 1, data: Buffer.from('hello').toString('base64') }));
  ws.send(JSON.stringify({ op: 'end', id: 1 }));
  const exit = await exited;
  assert.equal(exit.code, 7);
  assert.equal(out.join(''), 'got:hello');
  ws.close();
});

test('cross-origin WebSocket is refused, /api/watch still upgrades', async (t) => {
  const { host } = await start(t, true);
  const bad = procSocket(host, 'https://evil.example');
  await assert.rejects(new Promise((r, j) => { bad.on('open', r); bad.on('error', j); }));
  const watch = new WebSocket(`ws://${host}/api/watch`);
  await new Promise((r, j) => { watch.on('open', r); watch.on('error', j); });
  watch.close();
});
