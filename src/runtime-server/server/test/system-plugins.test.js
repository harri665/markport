/**
 * Integration tests for the system-plugins overlay.
 *
 * Verifies:
 *  1. init() loads plugins from src/plugins AND vendor/plugins.
 *  2. getSystemPluginDir() returns the correct rootDir per plugin id.
 *  3. tryGetSystemFilePath() resolves files from both directories.
 *  4. Duplicate id: src/plugins wins (first-wins precedence).
 *  5. ENOENT on vendor/plugins is handled gracefully (warn + continue).
 *  6. Path-traversal is blocked.
 */

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const test = require('node:test');

// We need to reset module state between tests. The module uses module-level
// Maps/Sets, so we re-require with a fresh registry by abusing the module
// cache. A thin wrapper gives us fresh state each test.
function freshModule(overrideDirs) {
  // Remove cached version so we can patch __dirname-derived paths.
  // We do this by temporarily monkey-patching the module's exported init
  // after loading — but the Map is module-level so we just call init() with
  // a patched SYSTEM_PLUGINS_DIR. Instead, we expose an internal _scanDir
  // that accepts a dir argument. Since we can't easily patch __dirname, we
  // clear the require cache and use a trick: pass the dirs via a temp env
  // variable. Simpler: just use the real module but call init() after
  // populating our tmp dirs, and rely on the fact that the module reads
  // SYSTEM_PLUGINS_DIR and VENDOR_PLUGINS_DIR at require-time. We need to
  // control those paths.
  //
  // Best approach: delete from require.cache and re-require. But the module
  // computes paths at require-time from __dirname, so we can't override them
  // without monkey-patching path.resolve or using env vars.
  //
  // Cleanest solution: expose a testable _initFromDirs(srcDir, vendorDir)
  // function, or accept that we test via the exported _scanDir helper that
  // we've added. Let's just test the exported API at arm's length by
  // building fixture dirs and calling init() after clearing the cache.
  //
  // We patch by deleting from require.cache each time.
  const key = require.resolve('../system-plugins');
  delete require.cache[key];
  const mod = require('../system-plugins');
  return mod;
}

// Build a minimal plugin fixture: <dir>/<id>/manifest.json + a main.js
async function makePlugin(dir, id) {
  const pluginDir = path.join(dir, id);
  await fsp.mkdir(pluginDir, { recursive: true });
  await fsp.writeFile(
    path.join(pluginDir, 'manifest.json'),
    JSON.stringify({ id, name: id, version: '0.0.1', minAppVersion: '0.15.0', author: 'test' }),
  );
  await fsp.writeFile(path.join(pluginDir, 'main.js'), `// ${id} plugin`);
  return pluginDir;
}

// ─── helpers to call the private scan with custom dirs ─────────────────────

/**
 * The module computes SYSTEM_PLUGINS_DIR and VENDOR_PLUGINS_DIR at
 * require-time from __dirname.  To test with fixture dirs we need to
 * monkey-patch the module's internals.  The cleanest way: re-require a
 * fresh copy of the module and immediately replace its Map contents by
 * calling the exported _initFromDirs if we add it, OR we patch the
 * module-level constants via Object.defineProperty on the module namespace.
 *
 * Since those constants are private (not exported), we use a different
 * strategy: we instrument the module with an extra export _initFromDirs
 * for test purposes.  But that would mean changing the source.
 *
 * Simpler: just test via the HTTP server as a black-box integration test
 * similar to vaults-api.test.js — spin up a full server with custom
 * clientPath/obsidianPath pointing to a temp tree that includes src/plugins
 * and vendor/plugins, then hit /api/fs/* endpoints.
 *
 * However that requires the server's createApp to accept pluginDirs, which
 * it doesn't. Let's go with the direct approach: add _initFromDirs as a
 * test-only export in the module, using an undocumented convention
 * (prefixed with _).  This keeps the surface small.
 *
 * ACTUALLY — re-reading the module: init() reads from SYSTEM_PLUGINS_DIR
 * and VENDOR_PLUGINS_DIR which are computed once.  The simplest test
 * approach that doesn't require source changes is to temporarily set up
 * the real dirs to point to our fixture by symlinking or by patching
 * require.cache internals.
 *
 * We go with: patch require.cache to inject a modified version of the
 * module that uses our tmp dirs.  This is a common Node.js test pattern.
 */

