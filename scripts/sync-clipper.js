#!/usr/bin/env node
/**
 * Keep Markport Clipper on this computer in step with this repo: the
 * Obsidian plugin in your desktop vaults, and the browser extension in
 * Chrome / Edge / Brave.
 *
 *   npm run clipper                       update the plugin in every vault that has it
 *   npm run clipper -- --add <vault>      also install it into a vault and enable it
 *                                         (<vault>: its folder, or its name as Obsidian shows it)
 *   npm run clipper -- --dry-run          only say what would change
 *
 * Run it after `git pull`, on each computer. Vaults come from desktop
 * Obsidian's own list (obsidian.json), so there is nothing to configure.
 * Only the plugin's code is copied (manifest.json, main.js, styles.css);
 * data.json - its settings, pairing key and image library - is never
 * touched. A vault that is synced between computers (NextCloud, Obsidian
 * Sync...) gets the update on the others through that sync, so running this
 * on a second computer is harmless: everything is already up to date.
 *
 * The browser extension can't be installed by a script: load
 * src/browser-extension/ unpacked once in each browser (it then runs from
 * this folder). This reports where each browser loads Markport Clipper
 * from, so a copy outside this repo or one that needs a reload stands out.
 *
 * Plain Node 18+, no dependencies.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_ID = 'markport-clipper';
const PLUGIN_DIR = path.join(ROOT, 'src', 'plugins', PLUGIN_ID);
const PLUGIN_FILES = ['manifest.json', 'main.js', 'styles.css'];
const EXTENSION_DIR = path.join(ROOT, 'src', 'browser-extension');
const IS_WIN = process.platform === 'win32';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function versionOf(dir) {
  const m = readJson(path.join(dir, 'manifest.json'));
  return m && typeof m.version === 'string' ? m.version : null;
}

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return IS_WIN ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

// ── Desktop Obsidian's vaults ───────────────────────────────────────────────

function obsidianConfigFiles() {
  const home = os.homedir();
  if (IS_WIN) return [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json')];
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')];
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    path.join(config, 'obsidian', 'obsidian.json'),
    path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),   // Flatpak
    path.join(home, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json'),          // Snap
  ];
}

// [{ path, name, open }] for every vault desktop Obsidian knows that still exists.
function knownVaults() {
  const out = [];
  for (const file of obsidianConfigFiles()) {
    const cfg = readJson(file);
    for (const v of Object.values((cfg && cfg.vaults) || {})) {
      if (!v || typeof v.path !== 'string' || !fs.existsSync(v.path)) continue;
      if (out.some((o) => samePath(o.path, v.path))) continue;
      out.push({ path: v.path, name: path.basename(v.path), open: v.open === true });
    }
  }
  return out;
}

function findVault(arg, vaults) {
  if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
    return vaults.find((v) => samePath(v.path, arg)) || { path: path.resolve(arg), name: path.basename(arg), open: false };
  }
  const hits = vaults.filter((v) => v.name.toLowerCase() === arg.toLowerCase());
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) fail(`"${arg}" matches more than one vault:\n  ${hits.map((v) => v.path).join('\n  ')}\nPass the folder instead.`);
  fail(`No vault called "${arg}". Desktop Obsidian knows:\n  ${vaults.map((v) => v.name + '  (' + v.path + ')').join('\n  ') || '(none)'}`);
}

// ── The plugin ──────────────────────────────────────────────────────────────

const pluginDest = (vault) => path.join(vault.path, '.obsidian', 'plugins', PLUGIN_ID);

function syncPlugin(vault, dryRun) {
  const dest = pluginDest(vault);
  const before = versionOf(dest);
  const changed = PLUGIN_FILES.filter((f) => {
    const src = fs.readFileSync(path.join(PLUGIN_DIR, f));
    let cur = null;
    try { cur = fs.readFileSync(path.join(dest, f)); } catch (_) { /* missing */ }
    return !cur || !cur.equals(src);
  });
  if (changed.length && !dryRun) {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of changed) fs.copyFileSync(path.join(PLUGIN_DIR, f), path.join(dest, f));
  }
  return { before, changed };
}

// Adds the plugin to the vault's enabled list. Returns true if it was not there.
function enablePlugin(vault, dryRun) {
  const file = path.join(vault.path, '.obsidian', 'community-plugins.json');
  const list = readJson(file);
  const ids = Array.isArray(list) ? list : [];
  if (ids.includes(PLUGIN_ID)) return false;
  if (!dryRun) fs.writeFileSync(file, JSON.stringify(ids.concat(PLUGIN_ID), null, 2));
  return true;
}

// ── Browsers ────────────────────────────────────────────────────────────────

