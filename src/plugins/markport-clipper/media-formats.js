'use strict';

/**
 * Markport media formats: shared by the image library plugin (main.js loads
 * this file from its own folder) and the Markport server's media service
 * (src/runtime-server/server/media/). Plain CommonJS, no dependencies, no DOM:
 * it runs in Node, in Obsidian and in a browser.
 *
 * What kind of file something is, how flipbook frames are ordered, and small
 * decoders for formats a browser cannot show and no library is needed for:
 * TGA, QOI, the JPEG preview inside camera RAW files, and the flattened image
 * inside Krita / OpenRaster / Procreate files (those are zip files; the
 * caller passes an unzip function).
 *
 * Nothing here converts or writes files. Decoders return pixels or bytes in
 * memory, for display.
 */

// Formats every browser shows as they are.
const WEB_IMAGE = ['png', 'apng', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'cur'];

// Formats the plugin can decode itself for display (no server needed).
const RAW_CAMERA = ['dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2', 'raf', 'pef', 'srw', 'x3f', '3fr', 'erf', 'kdc', 'mos', 'mrw', 'iiq', 'rwl', 'dcr'];
const LOCAL_DECODE = ['psd', 'psb', 'tif', 'tiff', 'tga', 'icb', 'vda', 'vst', 'qoi', 'kra', 'ora', 'procreate', 'heic', 'heif', 'hif'].concat(RAW_CAMERA);

// Formats only the server can turn into something viewable (sharp/libvips, ImageMagick).
const SERVER_IMAGE = ['jxl', 'jp2', 'j2k', 'j2c', 'jpf', 'jpx', 'jpm', 'exr', 'hdr', 'pic', 'dds', 'xcf', 'pcx',
  'ppm', 'pgm', 'pbm', 'pnm', 'pfm', 'pam', 'sgi', 'rgb', 'rgba', 'bw', 'ras', 'sun', 'dpx', 'cin', 'fits', 'fit', 'fts', 'wbmp', 'xpm',
  'xbm', 'miff', 'mng', 'jng', 'otb', 'palm', 'pict', 'pct', 'icns', 'vtf', 'ktx', 'ktx2', 'wdp', 'jxr', 'hdp'];

const MODEL = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', '3mf', 'dae', 'usdz'];

// Files a model loads from next to itself (besides textures). They stay ordinary files.
const MODEL_SIDECAR = ['mtl', 'bin'];

const FLIPBOOK_SUFFIX = '.flipbook';

const sets = {
  web: new Set(WEB_IMAGE),
  local: new Set(LOCAL_DECODE),
  server: new Set(SERVER_IMAGE),
  raw: new Set(RAW_CAMERA),
  model: new Set(MODEL),
};

function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 && i > s.lastIndexOf('/') ? s.slice(i + 1).toLowerCase() : '';
}

// 'image' | 'model' | '' for a file name or extension.
function kindOf(nameOrExt) {
  const ext = String(nameOrExt || '').includes('.') ? extOf(nameOrExt) : String(nameOrExt || '').toLowerCase();
  if (sets.web.has(ext) || sets.local.has(ext) || sets.server.has(ext)) return 'image';
  if (sets.model.has(ext)) return 'model';
  return '';
}

// How an image can be shown: 'web' (as it is), 'local' (decoded in memory
// by the plugin), 'server' (needs the server's converter), or ''.
function imageSupport(ext) {
  const e = String(ext || '').toLowerCase();
  if (sets.web.has(e)) return 'web';
  if (sets.local.has(e)) return 'local';
  if (sets.server.has(e)) return 'server';
  return '';
}

function isFlipbookName(name) {
  const s = String(name || '');
  return s.length > FLIPBOOK_SUFFIX.length && s.toLowerCase().endsWith(FLIPBOOK_SUFFIX);
}

function flipbookBase(name) {
  return String(name || '').slice(0, -FLIPBOOK_SUFFIX.length);
}

