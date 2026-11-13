/**
 * OPFS write worker — the fallback write path for browsers that have OPFS
 * but no `FileSystemFileHandle.createWritable()`.
 *
 * Safari (and so every iOS browser, all of which are WebKit) shipped OPFS
 * reads (`navigator.storage.getDirectory()`, Safari 15.2) years before
 * `createWritable()` (Safari 26). Its only write API in between is
 * `createSyncAccessHandle()`, which exists ONLY inside a dedicated Worker.
 * `opfs-store.js` feature-detects `createWritable` and, when it is missing,
 * posts each write here.
 *
 * Message in:  { id, parts, bytes }  — `parts` is the file's path from the
 *              OPFS root (from `root.resolve(fileHandle)`), `bytes` a
 *              Uint8Array holding the file's complete new contents.
 * Message out: { id } on success, { id, error: { name, message } } on failure.
 *
 * Writes run one at a time (a sync access handle is an exclusive lock on its
 * file, so two overlapping writes to one file would fail on the second).
 * Safari 15.2-16.x implemented an older draft where truncate/flush/close
 * return promises; every call is awaited so both shapes work.
 */
'use strict';

let queue = Promise.resolve();

self.onmessage = (ev) => {
  const msg = ev.data || {};
  queue = queue
    .then(() => writeFile(msg.parts, msg.bytes))
    .then(
      () => self.postMessage({ id: msg.id }),
      (e) => self.postMessage({
        id: msg.id,
        error: { name: (e && e.name) || 'Error', message: String((e && e.message) || e) },
      }),
    );
};

async function openSyncHandle(fh) {
  // Another tab of the same origin can hold the file's lock for a moment.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fh.createSyncAccessHandle();
    } catch (e) {
      if (attempt >= 20 || !e || e.name !== 'NoModificationAllowedError') throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

async function writeFile(parts, bytes) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('opfs-write-worker: empty path');
  let dir = await navigator.storage.getDirectory();
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: true });
  }
  const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const h = await openSyncHandle(fh);
  try {
    await h.truncate(0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const n = await h.write(offset === 0 ? bytes : bytes.subarray(offset), { at: offset });
      if (!n) throw new Error('opfs-write-worker: write made no progress');
      offset += n;
    }
    await h.flush();
  } finally {
    await h.close();
  }
}
