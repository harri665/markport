/**
 * File system HTTP API.
 *
 * Maps Node.js fs operations to HTTP endpoints. The client-side shim
 * (client/shims/original-fs.js) translates fs calls into requests here.
 *
 * All paths are relative to the configured vault root for safety.
 */

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const {
  tryGetSystemFilePath,
  getSystemPluginIds,
  getSystemPluginDir,
  mergeCommunityList,
  stripCommunityList,
} = require('../system-plugins');

// Imported lazily to avoid circular require — bootstrap.js exports serverCache.
function invalidateBootstrapCache(vaultId) {
  try {
    const { serverCache } = require('./bootstrap');
    if (serverCache) serverCache.delete(vaultId);
  } catch (_) {}
}

// Async existence check used by the system-plugin overlay so we can give
// the vault precedence over the repo copy.
async function fileExists(absPath) {
  try { await fsp.access(absPath); return true; } catch { return false; }
}

// Like fsp.readdir(target, { withFileTypes: true }) but returns [] when
// the directory is missing (ENOENT/ENOTDIR). Other errors still throw.
async function safeReaddir(absPath) {
  try {
    return await fsp.readdir(absPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
}

// ── Write coalescing for rapid writes ──────────────────────────────────────
// On slow filesystems (rclone FUSE) rapid writes to the same file pile up
// and choke the mount.  This mechanism detects per-file write frequency:
//
//   First write to a file   → immediate (no delay)
//   Second write within N ms → buffered; timer reset
//   After N ms of quiet     → flush to disk
//
// Normal note saves go straight to disk.  Rapid-fire config writes
// (workspace.json written 20x/min) coalesce into a single disk write.

const COALESCE_WINDOW_MS = 5000; // writes within this window are coalesced

// key = absolute path → { data, encoding, timer, mtime }
const pendingWrites = new Map();
// key = absolute path → timestamp of last completed write
const lastWriteTime = new Map();

function shouldCoalesce(absPath) {
  const last = lastWriteTime.get(absPath);
  return last && (Date.now() - last) < COALESCE_WINDOW_MS;
}

function pendingSize(entry) {
  return typeof entry.data === 'string'
    ? Buffer.byteLength(entry.data, entry.encoding || 'utf8')
    : entry.data.length;
}

// Write a buffered entry to disk. The file gets the mtime the API already
// reported for it while it was buffered (stat, the write response, the change
// event), so clients that recorded that mtime don't see the flush as yet
// another change.
async function writePending(absPath, entry) {
  await fsp.writeFile(absPath, entry.data, entry.encoding ? { encoding: entry.encoding } : undefined);
  try { await fsp.utimes(absPath, new Date(), new Date(entry.mtime)); } catch (_) { /* best effort */ }
  lastWriteTime.set(absPath, Date.now());
  if (entry.events) entry.events.expect(absPath, 'change', { mtime: entry.mtime, size: pendingSize(entry) });
}

function scheduleFlush(absPath) {
  const entry = pendingWrites.get(absPath);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    const pending = pendingWrites.get(absPath);
    if (!pending) return;
    pendingWrites.delete(absPath);
    try {
      await writePending(absPath, pending);
    } catch (err) {
      console.error('[write-coalesce] flush failed:', absPath, err.message);
    }
  }, COALESCE_WINDOW_MS);
}

function getPendingContent(absPath) {
  return pendingWrites.get(absPath) || null;
}

// Before a rename/copy/rmdir touches absPath (or anything under it), write
// out what is still buffered there, so the operation sees current content.
async function flushPendingUnder(absPath) {
  const prefix = absPath + path.sep;
  for (const [p, entry] of [...pendingWrites]) {
    if (p !== absPath && !p.startsWith(prefix)) continue;
    pendingWrites.delete(p);
    if (entry.timer) clearTimeout(entry.timer);
    try { await writePending(p, entry); } catch (err) { console.error('[write-coalesce] flush failed:', p, err.message); }
  }
}