// Frame order: natural sort, so "frame2" comes before "frame10".
function sortFrames(names) {
  return names.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

// ── TGA (Truevision) ────────────────────────────────────────────────────────
// Uncompressed and RLE, true-color (16/24/32 bit), grayscale and color-mapped.
// Returns { width, height, data: Uint8ClampedArray RGBA } or throws.

function decodeTGA(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 18) throw new Error('Not a TGA file');
  const idLen = b[0];
  const cmapType = b[1];
  const type = b[2];
  const cmapFirst = b[3] | (b[4] << 8);
  const cmapLen = b[5] | (b[6] << 8);
  const cmapBits = b[7];
  const width = b[12] | (b[13] << 8);
  const height = b[14] | (b[15] << 8);
  const bpp = b[16];
  const desc = b[17];
  if (!width || !height || ![1, 2, 3, 9, 10, 11].includes(type)) throw new Error('Unsupported TGA');
  let p = 18 + idLen;
  let cmap = null;
  if (cmapType === 1) {
    const cb = Math.ceil(cmapBits / 8);
    cmap = b.subarray(p, p + cmapLen * cb);
    p += cmapLen * cb;
  }
  const rle = type >= 9;
  const base = type & 7;           // 1 color-mapped, 2 true-color, 3 grayscale
  const pxBytes = Math.ceil(bpp / 8);
  const out = new Uint8ClampedArray(width * height * 4);
  const readColor = (src, off, dst, o) => {
    if (base === 3) {
      dst[o] = dst[o + 1] = dst[o + 2] = src[off];
      dst[o + 3] = pxBytes > 1 ? src[off + 1] : 255;
    } else if (base === 1) {
      const idx = (pxBytes === 2 ? src[off] | (src[off + 1] << 8) : src[off]) - cmapFirst;
      const cb = Math.ceil(cmapBits / 8);
      readTrue(cmap, idx * cb, cb, dst, o);
    } else {
      readTrue(src, off, pxBytes, dst, o);
    }
  };
  const total = width * height;
  let i = 0;
  if (!rle) {
    for (; i < total && p + pxBytes <= b.length; i++, p += pxBytes) readColor(b, p, out, i * 4);
  } else {
    while (i < total && p < b.length) {
      const h = b[p++];
      const n = (h & 127) + 1;
      if (h & 128) {
        const tmp = new Uint8ClampedArray(4);
        readColor(b, p, tmp, 0);
        p += pxBytes;
        for (let k = 0; k < n && i < total; k++, i++) out.set(tmp, i * 4);
      } else {
        for (let k = 0; k < n && i < total; k++, i++, p += pxBytes) readColor(b, p, out, i * 4);
      }
    }
  }
  // Origin: bit 5 set = top-left; otherwise bottom-left (flip rows). Bit 4 = right-to-left.
  if (!(desc & 0x20)) flipRows(out, width, height);
  if (desc & 0x10) flipCols(out, width, height);
  return { width, height, data: out };
}

function readTrue(src, off, bytes, dst, o) {
  if (bytes === 2) {
    const v = src[off] | (src[off + 1] << 8);
    dst[o] = ((v >> 10) & 31) * 255 / 31;
    dst[o + 1] = ((v >> 5) & 31) * 255 / 31;
    dst[o + 2] = (v & 31) * 255 / 31;
    dst[o + 3] = 255;
  } else {
    dst[o] = src[off + 2];
    dst[o + 1] = src[off + 1];
    dst[o + 2] = src[off];
    dst[o + 3] = bytes === 4 ? src[off + 3] : 255;
  }
}

function flipRows(px, w, h) {
  const row = w * 4;
  const tmp = new Uint8ClampedArray(row);
  for (let y = 0; y < h >> 1; y++) {
    const a = y * row;
    const z = (h - 1 - y) * row;
    tmp.set(px.subarray(a, a + row));
    px.copyWithin(a, z, z + row);
    px.set(tmp, z);
  }
}

function flipCols(px, w, h) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w >> 1; x++) {
      const a = (y * w + x) * 4;
      const z = (y * w + (w - 1 - x)) * 4;
      for (let c = 0; c < 4; c++) { const t = px[a + c]; px[a + c] = px[z + c]; px[z + c] = t; }
    }
  }
}

// ── QOI (Quite OK Image) ────────────────────────────────────────────────────

function decodeQOI(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 22 || b[0] !== 0x71 || b[1] !== 0x6f || b[2] !== 0x69 || b[3] !== 0x66) throw new Error('Not a QOI file');
  const width = ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0;
  const height = ((b[8] << 24) | (b[9] << 16) | (b[10] << 8) | b[11]) >>> 0;
  if (!width || !height || width * height > 400e6) throw new Error('Bad QOI size');
  const out = new Uint8ClampedArray(width * height * 4);
  const index = new Uint8Array(64 * 4);
  let r = 0, g = 0, bl = 0, a = 255;
  let p = 14;
  let run = 0;
  const end = b.length - 8;
  for (let o = 0; o < out.length; o += 4) {
    if (run > 0) run--;
    else if (p < end) {
      const b1 = b[p++];
      if (b1 === 0xfe) { r = b[p++]; g = b[p++]; bl = b[p++]; }
      else if (b1 === 0xff) { r = b[p++]; g = b[p++]; bl = b[p++]; a = b[p++]; }
      else if ((b1 & 0xc0) === 0x00) { const i = b1 * 4; r = index[i]; g = index[i + 1]; bl = index[i + 2]; a = index[i + 3]; }
      else if ((b1 & 0xc0) === 0x40) { r += ((b1 >> 4) & 3) - 2; g += ((b1 >> 2) & 3) - 2; bl += (b1 & 3) - 2; }
      else if ((b1 & 0xc0) === 0x80) {
        const b2 = b[p++];
        const dg = (b1 & 0x3f) - 32;
        r += dg - 8 + ((b2 >> 4) & 15);
        g += dg;
        bl += dg - 8 + (b2 & 15);
      } else run = b1 & 0x3f;
      r &= 255; g &= 255; bl &= 255;
      const i = ((r * 3 + g * 5 + bl * 7 + a * 11) % 64) * 4;
      index[i] = r; index[i + 1] = g; index[i + 2] = bl; index[i + 3] = a;
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = a;
  }
  return { width, height, data: out };
}

