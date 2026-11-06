'use strict';

/**
 * /api/media: thumbnails, previews, optimized 3D models, turntables and large
 * uploads, for the image library plugin (src/plugins/markport-clipper).
 *
 *   GET  /caps                         what this server can do
 *   GET  /thumb?vault&path&w[&v]       WebP, longest side <= w (256/480/1024/2048)
 *   GET  /info?vault&path              { width, height, format } of the original
 *   GET  /model?vault&path[&v]         web-optimized GLB (meshopt, WebP textures,
 *                                      Brotli when accepted); 202 while it is made,
 *                                      404 { needsSource } for formats a browser
 *                                      must convert first (FBX, OBJ, ...)
 *   PUT  /model-source?vault&path      a browser's GLB conversion of a model, to
 *                                      optimize and cache
 *   GET  /turntable?vault&path&r[&v]   a model's turntable sprite sheet (WebP); r is the
 *                                      browser renderer's version, part of the key
 *   PUT  /turntable?vault&path&r       store one (rendered by a browser)
 *   POST /upload/start                 { vault, path, size } -> { id, chunk }
 *   PUT  /upload/chunk?id&offset       raw bytes
 *   GET  /upload/status?id             { received }
 *   POST /upload/finish                { id } -> the file appears in the vault
 *
 * Everything derived lives in the cache directory, never in a vault. The
 * originals are only read - except /upload/finish, which writes the uploaded
 * file, unchanged, where the user put it.
 *
 * `v` is "<mtime>-<size>" of the original as the client knows it. When it
 * matches, the response is cached by the browser for a year (the URL changes
 * when the file does); otherwise it must revalidate.
 */

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');

const formats = require(path.join(__dirname, '..', '..', '..', 'plugins', 'markport-clipper', 'media-formats.js'));
const { createCache } = require('./cache');
const { createPool, createLimiter } = require('./pool');
const images = require('./images');

const WIDTHS = [256, 480, 1024, 2048];
const CHUNK = 8 * 1024 * 1024;
const MAX_UPLOAD = 20 * 1024 * 1024 * 1024;    // 20 GB
const MAX_MODEL_SOURCE = 2 * 1024 * 1024 * 1024;
const MAX_TURNTABLE = 32 * 1024 * 1024;
const GLTF = new Set(['glb', 'gltf']);

function snapWidth(w) {
  const n = parseInt(w, 10) || 480;
  return WIDTHS.find((x) => x >= n) || WIDTHS[WIDTHS.length - 1];
}

