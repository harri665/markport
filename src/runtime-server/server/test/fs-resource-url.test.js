const assert = require('assert/strict');
const fsp = require('fs').promises;
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createApp } = require('../index');

// Obsidian builds <img src> itself: the storage-root URI from
// Filesystem.getUri({path:''}) ("/api/fs/read?vault=<id>&path=") plus
// "/<vault id>/<encoded file path>". See stripResourcePrefix in api/fs.js.
test('/api/fs/read serves the resource URLs Obsidian builds for embeds', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'markport-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const vaultPath = path.join(tmp, 'vault');
  await fsp.mkdir(path.join(vaultPath, 'a b'), { recursive: true });
  const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  await fsp.writeFile(path.join(vaultPath, 'a b', 'תמונה.png'), bytes);

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

  const opened = await (await fetch(base + '/api/vaults/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: vaultPath, create: false }),
  })).json();
  const id = opened.id;

  // Exactly the string concatenation Obsidian's FS.getNativeUri does.
  const root = base + '/api/fs/read?vault=' + encodeURIComponent(id) + '&path=';
  const url = root + '/' + [id, 'a b', 'תמונה.png'].map(encodeURIComponent).join('/');
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);

  // The plain vault-relative form the shim uses keeps working.
  const plain = await fetch(root + encodeURIComponent('a b/תמונה.png'));
  assert.equal(plain.status, 200);

  // Another vault's id is not stripped.
  const other = await fetch(root + encodeURIComponent('/0000other00000/a b/תמונה.png'));
  assert.equal(other.status, 404);
});
