#!/usr/bin/env node
'use strict';

/**
 * install-livesync.js
 *
 * Downloads the obsidian-livesync plugin from GitHub releases and
 * installs it into vendor/plugins/obsidian-livesync/.
 *
 * After running this script, the system-plugins overlay will serve
 * the plugin automatically to any vault opened via obsidian-web.
 *
 * Usage:
 *   node scripts/install-livesync.js
 *   node scripts/install-livesync.js --version v0.23.8
 *   node scripts/install-livesync.js --force
 */

const fs  = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR    = path.join(PROJECT_ROOT, '.tmp', 'cache', 'livesync-releases');
const TARGET_DIR   = path.join(PROJECT_ROOT, 'vendor', 'plugins', 'obsidian-livesync');
const GITHUB_API   = 'https://api.github.com/repos/vrtmrz/obsidian-livesync/releases';
const USER_AGENT   = 'obsidian-web-installer';

// Required assets that must be present in the release. fail loud if missing.
const REQUIRED_ASSETS = ['main.js', 'manifest.json'];
// Optional assets downloaded if present.
const OPTIONAL_ASSETS = ['styles.css'];

// ── helpers ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { version: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version') {
      opts.version = argv[++i];
      if (!opts.version) throw new Error('--version requires a value');
    } else if (arg.startsWith('--version=')) {
      opts.version = arg.slice('--version='.length);
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetries(label, fn, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (err.retryable === false || attempt === attempts) break;
      console.warn(`${label} failed (${err.message}); retrying ${attempt + 1}/${attempts}…`);
      await sleep(attempt * 1000);
    }
  }
  throw lastErr;
}

function request(url, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: json ? 'application/vnd.github+json' : 'application/octet-stream',
        'User-Agent': USER_AGENT,
      },
    }, (res) => {
      // Follow redirects.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(request(new URL(res.headers.location, url).toString(), { json }));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const err = new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`);
          err.retryable = res.statusCode >= 500;
          reject(err);
        });
        return;
      }
      resolve(res);
    });
    req.on('error', err => { err.retryable = true; reject(err); });
  });
}

async function getJson(url) {
  return withRetries(`GET ${url}`, async () => {
    const res = await request(url, { json: true });
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  });
}

async function fetchRelease(version) {
  if (!version) return getJson(`${GITHUB_API}/latest`);
  const tag = version.startsWith('v') ? version : `v${version}`;
  return getJson(`${GITHUB_API}/tags/${encodeURIComponent(tag)}`);
}

/**
 * Pick a named asset from the release. Returns the asset object or null.
 */
function findAsset(release, name) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.find(a => a.name === name) || null;
}

async function fileExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * Download a single release asset to a local file.
 * Uses a .download temp file to avoid partial writes.
 */
async function downloadAsset(asset, destination, force) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  if (!force && await fileExists(destination)) {
    console.log(`  Using cached ${path.relative(PROJECT_ROOT, destination)}`);
    return;
  }
  console.log(`  Downloading ${asset.name} (${(asset.size / 1024).toFixed(0)} KB)…`);
  await withRetries(`download ${asset.name}`, async () => {
    const tmp = `${destination}.download`;
    await fsp.rm(tmp, { force: true });
    try {
      const res = await request(asset.browser_download_url);
      await pipeline(res, fs.createWriteStream(tmp));
      await fsp.rename(tmp, destination);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  });
}

/**
 * Pick asset-download logic — pure function, testable without network.
 * Returns { required: [{asset, name}], optional: [{asset, name}] } or throws
 * if a required asset is missing.
 */
function resolveAssets(release) {
  const required = [];
  for (const name of REQUIRED_ASSETS) {
    const asset = findAsset(release, name);
    if (!asset) {
      throw new Error(
        `Required asset "${name}" not found in release ${release.tag_name}. ` +
        'Check https://github.com/vrtmrz/obsidian-livesync/releases for the actual asset names.',
      );
    }
    required.push({ asset, name });
  }

  const optional = [];
  for (const name of OPTIONAL_ASSETS) {
    const asset = findAsset(release, name);
    if (asset) optional.push({ asset, name });
  }

  return { required, optional };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log([
      'Usage: node scripts/install-livesync.js [options]',
      '',
      'Downloads obsidian-livesync from GitHub and installs it into',
      'vendor/plugins/obsidian-livesync/.',
      '',
      'Options:',
      '  --version <tag>  Specific version tag, e.g. v0.23.8 (default: latest)',
      '  --force          Re-download even if files are cached; overwrite data.json',
      '  -h, --help       Show this help',
    ].join('\n'));
    return;
  }

  // 1. Fetch release metadata.
  console.log(opts.version ? `Fetching release ${opts.version}…` : 'Fetching latest obsidian-livesync release…');
  const release = await fetchRelease(opts.version);
  const version = release.tag_name;
  console.log(`Release: ${version}`);

  // 2. Resolve assets — fail loud if required ones are missing.
  const { required, optional } = resolveAssets(release);

  // 3. Download required assets via cache.
  console.log('Downloading assets…');
  for (const { asset, name } of required) {
    const cachePath = path.join(CACHE_DIR, version, name);
    const destPath  = path.join(TARGET_DIR, name);
    await downloadAsset(asset, cachePath, opts.force);
    await fsp.mkdir(TARGET_DIR, { recursive: true });
    await fsp.copyFile(cachePath, destPath);
    const stat = await fsp.stat(destPath);
    console.log(`  ${name.padEnd(20)} ${(stat.size / 1024).toFixed(0)} KB  →  vendor/plugins/obsidian-livesync/${name}`);
  }

  // 4. Download optional assets (e.g. styles.css) — skip gracefully if absent.
  for (const { asset, name } of optional) {
    const cachePath = path.join(CACHE_DIR, version, name);
    const destPath  = path.join(TARGET_DIR, name);
    await downloadAsset(asset, cachePath, opts.force);
    await fsp.mkdir(TARGET_DIR, { recursive: true });
    await fsp.copyFile(cachePath, destPath);
    const stat = await fsp.stat(destPath);
    console.log(`  ${name.padEnd(20)} ${(stat.size / 1024).toFixed(0)} KB  →  vendor/plugins/obsidian-livesync/${name}`);
  }

  // 5. Read manifest to extract version string.
  const manifestPath = path.join(TARGET_DIR, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read downloaded manifest.json: ${err.message}`);
  }
  const pluginVersion = manifest.version || version;

  // 6. Write data.json — only if missing or --force.
  const dataJsonPath = path.join(TARGET_DIR, 'data.json');
  const dataJsonExists = await fileExists(dataJsonPath);
  if (!dataJsonExists || opts.force) {
    const dataJson = {
      version: pluginVersion,
      remote_type: 'couchdb',
      _obsidian_web_note: 'Configure your CouchDB URI in the LiveSync settings tab.',
    };
    await fsp.writeFile(dataJsonPath, JSON.stringify(dataJson, null, 2) + '\n', 'utf8');
    console.log(`  data.json             written (version: ${pluginVersion})`);
  } else {
    console.log(`  data.json             kept (already exists; use --force to overwrite)`);
  }

  console.log(`\nDone. obsidian-livesync ${pluginVersion} installed to vendor/plugins/obsidian-livesync/`);
  console.log('Restart the obsidian-web server for the plugin to become available.');
}

// ── exports for unit testing ─────────────────────────────────────────────────
module.exports = { resolveAssets, parseArgs };

// Run when invoked directly (not when require()d by tests).
if (require.main === module) {
  main().catch(err => { console.error('Error:', err.message); process.exit(1); });
}
