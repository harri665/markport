/**
 * cache-invalidation.js — pure helpers that mutate the bootstrap cache
 * in place. No browser/DOM deps — runs under node:test and inside the
 * browser via a plain <script> tag (attaches to window.__owCacheInvalidation).
 *
 * Called from capacitor-shim's mutation methods (writeFile, mkdir, rmdir,
 * rename, copy, deleteFile, appendFile) and from the WebSocket watch
 * handler so chokidar-detected external changes invalidate the right
 * cache entries.
 */
(function () {
  'use strict';

  /**
   * Drop a single path's stat+content and its parent dir listing.
   * Used for writes/deletes of a single file or empty directory.
   */
  function invalidateCacheEntry(cache, p) {
    if (!cache) return;
    if (cache.fs) {
      delete cache.fs[p];
    }
    if (cache.dirs) {
      const parent = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
      delete cache.dirs[parent];
    }
  }

  /**
   * Drop the whole subtree at `prefix` (the prefix path itself + everything
   * under it). Use for recursive rmdir, rename of a directory, or any
   * mutation whose target may have been a directory.
   *
   * NB: matches on `prefix` exactly OR `prefix + '/'` — so a sibling whose
   * name happens to start with `prefix` (e.g. "Notes" vs "NotesSibling.md")
   * is NOT touched.
   */
  function invalidateCacheSubtree(cache, prefix) {
    if (!cache) return;
    const prefixSlash = prefix + '/';
    if (cache.fs) {
      for (const key of Object.keys(cache.fs)) {
        if (key === prefix || key.indexOf(prefixSlash) === 0) {
          delete cache.fs[key];
        }
      }
    }
    if (cache.dirs) {
      for (const key of Object.keys(cache.dirs)) {
        if (key === prefix || key.indexOf(prefixSlash) === 0) {
          delete cache.dirs[key];
        }
      }
      // Drop the prefix's parent dir listing too so readdir re-fetches.
      const parent = prefix.includes('/')
        ? prefix.substring(0, prefix.lastIndexOf('/'))
        : '';
      delete cache.dirs[parent];
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { invalidateCacheEntry, invalidateCacheSubtree };
  } else if (typeof window !== 'undefined') {
    window.__owCacheInvalidation = { invalidateCacheEntry, invalidateCacheSubtree };
  }
})();
