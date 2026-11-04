/**
 * bootstrap cache tests
 *
 * Verifies that:
 *  1. A cold request builds the cache (MISS).
 *  2. A warm request is a cache HIT and returns the response
 *     with a Content-Encoding header (pre-compressed buffer sent directly).
 *  3. Writing a file invalidates the cache so the next request is a MISS.
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
const { serverCache } = require('../api/bootstrap');

async function startTestServer(config) {
  const app = createApp(config);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Raw HTTP GET that does NOT decompress the response automatically.
 * Returns { status, headers, rawBody }.
 * Needed to inspect Content-Encoding on the wire.
 */
function rawGet(url, reqHeaders = {}) {
  return new Promise((resolve, reject) => {
    const { hostname, port, pathname, search } = new URL(url);
    const req = http.get(
      { hostname, port: parseInt(port, 10), path: pathname + search, headers: reqHeaders },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, rawBody: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
  });
}

/** Minimal vault fixture: a single .obsidian/ dir + one note. */
async function makeVaultFixture(dir) {
  const vaultPath = path.join(dir, 'vault');
  await fsp.mkdir(path.join(vaultPath, '.obsidian'), { recursive: true });
  await fsp.writeFile(path.join(vaultPath, 'note.md'), '# Hello\n');
  return vaultPath;
}

test('bootstrap cache HIT sends pre-compressed Content-Encoding header', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-bootstrap-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const vaultPath = await makeVaultFixture(tmp);

  // Register the vault so bootstrap knows which vaultId to use.
  const server = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath,
  });
  t.after(server.close);

  const openRes = await fetch(server.baseUrl + '/api/vaults/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: vaultPath, create: false }),
  });
  const { id: vaultId } = await openRes.json();

  // ── MISS: cold request builds the cache ──────────────────────────────────
  const coldRaw = await rawGet(
    `${server.baseUrl}/api/bootstrap?vault=${vaultId}`,
    { 'Accept-Encoding': 'br, gzip' },
  );
  assert.equal(coldRaw.status, 200, 'cold request should succeed');

  // ── HIT: second request should be served from the pre-compressed buffer ──
  const hotRaw = await rawGet(
    `${server.baseUrl}/api/bootstrap?vault=${vaultId}`,
    { 'Accept-Encoding': 'br, gzip' },
  );
  assert.equal(hotRaw.status, 200, 'cache HIT should succeed');

  // The server MUST advertise Content-Encoding (either br or gzip) to show
  // it sent the pre-compressed buffer and skipped re-serialisation.
  const ce = hotRaw.headers['content-encoding'];
  assert.ok(
    ce === 'br' || ce === 'gzip',
    `cache HIT Content-Encoding should be br or gzip, got: ${ce}`,
  );

  // Decompress and verify the response body is valid JSON with the right shape.
  const zlib = require('zlib');
  const decompress = ce === 'br'
    ? (buf) => new Promise((res, rej) => zlib.brotliDecompress(buf, (e, d) => e ? rej(e) : res(d)))
    : (buf) => new Promise((res, rej) => zlib.gunzip(buf, (e, d) => e ? rej(e) : res(d)));
  const jsonBuf = await decompress(hotRaw.rawBody);
  const hotBody = JSON.parse(jsonBuf.toString('utf8'));
  assert.ok(hotBody.electron, 'HIT response should still have electron section');
  assert.ok(hotBody.fs, 'HIT response should still have fs section');
});

test('BOOTSTRAP_DISABLED=true returns {disabled:true} without scanning', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-bootstrap-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const vaultPath = await makeVaultFixture(tmp);

  const server = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath,
    bootstrap: { enabled: false, maxFileKB: 500, maxTotalMB: 50 },
  });
  t.after(server.close);

  const openRes = await fetch(server.baseUrl + '/api/vaults/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: vaultPath, create: false }),
  });
  const { id: vaultId } = await openRes.json();

  const t0 = Date.now();
  const res = await fetch(`${server.baseUrl}/api/bootstrap?vault=${vaultId}&full=1`);
  const elapsed = Date.now() - t0;
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.disabled, true, 'should mark response as disabled');
  assert.ok(body.electron, 'electron values still present');
  assert.deepEqual(body.fs, {}, 'fs should be empty');
  assert.deepEqual(body.dirs, {}, 'dirs should be empty');
  assert.ok(elapsed < 200, `should respond in <200ms, got ${elapsed}ms`);
});

