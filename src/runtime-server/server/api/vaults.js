const express = require('express');
const fs = require('fs');
const path = require('path');

// A vault name becomes one folder directly under VAULTS_DIR, so it must be a
// single, ordinary path segment. Characters Windows forbids are rejected too,
// so a volume stays portable if it is ever copied off a Linux host.
function validVaultName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255) return null;
  if (trimmed.startsWith('.')) return null;            // hidden: syncDir would skip it
  if (/[\\/<>:"|?*\x00-\x1f]/.test(trimmed)) return null;
  return trimmed;
}

function createVaultsRouter(vaultRegistry, vaultsDir) {
  const router = express.Router();

  // What the start screen may offer. `serverCreate` is true only when the
  // server owns a vaults directory (VAULTS_DIR, set by the Docker image) -
  // without one there is nowhere to put a new vault.
  router.get('/storage', (req, res) => {
    res.json({ serverCreate: !!vaultsDir });
  });

  router.post('/create', express.json(), (req, res) => {
    if (!vaultsDir) {
      return res.status(404).json({ ok: false, error: 'this server has no vaults directory' });
    }
    const name = validVaultName(req.body && req.body.name);
    if (!name) {
      return res.status(400).json({ ok: false, error: 'invalid vault name' });
    }
    const vaultPath = path.join(path.resolve(vaultsDir), name);
    try {
      fs.mkdirSync(vaultPath);   // not recursive: an existing folder is an error
    } catch (err) {
      if (err.code === 'EEXIST') {
        return res.status(409).json({ ok: false, error: 'a vault with that name already exists' });
      }
      return res.status(500).json({ ok: false, error: err.message });
    }
    const result = vaultRegistry.open(vaultPath, false);
    if (!result.ok) return res.status(500).json(result);
    res.json({ ok: true, id: result.id, name });
  });

  router.get('/list', (req, res) => {
    res.json(vaultRegistry.list());
  });

  router.post('/open', express.json(), (req, res) => {
    const result = vaultRegistry.open(req.body.path, req.body.create === true);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  router.post('/move', express.json(), (req, res) => {
    if (!req.body || typeof req.body.oldPath !== 'string' || typeof req.body.newPath !== 'string') {
      return res.status(400).json({ ok: false, error: 'oldPath and newPath are required' });
    }
    try {
      const result = vaultRegistry.move(req.body.oldPath, req.body.newPath);
      if (result.notFound) return res.status(404).json({ ok: false, error: 'vault not found' });
      if (!result.ok) return res.status(500).json({ ok: false, error: result.error, code: result.code });
      // Return { ok: true, value: '' } for backward compat with the Obsidian starter IPC shape.
      res.json({ ok: true, value: '' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/remove', express.json(), (req, res) => {
    if (!req.body || typeof req.body.path !== 'string') {
      return res.status(400).json({ ok: false, error: 'path is required' });
    }
    try {
      const removed = vaultRegistry.remove(req.body.path);
      if (!removed) return res.status(404).json({ ok: false, error: 'vault not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = createVaultsRouter;
