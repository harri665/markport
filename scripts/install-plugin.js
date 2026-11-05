#!/usr/bin/env node
/**
 * Install a specific release of a community plugin into a vault folder.
 *
 *   node scripts/install-plugin.js <vault-folder> <owner/repo> [version] [--enable]
 *
 * Obsidian's own plugin browser always installs the LATEST release. Markport
 * runs Obsidian 1.12.7, so a plugin whose latest release needs a newer
 * Obsidian (minAppVersion) can't be installed from there - pin an older
 * release with this instead. Examples:
 *
 *   # Claudian: 2.1.4 is the last release that supports Obsidian 1.12
 *   node scripts/install-plugin.js /data/vaults/Notes YishenTu/claudian 2.1.4 --enable
 *   # Latex Suite: 1.14.2 doesn't load its default snippets at startup; 1.14.1 does
 *   node scripts/install-plugin.js /data/vaults/Notes artisticat1/obsidian-latex-suite 1.14.1 --enable
 *
 * In the Docker image:
 *   docker compose exec markport node /app/scripts/install-plugin.js /data/vaults/Notes YishenTu/claudian 2.1.4 --enable
 *
 * Reload the vault in the browser afterwards. --enable adds the plugin to the
 * vault's enabled list; community plugins themselves must be turned on once
 * per browser (Settings > Community plugins), which Obsidian stores in the
 * browser, not in the vault.
 */

'use strict';

const fs = require('fs');
const path = require('path');

async function download(repo, version, file) {
  const url = version
    ? `https://github.com/${repo}/releases/download/${version}/${file}`
    : `https://github.com/${repo}/releases/latest/download/${file}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'markport-install-plugin' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

async function main() {
  const args = process.argv.slice(2);
  const enable = args.includes('--enable');
  const [vault, repo, version] = args.filter((a) => a !== '--enable');
  if (!vault || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error('usage: node scripts/install-plugin.js <vault-folder> <owner/repo> [version] [--enable]');
    process.exit(2);
  }
  if (!fs.existsSync(vault)) throw new Error(`vault folder not found: ${vault}`);

  const manifestBuf = await download(repo, version, 'manifest.json');
  if (!manifestBuf) throw new Error(`no manifest.json in release ${version || 'latest'} of ${repo}`);
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  if (!manifest.id || !/^[\w.-]+$/.test(manifest.id)) throw new Error('manifest.json has no usable id');

  const mainJs = await download(repo, version, 'main.js');
  if (!mainJs) throw new Error(`no main.js in release ${version || 'latest'} of ${repo}`);
  const styles = await download(repo, version, 'styles.css');

  const obsidianDir = path.join(vault, '.obsidian');
  const dir = path.join(obsidianDir, 'plugins', manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestBuf);
  fs.writeFileSync(path.join(dir, 'main.js'), mainJs);
  if (styles) fs.writeFileSync(path.join(dir, 'styles.css'), styles);
  console.log(`installed ${manifest.name} ${manifest.version} (id ${manifest.id}, needs Obsidian ${manifest.minAppVersion || '?'}) -> ${dir}`);

  if (enable) {
    const enabledFile = path.join(obsidianDir, 'community-plugins.json');
    const enabled = readJson(enabledFile, []);
    if (!enabled.includes(manifest.id)) enabled.push(manifest.id);
    fs.writeFileSync(enabledFile, JSON.stringify(enabled, null, 2));
    // "Turn on community plugins" (restricted mode off) is NOT in the vault:
    // Obsidian keeps it in the browser's localStorage, per browser.
    console.log(`enabled ${manifest.id} - reload the vault; if community plugins are still off in this browser, turn them on in Settings > Community plugins`);
  }
}

main().catch((err) => { console.error(err.message || err); process.exitCode = 1; });
