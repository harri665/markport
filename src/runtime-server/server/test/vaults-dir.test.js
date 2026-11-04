const assert = require('assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const test = require('node:test');

const VaultRegistry = require('../vault-registry');

async function tmpdir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'markport-vaults-dir-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('syncDir creates the default vault when the directory is empty', async (t) => {
  const tmp = await tmpdir(t);
  const vaultsDir = path.join(tmp, 'vaults');
  const registry = new VaultRegistry(path.join(tmp, 'registry.json'));

  const ids = registry.syncDir(vaultsDir, 'Notes');

  assert.equal(ids.length, 1);
  assert.ok(fs.statSync(path.join(vaultsDir, 'Notes')).isDirectory());
  assert.equal(registry.get(ids[0]).path, path.join(vaultsDir, 'Notes'));
  // persisted, so a restart sees the same id
  const reloaded = new VaultRegistry(path.join(tmp, 'registry.json'));
  assert.deepEqual(reloaded.syncDir(vaultsDir, 'Notes'), ids);
});

test('syncDir registers existing folders, skips hidden ones, keeps ids stable', async (t) => {
  const tmp = await tmpdir(t);
  const vaultsDir = path.join(tmp, 'vaults');
  await fsp.mkdir(path.join(vaultsDir, 'Work'), { recursive: true });
  await fsp.mkdir(path.join(vaultsDir, 'Personal'));
  await fsp.mkdir(path.join(vaultsDir, '.trash'));
  await fsp.writeFile(path.join(vaultsDir, 'stray.md'), 'not a vault');
  const registry = new VaultRegistry(path.join(tmp, 'registry.json'));

  const first = registry.syncDir(vaultsDir, 'Notes');
  const second = registry.syncDir(vaultsDir, 'Notes');

  assert.equal(first.length, 2);
  assert.deepEqual(second, first);
  assert.equal(fs.existsSync(path.join(vaultsDir, 'Notes')), false, 'no default when vaults exist');
  const paths = Object.values(registry.list()).map((v) => path.basename(v.path)).sort();
  assert.deepEqual(paths, ['Personal', 'Work']);
});

test('syncDir drops vaults whose folder was deleted, leaves vaults elsewhere alone', async (t) => {
  const tmp = await tmpdir(t);
  const vaultsDir = path.join(tmp, 'vaults');
  const outside = path.join(tmp, 'elsewhere');
  await fsp.mkdir(path.join(vaultsDir, 'Keep'), { recursive: true });
  await fsp.mkdir(path.join(vaultsDir, 'Gone'));
  await fsp.mkdir(outside);
  const registry = new VaultRegistry(path.join(tmp, 'registry.json'));
  registry.syncDir(vaultsDir, 'Notes');
  const outsideId = registry.open(outside, false).id;

  await fsp.rm(path.join(vaultsDir, 'Gone'), { recursive: true });
  registry.syncDir(vaultsDir, 'Notes');

  const names = Object.values(registry.list()).map((v) => path.basename(v.path)).sort();
  assert.deepEqual(names, ['Keep', 'elsewhere']);
  assert.ok(registry.get(outsideId));
});
