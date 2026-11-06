'use strict';

/**
 * The media cache: thumbnails, previews, optimized models and turntables.
 * Lives outside every vault (by default <data>/media-cache), so nothing
 * derived ever lands next to the user's originals.
 *
 * Entries are keyed by what they were made from - vault, path, mtime, size,
 * plus PIPELINE (bumped when the output format changes) - so a changed file
 * gets new entries and stale ones simply stop being asked for. trim() keeps
 * the folder under its size cap, oldest-used first (a hit touches the file).
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PIPELINE = 1;

function createCache(dir, maxBytes) {
  const root = path.resolve(dir);

  function key(vaultId, relPath, stat) {
    return crypto.createHash('sha1')
      .update([PIPELINE, vaultId, relPath, Math.floor(stat.mtimeMs), stat.size].join('\0'))
      .digest('hex');
  }

  // <root>/<area>/<k[0..2]>/<k><suffix>
  function file(area, k, suffix) {
    return path.join(root, area, k.slice(0, 2), k + suffix);
  }

  async function has(p) {
    try {
      const s = await fsp.stat(p);
      if (!s.isFile()) return false;
      // Touch: trim() drops the least recently used entries first.
      const now = new Date();
      fsp.utimes(p, now, now).catch(() => {});
      return true;
    } catch (_) {
      return false;
    }
  }

  // Write atomically: readers never see half a file.
  async function put(p, data) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, p);
  }

  async function adopt(tmpPath, p) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.rename(tmpPath, p);
  }

  function tmpFile(ext) {
    return path.join(root, 'tmp', crypto.randomBytes(12).toString('hex') + (ext || ''));
  }

  async function trim() {
    if (!(maxBytes > 0)) return { removed: 0 };
    const entries = [];
    let total = 0;
    const walk = async (d) => {
      let list;
      try { list = await fsp.readdir(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of list) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'uploads') await walk(p); continue; }
        try {
          const s = await fsp.stat(p);
          // Half-written files older than an hour are leftovers.
          if (e.name.endsWith('.tmp') && Date.now() - s.mtimeMs > 3600e3) { await fsp.rm(p, { force: true }); continue; }
          entries.push({ p, size: s.size, used: s.mtimeMs });
          total += s.size;
        } catch (_) { /* gone */ }
      }
    };
    await walk(root);
    if (total <= maxBytes) return { removed: 0, total };
    entries.sort((a, b) => a.used - b.used);
    let removed = 0;
    for (const e of entries) {
      if (total <= maxBytes * 0.9) break;
      await fsp.rm(e.p, { force: true }).catch(() => {});
      total -= e.size;
      removed++;
    }
    return { removed, total };
  }

  return { root, key, file, has, put, adopt, tmpFile, trim };
}

module.exports = { createCache, PIPELINE };
