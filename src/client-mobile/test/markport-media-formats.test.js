'use strict';

// src/plugins/markport-clipper/media-formats.js: shared by the image library
// plugin and the server's media service.

const assert = require('assert/strict');
const path = require('path');
const test = require('node:test');

const F = require(path.join(__dirname, '..', '..', 'plugins', 'markport-clipper', 'media-formats.js'));

test('kinds: images by how they can be shown, models, flipbook folders', () => {
  assert.equal(F.kindOf('a.PNG'), 'image');
  assert.equal(F.kindOf('art.psd'), 'image');
  assert.equal(F.kindOf('photo.cr3'), 'image');
  assert.equal(F.kindOf('scan.exr'), 'image');
  assert.equal(F.kindOf('robot.fbx'), 'model');
  assert.equal(F.kindOf('glb'), 'model', 'a bare extension works too');
  assert.equal(F.kindOf('notes.md'), '');
  assert.equal(F.kindOf('Pyramid.mtl'), '', 'sidecars are not items');
  assert.equal(F.imageSupport('webp'), 'web');
  assert.equal(F.imageSupport('psd'), 'local');
  assert.equal(F.imageSupport('heic'), 'server');
  assert.equal(F.extOf('a/b.c/d'), '', 'a dot in a folder name is not an extension');
  assert.equal(F.isFlipbookName('Walk.flipbook'), true);
  assert.equal(F.isFlipbookName('.flipbook'), false);
  assert.equal(F.flipbookBase('Walk.FLIPBOOK'), 'Walk');
  assert.deepEqual(F.sortFrames(['f10.png', 'f2.png', 'F1.png']), ['F1.png', 'f2.png', 'f10.png']);
});

test('decodeTGA: true-color, origin, RLE', () => {
  // 2x2, 24-bit, bottom-left origin (default): first stored row is the bottom one.
  const raw = Buffer.alloc(18 + 12);
  raw[2] = 2; raw.writeUInt16LE(2, 12); raw.writeUInt16LE(2, 14); raw[16] = 24;
  // bottom row: red, green; top row: blue, white (BGR)
  Buffer.from([0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255]).copy(raw, 18);
  const a = F.decodeTGA(raw);
  assert.deepEqual([a.width, a.height], [2, 2]);
  assert.deepEqual([...a.data.slice(0, 4)], [0, 0, 255, 255], 'top-left is blue after the flip');
  assert.deepEqual([...a.data.slice(8, 12)], [255, 0, 0, 255], 'bottom-left is red');

  // RLE, 32-bit, top-left origin: one run of 3 orange pixels, then one raw pixel.
  const rle = Buffer.alloc(18 + 1 + 4 + 1 + 4);
  rle[2] = 10; rle.writeUInt16LE(4, 12); rle.writeUInt16LE(1, 14); rle[16] = 32; rle[17] = 0x20;
  Buffer.from([0x82, 0, 128, 255, 200, 0x00, 10, 20, 30, 40]).copy(rle, 18);
  const b = F.decodeTGA(rle);
  assert.deepEqual([...b.data.slice(0, 4)], [255, 128, 0, 200]);
  assert.deepEqual([...b.data.slice(8, 12)], [255, 128, 0, 200]);
  assert.deepEqual([...b.data.slice(12, 16)], [30, 20, 10, 40]);
  assert.throws(() => F.decodeTGA(Buffer.from('nope')));
});

test('decodeQOI: literal pixels, runs, index', () => {
  const head = Buffer.from([0x71, 0x6f, 0x69, 0x66, 0, 0, 0, 4, 0, 0, 0, 1, 4, 0]);
  // RGBA(10,20,30,255), RUN x2 (0xc1 = 2 pixels), then INDEX of that color
  const idx = (10 * 3 + 20 * 5 + 30 * 7 + 255 * 11) % 64;
  const body = Buffer.from([0xff, 10, 20, 30, 255, 0xc1, idx]);
  const q = F.decodeQOI(Buffer.concat([head, body, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]));
  assert.deepEqual([q.width, q.height], [4, 1]);
  for (let i = 0; i < 4; i++) assert.deepEqual([...q.data.slice(i * 4, i * 4 + 4)], [10, 20, 30, 255]);
  assert.throws(() => F.decodeQOI(Buffer.from('qoifxx')));
});

function jpegOf(w, hgt, payload) {
  // SOI, SOF0 (w x h), SOS + entropy data with a stuffed FF00 and a restart marker, EOI
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0, 0, 11, 8, hgt >> 8, hgt & 255, w >> 8, w & 255, 1, 1, 0x11, 0]),
    Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]),
    Buffer.from(payload), Buffer.from([0xff, 0x00, 1, 2, 0xff, 0xd3, 3]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

test('largestEmbeddedJpeg: picks the biggest complete preview in a RAW file', () => {
  const small = jpegOf(160, 120, Buffer.alloc(3000, 1));
  const big = jpegOf(6000, 4000, Buffer.alloc(5000, 2));
  const raw = Buffer.concat([Buffer.from('II*\0'), Buffer.alloc(100), small, Buffer.alloc(50), big, Buffer.alloc(20)]);
  const r = F.largestEmbeddedJpeg(raw);
  assert.deepEqual([r.width, r.height], [6000, 4000]);
  assert.deepEqual(Buffer.from(r.bytes), big);
  assert.equal(F.largestEmbeddedJpeg(Buffer.alloc(100)), null);
});

test('zipImage and psdSize', () => {
  const calls = [];
  const unzip = (bytes, name) => { calls.push(name); return name === 'mergedimage.png' ? new Uint8Array([1, 2]) : null; };
  assert.deepEqual([...F.zipImage('ora', new Uint8Array(1), unzip)], [1, 2]);
  assert.deepEqual(calls, ['mergedimage.png']);
  assert.equal(F.zipImage('procreate', new Uint8Array(1), () => null), null);
  const psd = Buffer.alloc(26);
  psd.write('8BPS', 0, 'latin1');
  psd.writeUInt32BE(300, 14);
  psd.writeUInt32BE(500, 18);
  assert.deepEqual(F.psdSize(psd), { height: 300, width: 500 });
  assert.equal(F.psdSize(Buffer.alloc(26)), null);
});
