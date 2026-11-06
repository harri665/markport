'use strict';

// /api/media (media/index.js) and the streamed /api/fs/read.

const assert = require('assert/strict');
const fsp = require('fs').promises;
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const sharp = require('sharp');

const { createApp } = require('../index');

async function setup(t) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'markport-media-'));
  const vaultPath = path.join(tmp, 'vault');
  await fsp.mkdir(path.join(vaultPath, 'Ref'), { recursive: true });
  const app = createApp({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath,
    media: { cacheDir: path.join(tmp, 'cache'), housekeeping: false },
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (app.locals.media) await app.locals.media.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  });
  const opened = await (await fetch(base + '/api/vaults/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: vaultPath, create: false }),
  })).json();
  return { tmp, vaultPath, base, id: opened.id, cache: path.join(tmp, 'cache') };
}

const q = (o) => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

// A 2:1 test image, red on the left half.
function testPng(w, h) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    px[o] = x < w / 2 ? 255 : 0; px[o + 1] = 0; px[o + 2] = x < w / 2 ? 0 : 255; px[o + 3] = 255;
  }
  return sharp(px, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

// An uncompressed 24-bit TGA, bottom-left origin.
function testTga(w, h) {
  const b = Buffer.alloc(18 + w * h * 3);
  b[2] = 2; b.writeUInt16LE(w, 12); b.writeUInt16LE(h, 14); b[16] = 24;
  for (let i = 0; i < w * h; i++) { b[18 + i * 3] = 255; }   // BGR: blue
  return b;
}

test('thumb: a WebP no bigger than asked, cached, and immutable when the version matches', async (t) => {
  const s = await setup(t);
  await fsp.writeFile(path.join(s.vaultPath, 'Ref', 'wide.png'), await testPng(1200, 600));
  const st = await fsp.stat(path.join(s.vaultPath, 'Ref', 'wide.png'));
  const v = Math.floor(st.mtimeMs) + '-' + st.size;

  const r = await fetch(s.base + '/api/media/thumb?' + q({ vault: s.id, path: 'Ref/wide.png', w: 300, v }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/webp');
  assert.match(r.headers.get('cache-control'), /immutable/);
  const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 480, 240], 'snapped to the 480 size, aspect kept');

  const stale = await fetch(s.base + '/api/media/thumb?' + q({ vault: s.id, path: 'Ref/wide.png', w: 300, v: 'old' }));
  assert.match(stale.headers.get('cache-control'), /no-cache/, 'a stale version must revalidate');

  const info = await (await fetch(s.base + '/api/media/info?' + q({ vault: s.id, path: 'Ref/wide.png' }))).json();
  assert.deepEqual([info.width, info.height], [1200, 600]);

  // The original was only read: the vault holds exactly what it held.
  assert.deepEqual(await fsp.readdir(path.join(s.vaultPath, 'Ref')), ['wide.png']);
});

test('thumb: TGA goes through the JS decoder; unreadable files fail fast and stay failed', async (t) => {
  const s = await setup(t);
  await fsp.writeFile(path.join(s.vaultPath, 'Ref', 'blue.tga'), testTga(64, 32));
  const r = await fetch(s.base + '/api/media/thumb?' + q({ vault: s.id, path: 'Ref/blue.tga', w: 256 }));
  assert.equal(r.status, 200);
  const { data, info } = await sharp(Buffer.from(await r.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [64, 32]);
  assert.ok(data[2] > 200 && data[0] < 40, 'blue pixels');

  await fsp.writeFile(path.join(s.vaultPath, 'Ref', 'broken.tga'), Buffer.from('nope'));
  const bad = await fetch(s.base + '/api/media/thumb?' + q({ vault: s.id, path: 'Ref/broken.tga' }));
  assert.equal(bad.status, 415);
  const again = await fetch(s.base + '/api/media/thumb?' + q({ vault: s.id, path: 'Ref/broken.tga' }));
  assert.equal(again.status, 415);

  const outside = await fetch(s.base + '/api/media/thumb?' + q({ vault: s.id, path: '../vaults.json' }));
  assert.equal(outside.status, 400, 'no path escapes the vault');
});

test('/api/fs/read streams binaries with Range and ETag', async (t) => {
  const s = await setup(t);
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i & 255));
  await fsp.writeFile(path.join(s.vaultPath, 'Ref', 'data.bin'), bytes);
  const url = s.base + '/api/fs/read?' + q({ vault: s.id, path: 'Ref/data.bin' });
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const etag = full.headers.get('etag');
  assert.ok(etag);
  const part = await fetch(url, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(10, 20));
  // Not fetch(): with If-None-Match it adds "Cache-Control: no-cache", which rules out a 304.
  const status = await new Promise((resolve, reject) => {
    http.get(url, { headers: { 'If-None-Match': etag } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 304);
});

test('chunked upload: resumable pieces, then the file appears unchanged in the vault', async (t) => {
  const s = await setup(t);
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  const start = await (await fetch(s.base + '/api/media/upload/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vault: s.id, path: 'Models/big.fbx', size: bytes.length }),
  })).json();
  assert.ok(start.id);
  const half = Math.floor(bytes.length / 2);
  for (const [a, b] of [[0, half], [half, bytes.length]]) {
    const r = await fetch(s.base + '/api/media/upload/chunk?' + q({ id: start.id, offset: a }), { method: 'PUT', body: bytes.subarray(a, b) });
    assert.equal((await r.json()).received, b);
  }
  const status = await (await fetch(s.base + '/api/media/upload/status?id=' + start.id)).json();
  assert.equal(status.received, bytes.length);
  const done = await (await fetch(s.base + '/api/media/upload/finish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: start.id }),
  })).json();
  assert.equal(done.ok, true);
  assert.deepEqual(await fsp.readFile(path.join(s.vaultPath, 'Models', 'big.fbx')), bytes);

  const dup = await fetch(s.base + '/api/media/upload/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vault: s.id, path: 'Models/big.fbx', size: 1 }),
  });
  assert.equal(dup.status, 409, 'never overwrites');
});

