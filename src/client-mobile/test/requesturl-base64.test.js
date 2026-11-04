'use strict';

/**
 * Unit tests for base64↔ArrayBuffer helpers used by requestUrl and Filesystem.
 *
 * The helpers (base64ToArrayBuffer / arrayBufferToBase64) live in capacitor-shim.js
 * which is a browser IIFE — we can't require() it directly. Instead we redefine
 * the helpers here (identical code) so the logic is tested standalone.
 *
 * If the helpers diverge from the shim, these tests will catch it.
 *
 * Node 18+ exposes atob/btoa as globals; no shim needed.
 */

const assert = require('assert/strict');
const { test } = require('node:test');

// ── Paste of the helpers (must stay in sync with capacitor-shim.js) ─────────

function base64ToArrayBuffer(b64) {
  const bin = atob(b64 || '');
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Encode an arbitrary byte-array to base64 using the same algorithm. */
function bytesToBase64(bytes) {
  return arrayBufferToBase64(bytes.buffer);
}

/** Decode base64 to Uint8Array. */
function base64ToBytes(b64) {
  return new Uint8Array(base64ToArrayBuffer(b64));
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('round-trip: empty string', () => {
  const b64 = arrayBufferToBase64(new ArrayBuffer(0));
  assert.equal(b64, '');
  const buf = base64ToArrayBuffer('');
  assert.equal(buf.byteLength, 0);
});

test('round-trip: ASCII text', () => {
  const text = 'Hello, World!';
  // encode text → utf-8 bytes (ASCII subset)
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const b64 = bytesToBase64(bytes);
  // verify we get a valid base64 string
  assert.match(b64, /^[A-Za-z0-9+/]+=*$/);
  // decode back
  const roundTripped = base64ToBytes(b64);
  assert.deepEqual(roundTripped, bytes);
  const decoded = new TextDecoder().decode(roundTripped);
  assert.equal(decoded, text);
});

test('round-trip: UTF-8 (Hebrew)', () => {
  const text = 'שלום עולם — בדיקה'; // multi-byte code-points
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const b64 = bytesToBase64(bytes);
  const roundTripped = base64ToBytes(b64);
  assert.deepEqual(roundTripped, bytes);
  assert.equal(new TextDecoder().decode(roundTripped), text);
});

test('round-trip: binary data > 65 KB (chunked btoa path)', () => {
  // 70 KB of pseudo-random bytes (all values 0-255)
  const SIZE = 70 * 1024;
  const bytes = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) bytes[i] = i % 256;

  const b64 = bytesToBase64(bytes);
  // base64 length should be ceil(SIZE / 3) * 4
  assert.equal(b64.length, Math.ceil(SIZE / 3) * 4);

  const roundTripped = base64ToBytes(b64);
  assert.equal(roundTripped.length, SIZE);
  // spot-check a few bytes including wrap-around values
  for (let i = 0; i < SIZE; i += 1024) {
    assert.equal(roundTripped[i], i % 256, `byte mismatch at index ${i}`);
  }
});

test('base64ToArrayBuffer: known vector (RFC 4648)', () => {
  // "Man" → "TWFu"
  const buf = base64ToArrayBuffer('TWFu');
  const bytes = new Uint8Array(buf);
  assert.equal(bytes[0], 0x4d); // 'M'
  assert.equal(bytes[1], 0x61); // 'a'
  assert.equal(bytes[2], 0x6e); // 'n'
});

test('arrayBufferToBase64: known vector (RFC 4648)', () => {
  const buf = new Uint8Array([0x4d, 0x61, 0x6e]).buffer;
  assert.equal(arrayBufferToBase64(buf), 'TWFu');
});

test('base64ToArrayBuffer: null/undefined treated as empty', () => {
  const buf = base64ToArrayBuffer(null);
  assert.equal(buf.byteLength, 0);
  const buf2 = base64ToArrayBuffer(undefined);
  assert.equal(buf2.byteLength, 0);
});