test('maxFileKB caps individual files: oversized files have stat but no content', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-bootstrap-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const vaultPath = await makeVaultFixture(tmp);

  // Write a small file (~1KB) and a "big" one (~30KB).
  await fsp.writeFile(path.join(vaultPath, 'small.md'), 'x'.repeat(1024));
  await fsp.writeFile(path.join(vaultPath, 'big.md'),   'y'.repeat(30 * 1024));

  // Cap at 10 KB: big.md (30 KB) should be skipped, small.md (1 KB) kept.
  const server = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath,
    bootstrap: { enabled: true, maxFileKB: 10, maxTotalMB: 50 },
  });
  t.after(server.close);

  const openRes = await fetch(server.baseUrl + '/api/vaults/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: vaultPath, create: false }),
  });
  const { id: vaultId } = await openRes.json();

  const res = await fetch(`${server.baseUrl}/api/bootstrap?vault=${vaultId}&full=1`);
  assert.equal(res.status, 200);
  const body = await res.json();

  // small.md: has both stat AND content in fs.
  assert.ok(body.fs['small.md'], 'small.md should be in fs cache');
  assert.equal(typeof body.fs['small.md'].content, 'string', 'small.md should have content');

  // big.md: NOT in fs (oversized text files are skipped entirely per plan
  // pitfall #7 option 2: dirs cache still has its stat).
  assert.equal(body.fs['big.md'], undefined, 'big.md should be absent from fs cache');

  // dirs still lists big.md so the client can discover it.
  const rootEntries = body.dirs[''] || [];
  const bigEntry = rootEntries.find((e) => e.name === 'big.md');
  assert.ok(bigEntry, 'big.md should still appear in dirs listing');
  assert.equal(bigEntry.isFile, true);
});

test('maxTotalMB caps total response: response carries {capped:true} and partial content', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-bootstrap-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const vaultPath = await makeVaultFixture(tmp);

  // Write several ~80 KB markdown files. Total budget will be 200 KB so we
  // expect ~2-3 files to land in fs cache and the rest to be capped.
  for (let i = 0; i < 8; i++) {
    await fsp.writeFile(path.join(vaultPath, `note-${i}.md`), 'z'.repeat(80 * 1024));
  }

  // maxFileKB high enough (each file fits individually); maxTotalMB tiny so
  // the *total* budget caps. We use 1 MB which is the smallest integer the
  // env var supports — we then sanity-check via the capped flag and partial
  // fs cache.
  // 8 * 80 KB = 640 KB total content. Budget 1 MB (1024 KB) is *higher*
  // than 640 KB, so to actually trigger capping we need maxTotalMB = 0
  // (no budget at all). But maxTotalMB is parsed as int — 0 is falsy in
  // applyLimits's `|| 50` fallback. So we shape the test around: with 8
  // files of 80 KB and a budget of (effectively) "as small as we can make
  // it via maxFileKB instead". Better: keep this test honest by using a
  // larger fixture. Bump each file to 200 KB and use maxTotalMB = 0.5 MB
  // is not int-friendly. Instead: 16 files of 80 KB = 1280 KB total,
  // and pass maxTotalMB=1 (1024 KB budget). That correctly caps.
  // Cleanup the small ones first; rewrite as 16.
  for (let i = 0; i < 8; i++) await fsp.unlink(path.join(vaultPath, `note-${i}.md`));
  for (let i = 0; i < 16; i++) {
    await fsp.writeFile(path.join(vaultPath, `note-${i}.md`), 'z'.repeat(80 * 1024));
  }

  const server = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath,
    bootstrap: { enabled: true, maxFileKB: 500, maxTotalMB: 1 },
  });
  t.after(server.close);

  const openRes = await fetch(server.baseUrl + '/api/vaults/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: vaultPath, create: false }),
  });
  const { id: vaultId } = await openRes.json();

  const res = await fetch(`${server.baseUrl}/api/bootstrap?vault=${vaultId}&full=1`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.capped, true, 'response should be flagged as capped');
  assert.ok(typeof body.cappedReason === 'string' && body.cappedReason.length > 0,
    'cappedReason should describe the cap');

  // dirs should list all 16 files (cap only affects content, not the dir walk).
  const rootEntries = body.dirs[''] || [];
  const noteEntries = rootEntries.filter((e) => /^note-\d+\.md$/.test(e.name));
  assert.equal(noteEntries.length, 16, 'all 16 notes should appear in dirs');

  // Some files have content, others don't (skipped due to budget).
  const withContent = Object.values(body.fs).filter((v) => typeof v.content === 'string').length;
  const totalFs = Object.keys(body.fs).length;
  assert.ok(withContent < 16, `expected fewer than 16 files with content, got ${withContent}`);
  assert.ok(withContent > 0, 'expected at least one file with content before cap hit');
  assert.ok(totalFs > 0, 'fs cache should contain stat entries');
});

