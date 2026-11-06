/**
 * bootstrap-lookup.js — pure lookup helpers over a bootstrap cache object.
 *
 * No browser/DOM deps — runs under node:test and inside the browser via a
 * plain <script> tag (attaches to window.__owBootstrapLookup).
 *
 * Cache shape (as returned from /api/bootstrap):
 *   {
 *     fs:   { [relPath]: { content?, size, mtime, isFile, isDirectory } },
 *     dirs: { [relPath]: [{ name, size, mtime, isFile, isDirectory }] },
 *     electron: { ... },
 *     disabled?: true,
 *     capped?: true, cappedReason?: string
 *   }
 */
(function () {
  'use strict';

  function lookupContent(cache, p, encoding) {
    if (!encoding) return null;
    if (!cache || !cache.fs) return null;
    const entry = cache.fs[p];
    if (!entry || typeof entry.content !== 'string') return null;
    return entry.content;
  }

  function lookupStat(cache, p) {
    if (!cache || !cache.fs) return null;
    const entry = cache.fs[p];
    if (!entry) return null;
    return {
      type:  entry.isDirectory ? 'directory' : 'file',
      size:  entry.size || 0,
      mtime: entry.mtime || 0,
      ctime: entry.mtime || 0,
      uri:   '',
    };
  }

  function lookupDir(cache, p) {
    if (!cache || !cache.dirs) return null;
    const entries = cache.dirs[p];
    if (!entries) return null;
    return entries.map(function (e) {
      return {
        name:  e.name,
        type:  e.isDirectory ? 'directory' : 'file',
        size:  e.size || 0,
        mtime: e.mtime || 0,
        uri:   '',
        ctime: e.mtime || 0,
      };
    });
  }

  /**
   * True when the cache proves `p` does not exist: its parent's listing is
   * cached and has no entry by that name. Obsidian probes a dozen config
   * files that a vault usually lacks (hotkeys.json, graph.json, ...), and
   * each 404 was a round-trip made one after another during startup.
   *
   * Safe against changes made since the response was built: every write,
   * delete and watch event drops the parent's listing (cache-invalidation.js),
   * and with no listing this answers false. Names compare case-insensitively,
   * so a file a case-insensitive server disk would still find is never
   * reported missing.
   */
  function lookupMissing(cache, p) {
    if (!cache || !cache.dirs || !cache.fs || !p) return false;
    if (cache.fs[p]) return false;
    const slash = p.lastIndexOf('/');
    const entries = cache.dirs[slash === -1 ? '' : p.substring(0, slash)];
    if (!entries) return false;
    const name = (slash === -1 ? p : p.substring(slash + 1)).toLowerCase();
    if (!name) return false;
    for (let i = 0; i < entries.length; i++) {
      if (String(entries[i].name).toLowerCase() === name) return false;
    }
    return true;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { lookupContent, lookupStat, lookupDir, lookupMissing };
  } else if (typeof window !== 'undefined') {
    window.__owBootstrapLookup = { lookupContent, lookupStat, lookupDir, lookupMissing };
  }
})();
