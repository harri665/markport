/**
 * Integration tests for the system plugin distribution API
 * (GET /api/system-plugins, GET /api/system-plugin-file) — used by OPFS
 * (local) vaults to seed system plugins into OPFS at boot (see
 * client-mobile/boot.js seedSystemPlugins() / docs/plans/opfs-seed-system-plugins.md).
 *
 * Uses the real src/plugins/obsidian-web-layout fixture (manifest.json +
 * main.js only — no styles.css), same as the running server.
 */

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createApp } = require('../index');
const systemPlugins = require('../system-plugins');

async function startTestServer(config) {
  systemPlugins.init(); // scans the real src/plugins + vendor/plugins dirs
  const app = createApp(config);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('GET /api/system-plugins lists obsidian-web-layout with its real files + version', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const server = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath: path.join(tmp, 'vault'),
  });
  t.after(server.close);

  const res = await fetch(server.baseUrl + '/api/system-plugins');
  assert.equal(res.status, 200);
  const body = await res.json();

  const layout = body.plugins.find((p) => p.id === 'obsidian-web-layout');
  assert.ok(layout, 'obsidian-web-layout present in manifest');
  assert.equal(layout.version, '0.1.0');
  assert.deepEqual([...layout.files].sort(), ['main.js', 'manifest.json']);
});

test('GET /api/system-plugin-file serves a real system plugin file', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const server = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath: path.join(tmp, 'vault'),
  });
  t.after(server.close);

  const res = await fetch(server.baseUrl + '/api/system-plugin-file?id=obsidian-web-layout&file=main.js');
  assert.equal(res.status, 200);
  const body = await res.text();

  const expected = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'plugins', 'obsidian-web-layout', 'main.js'),
    'utf8',
  );
  assert.equal(body, expected);
});

test('GET /api/system-plugin-file rejects an unknown plugin id', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const server = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath: path.join(tmp, 'vault'),
  });
  t.after(server.close);

  const res = await fetch(server.baseUrl + '/api/system-plugin-file?id=not-a-real-plugin&file=main.js');
  assert.equal(res.status, 404);
});

test('GET /api/system-plugin-file blocks path traversal via the file param', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const server = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath: path.join(tmp, 'vault'),
  });
  t.after(server.close);

  const res = await fetch(
    server.baseUrl + '/api/system-plugin-file?id=obsidian-web-layout&file=' + encodeURIComponent('../../../../etc/passwd'),
  );
  assert.equal(res.status, 404);
});
