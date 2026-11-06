'use strict';

/**
 * A small worker_threads pool for the media service's CPU-heavy JavaScript
 * (PSD and RAW decoding, model optimization), so it never blocks the event
 * loop that serves everyone else. Workers start on demand and exit after a
 * minute idle, which gives their memory (a decoded PSD can be gigabytes)
 * back to the system.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const IDLE_MS = 60e3;

function createPool(size, script) {
  const file = script || path.join(__dirname, 'worker.js');
  const idle = [];
  const busy = new Set();
  const queue = [];
  let nextId = 1;

  function spawn() {
    const w = new Worker(file);
    w.pending = new Map();
    w.on('message', (msg) => {
      const job = w.pending.get(msg.id);
      if (!job) return;
      w.pending.delete(msg.id);
      if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg.result);
      release(w);
    });
    const fail = (err) => {
      for (const job of w.pending.values()) job.reject(err instanceof Error ? err : new Error('Worker exited (' + err + ')'));
      w.pending.clear();
      busy.delete(w);
      const i = idle.indexOf(w);
      if (i >= 0) idle.splice(i, 1);
      pump();
    };
    w.on('error', fail);
    w.on('exit', (code) => { if (code !== 0 || w.pending.size) fail(code); });
    return w;
  }

  function release(w) {
    busy.delete(w);
    clearTimeout(w.idleTimer);
    w.idleTimer = setTimeout(() => {
      const i = idle.indexOf(w);
      if (i >= 0) { idle.splice(i, 1); w.terminate(); }
    }, IDLE_MS);
    w.idleTimer.unref();
    idle.push(w);
    pump();
  }

  function pump() {
    while (queue.length) {
      let w = idle.pop();
      if (!w) {
        if (busy.size >= size) return;
        w = spawn();
      }
      clearTimeout(w.idleTimer);
      busy.add(w);
      const job = queue.shift();
      w.pending.set(job.id, job);
      w.postMessage({ id: job.id, type: job.type, args: job.args });
    }
  }

  function run(type, args) {
    return new Promise((resolve, reject) => {
      queue.push({ id: nextId++, type, args, resolve, reject });
      pump();
    });
  }

  async function close() {
    for (const w of idle.concat([...busy])) await w.terminate();
    idle.length = 0;
    busy.clear();
  }

  return { run, close };
}

// Run at most `n` async jobs at once; the same key while one is running joins it.
function createLimiter(n) {
  let active = 0;
  const waiting = [];
  const running = new Map();
  const next = () => {
    if (active >= n || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return function once(key, fn) {
    if (running.has(key)) return running.get(key);
    const p = new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); })
      .finally(() => running.delete(key));
    running.set(key, p);
    return p;
  };
}

module.exports = { createPool, createLimiter };
