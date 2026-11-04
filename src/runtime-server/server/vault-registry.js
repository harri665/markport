const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class VaultRegistry {
  constructor(registryPath) {
    this.registryPath = registryPath;
    this.vaults = this.load();
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) || {};
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      // Corrupt or unreadable file — start empty and log, don't crash the server.
      console.error('[vault-registry] corrupt registry, starting empty:', err.message);
      return {};
    }
  }

  save() {
    const dir = path.dirname(this.registryPath);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to a temp file then rename over the final path so a
    // crash mid-write doesn't leave a partial/invalid JSON file.
    const tmp = this.registryPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.vaults, null, 2));
    fs.renameSync(tmp, this.registryPath);
  }

  list() {
    return { ...this.vaults };
  }

  get(id) {
    return this.vaults[id] || null;
  }

  findIdByPath(vaultPath) {
    const resolved = path.resolve(vaultPath);
    for (const [id, vault] of Object.entries(this.vaults)) {
      if (path.resolve(vault.path) === resolved) return id;
    }
    return null;
  }

  open(vaultPath, create) {
    if (!vaultPath || typeof vaultPath !== 'string') {
      return { ok: false, error: 'folder not found' };
    }

    const resolved = path.resolve(vaultPath);
    if (create) {
      fs.mkdirSync(resolved, { recursive: true });
    }

    let stats;
    try {
      stats = fs.statSync(resolved);
    } catch (err) {
      return { ok: false, error: 'folder not found' };
    }

    if (!stats.isDirectory()) {
      return { ok: false, error: 'path is not a folder' };
    }

    try {
      fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
      return { ok: false, error: 'no permission to access folder' };
    }

    const existingId = this.findIdByPath(resolved);
    const id = existingId || crypto.randomBytes(8).toString('hex');
    this.vaults[id] = {
      path: resolved,
      ts: Date.now(),
      open: true,
    };
    this.save();
    return { ok: true, id };
  }

  /**
   * Register every top-level folder of `dir` as a vault, so a server deployment
   * (VAULTS_DIR, e.g. a Docker volume) lists its vaults on the start screen
   * without anyone calling /api/vaults/open first. Folders are the source of
   * truth: a registered vault inside `dir` whose folder is gone is dropped.
   * When `dir` holds no vault folders, `defaultName` is created so a fresh
   * install has somewhere to write. Hidden folders (".trash", ".git") are skipped.
   * Returns the ids of the vaults found in `dir`.
   */
  syncDir(dir, defaultName) {
    const root = path.resolve(dir);
    fs.mkdirSync(root, { recursive: true });

    const folders = () => fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(root, e.name));

    let found = folders();
    if (found.length === 0 && defaultName) {
      fs.mkdirSync(path.join(root, defaultName), { recursive: true });
      found = folders();
    }

    let changed = false;
    for (const [id, vault] of Object.entries(this.vaults)) {
      const p = path.resolve(vault.path);
      if (path.dirname(p) === root && !fs.existsSync(p)) {
        delete this.vaults[id];
        changed = true;
      }
    }

    const ids = [];
    for (const folder of found) {
      let id = this.findIdByPath(folder);
      if (!id) {
        id = crypto.randomBytes(8).toString('hex');
        this.vaults[id] = { path: folder, ts: Date.now(), open: false };
        changed = true;
      }
      ids.push(id);
    }

    if (changed) this.save();
    return ids;
  }

  remove(vaultPath) {
    const id = this.findIdByPath(vaultPath);
    if (!id) return false;
    delete this.vaults[id];
    this.save();
    return true;
  }

  move(oldPath, newPath) {
    if (!oldPath || typeof oldPath !== 'string') return { ok: false, notFound: true };
    const id = this.findIdByPath(oldPath);
    if (!id) return { ok: false, notFound: true };

    const resolvedNewPath = path.resolve(newPath);
    try {
      fs.renameSync(this.vaults[id].path, resolvedNewPath);
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }

    this.vaults[id] = {
      ...this.vaults[id],
      path: resolvedNewPath,
      ts: Date.now(),
    };
    this.save();
    return { ok: true };
  }
}

module.exports = VaultRegistry;