// A deleted file must not be re-created by a buffered write flushing later.
function dropPending(absPath) {
  const entry = pendingWrites.get(absPath);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingWrites.delete(absPath);
}

// Flush all pending writes on shutdown (async with timeout so slow
// filesystems like rclone don't hang the process indefinitely).
async function flushAllPending() {
  const entries = [...pendingWrites.entries()];
  pendingWrites.clear();
  if (entries.length === 0) return;
  console.log('[write-coalesce] flushing', entries.length, 'pending writes...');
  const FLUSH_TIMEOUT = 10000;
  const writes = entries.map(([absPath, entry]) => {
    if (entry.timer) clearTimeout(entry.timer);
    return fsp.writeFile(absPath, entry.data, entry.encoding ? { encoding: entry.encoding } : undefined)
      .catch(err => console.error('[write-coalesce] flush failed:', absPath, err.message));
  });
  await Promise.race([
    Promise.all(writes),
    new Promise(resolve => setTimeout(() => {
      console.warn('[write-coalesce] flush timeout — some writes may be lost');
      resolve();
    }, FLUSH_TIMEOUT)),
  ]);
}

process.on('SIGTERM', () => flushAllPending().finally(() => process.exit(0)));
process.on('SIGINT', () => flushAllPending().finally(() => process.exit(0)));

