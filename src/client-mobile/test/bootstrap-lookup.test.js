'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { lookupContent, lookupStat, lookupDir, lookupMissing } = require('../bootstrap-lookup');
const { invalidateCacheEntry } = require('../cache-invalidation');

function configCache() {
  return {
    fs: {
      '.obsidian/app.json': { content: '{}', size: 2, mtime: 1, isFile: true },
      '.obsidian/community-plugins.json': { content: '[]', size: 2, mtime: 1, isFile: true },
    },
    dirs: {
      '': [{ name: '.obsidian', isDirectory: true }, { name: 'Welcome.md', isFile: true }],
      '.obsidian': [{ name: 'app.json', isFile: true }, { name: 'logo.png', isFile: true }],
    },
  };
}

test('lookupMissing: a name the cached parent listing lacks is missing', () => {
  assert.equal(lookupMissing(configCache(), '.obsidian/hotkeys.json'), true);
  assert.equal(lookupMissing(configCache(), 'Nope.md'), true);
});

test('lookupMissing: listed files, binary files and synthesized entries are not missing', () => {
  const cache = configCache();
  assert.equal(lookupMissing(cache, '.obsidian/app.json'), false);
  assert.equal(lookupMissing(cache, '.obsidian/logo.png'), false, 'listed but no fs entry (binary)');
  assert.equal(lookupMissing(cache, '.obsidian/community-plugins.json'), false, 'fs entry, not listed');
  assert.equal(lookupMissing(cache, 'welcome.md'), false, 'case-insensitive match');
});

test('lookupMissing: no answer without the parent listing', () => {
  assert.equal(lookupMissing(configCache(), 'folder/x.md'), false);
  assert.equal(lookupMissing(configCache(), ''), false);
  assert.equal(lookupMissing(null, '.obsidian/hotkeys.json'), false);
  assert.equal(lookupMissing({}, '.obsidian/hotkeys.json'), false);
});

test('lookupMissing: a write since the response was built is never reported missing', () => {
  const cache = configCache();
  invalidateCacheEntry(cache, '.obsidian/hotkeys.json');   // what writeFile does
  assert.equal(lookupMissing(cache, '.obsidian/hotkeys.json'), false);
});

test('lookupContent returns the cached text for a hit', () => {
  const cache = {
    fs: {
      'Welcome.md': { content: '# hello\n', size: 8, mtime: 1, isFile: true },
    },
  };
  const result = lookupContent(cache, 'Welcome.md', 'utf8');
  assert.equal(result, '# hello\n');
});

test('lookupContent returns null for stat-only entry (oversized/capped file)', () => {
  const cache = {
    fs: {
      'big.md': { size: 1_000_000, mtime: 1, isFile: true /* no content */ },
    },
  };
  assert.equal(lookupContent(cache, 'big.md', 'utf8'), null);
});

test('lookupContent returns null for binary read (no encoding)', () => {
  // Cache stores utf8 strings; binary reads expect base64 of an ArrayBuffer.
  // Returning the cached text would be the wrong format — must miss instead.
  const cache = { fs: { 'img.png': { content: 'irrelevant', size: 1, mtime: 1, isFile: true } } };
  assert.equal(lookupContent(cache, 'img.png', undefined), null);
});

test('lookupContent returns null when cache is null/undefined/empty', () => {
  // Before boot.js's fetch resolves, the cache is null. The shim must not
  // throw and must report MISS so the read falls through to HTTP.
  assert.equal(lookupContent(null,      'x.md', 'utf8'), null);
  assert.equal(lookupContent(undefined, 'x.md', 'utf8'), null);
  assert.equal(lookupContent({},        'x.md', 'utf8'), null);
});

test('lookupStat returns a Capacitor-shaped stat for a file entry', () => {
  const cache = {
    fs: { 'a.md': { content: 'a', size: 42, mtime: 1700, isFile: true } },
  };
  const stat = lookupStat(cache, 'a.md');
  assert.deepEqual(stat, { type: 'file', size: 42, mtime: 1700, ctime: 1700, uri: '' });
});

test('lookupStat marks directory entries with type=directory', () => {
  const cache = {
    fs: { 'Notes': { mtime: 99, size: 0, isFile: false, isDirectory: true } },
  };
  const stat = lookupStat(cache, 'Notes');
  assert.equal(stat.type, 'directory');
});

test('lookupStat returns null when entry is missing or cache empty', () => {
  assert.equal(lookupStat({ fs: {} }, 'x'), null);
  assert.equal(lookupStat(null,        'x'), null);
});

test('lookupDir returns a Capacitor-shaped entry array on hit', () => {
  const cache = {
    dirs: {
      'Notes': [
        { name: 'a.md', size: 1, mtime: 100, isFile: true,  isDirectory: false },
        { name: 'sub',  size: 0, mtime: 200, isFile: false, isDirectory: true  },
      ],
    },
  };
  const entries = lookupDir(cache, 'Notes');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0],
    { name: 'a.md', type: 'file',      size: 1, mtime: 100, uri: '', ctime: 100 });
  assert.deepEqual(entries[1],
    { name: 'sub',  type: 'directory', size: 0, mtime: 200, uri: '', ctime: 200 });
});

test('lookupDir returns null on missing dir or empty cache', () => {
  assert.equal(lookupDir({ dirs: {} }, 'nope'), null);
  assert.equal(lookupDir(null,         'nope'), null);
  assert.equal(lookupDir({},           'nope'), null);
});
