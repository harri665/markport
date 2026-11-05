/**
 * /api/fs for share vaults.
 *
 * Same endpoints and response shapes as api/fs.js (the client shim can't tell
 * the difference), but every path goes through Scope.resolve() first. Mounted
 * in front of the owner's fs router; only requests whose `vault` is a share id
 * reach it (see shares/gate.js).
 */

'use strict';

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { invalidateVaultIndex, fsError } = require('./scope');

function invalidateBootstrapCache(vaultId) {
  try {
    const { serverCache } = require('../api/bootstrap');
    if (serverCache) serverCache.delete(vaultId);
  } catch (_) {}
}

function serializeStats(stats) {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink: false,
    size: stats.size,
    mtime: stats.mtime.getTime(),
    ctime: stats.ctime.getTime(),
    atime: stats.atime.getTime(),
    birthtime: stats.birthtime.getTime(),
    mode: stats.mode,
  };
}

function syntheticDirStats() {
  const now = Date.now();
  return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0, mtime: now, ctime: now, atime: now, birthtime: now, mode: 0o040755 };
}

function handleError(res, err) {
  const status = err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR' ? 404
    : err.code === 'EACCES' || err.code === 'EPERM' ? 403
    : err.code === 'EEXIST' ? 409
    : 500;
  if (status === 500) console.error('[share-fs]', err);
  res.status(status).json({ error: err.message, code: err.code || null });
}

// Obsidian builds resource URLs as /api/fs/read?vault=<id>&path=/<id>/<file>
// (see api/fs.js stripResourcePrefix).
function stripResourcePrefix(shareId, relPath) {
  const prefix = '/' + shareId + '/';
  return relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
}

async function moveAcross(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

function createShareFsRouter() {
  const router = express.Router();

  // Everything below runs with req.shareScope set by the gate.
  router.use(async (req, res, next) => {
    try { await req.shareScope.ensureConfig(); next(); } catch (err) { handleError(res, err); }
  });

  function touched(req, area) {
    if (area === 'content' || area === 'trash' || area === 'trash-root') {
      invalidateBootstrapCache(req.shareScope.share.vault);
      invalidateVaultIndex(req.shareScope.vaultRoot);
    }
  }

  router.get('/stat', async (req, res) => {
    try {
      const r = await req.shareScope.resolve(req.query.path || '', 'read');
      if (!r.abs || r.area === 'linked-dir') return res.json(syntheticDirStats());
      if (r.area === 'root' && req.shareScope.isFile) {
        if (!(await req.shareScope.exists())) throw fsError('ENOENT', 'the shared note no longer exists');
      }
      res.json(serializeStats(await fsp.stat(r.abs)));
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/readdir', async (req, res) => {
    try {
      const entries = await req.shareScope.list(req.query.path || '');
      const out = await Promise.all(entries.map(async (e) => {
        if (!e.abs) return { name: e.name, isFile: false, isDirectory: true, isSymbolicLink: false, stats: syntheticDirStats() };
        try {
          const st = await fsp.stat(e.abs);
          return { name: e.name, isFile: st.isFile(), isDirectory: st.isDirectory(), isSymbolicLink: false, stats: serializeStats(st) };
        } catch (_) {
          return null;   // vanished, or a broken symlink: leave it out
        }
      }));
      res.json(out.filter(Boolean));
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/read', async (req, res) => {
    try {
      const rel = stripResourcePrefix(req.shareScope.share.id, req.query.path || '');
      const r = await req.shareScope.resolve(rel, 'read');
      if (!r.abs || r.area === 'root' || r.area === 'config-root' || r.area === 'linked-dir') throw fsError('EISDIR', 'is a directory');
      const encoding = req.query.encoding || null;
      if (encoding) {
        const data = await fsp.readFile(r.abs, encoding);
        res.type('text/plain; charset=utf-8').send(data);
      } else {
        const data = await fsp.readFile(r.abs);
        // Never let a shared file render as a same-origin page.
        res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'" });
        res.type('application/octet-stream').send(data);
      }
    } catch (err) {
      handleError(res, err);
    }
  });

  router.put('/write', express.raw({ type: '*/*', limit: '256mb' }), async (req, res) => {
    try {
      const r = await req.shareScope.resolve(req.query.path || '', 'write');
      if (r.area === 'discard') return res.json({ ok: true });
      try {
        if ((await fsp.stat(r.abs)).isDirectory()) throw fsError('EISDIR', 'is a directory');
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      const encoding = req.query.encoding || null;
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const data = encoding ? body.toString(encoding) : body;
      await fsp.mkdir(path.dirname(r.abs), { recursive: true });
      await fsp.writeFile(r.abs, data, encoding ? { encoding } : undefined);
      touched(req, r.area);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/mkdir', express.json(), async (req, res) => {
    try {
      const r = await req.shareScope.resolve(req.body.path || '', 'mkdir');
      await fsp.mkdir(r.abs, { recursive: req.body.recursive !== false });
      touched(req, r.area);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/unlink', async (req, res) => {
    try {
      const r = await req.shareScope.resolve(req.query.path || '', 'delete');
      await fsp.unlink(r.abs);
      touched(req, r.area);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  async function rmdir(req, res, relPath, recursive) {
    try {
      const r = await req.shareScope.resolve(relPath || '', 'delete');
      if (recursive) await fsp.rm(r.abs, { recursive: true, force: false });
      else await fsp.rmdir(r.abs);
      touched(req, r.area);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  }
  router.delete('/rmdir', (req, res) => rmdir(req, res, req.query.path, req.query.recursive === '1'));
  router.post('/rmdir', express.json(), (req, res) => rmdir(req, res, req.body.path, !!req.body.recursive));

  router.post('/rename', express.json(), async (req, res) => {
    try {
      const from = await req.shareScope.resolve(req.body.oldPath || '', 'rename');
      const to = await req.shareScope.resolve(req.body.newPath || '', 'rename');
      await fsp.mkdir(path.dirname(to.abs), { recursive: true });
      await moveAcross(from.abs, to.abs);
      touched(req, from.area);
      touched(req, to.area);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/copy', express.json(), async (req, res) => {
    try {
      const src = await req.shareScope.resolve(req.body.src || '', 'read');
      const dest = await req.shareScope.resolve(req.body.dest || '', 'write');
      await fsp.copyFile(src.abs, dest.abs);
      touched(req, dest.area);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.use((req, res) => res.status(404).json({ error: 'not found', code: 'ENOENT' }));
  return router;
}

module.exports = createShareFsRouter;
