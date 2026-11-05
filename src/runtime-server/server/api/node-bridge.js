/**
 * Node bridge - lets desktop-only community plugins (Claudian, ...) use real
 * Node APIs, executed HERE on the server, from the browser.
 *
 *   GET  /api/node-bridge/info?vault=<id>   os/env snapshot + the vault's real path
 *   POST /api/node-bridge/call              { mod, fn, args } -> run fs/os/child_process function
 *   WS   /api/node-bridge/proc              spawn processes, stream stdio
 *
 * The client side is src/client-mobile/shims/node-bridge.js, which builds
 * `fs`, `child_process`, `os`, ... modules on top of this, so a plugin
 * behaves as if Obsidian were running on the server machine.
 *
 * SECURITY: this is remote code execution by design - anyone who can reach
 * it can read any file and run any command as the server's user. It is OFF
 * unless MARKPORT_NODE_BRIDGE=true, and must only be enabled behind a reverse
 * proxy that authenticates users. Two cheap guards stop OTHER websites from
 * using it through a logged-in browser:
 *   - HTTP: a custom header is required, which makes a cross-origin request
 *     need a CORS preflight; no CORS headers are ever sent, so it fails.
 *   - WebSocket: browsers don't preflight WebSockets, so the Origin header
 *     must match the Host header.
 */

'use strict';

const childProcess = require('child_process');
const express = require('express');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');

const HEADER = 'x-markport-bridge';

// Environment variables the browser may see (it needs PATH/HOME to locate
// CLIs and config files). Everything else - API keys, tokens - stays on the
// server; spawned processes still inherit the full server environment.
const ENV_EXPOSED = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TERM|TMPDIR|TZ|XDG_[A-Z_]+|CLAUDE_CONFIG_DIR|NODE_PATH)$/;

// fs functions that return state the bridge can't carry across HTTP.
const FS_DENY = new Set(['watch', 'watchFile', 'unwatchFile', 'createReadStream', 'createWriteStream', 'openAsBlob']);

// ── value encoding (mirrored in shims/node-bridge.js) ────────────────────────
function encode(v) {
  if (v === undefined) return { $u: 1 };
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $b: Buffer.from(v).toString('base64') };
  if (v instanceof Date) return { $d: v.getTime() };
  if (v instanceof Error) {
    return { $e: { name: v.name, message: v.message, code: v.code, errno: v.errno, syscall: v.syscall, path: v.path, status: v.status, signal: v.signal, stdout: v.stdout && encode(v.stdout), stderr: v.stderr && encode(v.stderr) } };
  }
  if (v instanceof fs.Stats) {
    const o = {};
    for (const k of Object.keys(v)) o[k] = typeof v[k] === 'bigint' ? Number(v[k]) : v[k];
    o.t = v.isFile() ? 'f' : v.isDirectory() ? 'd' : v.isSymbolicLink() ? 'l' : v.isFIFO() ? 'p' : v.isSocket() ? 's' : v.isCharacterDevice() ? 'c' : v.isBlockDevice() ? 'b' : '?';
    return { $stat: o };
  }
  if (v instanceof fs.Dirent) {
    const t = v.isFile() ? 'f' : v.isDirectory() ? 'd' : v.isSymbolicLink() ? 'l' : '?';
    return { $dirent: { name: v.name, parentPath: v.parentPath || v.path, t } };
  }
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) if (typeof v[k] !== 'function') o[k] = encode(v[k]);
    return o;
  }
  return null;   // functions, symbols
}

function decode(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decode);
  if (v.$u) return undefined;
  if (typeof v.$b === 'string') return Buffer.from(v.$b, 'base64');
  if (typeof v.$d === 'number') return new Date(v.$d);
  const o = {};
  for (const k of Object.keys(v)) o[k] = decode(v[k]);
  return o;
}

// Resolve "fs.readFileSync" / "fs.promises.readFile" / "os.homedir" /
// "child_process.execFileSync" to a function. Only these namespaces exist.
function resolveFn(mod, fn) {
  let target;
  if (mod === 'fs') target = fs;
  else if (mod === 'fs.promises') target = fs.promises;
  else if (mod === 'os') target = os;
  else if (mod === 'child_process') target = childProcess;
  else return null;
  if (typeof fn !== 'string' || !Object.prototype.hasOwnProperty.call(target, fn)) return null;
  if ((mod === 'fs' || mod === 'fs.promises') && FS_DENY.has(fn)) return null;
  if (mod === 'child_process' && !/Sync$/.test(fn)) return null;   // async processes go over the WebSocket
  const f = target[fn];
  return typeof f === 'function' ? f.bind(target) : null;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;   // not a browser cross-site request
  try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
}