function loadModuleWithDirs(srcPluginsDir, vendorPluginsDir) {
  const modulePath = require.resolve('../system-plugins');
  // Remove from cache so we get a fresh eval.
  delete require.cache[modulePath];

  // Read source and patch the dir constants before loading.
  const originalSource = fs.readFileSync(modulePath, 'utf8');

  // Build patched source: replace the two path.resolve lines.
  const patchedSource = originalSource
    .replace(
      /const SYSTEM_PLUGINS_DIR = path\.resolve\(__dirname, '\.\.', '\.\.', 'plugins'\);/,
      `const SYSTEM_PLUGINS_DIR = ${JSON.stringify(srcPluginsDir)};`,
    )
    .replace(
      /const VENDOR_PLUGINS_DIR = path\.resolve\(__dirname, '\.\.', '\.\.', '\.\.', 'vendor', 'plugins'\);/,
      `const VENDOR_PLUGINS_DIR = ${JSON.stringify(vendorPluginsDir)};`,
    );

  // Write to a temp file and require it.
  const tmpFile = modulePath + '.test-patch.cjs';
  fs.writeFileSync(tmpFile, patchedSource);
  try {
    delete require.cache[require.resolve(tmpFile)];
    const mod = require(tmpFile);
    return { mod, tmpFile };
  } catch (err) {
    fs.unlinkSync(tmpFile);
    throw err;
  }
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('init loads plugins from src/plugins and vendor/plugins', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir,    { recursive: true });
  await fsp.mkdir(vendorDir, { recursive: true });

  await makePlugin(srcDir,    'obsidian-web-layout');
  await makePlugin(vendorDir, 'obsidian-livesync');

  const { mod, tmpFile } = loadModuleWithDirs(srcDir, vendorDir);
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch (_) {} });

  mod.init();

  const ids = mod.getSystemPluginIds();
  assert.ok(ids.includes('obsidian-web-layout'), 'src plugin loaded');
  assert.ok(ids.includes('obsidian-livesync'),   'vendor plugin loaded');
  assert.equal(ids.length, 2, 'exactly 2 plugins');
});

test('getSystemPluginDir returns correct rootDir per id', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir,    { recursive: true });
  await fsp.mkdir(vendorDir, { recursive: true });

  const srcPluginDir    = await makePlugin(srcDir,    'obsidian-web-layout');
  const vendorPluginDir = await makePlugin(vendorDir, 'obsidian-livesync');

  const { mod, tmpFile } = loadModuleWithDirs(srcDir, vendorDir);
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch (_) {} });

  mod.init();

  assert.equal(mod.getSystemPluginDir('obsidian-web-layout'), srcPluginDir,    'src plugin dir correct');
  assert.equal(mod.getSystemPluginDir('obsidian-livesync'),   vendorPluginDir, 'vendor plugin dir correct');
  assert.equal(mod.getSystemPluginDir('nonexistent'),         null,            'unknown id returns null');
});

test('tryGetSystemFilePath resolves files from both src and vendor', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir,    { recursive: true });
  await fsp.mkdir(vendorDir, { recursive: true });

  const srcPluginDir    = await makePlugin(srcDir,    'obsidian-web-layout');
  const vendorPluginDir = await makePlugin(vendorDir, 'obsidian-livesync');

  const { mod, tmpFile } = loadModuleWithDirs(srcDir, vendorDir);
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch (_) {} });

  mod.init();

  const srcResolved = mod.tryGetSystemFilePath('.obsidian/plugins/obsidian-web-layout/main.js');
  assert.equal(srcResolved, path.join(srcPluginDir, 'main.js'), 'src file resolves');

  const vendorResolved = mod.tryGetSystemFilePath('.obsidian/plugins/obsidian-livesync/main.js');
  assert.equal(vendorResolved, path.join(vendorPluginDir, 'main.js'), 'vendor file resolves');

  const noFile = mod.tryGetSystemFilePath('.obsidian/plugins/obsidian-livesync/nonexistent.js');
  assert.equal(noFile, null, 'missing file returns null');
});

test('duplicate id: src/plugins wins over vendor/plugins', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir,    { recursive: true });
  await fsp.mkdir(vendorDir, { recursive: true });

  // Same id in both directories.
  const srcPluginDir = await makePlugin(srcDir,    'shared-plugin');
  await makePlugin(vendorDir, 'shared-plugin');

  // Write a unique marker file only in the src copy.
  await fsp.writeFile(path.join(srcPluginDir, 'src-marker.txt'), 'from src');

  const { mod, tmpFile } = loadModuleWithDirs(srcDir, vendorDir);
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch (_) {} });

  mod.init();

  const ids = mod.getSystemPluginIds();
  assert.equal(ids.filter(id => id === 'shared-plugin').length, 1, 'id appears once');

  const dir = mod.getSystemPluginDir('shared-plugin');
  assert.equal(dir, srcPluginDir, 'src/plugins wins');

  // File that only exists in src copy should resolve.
  const marker = mod.tryGetSystemFilePath('.obsidian/plugins/shared-plugin/src-marker.txt');
  assert.ok(marker && marker.endsWith('src-marker.txt'), 'marker from src resolves');
});

test('ENOENT on vendor/plugins is handled gracefully', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  // Intentionally do NOT create vendor/plugins.
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir, { recursive: true });

  await makePlugin(srcDir, 'obsidian-web-layout');

  const { mod, tmpFile } = loadModuleWithDirs(srcDir, vendorDir);
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch (_) {} });

  // Must not throw even though vendor/plugins doesn't exist.
  assert.doesNotThrow(() => mod.init(), 'init does not throw on missing vendor/plugins');

  const ids = mod.getSystemPluginIds();
  assert.ok(ids.includes('obsidian-web-layout'), 'src plugin still loaded');
  assert.equal(ids.length, 1, 'exactly 1 plugin');
});

test('path traversal is blocked', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir,    { recursive: true });
  await fsp.mkdir(vendorDir, { recursive: true });

  await makePlugin(srcDir, 'my-plugin');

  const { mod, tmpFile } = loadModuleWithDirs(srcDir, vendorDir);
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch (_) {} });

  mod.init();

  // Attempt path traversal.
  const result = mod.tryGetSystemFilePath('.obsidian/plugins/my-plugin/../../etc/passwd');
  assert.equal(result, null, 'path traversal blocked');
});