function createMediaRouter(vaultRegistry, opts = {}) {
  const cache = createCache(opts.cacheDir, opts.maxBytes);
  const events = opts.events || null;
  const pool = opts.pool || createPool(opts.workers || 2);
  const jobs = createLimiter(opts.concurrency || 3);
  const modelJobs = createLimiter(1);
  const uploads = new Map();
  const router = express.Router();

  // Housekeeping: old half-uploads, and the cache's size cap.
  const uploadDir = path.join(cache.root, 'uploads');
  const tidy = async () => {
    try {
      for (const name of await fsp.readdir(uploadDir)) {
        const p = path.join(uploadDir, name);
        const s = await fsp.stat(p).catch(() => null);
        if (s && Date.now() - s.mtimeMs > 24 * 3600e3) await fsp.rm(p, { force: true });
      }
    } catch (_) { /* no uploads yet */ }
    await cache.trim().catch((e) => console.warn('[media] cache trim failed:', e.message));
  };
  if (opts.housekeeping !== false) {
    setTimeout(tidy, 30e3).unref();
    setInterval(tidy, 3600e3).unref();
  }

  // ── helpers ──

  function vaultRoot(id) {
    const v = id && vaultRegistry.get(id);
    if (!v) { const e = new Error('unknown vault'); e.status = 404; throw e; }
    return v.path;
  }

  function resolve(id, rel) {
    if (typeof rel !== 'string' || !rel) { const e = new Error('path required'); e.status = 400; throw e; }
    const root = path.resolve(vaultRoot(id));
    const abs = path.resolve(root, '.' + path.sep + rel);
    if (abs === root || !abs.startsWith(root + path.sep)) { const e = new Error('path escapes the vault'); e.status = 400; throw e; }
    return abs;
  }

  async function source(req) {
    const vault = String(req.query.vault || '');
    const rel = String(req.query.path || '');
    const abs = resolve(vault, rel);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) { const e = new Error('not found'); e.status = 404; throw e; }
    const version = Math.floor(stat.mtimeMs) + '-' + stat.size;
    return { vault, rel, abs, stat, ext: formats.extOf(rel), key: cache.key(vault, rel, stat), fresh: req.query.v === version };
  }

  function caching(res, fresh) {
    res.setHeader('Cache-Control', fresh ? 'private, max-age=31536000, immutable' : 'private, no-cache');
  }

  function sendFile(res, file, type, fresh, extra) {
    caching(res, fresh);
    res.setHeader('Content-Type', type);
    for (const k of Object.keys(extra || {})) res.setHeader(k, extra[k]);
    return new Promise((resolve) => {
      res.sendFile(file, { dotfiles: 'allow', cacheControl: false, lastModified: true, etag: true }, (err) => {
        if (err && !res.headersSent) res.status(err.statusCode || 500).json({ error: err.message });
        resolve();
      });
    });
  }

  const fail = (res, err) => {
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: String((err && err.message) || err) });
  };

  async function readJson(p) {
    try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch (_) { return null; }
  }

  // A remembered failure, if it is recent: failures are retried after a
  // while, so a server with a new decoder picks up files it could not read.
  const FAIL_TTL = 10 * 60e3;
  async function recentFailure(p) {
    const s = await fsp.stat(p).catch(() => null);
    if (!s) return null;
    if (Date.now() - s.mtimeMs > FAIL_TTL) { await fsp.rm(p, { force: true }).catch(() => {}); return null; }
    return readJson(p);
  }

  // Stream a request body to `file`, refusing more than `max` bytes.
  async function bodyTo(req, file, max, start) {
    let n = 0;
    const counter = new (require('stream').Transform)({
      transform(chunk, enc, cb) {
        n += chunk.length;
        if (n > max) { const e = new Error('too large'); e.status = 413; cb(e); return; }
        cb(null, chunk);
      },
    });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const out = fs.createWriteStream(file, start != null ? { flags: 'r+', start } : { flags: 'w' });
    await pipeline(req, counter, out);
    return n;
  }

  async function move(from, to) {
    try {
      await fsp.rename(from, to);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      await fsp.rm(from, { force: true });
    }
  }

  // ── caps ──

  router.get('/caps', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    const id = req.query.vault;
    res.json({
      version: 1,
      // A browser-only (OPFS) vault opened from this server is not one of its vaults.
      vaultKnown: !!(id && vaultRegistry.get(String(id))),
      thumbWidths: WIDTHS,
      imagemagick: !!images.magick(),
      models: true,
      turntables: true,
      uploadChunk: CHUNK,
    });
  });

  // ── images ──

  async function thumbFile(src, w) {
    const out = cache.file('thumb', src.key, '-' + w + '.webp');
    const infoFile = cache.file('thumb', src.key, '.json');
    const errFile = cache.file('thumb', src.key, '-' + w + '.err');
    if (await cache.has(out)) return { out };
    const known = await recentFailure(errFile);
    if (known) { const e = new Error(known.error); e.status = 415; throw e; }
    await jobs('thumb:' + out, async () => {
      if (await cache.has(out)) return;
      try {
        const info = await images.render(src.abs, src.ext, w, out, pool);
        await cache.put(infoFile, JSON.stringify(info));
      } catch (e) {
        await cache.put(errFile, JSON.stringify({ error: e.message })).catch(() => {});
        e.status = 415;
        throw e;
      }
    });
    return { out };
  }

  router.get('/thumb', async (req, res) => {
    try {
      const src = await source(req);
      if (formats.kindOf(src.ext) !== 'image') return res.status(415).json({ error: 'not an image' });
      const w = snapWidth(req.query.w);
      const { out } = await thumbFile(src, w);
      await sendFile(res, out, 'image/webp', src.fresh);
    } catch (e) { fail(res, e); }
  });

  router.get('/info', async (req, res) => {
    try {
      const src = await source(req);
      const infoFile = cache.file('thumb', src.key, '.json');
      let info = await readJson(infoFile);
      if (!info) info = await images.info(src.abs, src.ext);
      if (!info) { await thumbFile(src, 480); info = await readJson(infoFile); }
      caching(res, src.fresh);
      res.json(info || {});
    } catch (e) { fail(res, e); }
  });

  // ── models ──

  function modelFiles(src) {
    return { glb: cache.file('model', src.key, '.glb'), err: cache.file('model', src.key, '.err') };
  }

  function optimize(src, input, cleanup) {
    const f = modelFiles(src);
    return modelJobs('model:' + f.glb, async () => {
      try {
        if (await cache.has(f.glb)) return;
        const tmp = cache.tmpFile('.glb');
        await fsp.mkdir(path.dirname(tmp), { recursive: true });
        await pool.run('model', { input, output: tmp, maxTexture: opts.maxTexture || 2048 });
        await cache.adopt(tmp + '.br', f.glb + '.br');
        await cache.adopt(tmp, f.glb);
      } catch (e) {
        console.warn('[media] model optimization failed for ' + src.rel + ': ' + e.message);
        await cache.put(f.err, JSON.stringify({ error: e.message })).catch(() => {});
      } finally {
        if (cleanup) await fsp.rm(input, { force: true }).catch(() => {});
      }
    });
  }

  router.get('/model', async (req, res) => {
    try {
      const src = await source(req);
      if (formats.kindOf(src.ext) !== 'model') return res.status(415).json({ error: 'not a 3D model' });
      const f = modelFiles(src);
      if (await cache.has(f.glb)) {
        const br = /\bbr\b/.test(String(req.headers['accept-encoding'] || '')) && await cache.has(f.glb + '.br');
        return sendFile(res, br ? f.glb + '.br' : f.glb, 'model/gltf-binary', src.fresh, br ? { 'Content-Encoding': 'br', Vary: 'Accept-Encoding' } : { Vary: 'Accept-Encoding' });
      }
      res.setHeader('Cache-Control', 'private, no-cache');
      const failed = await recentFailure(f.err);
      if (failed) return res.status(422).json({ status: 'failed', error: failed.error });
      if (!GLTF.has(src.ext)) return res.status(404).json({ status: 'needs-source' });
      optimize(src, src.abs, false);
      res.status(202).json({ status: 'pending' });
    } catch (e) { fail(res, e); }
  });

  router.put('/model-source', async (req, res) => {
    try {
      const src = await source(req);
      if (formats.kindOf(src.ext) !== 'model') return res.status(415).json({ error: 'not a 3D model' });
      const f = modelFiles(src);
      if (await cache.has(f.glb)) return res.json({ status: 'ready' });
      const tmp = cache.tmpFile('.glb');
      await bodyTo(req, tmp, MAX_MODEL_SOURCE);
      await fsp.rm(f.err, { force: true }).catch(() => {});
      optimize(src, tmp, true);
      res.status(202).json({ status: 'pending' });
    } catch (e) { fail(res, e); }
  });

  router.get('/turntable', async (req, res) => {
    try {
      const src = await source(req);
      const out = cache.file('turntable', src.key, '-r' + (parseInt(req.query.r, 10) || 1) + '.webp');
      if (!(await cache.has(out))) { res.setHeader('Cache-Control', 'private, no-cache'); return res.status(404).json({ status: 'missing' }); }
      await sendFile(res, out, 'image/webp', src.fresh);
    } catch (e) { fail(res, e); }
  });

  router.put('/turntable', async (req, res) => {
    try {
      const src = await source(req);
      if (formats.kindOf(src.ext) !== 'model') return res.status(415).json({ error: 'not a 3D model' });
      const out = cache.file('turntable', src.key, '-r' + (parseInt(req.query.r, 10) || 1) + '.webp');
      const tmp = cache.tmpFile('.webp');
      await bodyTo(req, tmp, MAX_TURNTABLE);
      // Only images get cached: check it really is a WebP.
      // (From memory: on Windows an open file handle would block the rename below.)
      const meta = await require('sharp')(await fsp.readFile(tmp)).metadata().catch(() => null);
      if (!meta || meta.format !== 'webp') { await fsp.rm(tmp, { force: true }); return res.status(415).json({ error: 'expected a WebP image' }); }
      await cache.adopt(tmp, out);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ── chunked uploads ──

  router.post('/upload/start', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const { vault, size } = req.body || {};
      const rel = String((req.body && req.body.path) || '');
      const abs = resolve(vault, rel);
      if (!(Number.isSafeInteger(size) && size >= 0 && size <= MAX_UPLOAD)) return res.status(400).json({ error: 'bad size' });
      if (await fsp.stat(abs).catch(() => null)) return res.status(409).json({ error: 'a file with this name already exists' });
      const id = crypto.randomBytes(16).toString('hex');
      const tmp = path.join(uploadDir, id + '.part');
      await fsp.mkdir(uploadDir, { recursive: true });
      await (await fsp.open(tmp, 'w')).close();
      uploads.set(id, { vault, rel, abs, size, tmp, client: req.query.client || null });
      res.json({ id, chunk: CHUNK });
    } catch (e) { fail(res, e); }
  });

  router.put('/upload/chunk', async (req, res) => {
    try {
      const u = uploads.get(String(req.query.id || ''));
      if (!u) return res.status(404).json({ error: 'unknown upload' });
      const offset = parseInt(req.query.offset, 10);
      if (!(offset >= 0 && offset <= u.size)) return res.status(400).json({ error: 'bad offset' });
      const n = await bodyTo(req, u.tmp, Math.min(CHUNK * 2, u.size - offset), offset);
      res.json({ received: offset + n });
    } catch (e) { fail(res, e); }
  });

  router.get('/upload/status', async (req, res) => {
    const u = uploads.get(String(req.query.id || ''));
    if (!u) return res.status(404).json({ error: 'unknown upload' });
    const s = await fsp.stat(u.tmp).catch(() => null);
    res.json({ received: s ? s.size : 0, size: u.size });
  });

  router.post('/upload/finish', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const id = String((req.body && req.body.id) || '');
      const u = uploads.get(id);
      if (!u) return res.status(404).json({ error: 'unknown upload' });
      const s = await fsp.stat(u.tmp);
      if (s.size !== u.size) return res.status(409).json({ error: 'incomplete: ' + s.size + ' of ' + u.size + ' bytes' });
      await fsp.mkdir(path.dirname(u.abs), { recursive: true });
      if (await fsp.stat(u.abs).catch(() => null)) return res.status(409).json({ error: 'a file with this name already exists' });
      await move(u.tmp, u.abs);
      uploads.delete(id);
      const st = await fsp.stat(u.abs);
      const meta = { mtime: st.mtime.getTime(), size: st.size };
      try { const { serverCache } = require('../api/bootstrap'); if (serverCache) serverCache.delete(u.vault); } catch (_) { /* fine */ }
      if (events) events.publish(u.abs, 'add', null, meta);
      res.json(Object.assign({ ok: true, path: u.rel }, meta));
    } catch (e) { fail(res, e); }
  });

  router.close = () => pool.close();
  return router;
}

module.exports = { createMediaRouter, snapWidth };
