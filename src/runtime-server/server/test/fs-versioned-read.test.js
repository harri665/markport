const assert = require('assert/strict');
const fsp = require('fs').promises;
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createApp } = require('../index');

// capacitor-shim.js reads plugin and theme files with ?v=<mtime>-<size> (from
// the bootstrap) so the browser can keep them between visits. The server may
// only say "cache for good" when that version is the file it is serving.
test('/api/fs/read caches a versioned read only when the version matches', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'markport-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const vaultPath = path.join(tmp, 'vault');
  const rel = '.obsidian/plugins/demo/main.js';
  const abs = path.join(vaultPath, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, 'module.exports = 1;');

  const app = createApp({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const { id } = await (await fetch(base + '/api/vaults/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: vaultPath, create: false }),
  })).json();

  const read = (v) => fetch(base + '/api/fs/read?vault=' + encodeURIComponent(id) +
    '&path=' + encodeURIComponent(rel) + '&encoding=utf8' + (v ? '&v=' + v : ''));
  const st = await fsp.stat(abs);

  // Both ways the bootstrap turns mtimeMs into whole ms are accepted.
  for (const ms of [Math.floor(st.mtimeMs), st.mtime.getTime()]) {
    const res = await read(ms + '-' + st.size);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'module.exports = 1;');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  }

  // A stale or wrong version is served, but never cached for good.
  for (const v of [(Math.floor(st.mtimeMs) - 5000) + '-' + st.size, Math.floor(st.mtimeMs) + '-1', 'junk']) {
    const res = await read(v);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-cache');
  }

  // No version: unchanged behaviour.
  const plain = await read(null);
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('cache-control'), null);
});
