/**
 * Node bridge, browser side - real Node APIs for desktop-only plugins.
 *
 * Server mode only, and only when the server runs with
 * MARKPORT_NODE_BRIDGE=true (src/runtime-server/server/api/node-bridge.js).
 * Then `require('fs')`, `require('child_process')`, `require('os')`, ... in a
 * plugin act on the SERVER: files are the server's files, processes run on
 * the server, os.homedir() is the server user's home. A plugin such as
 * Claudian, which starts the `claude` CLI and passes it the vault folder as its
 * working directory, then works as it does in desktop Obsidian - with the
 * server playing the desktop.
 *
 * Pieces:
 *   - I/O modules (fs, child_process, os) forward to the server: synchronous
 *     calls by synchronous XHR, async calls by fetch, processes over one
 *     WebSocket with base64 stdio frames.
 *   - Pure-JS modules a Node plugin expects (events, stream, readline,
 *     string_decoder, buffer, util, crypto with a synchronous sha256) are
 *     implemented here, small and only as far as such plugins use them.
 *   - The vault adapter gets getBasePath()/basePath = the vault's real folder
 *     on the server, which is how desktop plugins find the vault on disk.
 *
 * Installed by filling window.__owModules (boot.js), which the bundle's
 * plugin require() reads. This file only DEFINES window.__owInstallNodeBridge;
 * boot.js calls it synchronously right after building the module map and
 * setting __owVaultType/__owVaultId - so it is in place before app.js (and
 * any plugin) runs, whatever order the browser loads scripts in.
 */
