'use strict';

/**
 * Image thumbnails and previews for the media service.
 *
 * One function, render(file, ext, width, out): make a WebP no wider or taller
 * than `width` from any image the server can read, and return the source's
 * size. Decoders, in order:
 *
 *   1. sharp (libvips): JPEG, PNG, WebP, AVIF, GIF, TIFF
 *   2. worker.js (plain JS / WebAssembly): HEIC/HEIF (libheif; tried before
 *      sharp for those), PSD/PSB, TGA, QOI, Krita/OpenRaster/Procreate,
 *      camera RAW previews, TIFF that libvips refused
 *   3. ImageMagick, when installed (the Docker image has it): HEIC, JPEG XL,
 *      JPEG 2000, EXR, HDR, DDS, XCF, BMP, ICO, PCX, ... and anything the
 *      first two could not read
 *
 * The source file is only read.
 */

const { spawn, spawnSync } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');
const sharp = require('sharp');

const formats = require(path.join(__dirname, '..', '..', '..', 'plugins', 'markport-clipper', 'media-formats.js'));

sharp.cache(false);                  // the media cache is the cache; keep libvips' memory low
sharp.concurrency(Math.max(1, Math.min(4, require('os').cpus().length - 1)));

const SHARP_INPUT = new Set(['jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp', 'png', 'apng', 'webp', 'avif', 'gif', 'tif', 'tiff', 'heic', 'heif', 'hif']);
const WORKER_INPUT = new Set(['psd', 'psb', 'tga', 'icb', 'vda', 'vst', 'qoi', 'kra', 'ora', 'procreate', 'tif', 'tiff', 'heic', 'heif', 'hif'].concat(formats.RAW_CAMERA));
const MAX_PIXELS = 512e6;            // refuse decompression bombs

// ImageMagick 7 ("magick") or 6 ("convert"). Not on Windows: convert.exe there is a disk tool.
let magickCmd;
function magick() {
  if (magickCmd !== undefined) return magickCmd;
  magickCmd = null;
  if (process.env.MARKPORT_IMAGEMAGICK === 'false') return null;
  const candidates = process.env.MARKPORT_IMAGEMAGICK ? [process.env.MARKPORT_IMAGEMAGICK] : (process.platform === 'win32' ? ['magick'] : ['magick', 'convert']);
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ['-version'], { timeout: 5000, encoding: 'utf8' });
      if (r.status === 0 && /ImageMagick/i.test(r.stdout || '')) { magickCmd = cmd; break; }
    } catch (_) { /* not there */ }
  }
  return magickCmd;
}

// ImageMagick -> PNG on stdout (first frame/page/layer only), size-limited.
function magickToPng(file, width) {
  const cmd = magick();
  if (!cmd) return Promise.reject(new Error('ImageMagick is not installed'));
  return new Promise((resolve, reject) => {
    const args = ['-limit', 'memory', '512MiB', '-limit', 'map', '1GiB', '-limit', 'time', '120',
      file + '[0]', '-auto-orient', '-colorspace', 'sRGB'];
    if (width) args.push('-thumbnail', width + 'x' + width + '>');
    args.push('png:-');
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 130e3);
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => { if (err.length < 2000) err += c; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error('ImageMagick could not read this file' + (err ? ': ' + err.trim().split('\n')[0] : '')));
    });
  });
}

function toWebp(img, width) {
  return img
    .rotate()
    .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: width <= 512 ? 74 : 82, effort: 4, smartSubsample: true });
}

async function sizeOf(img) {
  const m = await img.metadata();
  const swap = m.orientation >= 5;   // EXIF orientations 5-8 rotate by 90°
  return { width: swap ? m.height : m.width, height: swap ? m.width : m.height, format: m.format, pages: m.pages || 1 };
}

// HEIC/HEIF: libheif (worker) first - libvips here reads their headers but
// has no HEVC decoder. sharp after it covers JPEGs that only carry a .heic
// name (common after iPhone photos are converted on the way).
const HEIF = new Set(['heic', 'heif', 'hif']);

/**
 * Ways to decode `file` into a sharp pipeline, best first. Each resolves to
 * { img, source } where source is { width, height, format, decoder }.
 */
function openers(file, ext, pool, width) {
  const e = String(ext).toLowerCase();
  const out = [];
  const viaSharp = async () => {
    const img = sharp(file, { limitInputPixels: MAX_PIXELS, failOn: 'none', animated: false, pages: 1 });
    const source = await sizeOf(img);
    return { img, source: Object.assign(source, { decoder: 'sharp' }) };
  };
  const viaWorker = async () => {
    const r = await pool.run('decode', { file, ext: e });
    const img = r.kind === 'raw'
      ? sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), { raw: { width: r.width, height: r.height, channels: 4 }, limitInputPixels: MAX_PIXELS })
      : sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), { limitInputPixels: MAX_PIXELS, failOn: 'none' });
    const source = r.kind === 'raw' ? { width: r.width, height: r.height, format: e, pages: 1 } : await sizeOf(img);
    return { img, source: Object.assign(source, { format: e, decoder: 'js' }) };
  };
  const viaMagick = async () => {
    // Ask ImageMagick for a working size a little above the target, then let sharp finish.
    const png = await magickToPng(file, width ? Math.min(8192, width * 2) : 0);
    const img = sharp(png, { limitInputPixels: MAX_PIXELS });
    const source = await sizeOf(img);
    return { img, source: Object.assign(source, { format: e, decoder: 'imagemagick', approximate: true }) };
  };
  const worker = WORKER_INPUT.has(e) && pool;
  if (HEIF.has(e) && worker) out.push(viaWorker);
  if (SHARP_INPUT.has(e)) out.push(viaSharp);
  if (worker && !HEIF.has(e)) out.push(viaWorker);
  if (magick()) out.push(viaMagick);
  return out;
}

// Make the WebP with the first decoder that gets all the way through: a
// decoder can read a file's header and still fail on its pixels (libvips
// with HEVC), so the encode is part of each attempt.
async function render(file, ext, width, out, pool) {
  const e = String(ext).toLowerCase();
  const errors = [];
  await fsp.mkdir(path.dirname(out), { recursive: true });
  for (const attempt of openers(file, e, pool, width)) {
    const tmp = out + '.' + process.pid + '.' + Date.now() + '.tmp';
    try {
      const { img, source } = await attempt();
      await toWebp(img, width).toFile(tmp);
      await fsp.rename(tmp, out);
      return source;
    } catch (err) {
      errors.push(err.message);
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }
  throw new Error(errors[0] || ('This server cannot read .' + e + ' files' + (magick() ? '' : ' (install ImageMagick for more formats)')));
}

// The source's size without making a thumbnail, when that is cheap.
async function info(file, ext) {
  const e = String(ext).toLowerCase();
  if (SHARP_INPUT.has(e)) {
    try { return Object.assign(await sizeOf(sharp(file, { failOn: 'none' })), { decoder: 'sharp' }); } catch (_) { /* fall through */ }
  }
  if (e === 'psd' || e === 'psb') {
    const fh = await fsp.open(file, 'r');
    try {
      const b = Buffer.alloc(26);
      await fh.read(b, 0, 26, 0);
      const s = formats.psdSize(b);
      if (s) return Object.assign(s, { format: e, pages: 1, decoder: 'header' });
    } finally { await fh.close(); }
  }
  return null;
}

module.exports = { render, info, magick, SHARP_INPUT, WORKER_INPUT };
