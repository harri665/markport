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

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { lookupContent, lookupStat, lookupDir };
  } else if (typeof window !== 'undefined') {
    window.__owBootstrapLookup = { lookupContent, lookupStat, lookupDir };
  }
})();
