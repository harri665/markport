/**
 * System plugin distribution API — for OPFS (local) vaults.
 *
 * Server vaults get system plugins overlaid live over /api/fs (see
 * ../system-plugins.js + api/fs.js — tryGetSystemFilePath, mergeCommunityList).
 * OPFS vaults never touch /api/fs, so the client-side boot instead seeds
 * them once from these two endpoints (see client-mobile/boot.js
 * seedSystemPlugins()):
 *
 *   GET /api/system-plugins               → manifest: ids + files + version
 *   GET /api/system-plugin-file?id=&file= → raw bytes of one plugin file
 *
 * The file endpoint reuses tryGetSystemFilePath — the same traversal-safe
 * resolver the /api/fs overlay already relies on — so an unknown id or a
 * `..` segment simply resolves to null → 404, with no separate guard logic
 * to keep in sync.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const {
  getSystemPluginIds,
  getSystemPluginDir,
  tryGetSystemFilePath,
} = require('../system-plugins');

const MIME_BY_EXT = {
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.css': 'text/css',
};

// Which system plugins to auto-seed into OPFS vaults, and whether to enable
// them. Default: ONLY the lightweight layout switcher (enabled). Heavier /
// opt-in plugins like obsidian-livesync stay out of the auto-seed — the user
// installs them via Community plugins → Browse when they want them.
// A deployment (e.g. the Cloudflare edge build) can pre-seed more, optionally
// DISABLED (files land in OPFS but the plugin is not added to the enabled list):
//   SYSTEM_PLUGINS_SEED='obsidian-web-layout'          (comma list — seeded + enabled)
//   SYSTEM_PLUGINS_SEED_DISABLED='obsidian-livesync'   (comma list — seeded, NOT enabled)
function parseList(v) { return (v || '').split(',').map((s) => s.trim()).filter(Boolean); }
const SEED_ENABLED = new Set(parseList(process.env.SYSTEM_PLUGINS_SEED || 'obsidian-web-layout'));
const SEED_DISABLED = new Set(parseList(process.env.SYSTEM_PLUGINS_SEED_DISABLED));

function createSystemPluginFilesRouter() {
  const router = express.Router();

  // Manifest: only the plugins configured for auto-seed (see SEED_ENABLED /
  // SEED_DISABLED above), each with its version, on-disk files, and whether it
  // should be enabled after seeding.
  router.get('/system-plugins', (req, res) => {
    const plugins = getSystemPluginIds()
      .filter((id) => SEED_ENABLED.has(id) || SEED_DISABLED.has(id))
      .map((id) => {
      const dir = getSystemPluginDir(id);
      let version = '0.0.0';
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        if (manifest && typeof manifest.version === 'string') version = manifest.version;
      } catch (_) { /* keep fallback version */ }

      let files = [];
      try {
        files = fs.readdirSync(dir).filter((name) => {
          try {
            return fs.statSync(path.join(dir, name)).isFile();
          } catch (_) {
            return false;
          }
        });
      } catch (_) { /* dir vanished mid-request: empty file list */ }

      return { id, version, files, enabled: SEED_ENABLED.has(id) };
    });
    res.json({ plugins });
  });

  // Raw file bytes for one system plugin file.
  router.get('/system-plugin-file', (req, res) => {
    const id = req.query.id;
    const file = req.query.file;
    if (typeof id !== 'string' || typeof file !== 'string' || !id || !file) {
      return res.status(400).json({ error: 'id and file query params required' });
    }

    const relPath = '.obsidian/plugins/' + id + '/' + file;
    const absPath = tryGetSystemFilePath(relPath);
    if (!absPath) {
      return res.status(404).json({ error: 'not found' });
    }

    res.type(MIME_BY_EXT[path.extname(absPath)] || 'application/octet-stream');
    res.sendFile(absPath);
  });

  return router;
}

module.exports = createSystemPluginFilesRouter;
