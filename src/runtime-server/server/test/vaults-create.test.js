const assert = require('assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createApp } = require('../index');

async function start(t, extra) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'markport-vaults-create-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const app = createApp(Object.assign({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'registry.json'),
    vaultPath: path.join(tmp, 'default'),
    vaultsDir: null,
  }, extra(tmp)));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { tmp, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function create(baseUrl, name) {
  return fetch(baseUrl + '/api/vaults/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

test('without VAULTS_DIR the server offers no server-side create', async (t) => {
  const { baseUrl } = await start(t, () => ({}));
  const storage = await (await fetch(baseUrl + '/api/vaults/storage')).json();
  assert.equal(storage.serverCreate, false);
  assert.equal((await create(baseUrl, 'Work')).status, 404);
});

test('with VAULTS_DIR a vault is created as a folder and registered', async (t) => {
  const { tmp, baseUrl } = await start(t, (dir) => ({
    vaultsDir: path.join(dir, 'vaults'),
    defaultVaultName: 'Notes',
  }));
  const storage = await (await fetch(baseUrl + '/api/vaults/storage')).json();
  assert.equal(storage.serverCreate, true);

  const res = await create(baseUrl, '  Work  ');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.name, 'Work');
  assert.ok(fs.statSync(path.join(tmp, 'vaults', 'Work')).isDirectory());

  const list = await (await fetch(baseUrl + '/api/vaults/list')).json();
  assert.equal(list[body.id].path, path.join(tmp, 'vaults', 'Work'));

  assert.equal((await create(baseUrl, 'Work')).status, 409);
});

test('names that are not a single plain folder name are rejected', async (t) => {
  const { tmp, baseUrl } = await start(t, (dir) => ({ vaultsDir: path.join(dir, 'vaults') }));
  for (const bad of ['', '   ', '.hidden', '..', '../escape', 'a/b', 'a\\b', 'x:y', 'tab\there', 42]) {
    assert.equal((await create(baseUrl, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(fs.existsSync(path.join(tmp, 'escape')), false);
});
