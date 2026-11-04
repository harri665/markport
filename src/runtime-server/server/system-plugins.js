/**
 * System plugin overlay.
 *
 * This module scans two directories at startup and tracks plugin ids
 * whose source lives in the repo or in vendor/plugins (downloaded
 * third-party plugins).  The HTTP FS API (server/api/fs.js) consults
 * these helpers to overlay system plugin files on top of the vault's
 * filesystem:
 *
 *   - Reads/stats for .obsidian/plugins/<id>/<file> fall back to the
 *     correct directory copy when the vault doesn't have it.
 *   - Reads of .obsidian/community-plugins.json have system ids merged
 *     in, so Obsidian sees them as enabled.
 *   - Writes of .obsidian/community-plugins.json have system ids
 *     stripped, so we don't pollute the user's vault.
 *
 * Precedence: src/plugins/ wins over vendor/plugins/ (first-wins).
 * So our own plugins can override a vendored third-party plugin with
 * the same id if needed.
 *
 * Result: a user can open any vault and both layout-switcher and
 * any vendored plugin (e.g. obsidian-livesync) appear automatically —
 * without us ever touching files inside the vault directory.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// src/plugins/ — our own plugins, tracked in git.
const SYSTEM_PLUGINS_DIR = path.resolve(__dirname, '..', '..', 'plugins');

// vendor/plugins/ — downloaded third-party plugins, gitignored.
const VENDOR_PLUGINS_DIR = path.resolve(__dirname, '..', '..', '..', 'vendor', 'plugins');

// Populated by init() — maps plugin id → absolute rootDir.
// src/plugins takes precedence over vendor/plugins (first-wins).
const SYSTEM_PLUGIN_DIRS = new Map();

function _scanDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('[system-plugins] no ' + dir + ' directory — skipping');
      return;
    }
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const manifestPath = path.join(dir, dirName, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      console.warn('[system-plugins] skipping ' + dirName + ' in ' + dir + ': cannot read manifest.json (' + err.message + ')');
      continue;
    }
    if (!manifest || typeof manifest.id !== 'string') {
      console.warn('[system-plugins] skipping ' + dirName + ' in ' + dir + ': manifest.json has no string id');
      continue;
    }
    if (manifest.id !== dirName) {
      console.warn('[system-plugins] skipping ' + dirName + ' in ' + dir + ': directory name does not match manifest id "' + manifest.id + '"');
      continue;
    }

    // first-wins: src/plugins (scanned first) takes precedence over vendor/plugins.
    if (SYSTEM_PLUGIN_DIRS.has(manifest.id)) {
      console.warn('[system-plugins] duplicate plugin id "' + manifest.id + '" in ' + dir + ' — keeping src/plugins copy');
      continue;
    }
    SYSTEM_PLUGIN_DIRS.set(manifest.id, path.join(dir, dirName));
  }
}

function init() {
  SYSTEM_PLUGIN_DIRS.clear();

  // Scan src/plugins first so it wins on duplicate ids.
  _scanDir(SYSTEM_PLUGINS_DIR);
  // Then vendor/plugins (may not exist until install-livesync.js runs).
  _scanDir(VENDOR_PLUGINS_DIR);

  const ids = getSystemPluginIds();
  console.log('[system-plugins] Loaded ' + ids.length + ' system plugins' + (ids.length ? ': ' + ids.join(', ') : ''));
}

function getSystemPluginIds() {
  return Array.from(SYSTEM_PLUGIN_DIRS.keys()).sort();
}

/**
 * Returns the absolute rootDir for a system plugin id, or null if unknown.
 */
function getSystemPluginDir(id) {
  return SYSTEM_PLUGIN_DIRS.get(id) || null;
}

/**
 * True if relPath points to either a known system plugin directory
 * (.obsidian/plugins/<id>) or any file inside it.
 */
function isSystemPluginPath(relPath) {
  if (typeof relPath !== 'string') return false;
  const m = relPath.match(/^\.obsidian\/plugins\/([^/]+)(?:\/.*)?$/);
  if (!m) return false;
  return SYSTEM_PLUGIN_DIRS.has(m[1]);
}

/**
 * Resolve relPath against the correct plugin directory if it points to a
 * real file inside a known system plugin directory. Returns absolute path
 * or null.
 *
 * Path-traversal safe: resolved path must stay inside the plugin's rootDir.
 */
function tryGetSystemFilePath(relPath) {
  if (typeof relPath !== 'string') return null;

  const prefix = '.obsidian/plugins/';
  if (!relPath.startsWith(prefix)) return null;

  const rest = relPath.slice(prefix.length);
  if (!rest) return null;

  const parts = rest.split('/');
  const id = parts[0];
  const pluginRoot = getSystemPluginDir(id);
  if (!pluginRoot) return null;

  // Resolve against the plugin root dir. Path traversal guard:
  // resolved path must stay inside pluginRoot.
  const resolved = path.resolve(pluginRoot, '.' + path.sep + parts.slice(1).join('/'));
  const normalizedRoot = path.resolve(pluginRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    return null;
  }

  // Must actually exist on disk. Caller treats null as "no overlay file".
  try {
    fs.statSync(resolved);
  } catch (_) {
    return null;
  }
  return resolved;
}

/**
 * Merge system plugin ids into a community-plugins.json array. Dedup.
 */
function mergeCommunityList(arr) {
  const base = Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  const set = new Set(base);
  for (const id of SYSTEM_PLUGIN_DIRS.keys()) set.add(id);
  return Array.from(set);
}

/**
 * Strip system plugin ids from a community-plugins.json array
 * (so we don't pollute the user's vault when Obsidian writes it back).
 */
function stripCommunityList(arr) {
  if (!Array.isArray(arr)) return arr;
  return arr.filter((x) => typeof x === 'string' && !SYSTEM_PLUGIN_DIRS.has(x));
}

module.exports = {
  init,
  getSystemPluginIds,
  getSystemPluginDir,
  isSystemPluginPath,
  tryGetSystemFilePath,
  mergeCommunityList,
  stripCommunityList,
  SYSTEM_PLUGINS_DIR,
};