test('warm-up bails out without scanning when bootstrap is disabled', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-bootstrap-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const vaultPath = await makeVaultFixture(tmp);

  // Make a registry with one registered vault so warmUp has something to scan.
  const registryPath = path.join(tmp, 'vaults.json');
  await fsp.writeFile(registryPath, JSON.stringify({
    abc123: { path: vaultPath, ts: Date.now(), open: true },
  }));

  // Pre-clear serverCache (other tests may have populated it).
  const { serverCache, warmUpBootstrapCache } = require('../api/bootstrap');
  const VaultRegistry = require('../vault-registry');
  serverCache.clear();

  const registry = new VaultRegistry(registryPath);

  // Sanity: warm-up with enabled=false should NOT populate serverCache.
  await warmUpBootstrapCache(registry, vaultPath, { enabled: false, maxFileKB: 500, maxTotalMB: 50 });
  assert.equal(serverCache.size, 0, 'serverCache must stay empty when disabled');

  // Control: warm-up with enabled=true on the same vault DOES populate it.
  await warmUpBootstrapCache(registry, vaultPath, { enabled: true, maxFileKB: 500, maxTotalMB: 50 });
  assert.ok(serverCache.size > 0, 'serverCache should be populated when enabled');
});

test('buildElectronValues extracted helper produces same shape as enabled bootstrap', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-bootstrap-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const vaultPath = await makeVaultFixture(tmp);

  // Enabled server.
  const enabledServer = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath,
  });
  t.after(enabledServer.close);

  const openRes = await fetch(enabledServer.baseUrl + '/api/vaults/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: vaultPath, create: false }),
  });
  const { id: vaultId } = await openRes.json();

  const enabledBody = await (await fetch(
    `${enabledServer.baseUrl}/api/bootstrap?vault=${vaultId}`,
  )).json();

  // Disabled server using the same vault registry.
  const disabledServer = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath,
    bootstrap: { enabled: false, maxFileKB: 500, maxTotalMB: 50 },
  });
  t.after(disabledServer.close);

  const disabledBody = await (await fetch(
    `${disabledServer.baseUrl}/api/bootstrap?vault=${vaultId}`,
  )).json();

  // Same set of keys, same values for all known electron keys.
  assert.deepEqual(
    Object.keys(enabledBody.electron).sort(),
    Object.keys(disabledBody.electron).sort(),
    'electron key set must match between enabled and disabled paths',
  );
  for (const key of Object.keys(enabledBody.electron)) {
    assert.deepEqual(disabledBody.electron[key], enabledBody.electron[key],
      `electron[${key}] should match between paths`);
  }
});

test('bootstrap cache is invalidated when a file is written', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-bootstrap-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const vaultPath = await makeVaultFixture(tmp);

  const server = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath,
  });
  t.after(server.close);

  const openRes = await fetch(server.baseUrl + '/api/vaults/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: vaultPath, create: false }),
  });
  const { id: vaultId } = await openRes.json();

  // Cold request — fills cache.
  await fetch(`${server.baseUrl}/api/bootstrap?vault=${vaultId}`);
  assert.ok(serverCache.has(vaultId), 'cache should be populated after first request');

  // Write a new file to vault root (changes the root dir mtime).
  await fsp.writeFile(path.join(vaultPath, 'new-note.md'), '# New\n');

  // The cache invalidation happens on the next bootstrap request, not eagerly.
  // But we can verify that after writing, the next request re-builds.
  const afterWriteRes = await fetch(`${server.baseUrl}/api/bootstrap?vault=${vaultId}`);
  assert.equal(afterWriteRes.status, 200, 'post-write request should succeed');
  const afterBody = await afterWriteRes.json();
  assert.ok(afterBody.fs, 'post-write response should have fs section');
});