function guard(req, res, next) {
  if (req.get(HEADER) !== '1' || !sameOrigin(req)) {
    return res.status(403).json({ error: 'node bridge: missing header or cross-origin request' });
  }
  next();
}

function info(vaultRegistry, vaultId) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (ENV_EXPOSED.test(k)) env[k] = v;
  let userInfo = null;
  try { userInfo = os.userInfo(); } catch (_) { /* no passwd entry in some containers */ }
  const vault = vaultId ? vaultRegistry.get(vaultId) : null;
  return {
    enabled: true,
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    execPath: process.execPath,
    cwd: process.cwd(),
    pid: process.pid,
    env,
    os: {
      homedir: os.homedir(), tmpdir: os.tmpdir(), hostname: os.hostname(), type: os.type(),
      release: os.release(), EOL: os.EOL, arch: os.arch(), platform: os.platform(),
      cpus: os.cpus().length, totalmem: os.totalmem(), userInfo,
    },
    vaultPath: vault ? vault.path : null,
  };
}

function createNodeBridgeRouter(vaultRegistry, enabled) {
  const router = express.Router();
  router.get('/info', (req, res) => {
    if (!enabled) return res.json({ enabled: false });
    if (!sameOrigin(req)) return res.status(403).json({ enabled: false });
    res.json(info(vaultRegistry, req.query.vault));
  });
  if (!enabled) return router;

  router.post('/call', guard, express.json({ limit: '200mb' }), async (req, res) => {
    const { mod, fn } = req.body || {};
    const f = resolveFn(mod, fn);
    if (!f) return res.status(400).json({ error: `node bridge: ${mod}.${fn} is not available` });
    try {
      const args = decode(req.body.args || []);
      res.json({ ok: encode(await f(...args)) });
    } catch (err) {
      res.json({ err: encode(err) });
    }
  });
  return router;
}

/** WebSocket: one connection per spawned process tree owner (a browser tab). */
// isOwner(req): the owner-login check (auth.js); share-link visitors and
// anonymous requests never reach the bridge.
function attachNodeBridgeProcServer(httpServer, enabled, isOwner) {
  if (!enabled) return;
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/api/node-bridge/proc') return;
    if (!sameOrigin(req) || (isOwner && !isOwner(req))) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const procs = new Map();
    const send = (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch (_) { return; }
      const p = procs.get(m.id);
      if (m.op === 'spawn') {
        const opts = m.opts || {};
        let child;
        try {
          child = childProcess.spawn(m.cmd, m.args || [], {
            cwd: opts.cwd || undefined,
            env: Object.assign({}, process.env, opts.env || {}),
            shell: opts.shell || false,
            windowsHide: true,
            stdio: 'pipe',
          });
        } catch (err) {
          send({ op: 'error', id: m.id, err: encode(err) });
          return;
        }
        procs.set(m.id, child);
        child.on('spawn', () => send({ op: 'spawn', id: m.id, pid: child.pid }));
        child.stdout.on('data', (d) => send({ op: 'stdout', id: m.id, data: d.toString('base64') }));
        child.stderr.on('data', (d) => send({ op: 'stderr', id: m.id, data: d.toString('base64') }));
        child.stdin.on('error', () => { /* EPIPE after exit - reported via exit */ });
        child.on('error', (err) => send({ op: 'error', id: m.id, err: encode(err) }));
        child.on('close', (code, signal) => {
          procs.delete(m.id);
          send({ op: 'exit', id: m.id, code, signal });
        });
      } else if (m.op === 'stdin' && p) {
        p.stdin.write(Buffer.from(m.data, 'base64'));
      } else if (m.op === 'end' && p) {
        p.stdin.end();
      } else if (m.op === 'kill' && p) {
        try { p.kill(m.signal || 'SIGTERM'); } catch (_) { /* already gone */ }
      }
    });

    // Tab closed or reloaded: don't leave agents running.
    ws.on('close', () => {
      for (const child of procs.values()) { try { child.kill('SIGTERM'); } catch (_) { /* gone */ } }
      procs.clear();
    });
  });
}

module.exports = { createNodeBridgeRouter, attachNodeBridgeProcServer, encode, decode };