// ── The JPEG preview inside camera RAW files ────────────────────────────────
// Nearly every RAW format (CR2, CR3, NEF, ARW, DNG, ORF, RW2, RAF, PEF, ...)
// carries one or more ordinary JPEG previews; the largest is usually full
// size. Finds every complete JPEG in the bytes by walking its markers, and
// returns the largest by pixel count: { bytes: Uint8Array, width, height } or null.

function largestEmbeddedJpeg(input, minBytes) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  let best = null;
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] !== 0xff || b[i + 1] !== 0xd8 || b[i + 2] !== 0xff) continue;
    const found = walkJpeg(b, i);
    if (!found) continue;
    if ((!best || found.width * found.height > best.width * best.height) && found.end - i >= (minBytes || 2048)) {
      best = { start: i, end: found.end, width: found.width, height: found.height };
    }
    i = found.end - 1;
  }
  return best ? { bytes: b.subarray(best.start, best.end), width: best.width, height: best.height } : null;
}

function walkJpeg(b, start) {
  let p = start + 2;
  let width = 0;
  let height = 0;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    let m = b[p + 1];
    while (m === 0xff && p + 2 < b.length) { p++; m = b[p + 1]; }
    if (m === 0xd9) return width && height ? { end: p + 2, width, height } : null;
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2) return null;
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && p + 9 < b.length) {
      height = (b[p + 5] << 8) | b[p + 6];
      width = (b[p + 7] << 8) | b[p + 8];
    }
    p += 2 + len;
    if (m === 0xda) {
      // Entropy-coded data: runs to the next marker that is not a stuffed
      // byte (FF00) or a restart marker (FFD0-FFD7).
      while (p + 1 < b.length) {
        if (b[p] === 0xff && b[p + 1] !== 0x00 && !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7) && b[p + 1] !== 0xff) break;
        p++;
      }
    }
  }
  return null;
}

// ── Zip-based paint formats ─────────────────────────────────────────────────
// unzip(bytes, wantedName) -> Uint8Array | null (fflate's unzipSync with a
// filter works). Returns the PNG bytes of the flattened image.

const ZIP_IMAGE = {
  ora: ['mergedimage.png', 'Thumbnails/thumbnail.png'],
  kra: ['mergedimage.png', 'preview.png'],
  procreate: ['QuickLook/Thumbnail.png'],
};

function zipImage(ext, bytes, unzip) {
  for (const name of ZIP_IMAGE[String(ext).toLowerCase()] || []) {
    const out = unzip(bytes, name);
    if (out && out.length) return out;
  }
  return null;
}

// ── HEIC / HEIF (iPhone photos) ─────────────────────────────────────────────
// lib: libheif-js (WebAssembly), passed in so this file stays dependency-free.
// Decodes the primary image with its rotation/mirroring applied.
// Resolves to { width, height, data: Uint8ClampedArray RGBA }.

function isHeifBytes(b) {
  // ISO BMFF: size(4) "ftyp" brand - heic heix hevc hevx heim heis mif1 msf1 avif ...
  return b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
}

function decodeHEIF(lib, input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isHeifBytes(b)) return Promise.reject(new Error('Not a HEIF file'));
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(b);
  if (!images || !images.length) return Promise.reject(new Error('No image in this HEIC file'));
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  return new Promise((resolve, reject) => {
    image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (out) => {
      for (const im of images) { try { if (im.free) im.free(); } catch (_) { /* already gone */ } }
      if (!out) reject(new Error('Could not decode this HEIC file'));
      else resolve({ width, height, data: out.data });
    });
  });
}

// ── PSD / PSB header (dimensions without decoding) ──────────────────────────

function psdSize(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 26 || b[0] !== 0x38 || b[1] !== 0x42 || b[2] !== 0x50 || b[3] !== 0x53) return null;
  const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  return { height: u32(14), width: u32(18) };
}

module.exports = {
  WEB_IMAGE, LOCAL_DECODE, SERVER_IMAGE, RAW_CAMERA, MODEL, MODEL_SIDECAR, FLIPBOOK_SUFFIX,
  extOf, kindOf, imageSupport, isFlipbookName, flipbookBase, sortFrames,
  decodeTGA, decodeQOI, largestEmbeddedJpeg, zipImage, psdSize, isHeifBytes, decodeHEIF,
};