function browserRoots() {
  const home = os.homedir();
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      ['Chrome', path.join(local, 'Google', 'Chrome', 'User Data')],
      ['Edge', path.join(local, 'Microsoft', 'Edge', 'User Data')],
      ['Brave', path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ];
  }
  if (process.platform === 'darwin') {
    const sup = path.join(home, 'Library', 'Application Support');
    return [
      ['Chrome', path.join(sup, 'Google', 'Chrome')],
      ['Edge', path.join(sup, 'Microsoft Edge')],
      ['Brave', path.join(sup, 'BraveSoftware', 'Brave-Browser')],
    ];
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    ['Chrome', path.join(config, 'google-chrome')],
    ['Chromium', path.join(config, 'chromium')],
    ['Edge', path.join(config, 'microsoft-edge')],
    ['Brave', path.join(config, 'BraveSoftware', 'Brave-Browser')],
  ];
}

// Every unpacked Markport Clipper the browsers have, read from their own
// settings files (read only). [{ browser, profile, dir, onDisk, loaded }]
function loadedExtensions() {
  const out = [];
  for (const [browser, root] of browserRoots()) {
    let profiles = [];
    try { profiles = fs.readdirSync(root).filter((d) => d === 'Default' || /^Profile \d+$/.test(d)); } catch (_) { continue; }
    for (const profile of profiles) {
      const seen = new Set();
      for (const name of ['Secure Preferences', 'Preferences']) {
        const prefs = readJson(path.join(root, profile, name));
        const settings = (prefs && prefs.extensions && prefs.extensions.settings) || {};
        for (const [id, s] of Object.entries(settings)) {
          if (seen.has(id) || !s || typeof s.path !== 'string' || !path.isAbsolute(s.path)) continue;
          const manifest = readJson(path.join(s.path, 'manifest.json'));
          if (!manifest || manifest.name !== 'Markport Clipper') continue;
          seen.add(id);
          const reg = s.service_worker_registration_info;
          out.push({ browser, profile, dir: s.path, onDisk: manifest.version, loaded: reg && reg.version });
        }
      }
    }
  }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────

function fail(msg) { console.error('[clipper] ' + msg); process.exit(1); }

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const adds = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--add') {
      if (!args[i + 1]) fail('--add needs a vault: its folder or its name.');
      adds.push(args[++i]);
    } else if (args[i] !== '--dry-run') {
      fail('Unknown argument ' + args[i] + '. Usage: npm run clipper -- [--add <vault>]... [--dry-run]');
    }
  }
  const version = versionOf(PLUGIN_DIR);
  const extVersion = versionOf(EXTENSION_DIR);
  const say = (msg) => console.log('[clipper] ' + msg);
  say(`This repo: plugin ${version}, extension ${extVersion}${dryRun ? '  (dry run: nothing is written)' : ''}`);

  // The plugin.
  const vaults = knownVaults();
  const targets = vaults.filter((v) => fs.existsSync(pluginDest(v)));
  for (const a of adds) {
    const v = findVault(a, vaults);
    if (!targets.some((t) => samePath(t.path, v.path))) targets.push(v);
    v.add = true;
  }
  console.log('');
  say('Obsidian plugin');
  if (!targets.length) {
    say('  No vault has it yet. Install it with: npm run clipper -- --add <vault>');
    if (vaults.length) say('  Your vaults: ' + vaults.map((v) => v.name).join(', '));
  }
  const restart = [];
  for (const v of targets) {
    const { before, changed } = syncPlugin(v, dryRun);
    const enabled = v.add ? enablePlugin(v, dryRun) : false;
    let what = !changed.length ? 'up to date'
      : !before ? 'installed'
      : before !== version ? `updated ${before} -> ${version}` : 'updated (' + changed.join(', ') + ')';
    if (enabled) what += ', enabled';
    say(`  ${v.name}: ${what}   ${v.path}`);
    if (changed.length || enabled) restart.push(v);
  }
  if (restart.length && !dryRun) {
    say('  Obsidian loads plugin code at startup: restart Obsidian (or turn the plugin off and on)'
      + (restart.some((v) => v.add) ? '. In a vault that never used community plugins, Obsidian asks once to turn them on' : '') + '.');
  }

  // The extension.
  console.log('');
  say('Browser extension');
  const exts = loadedExtensions();
  if (!exts.length) {
    say('  Not loaded in Chrome, Edge or Brave. In each browser: open its extensions page, turn on');
    say('  Developer mode, "Load unpacked", and pick ' + EXTENSION_DIR);
  }
  for (const e of exts) {
    const where = `  ${e.browser} (${e.profile}): `;
    if (!samePath(e.dir, EXTENSION_DIR)) {
      say(where + `loaded from ANOTHER folder, ${e.dir} (${e.onDisk}).`);
      say('    Remove it there, then "Load unpacked" ' + EXTENSION_DIR);
    } else if (e.loaded && e.loaded !== extVersion) {
      say(where + `this repo, but the browser still runs ${e.loaded}: reload it on its extensions page.`);
    } else {
      say(where + `this repo, ${extVersion}. After a git pull that changes it, reload it on the extensions page.`);
    }
  }
}

main();