test('models: a GLB is optimized into the cache (meshopt, Brotli); other formats ask for a browser conversion', async (t) => {
  const s = await setup(t);
  const { Document, NodeIO } = require('@gltf-transform/core');
  const doc = new Document();
  const buffer = doc.createBuffer();
  const pos = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1]));
  const prim = doc.createPrimitive().setAttribute('POSITION', pos);
  doc.createScene().addChild(doc.createNode('tri').setMesh(doc.createMesh().addPrimitive(prim)));
  const glb = await new NodeIO().writeBinary(doc);
  await fsp.writeFile(path.join(s.vaultPath, 'Ref', 'tri.glb'), glb);

  const url = s.base + '/api/media/model?' + q({ vault: s.id, path: 'Ref/tri.glb' });
  const first = await fetch(url);
  assert.equal(first.status, 202);
  let r;
  for (let i = 0; i < 100; i++) {
    r = await fetch(url, { headers: { 'Accept-Encoding': 'br' } });
    if (r.status === 200) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'model/gltf-binary');
  const out = Buffer.from(await r.arrayBuffer());   // fetch undoes the Brotli
  assert.equal(out.toString('latin1', 0, 4), 'glTF');
  assert.match(out.toString('latin1'), /EXT_meshopt_compression/);
  assert.deepEqual(await fsp.readdir(path.join(s.vaultPath, 'Ref')), ['tri.glb'], 'nothing written next to the original');

  await fsp.writeFile(path.join(s.vaultPath, 'Ref', 'box.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  const obj = await fetch(s.base + '/api/media/model?' + q({ vault: s.id, path: 'Ref/box.obj' }));
  assert.equal(obj.status, 404);
  assert.equal((await obj.json()).status, 'needs-source');
});

test('turntables: only WebP images are stored', async (t) => {
  const s = await setup(t);
  await fsp.writeFile(path.join(s.vaultPath, 'Ref', 'box.obj'), 'v 0 0 0\n');
  const url = s.base + '/api/media/turntable?' + q({ vault: s.id, path: 'Ref/box.obj' });
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(url, { method: 'PUT', body: Buffer.from('not an image') })).status, 415);
  const webp = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#888' } }).webp().toBuffer();
  assert.equal((await fetch(url, { method: 'PUT', body: webp })).status, 200);
  const got = await fetch(url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/webp');
});
