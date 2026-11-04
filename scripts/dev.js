#!/usr/bin/env node
'use strict';

/**
 * Local run/test entry point - no Docker. Called by the root package.json:
 *
 *   npm run setup   install server deps + download Obsidian's renderer (once)
 *   npm run dev     run the server, restarting when server code changes
 *   npm start       run the server
 *   npm test        run every package's test suite
 *
 * Plain Node, no dependencies, so it behaves the same in PowerShell, cmd and
 * bash. Vaults go in user-data/vaults/ (gitignored), the same layout the
 * Docker image uses under /data/vaults: each folder there is a vault on the
 * start screen. On first run the tracked demo vault is copied in as "Demo",
 * so there is something to open, and the tracked copy is never edited.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'src', 'runtime-server', 'server');
const CLIENT_DIR = path.join(ROOT, 'src', 'client-mobile');
const SYNC_DIR = path.join(ROOT, 'src', 'sync-server');
const VENDOR_DIR = path.join(ROOT, 'vendor', 'obsidian-mobile');
const VAULTS_DIR = path.join(ROOT, 'user-data', 'vaults');
const DEMO_VAULT = path.join(ROOT, 'user-data', 'demo-vault');
const IS_WIN = process.platform === 'win32';

// 1.13+ does not boot - see README.md, "Obsidian Version".
const OBSIDIAN_VERSION = process.env.OBSIDIAN_VERSION || '1.12.7';
// A file each part must contain to count as installed. The codemirror one is
// what a broken extraction used to leave out.
const VENDOR_MARKERS = ['app.js', 'native-bridge.js', 'worker.js', 'lib/codemirror/codemirror.js'];

function log(msg) { console.log('[markport] ' + msg); }
function fail(msg) { console.error('[markport] ' + msg); process.exit(1); }

function run(cmd, args, opts = {}) {
  // npm is npm.cmd on Windows, which only resolves through a shell.
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: IS_WIN && cmd !== process.execPath, ...opts });
  if (r.error) throw r.error;
  return r.status;
}

function has(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: IS_WIN });
  return !r.error && r.status === 0;
}

const vendorMissing = () => VENDOR_MARKERS.filter((f) => !fs.existsSync(path.join(VENDOR_DIR, f)));
const depsInstalled = () => fs.existsSync(path.join(SERVER_DIR, 'node_modules', 'express'));

function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) fail(`Node ${process.versions.node} is too old - Node 18 or newer is required.`);
}

// ── setup ───────────────────────────────────────────────────────────────────

function setup(args) {
  checkNode();
  const force = args.includes('--force');

  if (force || !depsInstalled()) {
    log('Installing server dependencies…');
    if (run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: SERVER_DIR }) !== 0) fail('npm ci failed.');
  } else {
    log('Server dependencies: installed.');
  }

  const missing = vendorMissing();
  if (force || missing.length) {
    if (missing.length && !force) log(`Obsidian renderer: missing ${missing.join(', ')}.`);
    log(`Downloading Obsidian ${OBSIDIAN_VERSION} from Obsidian's GitHub releases…`);
    const status = run(process.execPath,
      [path.join(__dirname, 'update-obsidian-mobile.js'), '--version', OBSIDIAN_VERSION]);
    if (status !== 0) fail('Downloading Obsidian failed - see the error above.');
  } else {
    log(`Obsidian renderer: installed (vendor/obsidian-mobile).`);
  }

  log('Ready. Run `npm run dev`.');
}

// ── dev / start ─────────────────────────────────────────────────────────────

function seedVaults() {
  if (fs.existsSync(VAULTS_DIR)) return;
  fs.mkdirSync(VAULTS_DIR, { recursive: true });
  if (fs.existsSync(DEMO_VAULT)) {
    fs.cpSync(DEMO_VAULT, path.join(VAULTS_DIR, 'Demo'), { recursive: true });
    log('Created user-data/vaults/Demo (a copy of the demo vault).');
  }
}

function serve(watch) {
  checkNode();
  const problems = [];
  if (!depsInstalled()) problems.push('server dependencies are not installed');
  const missing = vendorMissing();
  if (missing.length) problems.push(`Obsidian's renderer is missing (${missing.join(', ')})`);
  if (problems.length) fail(problems.join('; ') + '.\n[markport] Run `npm run setup` first.');

  seedVaults();
  const env = {
    ...process.env,
    VAULTS_DIR: process.env.VAULTS_DIR || VAULTS_DIR,
  };
  const port = env.PORT || '3500';
  const host = env.HOST || '127.0.0.1';
  log(`Vaults: ${path.relative(ROOT, env.VAULTS_DIR) || env.VAULTS_DIR} - add a folder there and restart to add a vault.`);
  log(`Open http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}` +
    (watch ? '  (server restarts on server-code changes; reload the page for client changes)' : ''));

  const nodeArgs = watch ? ['--watch', 'index.js'] : ['index.js'];
  const child = spawn(process.execPath, nodeArgs, { cwd: SERVER_DIR, env, stdio: ['inherit', 'inherit', 'pipe'] });
  child.stderr.on('data', (buf) => {
    process.stderr.write(buf);
    if (/EADDRINUSE/.test(buf.toString())) {
      console.error(`[markport] Port ${port} is already in use - stop the other server, or run with PORT=<other port>.`);
    }
  });
  const stop = () => child.kill('SIGINT');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ── test ────────────────────────────────────────────────────────────────────

function test() {
  checkNode();
  if (!depsInstalled()) fail('Server dependencies are not installed. Run `npm run setup` first.');

  const suites = [
    { name: 'server', cwd: SERVER_DIR, cmd: process.execPath, args: ['--test'] },
    { name: 'client', cwd: CLIENT_DIR, cmd: process.execPath, args: ['--test'] },
  ];
  // The sync server's tests use bun:test, so they only run where bun exists.
  if (has('bun')) {
    if (!fs.existsSync(path.join(SYNC_DIR, 'node_modules'))) run('bun', ['install'], { cwd: SYNC_DIR });
    suites.push({ name: 'sync-server', cwd: SYNC_DIR, cmd: 'bun', args: ['test'] });
  }

  const results = suites.map((s) => {
    log(`── ${s.name} tests ──`);
    return { name: s.name, ok: run(s.cmd, s.args, { cwd: s.cwd }) === 0 };
  });
  if (!has('bun')) results.push({ name: 'sync-server', skipped: true });

  console.log('');
  for (const r of results) {
    log(`${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.name}` +
      (r.skipped ? '  (needs bun: https://bun.sh)' : ''));
  }
  process.exit(results.some((r) => r.ok === false) ? 1 : 0);
}

// ── main ────────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);
const commands = {
  setup: () => setup(rest),
  dev: () => serve(true),
  start: () => serve(false),
  test: () => test(),
};
if (!commands[command]) {
  console.log('Usage: node scripts/dev.js <setup [--force] | dev | start | test>');
  process.exit(command ? 1 : 0);
}
commands[command]();
