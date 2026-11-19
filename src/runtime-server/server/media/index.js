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
 *   POST /upload/start                 { vault, path, size[, overwrite, reencode] }
 *                                      -> { id, chunk }
 *   PUT  /upload/chunk?id&offset       raw bytes
 *   GET  /upload/status?id             { received }
 *   POST /upload/finish                { id } -> the file appears in the vault,
 *                                      or { reencoding: true }: it appears once
 *                                      ffmpeg has re-encoded it (video.js)
 *   GET  /upload/encoding?vault        { paths } still being re-encoded
 *   POST /upload/encoding/cancel       { vault, path } drop one of those
 *
 * Everything derived lives in the cache directory, never in a vault. The
 * originals are only read - except /upload/finish, which writes the uploaded
 * file where the user put it: unchanged, unless the upload asked for a video
 * to be re-encoded (markport-sync's "Re-encode large videos"). `overwrite`
 * lets an upload replace a file; without it an existing name is refused.
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
const video = require('./video');

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
  // Finished uploads ffmpeg is still re-encoding: absolute target -> job.
  const encodes = new Map();
  const videoJobs = createLimiter(1);
  const videoOn = opts.video !== false;
  let closed = false;
  const router = express.Router();

  // Housekeeping: old half-uploads, and the cache's size cap.
  const uploadDir = path.join(cache.root, 'uploads');
  const tidy = async () => {
    try {
      const active = new Set([...encodes.values()].map((j) => j.id));
      for (const name of await fsp.readdir(uploadDir)) {
        if (active.has(name.split('.')[0])) continue;
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

  async function move(from, to, overwrite) {
    try {
      await fsp.rename(from, to);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fsp.copyFile(from, to, overwrite ? 0 : fs.constants.COPYFILE_EXCL);
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
      // /upload/start takes `overwrite`, and `reencode` for these extensions.
      uploadOverwrite: true,
      videoReencode: videoOn ? video.extensions() : [],
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

  // '-2': the model pipeline's own version (2 = dense meshes simplified, see
  // worker.js), so models optimized before are redone without touching the
  // image thumbnails that share the cache key.
  function modelFiles(src) {
    return { glb: cache.file('model', src.key, '-2.glb'), err: cache.file('model', src.key, '-2.err') };
  }

  function optimize(src, input, cleanup) {
    const f = modelFiles(src);
    return modelJobs('model:' + f.glb, async () => {
      try {
        if (await cache.has(f.glb)) return;
        const tmp = cache.tmpFile('.glb');
        await fsp.mkdir(path.dirname(tmp), { recursive: true });
        await pool.run('model', { input, output: tmp, maxTexture: opts.maxTexture || 2048, maxTriangles: opts.maxTriangles || 500000 });
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

  // Put a finished upload (or its re-encoding) at its place in the vault and
  // tell the sessions watching it.
  async function place(file, u, existed) {
    await fsp.mkdir(path.dirname(u.abs), { recursive: true });
    await move(file, u.abs, u.overwrite);
    const st = await fsp.stat(u.abs);
    const meta = { mtime: st.mtime.getTime(), size: st.size };
    try { const { serverCache } = require('../api/bootstrap'); if (serverCache) serverCache.delete(u.vault); } catch (_) { /* fine */ }
    if (events) events.publish(u.abs, existed ? 'change' : 'add', null, meta);
    return meta;
  }

  const statOf = async (abs) => {
    const s = await fsp.stat(abs).catch(() => null);
    return s ? { mtime: s.mtimeMs, size: s.size } : null;
  };

  // A newer upload to the same place replaces one still being re-encoded.
  function cancelEncode(abs) {
    const job = encodes.get(abs);
    if (!job) return;
    job.cancelled = true;
    encodes.delete(abs);
    if (job.proc) job.proc.kill('SIGKILL');
    // Still waiting for its turn: encode() tidies up when it gets there. The
    // manifest goes now, so a restart doesn't bring the upload back.
    fsp.rm(path.join(uploadDir, job.id + '.json'), { force: true }).catch(() => {});
  }

  // Re-encode a finished upload, then place it. The original is kept instead
  // when ffmpeg fails or does not make it smaller. Until then the upload and
  // a small manifest stay in the upload folder, so a restarted server
  // carries on (recoverEncodes).
  function startEncode(job) {
    encodes.set(job.abs, job);
    videoJobs('video:' + job.id, () => encode(job))
      .catch((e) => console.warn('[media] upload not placed:', job.rel, e.message))
      .finally(() => { if (encodes.get(job.abs) === job) encodes.delete(job.abs); });
  }

  async function encode(job) {
    const out = path.join(uploadDir, job.id + '.out');
    const manifest = path.join(uploadDir, job.id + '.json');
    const cleanup = () => Promise.all([job.tmp, out, manifest].map((f) => fsp.rm(f, { force: true }).catch(() => {})));
    if (job.cancelled) return cleanup();
    if (closed) return;
    let file = job.tmp;
    try {
      await video.reencode(job.tmp, out, video.extOf(job.rel), Object.assign({}, opts.video, { onProcess: (p) => { job.proc = p; } }));
      const [a, b] = await Promise.all([fsp.stat(job.tmp), fsp.stat(out)]);
      if (b.size > 0 && b.size < a.size) file = out;
    } catch (e) {
      if (!job.cancelled && !closed) console.warn('[media] re-encoding failed, keeping the original:', job.rel, e.message);
    }
    job.proc = null;
    if (job.cancelled) return cleanup();
    if (closed) { await fsp.rm(out, { force: true }).catch(() => {}); return; }   // resumed on the next start
    // Written by someone else in the meantime: that newer file stays.
    const now = await statOf(job.abs);
    const b = job.before;
    const untouched = b ? !!now && now.mtime === b.mtime && now.size === b.size : !now;
    if (untouched) await place(file, job, !!b);
    else console.warn('[media] ' + job.rel + ' changed while its upload was re-encoded; the upload was dropped');
    await cleanup();
  }

  async function recoverEncodes() {
    const names = await fsp.readdir(uploadDir).catch(() => []);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const m = await readJson(path.join(uploadDir, name));
      const tmp = path.join(uploadDir, name.slice(0, -5) + '.part');
      try {
        if (!m || m.id + '.json' !== name || !(await fsp.stat(tmp).catch(() => null))) throw new Error('incomplete');
        const abs = resolve(m.vault, m.rel);
        if (encodes.has(abs)) continue;
        startEncode({ id: m.id, vault: m.vault, rel: m.rel, abs, tmp, overwrite: !!m.overwrite, before: m.before || null });
      } catch (_) {
        await fsp.rm(path.join(uploadDir, name), { force: true }).catch(() => {});
      }
    }
  }
  if (videoOn) setTimeout(() => recoverEncodes().catch(() => {}), 3000).unref();

  router.post('/upload/start', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const { vault, size } = req.body || {};
      const rel = String((req.body && req.body.path) || '');
      const abs = resolve(vault, rel);
      const overwrite = req.body.overwrite === true;
      if (!(Number.isSafeInteger(size) && size >= 0 && size <= MAX_UPLOAD)) return res.status(400).json({ error: 'bad size' });
      const there = await fsp.stat(abs).catch(() => null);
      if (there && there.isDirectory()) return res.status(409).json({ error: 'a folder with this name already exists' });
      if (there && !overwrite) return res.status(409).json({ error: 'a file with this name already exists' });
      const id = crypto.randomBytes(16).toString('hex');
      const tmp = path.join(uploadDir, id + '.part');
      await fsp.mkdir(uploadDir, { recursive: true });
      await (await fsp.open(tmp, 'w')).close();
      const reencode = videoOn && req.body.reencode === true && video.canReencode(rel);
      uploads.set(id, { vault, rel, abs, size, tmp, overwrite, reencode, client: req.query.client || null });
      res.json({ id, chunk: CHUNK, reencode });
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
      const before = await statOf(u.abs);
      if (before && !u.overwrite) return res.status(409).json({ error: 'a file with this name already exists' });
      uploads.delete(id);
      cancelEncode(u.abs);
      if (u.reencode) {
        const job = { id, vault: u.vault, rel: u.rel, abs: u.abs, tmp: u.tmp, overwrite: u.overwrite, before };
        await fsp.writeFile(path.join(uploadDir, id + '.json'),
          JSON.stringify({ id, vault: job.vault, rel: job.rel, overwrite: job.overwrite, before }));
        startEncode(job);
        return res.json({ ok: true, path: u.rel, reencoding: true });
      }
      const meta = await place(u.tmp, u, !!before);
      res.json(Object.assign({ ok: true, path: u.rel }, meta));
    } catch (e) { fail(res, e); }
  });

  // The uploader deleted or renamed the file meanwhile: drop its upload.
  router.post('/upload/encoding/cancel', express.json({ limit: '16kb' }), (req, res) => {
    try {
      const abs = resolve(req.body && req.body.vault, String((req.body && req.body.path) || ''));
      const was = encodes.has(abs);
      cancelEncode(abs);
      res.json({ ok: true, cancelled: was });
    } catch (e) { fail(res, e); }
  });

  // What is still being re-encoded for a vault: uploads that finished but
  // are not in it yet.
  router.get('/upload/encoding', (req, res) => {
    const vault = String(req.query.vault || '');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json({ paths: [...encodes.values()].filter((j) => j.vault === vault).map((j) => j.rel) });
  });

  router.close = () => {
    closed = true;
    for (const job of encodes.values()) if (job.proc) job.proc.kill('SIGKILL');
    return pool.close();
  };
  return router;
}

module.exports = { createMediaRouter, snapWidth };
