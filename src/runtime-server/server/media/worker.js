'use strict';

/**
 * Media worker (worker_threads; see pool.js). Two jobs:
 *
 *   decode  formats sharp cannot read, in JavaScript: HEIC/HEIF (libheif), PSD/PSB
 *           composite (ag-psd), TGA, QOI, TIFF fallback (utif2), the
 *           flattened image in Krita/OpenRaster/Procreate files, the JPEG
 *           preview in camera RAW files. Returns raw RGBA pixels or encoded
 *           image bytes, for sharp to resize on the main thread.
 *
 *   model   optimize a glTF/GLB for the web with glTF-Transform: dedup,
 *           weld, simplify dense meshes (to about maxTriangles in all),
 *           resample, prune, WebP textures (at most maxTexture px),
 *           meshopt geometry compression. Writes the GLB and a Brotli copy.
 *
 * Neither touches the vault: inputs are read, outputs go to the cache.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parentPort } = require('worker_threads');

const formats = require(path.join(__dirname, '..', '..', '..', 'plugins', 'markport-clipper', 'media-formats.js'));

function raw(img) {
  const data = img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return { kind: 'raw', width: img.width, height: img.height, data };
}

function encoded(bytes) {
  return { kind: 'encoded', data: new Uint8Array(bytes) };   // a copy: never a view of the whole file
}

function unzipOne(bytes, name) {
  const { unzipSync } = require('fflate');
  const out = unzipSync(bytes, { filter: (f) => f.name === name });
  return out[name] || null;
}

let psdReady = false;
let heif = null;   // libheif (WebAssembly), loaded on the first HEIC

function decode({ file, ext }) {
  const buf = new Uint8Array(fs.readFileSync(file));
  const e = String(ext).toLowerCase();
  if (e === 'psd' || e === 'psb') {
    const { readPsd, initializeCanvas } = require('ag-psd');
    // Pixels only, no canvas: ag-psd still wants a way to make image data.
    if (!psdReady) {
      initializeCanvas(() => { throw new Error('no canvas in the media worker'); }, (w, hgt) => ({ width: w, height: hgt, data: new Uint8ClampedArray(w * hgt * 4) }));
      psdReady = true;
    }
    const psd = readPsd(buf, { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
    if (!psd.imageData) throw new Error('This PSD has no flattened image (save it with "Maximize compatibility")');
    return raw(psd.imageData);
  }
  if (e === 'heic' || e === 'heif' || e === 'hif') {
    if (!heif) heif = require('libheif-js/wasm-bundle');
    return formats.decodeHEIF(heif, buf).then(raw);
  }
  if (e === 'tga' || e === 'icb' || e === 'vda' || e === 'vst') return raw(formats.decodeTGA(buf));
  if (e === 'qoi') return raw(formats.decodeQOI(buf));
  if (e === 'kra' || e === 'ora' || e === 'procreate') {
    const png = formats.zipImage(e, buf, unzipOne);
    if (!png) throw new Error('No flattened image in this ' + e + ' file');
    return encoded(png);
  }
  if (formats.RAW_CAMERA.includes(e)) {
    const jpg = formats.largestEmbeddedJpeg(buf);
    if (!jpg) throw new Error('No preview image in this RAW file');
    return encoded(jpg.bytes);
  }
  if (e === 'tif' || e === 'tiff') {
    const UTIF = require('utif2');
    const ifds = UTIF.decode(buf.buffer);
    if (!ifds.length) throw new Error('Empty TIFF');
    // The largest page is the image; small ones are thumbnails.
    const page = ifds.reduce((a, b) => ((b.width || b.t256) * (b.height || b.t257) > (a.width || a.t256) * (a.height || a.t257) ? b : a));
    UTIF.decodeImage(buf.buffer, page, ifds);
    return raw({ width: page.width, height: page.height, data: new Uint8Array(UTIF.toRGBA8(page)) });
  }
  throw new Error('No decoder for .' + e);
}

let gltf = null;
async function gltfTools() {
  if (gltf) return gltf;
  const { NodeIO } = require('@gltf-transform/core');
  const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
  const F = require('@gltf-transform/functions');
  const { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } = require('meshoptimizer');
  const draco3d = require('draco3dgltf');
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
  gltf = { io, F, MeshoptEncoder, MeshoptSimplifier, sharp: require('sharp') };
  return gltf;
}

// Triangles drawn per frame across a document's triangle meshes.
function countTriangles(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;            // TRIANGLES only
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      n += (idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3;
    }
  }
  return n;
}

async function model({ input, output, maxTexture, maxTriangles }) {
  const { io, F, MeshoptEncoder, MeshoptSimplifier, sharp } = await gltfTools();
  const doc = await io.read(input);
  // Draco input was decoded on read; the output uses meshopt only.
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
  }
  const size = maxTexture || 2048;
  await doc.transform(F.dedup(), F.weld());
  // Scans and CAD exports often carry millions of triangles: on the GPU that
  // is what makes orbiting slow on every device, laptops and phones alike.
  // The web copy is simplified toward maxTriangles; the error bound (0.5% of
  // each mesh's size) stops it before detail visibly changes, so a model
  // that cannot get there without looking different keeps more triangles.
  // The original file in the vault is never touched.
  const limit = maxTriangles || 500000;
  const triangles = countTriangles(doc);
  if (triangles > limit) {
    await doc.transform(F.simplify({ simplifier: MeshoptSimplifier, ratio: limit / triangles, error: 0.005 }));
  }
  await doc.transform(
    F.resample(),
    F.prune(),
    F.textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: 85 }),
    F.meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const glb = await io.writeBinary(doc);
  // meshopt data is built to be compressed again: Brotli shrinks it a lot more.
  const br = zlib.brotliCompressSync(glb, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: glb.length },
  });
  fs.writeFileSync(output, glb);
  fs.writeFileSync(output + '.br', br);
  return { bytes: glb.length, brotli: br.length };
}

parentPort.on('message', async ({ id, type, args }) => {
  try {
    let result;
    if (type === 'decode') {
      result = await decode(args);
      parentPort.postMessage({ id, result }, [result.data.buffer]);
      return;
    }
    if (type === 'model') result = await model(args);
    else throw new Error('Unknown job ' + type);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
});
