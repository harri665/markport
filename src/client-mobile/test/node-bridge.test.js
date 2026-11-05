'use strict';

/**
 * shims/node-bridge.js in a vm sandbox: fake XHR (the /info and /call
 * endpoints) and a fake WebSocket standing in for the server, real
 * TextEncoder/crypto/etc. from Node. Covers the pure-JS modules (Buffer,
 * events, stream, readline, crypto) against Node's own, and the
 * child_process/fs plumbing against the wire protocol of
 * runtime-server/server/api/node-bridge.js.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const test = require('node:test');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'shims', 'node-bridge.js'), 'utf8');

function sandbox(opts = {}) {
  const info = Object.assign({
    enabled: true, platform: 'linux', arch: 'x64', versions: { node: '22.0.0' }, execPath: '/usr/bin/node',
    cwd: '/app', pid: 1, env: { PATH: '/usr/bin', HOME: '/home/node' },
    os: { homedir: '/home/node', tmpdir: '/tmp', hostname: 'h', type: 'Linux', release: '6', EOL: '\n', arch: 'x64', platform: 'linux', cpus: 2, totalmem: 1, userInfo: null },
    vaultPath: '/data/vaults/Notes',
  }, opts.info);
  const calls = [];
  const sockets = [];
  class FakeXHR {
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send(body) {
      if (this.url.startsWith('/api/node-bridge/info')) { this.status = 200; this.responseText = JSON.stringify(info); return; }
      const req = JSON.parse(body);
      calls.push(req);
      const reply = (opts.onCall || (() => ({ ok: { $u: 1 } })))(req);
      this.status = 200; this.responseText = JSON.stringify(reply);
    }
  }
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send(s) { this.sent.push(JSON.parse(s)); }
    serverSends(m) { this.onmessage({ data: JSON.stringify(m) }); }
  }
  const win = {
    __owModules: { path: { join: (...p) => p.join('/'), sep: '/' }, util: {}, crypto: {} },
    __owVaultType: 'server', __owVaultId: 'v1', process: { versions: { electron: '30.0.0' }, env: {} },
    app: { vault: { adapter: { basePath: 'v1' } } },
    XMLHttpRequest: FakeXHR, WebSocket: FakeWS, location: { protocol: 'http:', host: 'x' },
    TextEncoder, TextDecoder, URL, URLSearchParams, btoa, atob, crypto: nodeCrypto.webcrypto, performance,
    setTimeout, clearTimeout, setInterval, clearInterval, console, Promise, Symbol, BigInt, Proxy,
    fetch: async (url, init) => {
      const req = JSON.parse(init.body); calls.push(req);
      const reply = (opts.onCall || (() => ({ ok: { $u: 1 } })))(req);
      return { status: 200, text: async () => JSON.stringify(reply) };
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win);
  win.__owInstallNodeBridge();
  return { win, m: win.__owModules, calls, sockets };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('not installed outside server mode or when the server says disabled', () => {
  const a = sandbox({ info: { enabled: false } });
  assert.equal(a.m.fs, undefined);
  const b = sandbox({ info: { platform: 'win32' } });
  assert.equal(b.m.fs, undefined);
});

test('Buffer matches Node for the encodings plugins use', () => {
  const { m } = sandbox();
  const B = m.buffer.Buffer;
  const s = 'héllo ✓ \u{1F600}';
  for (const enc of ['utf8', 'base64', 'hex', 'latin1', 'utf16le', 'base64url']) {
    assert.equal(B.from(s).toString(enc), Buffer.from(s).toString(enc), enc);
    const encoded = Buffer.from(s).toString(enc);
    assert.equal(B.from(encoded, enc).toString('hex'), Buffer.from(encoded, enc).toString('hex'), enc + ' decode');
  }
  assert.equal(B.concat([B.from('ab'), B.from('cd')]).toString(), 'abcd');
  assert.equal(B.byteLength('✓'), 3);
  assert.equal(B.isBuffer(B.from('x')), true);
  assert.equal(B.from('hello').subarray(1, 3).toString(), 'el');
  assert.equal(B.from('a,b').indexOf(','), 1);
});

test('crypto: synchronous sha256 and HMAC equal Node', () => {
  const { m } = sandbox();
  for (const input of ['', 'abc', 'x'.repeat(1000), '{"additionalInputs":[["hostnameCliPath",""]]}']) {
    assert.equal(m.crypto.createHash('sha256').update(input, 'utf8').digest('hex'), nodeCrypto.createHash('sha256').update(input).digest('hex'));
  }
  assert.equal(m.crypto.createHmac('sha256', 'key').update('msg').digest('base64'), nodeCrypto.createHmac('sha256', 'key').update('msg').digest('base64'));
});

test('events: once/off/emit order', () => {
  const { m } = sandbox();
  const e = new m.events();
  const seen = [];
  const f = (x) => seen.push('on' + x);
  e.on('a', f); e.once('a', (x) => seen.push('once' + x));
  e.emit('a', 1); e.emit('a', 2); e.off('a', f); e.emit('a', 3);
  assert.deepEqual(seen, ['on1', 'once1', 'on2']);
  assert.throws(() => e.emit('error', new Error('boom')), /boom/);
});

test('readline splits a stream into lines, async-iterable, keeps a trailing partial line', async () => {
  const { m } = sandbox();
  const r = new m.stream.Readable();
  const rl = m.readline.createInterface({ input: r });
  const lines = [];
  const done = (async () => { for await (const l of rl) lines.push(l); })();
  r.push(m.buffer.Buffer.from('{"a":1}\n{"b"'));
  r.push(m.buffer.Buffer.from(':2}\r\ntail'));
  r.push(null);
  await done;
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', 'tail']);
});

test('fs: sync calls go over XHR with encoded args; Stats/errors decode', () => {
  const { m, calls } = sandbox({
    onCall: (req) => {
      if (req.fn === 'statSync') return { ok: { $stat: { size: 3, mtimeMs: 1000, t: 'd' } } };
      if (req.fn === 'readFileSync') return { err: { $e: { message: 'ENOENT: no such file', code: 'ENOENT' } } };
      if (req.fn === 'existsSync') return { err: { $e: { message: 'x' } } };
      return { ok: { $u: 1 } };
    },
  });
  m.fs.writeFileSync('/tmp/a', m.buffer.Buffer.from([1, 2]));
  assert.deepEqual(calls[0], { mod: 'fs', fn: 'writeFileSync', args: ['/tmp/a', { $b: 'AQI=' }] });
  const st = m.fs.statSync('/x');
  assert.equal(st.isDirectory(), true);
  assert.equal(st.mtime.getTime(), 1000);
  assert.throws(() => m.fs.readFileSync('/nope'), (e) => e.code === 'ENOENT');
  assert.equal(m.fs.existsSync('/x'), false, 'existsSync never throws');
  assert.equal(m.fs.realpathSync.native, m.fs.realpathSync);
  assert.equal(m['node:fs'], m.fs);
});

test('child_process.spawn: stdio over the socket, exit then close, kill', async () => {
  const { m, sockets } = sandbox();
  const c = m.child_process.spawn('claude', ['--print'], { cwd: '/data/vaults/Notes', stdio: ['pipe', 'pipe', 'pipe'], env: { A: '1' } });
  const out = [];
  const events = [];
  c.stdout.on('data', (d) => out.push(d.toString()));
  c.on('spawn', () => events.push('spawn'));
  c.on('exit', (code) => events.push('exit' + code));
  c.on('close', (code) => events.push('close' + code));
  c.stdin.write('{"type":"user"}\n');
  await tick();
  const ws = sockets[0];
  const [spawnMsg, stdinMsg] = ws.sent;
  assert.equal(spawnMsg.op, 'spawn');
  assert.equal(spawnMsg.cmd, 'claude');
  assert.deepEqual(spawnMsg.opts, { cwd: '/data/vaults/Notes', env: { A: '1' } });
  assert.equal(Buffer.from(stdinMsg.data, 'base64').toString(), '{"type":"user"}\n');
  ws.serverSends({ op: 'spawn', id: spawnMsg.id, pid: 42 });
  ws.serverSends({ op: 'stdout', id: spawnMsg.id, data: Buffer.from('hi\n').toString('base64') });
  await tick();
  assert.equal(c.pid, 42);
  assert.equal(c.kill('SIGTERM'), true);
  assert.deepEqual(ws.sent[ws.sent.length - 1], { op: 'kill', id: spawnMsg.id, signal: 'SIGTERM' });
  ws.serverSends({ op: 'exit', id: spawnMsg.id, code: 0, signal: null });
  await tick();
  assert.deepEqual(out, ['hi\n']);
  assert.deepEqual(events, ['spawn', 'exit0', 'close0']);
  assert.equal(c.exitCode, 0);
});

test('stdio "ignore" slots are null; promisified execFile resolves {stdout, stderr}', async () => {
  const { m, sockets } = sandbox();
  const c = m.child_process.spawn('x', [], { stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(c.stdin, null);
  assert.equal(c.stderr, null);
  const p = m.util.promisify(m.child_process.execFile)('claude', ['--version']);
  await tick();
  const ws = sockets[0];
  const id = ws.sent.filter((s) => s.op === 'spawn')[1].id;
  ws.serverSends({ op: 'stdout', id, data: Buffer.from('2.0.0\n').toString('base64') });
  ws.serverSends({ op: 'exit', id, code: 0, signal: null });
  assert.deepEqual(JSON.parse(JSON.stringify(await p)), { stdout: '2.0.0\n', stderr: '' });
});

test('process and os reflect the server', () => {
  const { win, m } = sandbox();
  assert.equal(win.process.platform, 'linux');
  assert.equal(win.process.env.HOME, '/home/node');
  assert.equal(win.process.versions.electron, '30.0.0', 'the bundle needs this one kept');
  assert.equal(m.os.homedir(), '/home/node');
  assert.equal(m.process, win.process);
  assert.equal(win.app.vault.adapter.getBasePath(), '/data/vaults/Notes');
  assert.equal(win.app.vault.adapter.basePath, 'v1', 'non-plugin code keeps the adapter\'s own basePath');
  // plugin code (Obsidian evaluates it with sourceURL "plugin:<id>") sees the real folder
  const fromPlugin = vm.runInContext('(function readIt() { return app.vault.adapter.basePath; })\n//# sourceURL=plugin:realclaudian', win);
  assert.equal(fromPlugin(), '/data/vaults/Notes');
});