window.__owInstallNodeBridge = function () {
  'use strict';

  var modules = window.__owModules;
  if (!modules || window.__owBackend === 'none' || window.__owVaultType !== 'server' || !window.__owVaultId) return;

  var INFO;
  try {
    var x = new XMLHttpRequest();
    x.open('GET', '/api/node-bridge/info?vault=' + encodeURIComponent(window.__owVaultId), false);
    x.send();
    INFO = x.status === 200 ? JSON.parse(x.responseText) : null;
  } catch (e) { INFO = null; }
  if (!INFO || !INFO.enabled) return;
  if (INFO.platform === 'win32') {
    console.warn('[node-bridge] server runs on Windows - the bridge needs a POSIX server (Linux/macOS, e.g. the Docker image). Not installed.');
    return;
  }

  // ── Buffer ────────────────────────────────────────────────────────────────
  var te = new TextEncoder();
  function utf8Decode(u8) { return new TextDecoder('utf-8').decode(u8); }
  function b64encode(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64decode(str) {
    str = String(str).replace(/[-_]/g, function (c) { return c === '-' ? '+' : '/'; }).replace(/[^A-Za-z0-9+/]/g, '');
    while (str.length % 4) str += '=';
    var bin = atob(str), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function normEnc(enc) { return String(enc || 'utf8').toLowerCase().replace('-', ''); }

  class Buffer extends Uint8Array {
    static from(v, encOrOffset, length) {
      if (typeof v === 'string') return Buffer._fromString(v, encOrOffset);
      if (v instanceof ArrayBuffer) return new Buffer(v, encOrOffset || 0, length === undefined ? v.byteLength - (encOrOffset || 0) : length);
      if (ArrayBuffer.isView(v)) { var b = new Buffer(v.byteLength); b.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); return b; }
      if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
      if (Array.isArray(v) || (v && typeof v.length === 'number')) { var a = new Buffer(v.length); for (var i = 0; i < v.length; i++) a[i] = v[i] & 255; return a; }
      throw new TypeError('Buffer.from: unsupported argument');
    }
    static _fromString(s, enc) {
      var e = normEnc(enc), u;
      if (e === 'utf8') u = te.encode(s);
      else if (e === 'base64' || e === 'base64url') u = b64decode(s);
      else if (e === 'hex') { u = new Uint8Array(s.length >> 1); for (var i = 0; i < u.length; i++) u[i] = parseInt(s.substr(i * 2, 2), 16); }
      else if (e === 'latin1' || e === 'binary' || e === 'ascii') { u = new Uint8Array(s.length); for (var j = 0; j < s.length; j++) u[j] = s.charCodeAt(j) & 255; }
      else if (e === 'utf16le' || e === 'ucs2') { u = new Uint8Array(s.length * 2); for (var k = 0; k < s.length; k++) { var c = s.charCodeAt(k); u[k * 2] = c & 255; u[k * 2 + 1] = c >> 8; } }
      else u = te.encode(s);
      return Buffer.from(u);
    }
    static alloc(n, fill) { var b = new Buffer(n); if (fill !== undefined) b.fill(typeof fill === 'string' ? fill.charCodeAt(0) : fill); return b; }
    static allocUnsafe(n) { return new Buffer(n); }
    static allocUnsafeSlow(n) { return new Buffer(n); }
    static isBuffer(x) { return x instanceof Buffer; }
    static isEncoding(e) { return ['utf8', 'base64', 'base64url', 'hex', 'latin1', 'binary', 'ascii', 'utf16le', 'ucs2'].indexOf(normEnc(e)) >= 0; }
    static byteLength(s, enc) { return typeof s === 'string' ? Buffer._fromString(s, enc).length : s.byteLength; }
    static concat(list, total) {
      if (total === undefined) { total = 0; for (var i = 0; i < list.length; i++) total += list[i].length; }
      var out = new Buffer(total), off = 0;
      for (var j = 0; j < list.length && off < total; j++) { var p = list[j]; out.set(p.length + off > total ? p.subarray(0, total - off) : p, off); off += p.length; }
      return out;
    }
    static compare(a, b) { return Buffer.from(a).compare(b); }
    toString(enc, start, end) {
      var u = (start || end !== undefined) ? this.subarray(start || 0, end === undefined ? this.length : end) : this;
      var e = normEnc(enc);
      if (e === 'utf8') return utf8Decode(u);
      if (e === 'base64') return b64encode(u);
      if (e === 'base64url') return b64encode(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (e === 'hex') { var h = ''; for (var i = 0; i < u.length; i++) h += (u[i] < 16 ? '0' : '') + u[i].toString(16); return h; }
      if (e === 'latin1' || e === 'binary' || e === 'ascii') { var s = ''; for (var j = 0; j < u.length; j++) s += String.fromCharCode(u[j]); return s; }
      if (e === 'utf16le' || e === 'ucs2') return new TextDecoder('utf-16le').decode(u.subarray(0, u.length - (u.length % 2)));   // Node drops an odd trailing byte
      return utf8Decode(u);
    }
    toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
    equals(o) { return this.compare(o) === 0; }
    compare(o) {
      var n = Math.min(this.length, o.length);
      for (var i = 0; i < n; i++) if (this[i] !== o[i]) return this[i] < o[i] ? -1 : 1;
      return this.length === o.length ? 0 : this.length < o.length ? -1 : 1;
    }
    slice(s, e) { return this.subarray(s, e); }
    subarray(s, e) { var u = Uint8Array.prototype.subarray.call(this, s, e); return new Buffer(u.buffer, u.byteOffset, u.length); }
    copy(target, tStart, sStart, sEnd) { var part = this.subarray(sStart || 0, sEnd === undefined ? this.length : sEnd); target.set(part, tStart || 0); return part.length; }
    write(str, offset, len, enc) { if (typeof offset === 'string') { enc = offset; offset = 0; } var b = Buffer._fromString(str, enc).subarray(0, len === undefined ? undefined : len); this.set(b.subarray(0, this.length - (offset || 0)), offset || 0); return Math.min(b.length, this.length - (offset || 0)); }
    indexOf(v, from, enc) {
      if (typeof v === 'number') return Uint8Array.prototype.indexOf.call(this, v, from);
      var n = typeof v === 'string' ? Buffer._fromString(v, enc) : v;
      outer: for (var i = from || 0; i <= this.length - n.length; i++) { for (var j = 0; j < n.length; j++) if (this[i + j] !== n[j]) continue outer; return i; }
      return -1;
    }
    includes(v, from, enc) { return this.indexOf(v, from, enc) !== -1; }
    readUInt8(o) { return this[o || 0]; }
    readUInt16LE(o) { o = o || 0; return this[o] | (this[o + 1] << 8); }
    readUInt32LE(o) { o = o || 0; return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16)) + this[o + 3] * 0x1000000; }
    readUInt32BE(o) { o = o || 0; return this[o] * 0x1000000 + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]); }
    writeUInt8(v, o) { this[o || 0] = v; return (o || 0) + 1; }
    writeUInt32BE(v, o) { o = o || 0; this[o] = v >>> 24; this[o + 1] = v >>> 16; this[o + 2] = v >>> 8; this[o + 3] = v; return o + 4; }
  }
  Buffer.poolSize = 8192;

  // ── events ────────────────────────────────────────────────────────────────
  class EventEmitter {
    constructor() { this._ev = Object.create(null); this._max = 10; }
    _l(n) { if (!this._ev) this._ev = Object.create(null); return this._ev[n] || (this._ev[n] = []); }
    on(n, f) { this._l(n).push(f); if (n !== 'newListener') this.emit('newListener', n, f); return this; }
    addListener(n, f) { return this.on(n, f); }
    prependListener(n, f) { this._l(n).unshift(f); return this; }
    once(n, f) { var self = this; function w() { self.off(n, w); return f.apply(this, arguments); } w.listener = f; return this.on(n, w); }
    prependOnceListener(n, f) { var self = this; function w() { self.off(n, w); return f.apply(this, arguments); } w.listener = f; return this.prependListener(n, w); }
    off(n, f) { var l = this._l(n); for (var i = l.length - 1; i >= 0; i--) if (l[i] === f || l[i].listener === f) { l.splice(i, 1); break; } return this; }
    removeListener(n, f) { return this.off(n, f); }
    removeAllListeners(n) { if (n === undefined) this._ev = Object.create(null); else if (this._ev) delete this._ev[n]; return this; }
    emit(n) {
      var l = this._ev && this._ev[n];
      if (!l || !l.length) { if (n === 'error') { var err = arguments[1]; throw err instanceof Error ? err : new Error('Unhandled error: ' + err); } return false; }
      var args = Array.prototype.slice.call(arguments, 1);
      l.slice().forEach(function (f) { f.apply(this, args); }, this);
      return true;
    }
    listeners(n) { return this._l(n).map(function (f) { return f.listener || f; }); }
    rawListeners(n) { return this._l(n).slice(); }
    listenerCount(n) { return this._l(n).length; }
    eventNames() { return Object.keys(this._ev || {}); }
    setMaxListeners(n) { this._max = n; return this; }
    getMaxListeners() { return this._max; }
  }
  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.defaultMaxListeners = 10;
  EventEmitter.setMaxListeners = function () {};
  EventEmitter.once = function (em, n) { return new Promise(function (res, rej) { em.once(n, function () { res(Array.prototype.slice.call(arguments)); }); if (n !== 'error') em.once('error', rej); }); };
  EventEmitter.on = function (em, n) {
    var q = [], waiters = [];
    em.on(n, function () { var v = Array.prototype.slice.call(arguments); if (waiters.length) waiters.shift()({ value: v, done: false }); else q.push(v); });
    return { [Symbol.asyncIterator]() { return this; }, next() { return q.length ? Promise.resolve({ value: q.shift(), done: false }) : new Promise(function (r) { waiters.push(r); }); }, return() { return Promise.resolve({ done: true }); } };
  };

  // ── stream (enough for child stdio, readline, pipe) ───────────────────────
  class Readable extends EventEmitter {
    constructor(opts) {
      super(); this.readable = true; this.destroyed = false; this.readableEnded = false; this._enc = null;
      this._flowing = null; this._buf = []; this._ended = false;
      if (opts && typeof opts.read === 'function') this._read = opts.read;
    }
    on(n, f) { super.on(n, f); if (n === 'data' && this._flowing !== false) this.resume(); return this; }
    setEncoding(enc) { this._enc = enc; return this; }
    push(chunk) {
      if (chunk === null) { this._ended = true; this._drain(); return false; }
      this._buf.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      this._drain();
      return true;
    }
    _drain() {
      if (!this._flowing) return;
      while (this._buf.length && this._flowing) { var c = this._buf.shift(); this.emit('data', this._enc ? Buffer.from(c).toString(this._enc) : c); }
      if (this._ended && !this._buf.length && !this.readableEnded) {
        this.readableEnded = true; this.readable = false;
        var self = this; setTimeout(function () { self.emit('end'); self.emit('close'); }, 0);
      }
    }
    pause() { this._flowing = false; return this; }
    resume() { var self = this; this._flowing = true; setTimeout(function () { self._drain(); }, 0); return this; }
    isPaused() { return this._flowing === false; }
    read() { if (!this._buf.length) return null; var all = Buffer.concat(this._buf); this._buf = []; return this._enc ? all.toString(this._enc) : all; }
    pipe(dest) { this.on('data', function (d) { dest.write(d); }); this.on('end', function () { if (dest.end && dest !== window.process.stdout) dest.end(); }); return dest; }
    unpipe() { return this; }
    unref() { return this; }
    ref() { return this; }
    destroy(err) { if (this.destroyed) return this; this.destroyed = true; this.readable = false; var self = this; setTimeout(function () { if (err) self.emit('error', err); self.emit('close'); }, 0); return this; }
    [Symbol.asyncIterator]() {
      var self = this, q = [], waiters = [], done = false, error = null;
      self.on('data', function (d) { if (waiters.length) waiters.shift().res({ value: d, done: false }); else q.push(d); });
      function fin() { done = true; while (waiters.length) waiters.shift().res({ value: undefined, done: true }); }
      self.on('end', fin); self.on('close', fin);
      self.on('error', function (e) { error = e; while (waiters.length) waiters.shift().rej(e); });
      return {
        next: function () {
          if (q.length) return Promise.resolve({ value: q.shift(), done: false });
          if (error) return Promise.reject(error);
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise(function (res, rej) { waiters.push({ res: res, rej: rej }); });
        },
        return: function () { fin(); return Promise.resolve({ value: undefined, done: true }); },
        [Symbol.asyncIterator]() { return this; },
      };
    }
  }
  Readable.from = function (iterable) {
    var r = new Readable();
    (async function () { try { for await (var c of iterable) r.push(c); r.push(null); } catch (e) { r.destroy(e); } })();
    return r;
  };

  class Writable extends EventEmitter {
    constructor(opts) {
      super(); this.writable = true; this.destroyed = false; this.writableEnded = false; this.writableFinished = false;
      if (opts && typeof opts.write === 'function') this._write = opts.write;
      if (opts && typeof opts.final === 'function') this._final = opts.final;
    }
    _write(chunk, enc, cb) { cb(); }
    write(chunk, enc, cb) {
      if (typeof enc === 'function') { cb = enc; enc = undefined; }
      if (this.writableEnded) { var err = new Error('write after end'); err.code = 'ERR_STREAM_WRITE_AFTER_END'; if (cb) setTimeout(function () { cb(err); }, 0); return false; }
      var self = this;
      this._write(typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk, enc || 'buffer', function (e) { if (e) self.emit('error', e); if (cb) cb(e); });
      return true;
    }
    end(chunk, enc, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; }
      if (typeof enc === 'function') { cb = enc; enc = undefined; }
      if (chunk != null) this.write(chunk, enc);
      if (this.writableEnded) return this;
      this.writableEnded = true; this.writable = false;
      var self = this;
      var done = function () { self.writableFinished = true; self.emit('finish'); self.emit('close'); if (cb) cb(); };
      if (this._final) this._final(function () { setTimeout(done, 0); }); else setTimeout(done, 0);
      return this;
    }
    cork() {} uncork() {}
    setDefaultEncoding() { return this; }
    destroy(err) { if (this.destroyed) return this; this.destroyed = true; this.writable = false; var self = this; setTimeout(function () { if (err) self.emit('error', err); self.emit('close'); }, 0); return this; }
  }

  class PassThrough extends Readable {
    constructor() { super(); this.writable = true; }
    write(c, enc, cb) { if (typeof enc === 'function') cb = enc; this.push(typeof c === 'string' ? Buffer.from(c) : c); if (cb) cb(); return true; }
    end(c) { if (c != null && typeof c !== 'function') this.write(c); this.writable = false; this.push(null); this.emit('finish'); return this; }
  }
  class Transform extends PassThrough {
    constructor(opts) { super(); if (opts && opts.transform) this._transform = opts.transform; }
    write(c, enc, cb) { var self = this; if (typeof enc === 'function') { cb = enc; enc = undefined; } if (!this._transform) return super.write(c, enc, cb); this._transform(c, enc, function (e, out) { if (out != null) self.push(out); if (cb) cb(e); }); return true; }
  }
  function pipeline() {
    var streams = Array.prototype.slice.call(arguments), cb = typeof streams[streams.length - 1] === 'function' ? streams.pop() : null;
    for (var i = 0; i < streams.length - 1; i++) streams[i].pipe(streams[i + 1]);
    var last = streams[streams.length - 1];
    if (cb) { last.on('finish', function () { cb(); }); last.on('error', cb); }
    return last;
  }
  function finished(s, cb) { s.on('end', function () { cb(); }); s.on('finish', function () { cb(); }); s.on('error', cb); }
  var streamMod = { Readable: Readable, Writable: Writable, Duplex: PassThrough, PassThrough: PassThrough, Transform: Transform, Stream: Readable, pipeline: pipeline, finished: finished };
  streamMod.promises = {
    pipeline: function () { var a = Array.prototype.slice.call(arguments); return new Promise(function (r, j) { pipeline.apply(null, a.concat(function (e) { e ? j(e) : r(); })); }); },
    finished: function (s) { return new Promise(function (r, j) { finished(s, function (e) { e ? j(e) : r(); }); }); },
  };

  // ── string_decoder ────────────────────────────────────────────────────────
  function StringDecoder(enc) { this.enc = normEnc(enc); this.td = (this.enc === 'utf8') ? new TextDecoder('utf-8') : null; }
  StringDecoder.prototype.write = function (b) { if (typeof b === 'string') return b; return this.td ? this.td.decode(b, { stream: true }) : Buffer.from(b).toString(this.enc); };
  StringDecoder.prototype.end = function (b) { var s = b ? this.write(b) : ''; return this.td ? s + this.td.decode() : s; };

  // ── readline ──────────────────────────────────────────────────────────────
  function createInterface(opts) {
    var input = opts && opts.input ? opts.input : opts;
    var rl = new EventEmitter(), dec = new StringDecoder('utf8'), rest = '', closed = false;
    var q = [], waiters = [];
    function line(l) { rl.emit('line', l); if (waiters.length) waiters.shift()({ value: l, done: false }); else q.push(l); }
    function close() {
      if (closed) return; closed = true;
      if (rest) { line(rest); rest = ''; }
      rl.emit('close'); while (waiters.length) waiters.shift()({ value: undefined, done: true });
    }
    var onData = function (d) {
      rest += typeof d === 'string' ? d : dec.write(d);
      var parts = rest.split(/\r?\n/); rest = parts.pop();
      parts.forEach(line);
    };
    input.on('data', onData);
    input.on('end', close); input.on('close', close);
    rl.close = function () { input.off && input.off('data', onData); close(); };
    rl.pause = function () { return rl; }; rl.resume = function () { return rl; };
    rl.setPrompt = function () {}; rl.prompt = function () {}; rl.write = function () {};
    rl[Symbol.asyncIterator] = function () {
      return {
        next: function () {
          if (q.length) return Promise.resolve({ value: q.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise(function (r) { waiters.push(r); });
        },
        return: function () { rl.close(); return Promise.resolve({ value: undefined, done: true }); },
        [Symbol.asyncIterator]() { return this; },
      };
    };
    return rl;
  }
  var readlineMod = { createInterface: createInterface, Interface: EventEmitter, clearLine: function () {}, cursorTo: function () {}, emitKeypressEvents: function () {} };

  // ── value codec (mirrors api/node-bridge.js) ──────────────────────────────
  function Stats(o) { for (var k in o) if (k !== 't') this[k] = o[k]; this._t = o.t; ['atime', 'mtime', 'ctime', 'birthtime'].forEach(function (k) { if (typeof o[k + 'Ms'] === 'number') this[k] = new Date(o[k + 'Ms']); }, this); }
  Stats.prototype.isFile = function () { return this._t === 'f'; };
  Stats.prototype.isDirectory = function () { return this._t === 'd'; };
  Stats.prototype.isSymbolicLink = function () { return this._t === 'l'; };
  Stats.prototype.isFIFO = function () { return this._t === 'p'; };
  Stats.prototype.isSocket = function () { return this._t === 's'; };
  Stats.prototype.isCharacterDevice = function () { return this._t === 'c'; };
  Stats.prototype.isBlockDevice = function () { return this._t === 'b'; };
  function Dirent(o) { this.name = o.name; this.parentPath = o.parentPath; this.path = o.parentPath; this._t = o.t; }
  Dirent.prototype = Object.create(Stats.prototype);

  function encode(v) {
    if (v === undefined) return { $u: 1 };
    if (v === null || typeof v !== 'object') return typeof v === 'function' ? null : v;
    if (v instanceof Uint8Array || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { $b: b64encode(v instanceof Uint8Array ? v : new Uint8Array(v.buffer || v, v.byteOffset || 0, v.byteLength)) };
    if (v instanceof Date) return { $d: v.getTime() };
    if (typeof URL !== 'undefined' && v instanceof URL) return v.protocol === 'file:' ? decodeURIComponent(v.pathname) : v.href;
    if (Array.isArray(v)) return v.map(encode);
    var o = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k) && typeof v[k] !== 'function' && k !== 'signal') o[k] = encode(v[k]);
    return o;
  }
  function decode(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(decode);
    if (v.$u) return undefined;
    if (typeof v.$b === 'string') return Buffer.from(b64decode(v.$b));
    if (typeof v.$d === 'number') return new Date(v.$d);
    if (v.$stat) return new Stats(v.$stat);
    if (v.$dirent) return new Dirent(v.$dirent);
    if (v.$e) {
      var e = new Error(v.$e.message);
      for (var k in v.$e) if (v.$e[k] != null && k !== 'message') e[k] = (k === 'stdout' || k === 'stderr') ? decode(v.$e[k]) : v.$e[k];
      return e;
    }
    var o = {};
    for (var key in v) o[key] = decode(v[key]);
    return o;
  }

  function body(mod, fn, args) { return JSON.stringify({ mod: mod, fn: fn, args: encode(Array.prototype.slice.call(args)) }); }
  function result(status, text, mod, fn) {
    if (status !== 200) throw new Error('[node-bridge] ' + mod + '.' + fn + ' failed: HTTP ' + status + ' ' + text.slice(0, 200));
    var r = JSON.parse(text);
    if (r.err) throw decode(r.err);
    return decode(r.ok);
  }
  function callSync(mod, fn, args) {
    var x = new XMLHttpRequest();
    x.open('POST', '/api/node-bridge/call', false);
    x.setRequestHeader('Content-Type', 'application/json');
    x.setRequestHeader('X-Markport-Bridge', '1');
    x.send(body(mod, fn, args));
    return result(x.status, x.responseText, mod, fn);
  }
  function callAsync(mod, fn, args) {
    return fetch('/api/node-bridge/call', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Markport-Bridge': '1' }, body: body(mod, fn, args),
    }).then(function (r) { return r.text().then(function (t) { return result(r.status, t, mod, fn); }); });
  }

  // ── fs ────────────────────────────────────────────────────────────────────
  var FS_SYNC = ['accessSync', 'appendFileSync', 'chmodSync', 'chownSync', 'copyFileSync', 'cpSync', 'existsSync', 'lstatSync',
    'mkdirSync', 'mkdtempSync', 'readFileSync', 'readdirSync', 'readlinkSync', 'realpathSync', 'renameSync', 'rmSync', 'rmdirSync',
    'statSync', 'symlinkSync', 'truncateSync', 'unlinkSync', 'utimesSync', 'writeFileSync', 'openSync', 'closeSync', 'statfsSync'];
  var FS_ASYNC = ['access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lstat', 'mkdir', 'mkdtemp', 'readFile', 'readdir',
    'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile', 'statfs', 'opendir'];
  var fsMod = {}, fsPromises = {};
  FS_SYNC.forEach(function (fn) { fsMod[fn] = function () { return callSync('fs', fn, arguments); }; });
  FS_ASYNC.forEach(function (fn) {
    fsPromises[fn] = function () { return callAsync('fs.promises', fn, arguments); };
    fsMod[fn] = function () {
      var args = Array.prototype.slice.call(arguments), cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      var p = fsPromises[fn].apply(null, args);
      if (cb) p.then(function (v) { cb(null, v); }, function (e) { cb(e); });
      return undefined;
    };
  });
  // existsSync must never throw; exists(path, cb) has no error argument.
  var rawExists = fsMod.existsSync;
  fsMod.existsSync = function (p) { try { return !!rawExists(p); } catch (e) { return false; } };
  fsMod.exists = function (p, cb) { fsPromises.access(p).then(function () { cb(true); }, function () { cb(false); }); };
  fsMod.realpathSync.native = fsMod.realpathSync;
  fsMod.realpath.native = fsMod.realpath;
  fsMod.constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, COPYFILE_EXCL: 1, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960 };
  Object.assign(fsMod, { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, Stats: Stats, Dirent: Dirent });
  fsPromises.constants = fsMod.constants;
  fsMod.promises = fsPromises;
  // Not bridged (they'd need a long-lived handle on the server); good enough
  // for plugins that only use them for logs or optional live reload.
  fsMod.watch = function () { var w = new EventEmitter(); w.close = function () {}; w.unref = w.ref = function () { return w; }; return w; };
  fsMod.watchFile = function () {}; fsMod.unwatchFile = function () {};
  fsPromises.watch = function () { return { [Symbol.asyncIterator]() { return { next: function () { return new Promise(function () {}); } }; } }; };
  fsMod.createReadStream = function (p, opts) {
    var r = new Readable();
    fsPromises.readFile(p).then(function (b) {
      if (opts && (opts.start != null || opts.end != null)) b = b.subarray(opts.start || 0, opts.end == null ? undefined : opts.end + 1);
      if (opts && opts.encoding) r.setEncoding(opts.encoding);
      r.push(b); r.push(null);
    }, function (e) { r.destroy(e); });
    r.path = p; r.close = function (cb) { r.destroy(); if (cb) cb(); };
    return r;
  };
  fsMod.createWriteStream = function (p, opts) {
    var flags = (opts && opts.flags) || 'w', chain = flags.indexOf('a') === 0 ? Promise.resolve() : fsPromises.writeFile(p, '');
    var w = new Writable({
      write: function (chunk, enc, cb) { chain = chain.then(function () { return fsPromises.appendFile(p, chunk); }); chain.then(function () { cb(); }, cb); },
      final: function (cb) { chain.then(function () { cb(); }, cb); },
    });
    w.path = p; w.close = function (cb) { w.end(cb); };
    return w;
  };

  // ── os / process ──────────────────────────────────────────────────────────
  var O = INFO.os;
  var osMod = {
    homedir: function () { return O.homedir; }, tmpdir: function () { return O.tmpdir; }, hostname: function () { return O.hostname; },
    type: function () { return O.type; }, release: function () { return O.release; }, platform: function () { return O.platform; },
    arch: function () { return O.arch; }, EOL: O.EOL, devNull: '/dev/null',
    userInfo: function () { return O.userInfo || { username: INFO.env.USER || 'node', homedir: O.homedir, shell: INFO.env.SHELL || '/bin/sh', uid: 1000, gid: 1000 }; },
    cpus: function () { var a = []; for (var i = 0; i < O.cpus; i++) a.push({ model: 'server', speed: 0, times: {} }); return a; },
    totalmem: function () { return O.totalmem; }, freemem: function () { return 0; }, uptime: function () { return 0; },
    loadavg: function () { return [0, 0, 0]; }, networkInterfaces: function () { return {}; }, endianness: function () { return 'LE'; },
    availableParallelism: function () { return O.cpus; },
    constants: { signals: { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 }, errno: {} },
  };

  var proc = window.process || {};
  var procEmitter = new EventEmitter();
  ['on', 'once', 'off', 'emit', 'addListener', 'removeListener', 'removeAllListeners', 'listeners', 'listenerCount', 'prependListener'].forEach(function (k) {
    if (typeof proc[k] !== 'function') proc[k] = procEmitter[k].bind(procEmitter);
  });
  proc.platform = INFO.platform;
  proc.arch = INFO.arch;
  proc.env = Object.assign({}, INFO.env, proc.env && typeof proc.env === 'object' ? proc.env : {});
  proc.execPath = INFO.execPath;
  proc.pid = INFO.pid;
  proc.versions = Object.assign({}, INFO.versions, proc.versions || {}, { node: INFO.versions.node });
  proc.version = 'v' + INFO.versions.node;
  proc.cwd = function () { return INFO.vaultPath || O.homedir; };
  proc.hrtime = proc.hrtime || function (prev) { var t = performance.now(), s = Math.floor(t / 1000), ns = Math.floor((t % 1000) * 1e6); if (prev) { s -= prev[0]; ns -= prev[1]; if (ns < 0) { s--; ns += 1e9; } } return [s, ns]; };
  proc.hrtime.bigint = proc.hrtime.bigint || function () { return BigInt(Math.floor(performance.now() * 1e6)); };
  proc.memoryUsage = proc.memoryUsage || function () { return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }; };
  proc.uptime = proc.uptime || function () { return performance.now() / 1000; };
  proc.emitWarning = proc.emitWarning || function (w) { console.warn('[process warning]', w); };
  proc.stdout = proc.stdout || { write: function (s) { console.log(String(s)); return true; }, isTTY: false, on: function () {}, columns: 80 };
  proc.stderr = proc.stderr || { write: function (s) { console.warn(String(s)); return true; }, isTTY: false, on: function () {} };
  proc.argv = proc.argv || ['node'];
  proc.exitCode = undefined;
  proc.kill = proc.kill || function () { return true; };
  window.process = proc;

  // ── child_process ─────────────────────────────────────────────────────────
  var ws = null, wsQueue = [], wsReady = false, nextId = 1, children = new Map();
  function wsSend(m) { if (wsReady) ws.send(JSON.stringify(m)); else { wsQueue.push(m); openWs(); } }
  function openWs() {
    if (ws) return;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/node-bridge/proc');
    ws.onopen = function () { wsReady = true; var q = wsQueue; wsQueue = []; q.forEach(wsSend); };
    ws.onmessage = function (ev) {
      var m = JSON.parse(ev.data), c = children.get(m.id);
      if (!c) return;
      if (m.op === 'spawn') { c.pid = m.pid; c.emit('spawn'); }
      else if (m.op === 'stdout') { if (c.stdout) c.stdout.push(Buffer.from(b64decode(m.data))); }
      else if (m.op === 'stderr') { if (c.stderr) c.stderr.push(Buffer.from(b64decode(m.data))); }
      else if (m.op === 'error') { c._exited = true; children.delete(m.id); c.emit('error', decode(m.err)); }
      else if (m.op === 'exit') {
        children.delete(m.id);
        c.exitCode = m.code; c.signalCode = m.signal;
        if (c.stdout) c.stdout.push(null);
        if (c.stderr) c.stderr.push(null);
        c.emit('exit', m.code, m.signal);
        setTimeout(function () { c.emit('close', m.code, m.signal); }, 0);
      }
    };
    ws.onclose = function () {
      ws = null; wsReady = false;
      children.forEach(function (c, id) { children.delete(id); c.exitCode = null; c.signalCode = 'SIGKILL'; if (c.stdout) c.stdout.push(null); if (c.stderr) c.stderr.push(null); c.emit('exit', null, 'SIGKILL'); c.emit('close', null, 'SIGKILL'); });
    };
  }

  function stdioSlot(stdio, i) {
    if (stdio === 'ignore' || stdio === 'inherit') return 'ignore';
    if (Array.isArray(stdio)) return stdio[i] === 'pipe' || stdio[i] === undefined || stdio[i] === null || stdio[i] === 'overlapped' ? 'pipe' : 'ignore';
    return 'pipe';
  }

  function spawn(cmd, args, opts) {
    if (!Array.isArray(args)) { opts = args; args = []; }
    opts = opts || {};
    var id = nextId++, c = new EventEmitter();
    c.pid = undefined; c.exitCode = null; c.signalCode = null; c.killed = false; c.spawnfile = cmd; c.spawnargs = [cmd].concat(args);
    var stdio = opts.stdio;
    c.stdin = stdioSlot(stdio, 0) === 'pipe' ? new Writable({
      write: function (chunk, enc, cb) { wsSend({ op: 'stdin', id: id, data: b64encode(chunk) }); cb(); },
      final: function (cb) { wsSend({ op: 'end', id: id }); cb(); },
    }) : null;
    c.stdout = stdioSlot(stdio, 1) === 'pipe' ? new Readable() : null;
    c.stderr = stdioSlot(stdio, 2) === 'pipe' ? new Readable() : null;
    c.stdio = [c.stdin, c.stdout, c.stderr];
    c.kill = function (sig) { if (c.exitCode !== null || c.signalCode !== null) return false; c.killed = true; wsSend({ op: 'kill', id: id, signal: typeof sig === 'string' ? sig : 'SIGTERM' }); return true; };
    c.ref = c.unref = function () { return c; };
    c.disconnect = function () {};
    children.set(id, c);
    var env = opts.env ? encode(opts.env) : undefined;
    wsSend({ op: 'spawn', id: id, cmd: cmd, args: args.map(String), opts: { cwd: opts.cwd, env: env, shell: opts.shell } });
    if (opts.signal) {
      var abort = function () { c.kill('SIGTERM'); };
      if (opts.signal.aborted) abort(); else opts.signal.addEventListener('abort', abort, { once: true });
    }
    if (opts.timeout > 0) setTimeout(function () { c.kill(opts.killSignal || 'SIGTERM'); }, opts.timeout);
    return c;
  }

  function collect(c, encoding, cb) {
    var out = [], err = [];
    if (c.stdout) c.stdout.on('data', function (d) { out.push(d); });
    if (c.stderr) c.stderr.on('data', function (d) { err.push(d); });
    var done = false;
    function finish(e, code, signal) {
      if (done) return; done = true;
      var so = Buffer.concat(out), se = Buffer.concat(err);
      var enc = encoding === null || encoding === 'buffer' ? null : (encoding || 'utf8');
      var o = enc ? so.toString(enc) : so, s = enc ? se.toString(enc) : se;
      if (!e && code !== 0) { e = new Error('Command failed: ' + c.spawnargs.join(' ') + '\n' + se.toString()); e.code = code; e.signal = signal; e.killed = c.killed; }
      if (e) { e.stdout = o; e.stderr = s; }
      if (cb) cb(e || null, o, s);
    }
    c.on('error', function (e) { finish(e); });
    c.on('close', function (code, signal) { finish(null, code, signal); });
  }

  function execFile(file, args, opts, cb) {
    if (typeof args === 'function') { cb = args; args = []; opts = {}; }
    else if (!Array.isArray(args)) { cb = opts; opts = args; args = []; }
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};
    var c = spawn(file, args, Object.assign({}, opts, { stdio: ['pipe', 'pipe', 'pipe'] }));
    if (c.stdin) c.stdin.end();
    collect(c, opts.encoding, cb);
    return c;
  }
  function exec(command, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};
    return execFile(typeof opts.shell === 'string' ? opts.shell : '/bin/sh', ['-c', command], Object.assign({}, opts, { shell: false }), cb);
  }
  // util.promisify(exec/execFile) resolves to { stdout, stderr }, as in Node.
  var PROMISIFY = Symbol.for('nodejs.util.promisify.custom');
  execFile[PROMISIFY] = function (f, a, o) { return new Promise(function (res, rej) { execFile(f, a, o, function (e, so, se) { e ? rej(e) : res({ stdout: so, stderr: se }); }); }); };
  exec[PROMISIFY] = function (cmd, o) { return new Promise(function (res, rej) { exec(cmd, o, function (e, so, se) { e ? rej(e) : res({ stdout: so, stderr: se }); }); }); };

  function syncOpts(o) { o = Object.assign({}, o || {}); delete o.signal; return o; }
  var cpMod = {
    spawn: spawn, exec: exec, execFile: execFile,
    fork: function (mod, args, opts) { return spawn(INFO.execPath, [mod].concat(Array.isArray(args) ? args : []), Array.isArray(args) ? opts : args); },
    execSync: function (cmd, o) { return callSync('child_process', 'execSync', [cmd, syncOpts(o)]); },
    execFileSync: function (f, a, o) { if (!Array.isArray(a)) { o = a; a = []; } return callSync('child_process', 'execFileSync', [f, a, syncOpts(o)]); },
    spawnSync: function (f, a, o) { if (!Array.isArray(a)) { o = a; a = []; } return callSync('child_process', 'spawnSync', [f, a, syncOpts(o)]); },
    ChildProcess: EventEmitter,
  };

  // ── util ──────────────────────────────────────────────────────────────────
  var baseUtil = modules.util || {};
  function format(f) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (typeof f !== 'string') return [f].concat(args).map(inspect).join(' ');
    var s = f.replace(/%[sdifjoO%]/g, function (m) {
      if (m === '%%') return '%';
      if (!args.length) return m;
      var a = args.shift();
      return m === '%d' || m === '%i' ? String(parseInt(a, 10)) : m === '%f' ? String(parseFloat(a)) : m === '%j' || m === '%o' || m === '%O' ? inspect(a) : String(a);
    });
    return args.length ? s + ' ' + args.map(inspect).join(' ') : s;
  }
  function inspect(o) { if (typeof o === 'string') return o; try { return JSON.stringify(o); } catch (e) { return String(o); } }
  function promisify(fn) {
    if (fn && fn[PROMISIFY]) return fn[PROMISIFY];
    return function () { var self = this, args = Array.prototype.slice.call(arguments); return new Promise(function (res, rej) { args.push(function (e, v) { e ? rej(e) : res(v); }); fn.apply(self, args); }); };
  }
  promisify.custom = PROMISIFY;
  var utilMod = Object.assign({}, baseUtil, {
    promisify: promisify, format: format, inspect: inspect,
    deprecate: function (fn) { return fn; }, debuglog: function () { return function () {}; },
    inherits: baseUtil.inherits || function (c, s) { c.super_ = s; Object.setPrototypeOf(c.prototype, s.prototype); },
    isDeepStrictEqual: function (a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return a === b; } },
    types: { isPromise: function (p) { return p instanceof Promise; }, isDate: function (d) { return d instanceof Date; }, isRegExp: function (r) { return r instanceof RegExp; }, isUint8Array: function (u) { return u instanceof Uint8Array; }, isNativeError: function (e) { return e instanceof Error; } },
    TextEncoder: TextEncoder, TextDecoder: TextDecoder,
    stripVTControlCharacters: function (s) { return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); },
  });

  // ── crypto: synchronous hashes (WebCrypto is async-only) ──────────────────
  function sha256(bytes) {
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n);
    m.set(bytes); m[l] = 0x80;
    var bits = l * 8; for (var i = 0; i < 8; i++) m[n - 1 - i] = (i < 4) ? (bits >>> (i * 8)) & 255 : Math.floor(bits / 0x100000000) >>> ((i - 4) * 8) & 255;
    var w = new Uint32Array(64);
    for (var off = 0; off < n; off += 64) {
      for (var t = 0; t < 16; t++) w[t] = (m[off + t * 4] << 24) | (m[off + t * 4 + 1] << 16) | (m[off + t * 4 + 2] << 8) | m[off + t * 4 + 3];
      for (t = 16; t < 64; t++) {
        var a0 = w[t - 15], a1 = w[t - 2];
        var s0 = ((a0 >>> 7) | (a0 << 25)) ^ ((a0 >>> 18) | (a0 << 14)) ^ (a0 >>> 3);
        var s1 = ((a1 >>> 17) | (a1 << 15)) ^ ((a1 >>> 19) | (a1 << 13)) ^ (a1 >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = new Buffer(32);
    for (i = 0; i < 8; i++) { out[i * 4] = H[i] >>> 24; out[i * 4 + 1] = H[i] >>> 16; out[i * 4 + 2] = H[i] >>> 8; out[i * 4 + 3] = H[i]; }
    return out;
  }
  function toBytes(d, enc) { return typeof d === 'string' ? Buffer._fromString(d, enc) : Buffer.from(d); }
  function hasher(algo, key) {
    var a = String(algo || '').toLowerCase().replace('-', '');
    if (a !== 'sha256') console.warn('[node-bridge] crypto: ' + algo + ' is computed as sha256 (only sha256 is implemented synchronously)');
    var chunks = [];
    var h = {
      update: function (d, enc) { chunks.push(toBytes(d, enc)); return h; },
      digest: function (enc, cb) {
        if (typeof enc === 'function') { cb = enc; enc = 'hex'; }
        var msg = Buffer.concat(chunks), out;
        if (key) {
          var k = key.length > 64 ? sha256(key) : key, ip = new Buffer(64), op = new Buffer(64);
          for (var i = 0; i < 64; i++) { ip[i] = (k[i] || 0) ^ 0x36; op[i] = (k[i] || 0) ^ 0x5c; }
          out = sha256(Buffer.concat([op, sha256(Buffer.concat([ip, msg]))]));
        } else out = sha256(msg);
        var res = enc ? out.toString(enc) : out;
        if (typeof cb === 'function') cb(null, res);
        return res;
      },
      copy: function () { var c = hasher(algo, key); chunks.forEach(function (x) { c.update(x); }); return c; },
    };
    return h;
  }
  var baseCrypto = modules.crypto || {};
  var cryptoMod = Object.assign({}, baseCrypto, {
    createHash: function (algo) { return hasher(algo); },
    createHmac: function (algo, key) { return hasher(algo, toBytes(key)); },
    randomBytes: function (n, cb) { var b = new Buffer(n); crypto.getRandomValues(b); if (cb) { setTimeout(function () { cb(null, b); }, 0); return undefined; } return b; },
    randomUUID: function () { return crypto.randomUUID(); },
    randomInt: function (min, max) { if (max === undefined) { max = min; min = 0; } return min + Math.floor(Math.random() * (max - min)); },
    getRandomValues: function (a) { return crypto.getRandomValues(a); },
    timingSafeEqual: function (a, b) { return Buffer.from(a).equals(b); },
    webcrypto: crypto, subtle: crypto.subtle,
  });

  // ── small extras ──────────────────────────────────────────────────────────
  class AsyncLocalStorage {
    constructor() { this._store = undefined; }
    run(store, fn) { var prev = this._store; this._store = store; try { return fn.apply(null, Array.prototype.slice.call(arguments, 2)); } finally { this._store = prev; } }
    getStore() { return this._store; }
    enterWith(store) { this._store = store; }
    exit(fn) { return this.run(undefined, fn); }
    disable() { this._store = undefined; }
  }
  var urlMod = Object.assign({}, modules.url || {}, {
    URL: URL, URLSearchParams: URLSearchParams,
    fileURLToPath: function (u) { return decodeURIComponent((typeof u === 'string' ? new URL(u) : u).pathname); },
    pathToFileURL: function (p) { return new URL('file://' + encodeURI(p)); },
  });
  var pathMod = Object.assign({}, modules.path);
  pathMod.format = pathMod.format || function (o) { var dir = o.dir || o.root || ''; var base = o.base || ((o.name || '') + (o.ext || '')); return dir ? (dir === o.root ? dir + base : dir + '/' + base) : base; };
  pathMod.toNamespacedPath = function (p) { return p; };
  pathMod.posix = pathMod; pathMod.win32 = pathMod;
  function unavailable(name) {
    return new Proxy({}, { get: function (t, k) { if (k === '__esModule' || typeof k === 'symbol') return undefined; return function () { throw new Error('[node-bridge] ' + name + '.' + String(k) + ' is not available in Markport'); }; } });
  }
  function notFound(n) { var e = new Error("Cannot find module '" + n + "'"); e.code = 'MODULE_NOT_FOUND'; return e; }
  var moduleMod = {
    createRequire: function () {
      var r = function (n) { if (Object.prototype.hasOwnProperty.call(modules, n) && modules[n] !== undefined) return modules[n]; throw notFound(n); };
      r.resolve = function (n) { if (Object.prototype.hasOwnProperty.call(modules, n)) return n; throw notFound(n); };
      return r;
    },
    builtinModules: Object.keys(modules),
  };
  // SharedArrayBuffer only exists on cross-origin-isolated pages (COOP/COEP
  // headers, which would block web images/iframes embedded in notes). Bundled
  // Node code (the Claude Agent SDK) uses it for one thing: a synchronous
  // sleep, Atomics.wait() on a 4-byte buffer, in file-retry loops. Stand-in:
  // a plain ArrayBuffer, and Atomics.wait on one busy-waits its timeout
  // (capped at 1s; the main thread can't block for real anyway).
  if (typeof window.SharedArrayBuffer === 'undefined') {
    window.SharedArrayBuffer = ArrayBuffer;
    var realWait = Atomics.wait;
    Atomics.wait = function (arr, idx, val, timeout) {
      if (arr && arr.buffer instanceof ArrayBuffer && !(typeof realWait === 'function' && arr.buffer.constructor.name === 'SharedArrayBuffer')) {
        if (arr[idx] !== val) return 'not-equal';
        var until = performance.now() + Math.min(isFinite(timeout) ? timeout : 1000, 1000);
        while (performance.now() < until) { /* sleep */ }
        return 'timed-out';
      }
      return realWait.apply(Atomics, arguments);
    };
  }
  // Electron's renderer has these as globals; bundled Node libraries (the
  // Claude Agent SDK: createRequire(__filename)) read them at load.
  if (typeof window.__filename !== 'string') window.__filename = INFO.cwd + '/index.html';
  if (typeof window.__dirname !== 'string') window.__dirname = INFO.cwd;

  // ── install ───────────────────────────────────────────────────────────────
  window.Buffer = Buffer;
  var install = {
    fs: fsMod, 'fs/promises': fsPromises, child_process: cpMod, os: osMod, events: EventEmitter, stream: streamMod,
    'stream/promises': streamMod.promises, readline: readlineMod, string_decoder: { StringDecoder: StringDecoder },
    buffer: { Buffer: Buffer, constants: { MAX_LENGTH: 0x7fffffff } }, util: utilMod, crypto: cryptoMod, process: proc,
    path: pathMod, url: urlMod, async_hooks: { AsyncLocalStorage: AsyncLocalStorage, AsyncResource: class { runInAsyncScope(fn, self) { return fn.apply(self, Array.prototype.slice.call(arguments, 2)); } } },
    module: moduleMod, timers: { setTimeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window), setInterval: setInterval.bind(window), clearInterval: clearInterval.bind(window), setImmediate: function (f) { return setTimeout(f, 0); } },
    'timers/promises': { setTimeout: function (ms, v) { return new Promise(function (r) { setTimeout(function () { r(v); }, ms); }); } },
    zlib: unavailable('zlib'), http: unavailable('http'), https: unavailable('https'), net: unavailable('net'), tls: unavailable('tls'),
  };
  Object.keys(install).forEach(function (k) { modules[k] = install[k]; modules['node:' + k] = install[k]; });
  // 'original-fs' stays unregistered on purpose: the bundle uses it to pick
  // its desktop file adapter, and the vault must stay on Markport's own.

  // Desktop plugins find the vault on disk through the adapter.
  (function patchAdapter() {
    var a = window.app && window.app.vault && window.app.vault.adapter;
    if (!a) { setTimeout(patchAdapter, 20); return; }
    if (!INFO.vaultPath) return;
    if (typeof a.getBasePath !== 'function') a.getBasePath = function () { return INFO.vaultPath; };
    // basePath has two meanings. The mobile adapter's own code builds every
    // path from it (basePath + '/' + file) and must keep seeing its storage
    // key; desktop plugins read it as the vault's absolute folder, as on
    // desktop (Claudian: adapter.basePath -> the agent's working directory).
    // Obsidian evaluates each plugin with the source URL "plugin:<id>", so the
    // getter answers by its IMMEDIATE caller: plugin code gets the real
    // folder, everything else - including the adapter's own methods when a
    // plugin calls adapter.read() - gets the original value.
    var internal = a.basePath;
    Object.defineProperty(a, 'basePath', {
      configurable: true, enumerable: true,
      get: function () {
        var caller = (new Error().stack || '').split('\n')[2] || '';
        return caller.indexOf('plugin:') !== -1 ? INFO.vaultPath : internal;
      },
      set: function (v) { internal = v; },
    });
  })();

  window.__owNodeBridge = { info: INFO, callSync: callSync, callAsync: callAsync };
  console.log('[node-bridge] installed - plugins run Node APIs on the server (' + INFO.platform + ', vault at ' + INFO.vaultPath + ')');
};
