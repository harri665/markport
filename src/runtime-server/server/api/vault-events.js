/**
 * Vault change hub.
 *
 * Every change made through /api/fs is published here the moment it is
 * made, and api/watch.js pushes it to every other session watching that
 * vault (web tabs, the native markport-sync plugin). Without this, sessions
 * only learned about each other's edits from chokidar, which waits for the
 * write to settle (awaitWriteFinish), polls every few seconds on NFS/SMB
 * (WATCH_POLLING), and never sees a write that is still buffered by the
 * write coalescer in api/fs.js.
 *
 * Paths are absolute, so one change reaches both a whole-vault watcher and a
 * share's watcher rooted at a subfolder of that vault.
 *
 * The session that made a change is named by its client id (the `client`
 * query/body parameter) and is not sent its own change back. Chokidar later
 * reports the same change from disk; isEcho() recognizes it so it is not
 * sent a second time: a file event is an echo only when the file still has
 * the mtime and size the hub published, so a real external edit made right
 * after ours still goes out.
 */

'use strict';

const { EventEmitter } = require('events');
const path = require('path');

const ECHO_WINDOW_MS = 30 * 1000;
const MAX_REMEMBERED = 5000;

function createVaultEvents(opts = {}) {
  const echoWindowMs = opts.echoWindowMs || ECHO_WINDOW_MS;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  // absolute path → { type, at, mtime, size }
  const recent = new Map();

  function prune() {
    const cutoff = Date.now() - echoWindowMs;
    for (const [k, e] of recent) if (e.at < cutoff) recent.delete(k);
    // Still too many (a huge copy or import): drop the oldest.
    while (recent.size > MAX_REMEMBERED) recent.delete(recent.keys().next().value);
  }

  // Record what disk is about to show for absPath, without telling anyone.
  // Used when a buffered write is finally flushed: the change was already
  // published when the write came in.
  function expect(absPath, type, meta = {}) {
    const key = path.resolve(absPath);
    recent.delete(key);   // re-insert so Map order stays oldest-first
    recent.set(key, { type, at: Date.now(), mtime: meta.mtime, size: meta.size });
    if (recent.size > MAX_REMEMBERED) prune();
  }

  // type: add | change | unlink | addDir | unlinkDir
  // origin: client id of the session that made the change (or null)
  // meta: { mtime, size } for files
  function publish(absPath, type, origin, meta = {}) {
    const abs = path.resolve(absPath);
    expect(abs, type, meta);
    emitter.emit('change', {
      abs,
      type,
      origin: origin || null,
      mtime: meta.mtime,
      size: meta.size,
    });
  }

  // Is this chokidar event just disk catching up with something published?
  // stats: the fs.Stats chokidar (or the caller) has for the path, if any.
  function isEcho(absPath, type, stats) {
    const key = path.resolve(absPath);
    const e = recent.get(key);
    if (!e) return false;
    if (Date.now() - e.at > echoWindowMs) {
      recent.delete(key);
      return false;
    }
    let echo;
    if (type === 'add' || type === 'change') {
      echo = (e.type === 'add' || e.type === 'change')
        && !!stats && e.mtime != null
        && Math.abs(stats.mtimeMs - e.mtime) < 1 && stats.size === e.size;
    } else {
      echo = e.type === type;
    }
    // Something other than us touched the path: forget our record, so a
    // later external event on it can't be mistaken for an echo.
    if (!echo) recent.delete(key);
    return echo;
  }

  return {
    publish,
    expect,
    isEcho,
    on: (fn) => emitter.on('change', fn),
    off: (fn) => emitter.off('change', fn),
  };
}

module.exports = { createVaultEvents };