// hooks.onRename(vaultId, oldRel, newRel)  share links follow renames
// hooks.events                             api/vault-events.js hub: every
//                                          change is published to the other
//                                          sessions watching the vault
function createFsRouter(vaultRegistry, fallbackVaultRoot, hooks = {}) {
  const router = express.Router();
  const events = hooks.events || null;

  // The session making the request (capacitor-shim, markport-sync), so it
  // isn't sent its own change back.
  function clientOf(req) {
    const c = (req.query && req.query.client) || (req.body && req.body.client);
    return typeof c === 'string' && c ? c.slice(0, 100) : null;
  }

  function publish(req, abs, type, meta) {
    if (events) events.publish(abs, type, clientOf(req), meta);
  }

  async function publishFile(req, abs, type) {
    if (!events) return;
    try {
      const s = await fsp.stat(abs);
      publish(req, abs, s.isDirectory() ? (type === 'add' ? 'addDir' : 'unlinkDir') : type, { mtime: s.mtime.getTime(), size: s.size });
    } catch (_) { /* gone again already */ }
  }

  function getVaultRoot(req) {
    const vaultId = req.query.vault || (req.body && req.body.vault);
    if (vaultId) {
      const vault = vaultRegistry.get(vaultId);
      if (!vault) {
        const err = new Error('unknown vault: ' + vaultId);
        err.code = 'ENOVAULT';
        throw err;
      }
      return vault.path;
    }
    return fallbackVaultRoot;
  }

  // Resource URLs (<img src>, audio, PDF) are assembled by Obsidian itself,
  // not by our shim: it takes the storage-root URI Filesystem.getUri({path:''})
  // returned ("/api/fs/read?vault=<id>&path=") and appends
  // "/<basePath>/<file>", where basePath is the vault id - the same prefix
  // capacitor-shim's fullPath() strips from every other call. Without this,
  // every embedded image resolved to <vault>/<id>/<file> and 404'd.
  function stripResourcePrefix(req, relPath) {
    const id = req.query.vault;
    const prefix = id ? '/' + id + '/' : null;
    return prefix && relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
  }

  // Resolve a path relative to the vault root, ensuring it stays inside.
  function resolveSafe(req, relPath) {
    if (typeof relPath !== 'string') {
      throw new Error('path must be a string');
    }
    const vaultRoot = getVaultRoot(req);
    const absolute = path.resolve(vaultRoot, '.' + path.sep + relPath);
    const normalizedRoot = path.resolve(vaultRoot);
    if (absolute !== normalizedRoot && !absolute.startsWith(normalizedRoot + path.sep)) {
      throw new Error('path escapes vault root: ' + relPath);
    }
    return absolute;
  }

  // Convert an fs.Stats object into a JSON-friendly form.
  function serializeStats(stats) {
    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
      size: stats.size,
      mtime: stats.mtime.getTime(),
      ctime: stats.ctime.getTime(),
      atime: stats.atime.getTime(),
      birthtime: stats.birthtime.getTime(),
      mode: stats.mode,
    };
  }

  // A buffered write is the file's current content: report its mtime and
  // size, not what is still on disk, or a session that compares stats
  // (markport-sync) would miss the change.
  async function statWithPending(target) {
    const out = serializeStats(await fsp.stat(target));
    const pending = getPendingContent(target);
    if (pending) {
      out.mtime = pending.mtime;
      out.size = pendingSize(pending);
    }
    return out;
  }

  function handleError(res, err) {
    // ENOTDIR (readdir on a file) and EISDIR (read on a directory) are
    // routine "wrong shape" errors that Obsidian handles via try/catch.
    // We return 404 so the client-side fetch wrapper treats them like
    // any other "not found" without alarming console errors.
    const status = err.code === 'ENOENT' ? 404
      : err.code === 'EACCES' ? 403
      : err.code === 'EISDIR' ? 404
      : err.code === 'ENOTDIR' ? 404
      : err.code === 'ENOVAULT' ? 404
      : err.code === 'EEXIST' ? 409
      : 500;
    res.status(status).json({
      error: err.message,
      code: err.code || null,
    });
  }

  // Stat a single entry.
  router.get('/stat', async (req, res) => {
    const relPath = req.query.path || '';
    const isPluginsDir = relPath === '.obsidian/plugins' || relPath === '.obsidian/plugins/';

    try {
      const target = resolveSafe(req, relPath);

      // System plugin overlay: if this is a system plugin path AND not in
      // the vault, stat the repo copy instead.
      const systemPath = tryGetSystemFilePath(relPath);
      if (systemPath) {
        const vaultHas = await fileExists(target);
        if (!vaultHas) {
          const stats = await fsp.stat(systemPath);
          return res.json(serializeStats(stats));
        }
      }

      res.json(await statWithPending(target));
    } catch (err) {
      // Synthesize a directory stat for .obsidian/plugins when the vault
      // doesn't have it yet — otherwise Obsidian's plugin discovery aborts
      // before it ever gets to readdir, and our system plugins stay hidden.
      if ((err.code === 'ENOENT' || err.code === 'ENOTDIR')
          && isPluginsDir
          && getSystemPluginIds().length > 0) {
        const now = Date.now();
        return res.json({
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          size: 4096,
          mtime: now,
          ctime: now,
          atime: now,
          birthtime: now,
          mode: 0o040755,
        });
      }
      handleError(res, err);
    }
  });

  // List directory contents (with stats so the client can avoid extra round-trips).
  router.get('/readdir', async (req, res) => {
    const relPath = req.query.path || '';
    const isPluginsDir = relPath === '.obsidian/plugins' || relPath === '.obsidian/plugins/';
    // Match exactly .obsidian/plugins/<id> (no trailing path); optional trailing slash.
    const inSysDirMatch = relPath.match(/^\.obsidian\/plugins\/([^/]+)\/?$/);
    const inSysDir = inSysDirMatch && getSystemPluginIds().includes(inSysDirMatch[1]);

    try {
      const target = resolveSafe(req, relPath);
      // Helpful debug: log the resolved absolute path when readdir is called.
      // Useful for tracking down "readdir on a file" mysteries.
      if (process.env.OW_DEBUG) {
        console.log('[readdir]', relPath, '->', target);
      }

      // Inside a system plugin dir? If the vault doesn't have its own copy,
      // list from the repo. (If the vault DOES override it, fall through to
      // the normal readdir on the vault copy.)
      if (inSysDir) {
        const vaultEntries = await safeReaddir(target);
        if (vaultEntries.length === 0) {
          const repoDir = getSystemPluginDir(inSysDirMatch[1]);
          const entries = await fsp.readdir(repoDir, { withFileTypes: true });
          const result = await Promise.all(entries.map(async (entry) => {
            const child = path.join(repoDir, entry.name);
            let stats = null;
            try {
              const s = await fsp.stat(child);
              stats = serializeStats(s);
            } catch (_) { /* ignore */ }
            return {
              name: entry.name,
              isFile: entry.isFile(),
              isDirectory: entry.isDirectory(),
              isSymbolicLink: entry.isSymbolicLink(),
              stats,
            };
          }));
          return res.json(result);
        }
      }

      const entries = await fsp.readdir(target, { withFileTypes: true });
      const result = await Promise.all(entries.map(async (entry) => {
        const child = path.join(target, entry.name);
        let stats = null;
        try {
          const s = await fsp.stat(child);
          stats = serializeStats(s);
        } catch (_) {
          // Broken symlink or permission issue: still return the name.
        }
        return {
          name: entry.name,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
          isSymbolicLink: entry.isSymbolicLink(),
          stats,
        };
      }));

      // If listing .obsidian/plugins, merge in system plugin directory entries
      // for ids the vault doesn't already have.
      if (isPluginsDir) {
        for (const id of getSystemPluginIds()) {
          if (!result.find((e) => e.name === id)) {
            result.push({
              name: id,
              isFile: false,
              isDirectory: true,
              isSymbolicLink: false,
              stats: null,
            });
          }
        }
      }

      res.json(result);
    } catch (err) {
      // Synthesize a listing for .obsidian/plugins when the vault doesn't
      // have that directory yet — Obsidian creates it lazily, but we want
      // our system plugins to show up immediately.
      if ((err.code === 'ENOENT' || err.code === 'ENOTDIR')
          && isPluginsDir
          && getSystemPluginIds().length > 0) {
        return res.json(getSystemPluginIds().map((id) => ({
          name: id,
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          stats: null,
        })));
      }
      handleError(res, err);
    }
  });

  // Read a file (text or binary depending on ?encoding).
  router.get('/read', async (req, res) => {
    try {
      const relPath = stripResourcePrefix(req, req.query.path || '');
      const target = resolveSafe(req, relPath);
      const encoding = req.query.encoding || null;

      // Special case: community-plugins.json — merge system ids into the
      // list Obsidian sees, regardless of whether the vault file exists.
      if (relPath === '.obsidian/community-plugins.json') {
        let list = [];
        const pending = getPendingContent(target);
        if (pending) {
          // Pending write — parse the buffered content.
          try {
            const txt = typeof pending.data === 'string' ? pending.data : pending.data.toString('utf8');
            const parsed = JSON.parse(txt);
            if (Array.isArray(parsed)) list = parsed;
          } catch (_) { /* malformed: start from empty */ }
        } else {
          try {
            const txt = await fsp.readFile(target, 'utf8');
            const parsed = JSON.parse(txt);
            if (Array.isArray(parsed)) list = parsed;
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
          }
        }
        const merged = mergeCommunityList(list);
        if (encoding) {
          return res.type('text/plain; charset=utf-8').send(JSON.stringify(merged));
        }
        return res.type('application/json').send(JSON.stringify(merged));
      }

      // System plugin overlay: if this is a system plugin file AND the
      // vault doesn't have it, serve from <repo>/plugins/.
      const systemPath = tryGetSystemFilePath(relPath);
      if (systemPath) {
        const vaultHas = await fileExists(target);
        if (!vaultHas) {
          if (encoding) {
            const data = await fsp.readFile(systemPath, encoding);
            return res.type('text/plain; charset=utf-8').send(data);
          }
          const data = await fsp.readFile(systemPath);
          return res.type('application/octet-stream').send(data);
        }
      }

      // Serve from debounce buffer if a write is pending.
      const pending = getPendingContent(target);
      if (pending) {
        if (encoding) {
          res.type('text/plain; charset=utf-8').send(typeof pending.data === 'string' ? pending.data : pending.data.toString(encoding));
        } else {
          res.type('application/octet-stream').send(pending.data);
        }
        return;
      }
      if (encoding) {
        const data = await fsp.readFile(target, encoding);
        res.type('text/plain; charset=utf-8').send(data);
      } else {
        // Binary (images, models, video, PDFs, ...): streamed, never read
        // whole into memory, with Range requests (video seeking, partial
        // model loads), and ETag/Last-Modified so a browser revalidates
        // instead of downloading again.
        const s = await fsp.stat(target);
        if (!s.isFile()) throw Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' });
        res.setHeader('Content-Type', 'application/octet-stream');
        // no-cache = always revalidate: an edited file is never shown stale,
        // and an unchanged one costs a 304.
        res.setHeader('Cache-Control', 'private, no-cache');
        await new Promise((resolve) => {
          res.sendFile(target, { dotfiles: 'allow', acceptRanges: true, lastModified: true, etag: true, cacheControl: false }, (err) => {
            if (err && !res.headersSent) handleError(res, err);
            resolve();
          });
        });
      }
    } catch (err) {
      handleError(res, err);
    }
  });

  // Write a file. Body is the raw content (text or binary).
  // ?encoding=utf8 means the server treats body as utf-8 text.
  router.put('/write', express.raw({ type: '*/*', limit: '256mb' }), async (req, res) => {
    try {
      const relPath = req.query.path || '';
      const target = resolveSafe(req, relPath);
      const encoding = req.query.encoding || null;
      let data = encoding ? req.body.toString(encoding) : req.body;

      // For community-plugins.json: strip our system plugin ids before
      // writing so we don't pollute the user's vault. Malformed JSON is
      // passed through untouched.
      if (relPath === '.obsidian/community-plugins.json' && encoding) {
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) {
            const cleaned = stripCommunityList(parsed);
            data = JSON.stringify(cleaned, null, 2);
          }
        } catch (_) { /* malformed JSON: pass through as-is */ }
      }

      await fsp.mkdir(path.dirname(target), { recursive: true });
      const existed = await fileExists(target);
      const type = existed ? 'change' : 'add';

      // If this file was written recently, coalesce instead of hitting disk.
      if (shouldCoalesce(target)) {
        const entry = { data, encoding, timer: null, mtime: Date.now(), events };
        pendingWrites.set(target, entry);
        scheduleFlush(target);
        invalidateBootstrapCache(req.query.vault);
        const meta = { mtime: entry.mtime, size: pendingSize(entry) };
        publish(req, target, type, meta);
        res.json(Object.assign({ ok: true }, meta));
        return;
      }

      dropPending(target);
      await fsp.writeFile(target, data, encoding ? { encoding } : undefined);
      lastWriteTime.set(target, Date.now());
      invalidateBootstrapCache(req.query.vault);
      // mtime/size as /stat reports them, so a client can record what it
      // wrote without another round trip (markport-sync does).
      const s = await fsp.stat(target);
      const meta = { mtime: s.mtime.getTime(), size: s.size };
      publish(req, target, type, meta);
      res.json(Object.assign({ ok: true }, meta));
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/mkdir', express.json(), async (req, res) => {
    try {
      const target = resolveSafe(req, req.body.path || '');
      const recursive = req.body.recursive !== false;
      const existed = await fileExists(target);
      await fsp.mkdir(target, { recursive });
      invalidateBootstrapCache(req.body.vault);
      if (!existed) publish(req, target, 'addDir');
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/unlink', async (req, res) => {
    try {
      const target = resolveSafe(req, req.query.path || '');
      dropPending(target);
      await fsp.unlink(target);
      invalidateBootstrapCache(req.query.vault);
      publish(req, target, 'unlink');
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // The client shim sends rmdir as POST with a JSON body (like mkdir); the
  // DELETE form with query parameters is kept for older callers.
  async function rmdir(req, res, relPath, recursive) {
    try {
      const target = resolveSafe(req, relPath || '');
      if (target === path.resolve(getVaultRoot(req))) throw Object.assign(new Error('refusing to remove the vault root'), { code: 'EACCES' });
      if (recursive) {
        for (const p of [...pendingWrites.keys()]) if (p.startsWith(target + path.sep)) dropPending(p);
        await fsp.rm(target, { recursive: true, force: false });
      } else {
        await fsp.rmdir(target);
      }
      invalidateBootstrapCache(req.query.vault || (req.body && req.body.vault));
      publish(req, target, 'unlinkDir');
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  }
  router.delete('/rmdir', (req, res) => rmdir(req, res, req.query.path, req.query.recursive === '1'));
  router.post('/rmdir', express.json(), (req, res) => rmdir(req, res, req.body && req.body.path, !!(req.body && req.body.recursive)));

  router.post('/rename', express.json(), async (req, res) => {
    try {
      const oldPath = resolveSafe(req, req.body.oldPath || '');
      const newPath = resolveSafe(req, req.body.newPath || '');
      // overwrite:false - fail instead of replacing an existing target
      // (markport-sync renames with this; Obsidian's own renames don't send it).
      if (req.body.overwrite === false && oldPath !== newPath && await fileExists(newPath)) {
        throw Object.assign(new Error('target exists: ' + req.body.newPath), { code: 'EEXIST' });
      }
      await flushPendingUnder(oldPath);
      const wasDir = (await fsp.stat(oldPath)).isDirectory();
      await fsp.mkdir(path.dirname(newPath), { recursive: true });
      await fsp.rename(oldPath, newPath);
      invalidateBootstrapCache(req.body.vault);
      if (hooks.onRename && req.body.vault) {
        try { hooks.onRename(req.body.vault, req.body.oldPath, req.body.newPath); }
        catch (err) { console.error('[fs] rename hook failed:', err.message); }
      }
      publish(req, oldPath, wasDir ? 'unlinkDir' : 'unlink');
      await publishFile(req, newPath, 'add');
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/copy', express.json(), async (req, res) => {
    try {
      const src = resolveSafe(req, req.body.src || '');
      const dest = resolveSafe(req, req.body.dest || '');
      await flushPendingUnder(src);
      const existed = await fileExists(dest);
      await fsp.copyFile(src, dest);
      invalidateBootstrapCache(req.body.vault);
      await publishFile(req, dest, existed ? 'change' : 'add');
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // The whole vault (or one folder of it) in one response: every file with
  // its mtime and size, and every folder. Hidden entries (".obsidian",
  // ".trash", dotfiles) are left out, as the watcher leaves them out.
  // markport-sync compares this against its last sync to find changes.
  //
  // ?path=.obsidian lists the vault's settings and plugins as they are on
  // disk (markport-sync's "Sync settings and plugins"), without the system
  // plugin overlay. systemPlugins says which plugin ids are Markport's own,
  // served to every vault from the repo, so a device leaves their code alone.
  router.get('/tree', async (req, res) => {
    try {
      const rel = String(req.query.path || '').replace(/^\/+|\/+$/g, '');
      const root = resolveSafe(req, rel);
      const files = [];
      const dirs = [];
      async function walk(abs, relDir) {
        const entries = await safeReaddir(abs);
        await Promise.all(entries.map(async (e) => {
          if (e.name.startsWith('.')) return;
          const childRel = relDir ? relDir + '/' + e.name : e.name;
          const childAbs = path.join(abs, e.name);
          let st;
          try { st = await statWithPending(childAbs); } catch (_) { return; }   // vanished, broken link
          if (st.isDirectory) {
            if (e.isSymbolicLink()) return;   // could loop; Obsidian doesn't follow them either
            dirs.push(childRel);
            await walk(childAbs, childRel);
          } else if (st.isFile) {
            files.push({ path: childRel, mtime: st.mtime, size: st.size });
          }
        }));
      }
      await walk(root, rel);
      res.json({ files, dirs, systemPlugins: getSystemPluginIds() });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}

module.exports = createFsRouter;
// /api/bootstrap reads the vault from disk, so it writes out what is still
// buffered first; otherwise a reload within the coalesce window would see the
// old content of a file, or no file at all.
module.exports.flushPendingUnder = flushPendingUnder;
