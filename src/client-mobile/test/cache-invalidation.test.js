'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { invalidateCacheEntry, invalidateCacheSubtree } = require('../cache-invalidation');

test('invalidateCacheEntry drops the file entry and its parent dir listing', () => {
  const cache = {
    fs: {
      'Notes/foo.md': { content: 'a', size: 1, mtime: 1, isFile: true },
      'Notes/bar.md': { content: 'b', size: 1, mtime: 1, isFile: true },
      'other.md':     { content: 'c', size: 1, mtime: 1, isFile: true },
    },
    dirs: {
      '':      [{ name: 'Notes', isDirectory: true }, { name: 'other.md', isFile: true }],
      'Notes': [{ name: 'foo.md', isFile: true }, { name: 'bar.md', isFile: true }],
    },
  };

  invalidateCacheEntry(cache, 'Notes/foo.md');

  // Target file removed.
  assert.equal(cache.fs['Notes/foo.md'], undefined);
  // Siblings untouched.
  assert.ok(cache.fs['Notes/bar.md']);
  assert.ok(cache.fs['other.md']);
  // Parent dir listing dropped (will be re-fetched on next readdir).
  assert.equal(cache.dirs['Notes'], undefined);
  // Other dirs untouched.
  assert.ok(cache.dirs['']);
});

test('invalidateCacheEntry on a root-level file drops dirs[""]', () => {
  const cache = {
    fs:   { 'top.md': { content: 'x', size: 1, mtime: 1, isFile: true } },
    dirs: { '': [{ name: 'top.md', isFile: true }] },
  };
  invalidateCacheEntry(cache, 'top.md');
  assert.equal(cache.fs['top.md'], undefined);
  assert.equal(cache.dirs[''], undefined);
});

test('invalidateCacheEntry is a no-op when cache is null/undefined/empty', () => {
  // The shim guards against this but defense in depth — must not throw.
  assert.doesNotThrow(() => invalidateCacheEntry(null,      'x.md'));
  assert.doesNotThrow(() => invalidateCacheEntry(undefined, 'x.md'));
  assert.doesNotThrow(() => invalidateCacheEntry({},        'x.md'));
});

test('invalidateCacheSubtree drops every fs/dirs entry under the prefix', () => {
  // For recursive rmdir / rename of a directory.
  const cache = {
    fs: {
      'Notes':           { mtime: 1, size: 0, isFile: false, isDirectory: true },
      'Notes/a.md':      { content: 'a', size: 1, mtime: 1, isFile: true },
      'Notes/sub':       { mtime: 1, size: 0, isFile: false, isDirectory: true },
      'Notes/sub/b.md':  { content: 'b', size: 1, mtime: 1, isFile: true },
      'unrelated.md':    { content: 'c', size: 1, mtime: 1, isFile: true },
      'NotesSibling.md': { content: 'd', size: 1, mtime: 1, isFile: true },
    },
    dirs: {
      '':            [{ name: 'Notes', isDirectory: true }],
      'Notes':       [{ name: 'a.md', isFile: true }, { name: 'sub', isDirectory: true }],
      'Notes/sub':   [{ name: 'b.md', isFile: true }],
      'NotesOther':  [{ name: 'z.md', isFile: true }],
    },
  };

  invalidateCacheSubtree(cache, 'Notes');

  // Everything under Notes/* is gone.
  assert.equal(cache.fs['Notes'],          undefined);
  assert.equal(cache.fs['Notes/a.md'],     undefined);
  assert.equal(cache.fs['Notes/sub'],      undefined);
  assert.equal(cache.fs['Notes/sub/b.md'], undefined);
  // Siblings whose name only HAPPENS to start with "Notes" must survive.
  assert.ok(cache.fs['NotesSibling.md'], 'NotesSibling.md should survive');
  // Unrelated entries untouched.
  assert.ok(cache.fs['unrelated.md']);

  // dirs entries under the prefix gone; parent dropped so readdir re-fetches.
  assert.equal(cache.dirs['Notes'],     undefined);
  assert.equal(cache.dirs['Notes/sub'], undefined);
  assert.equal(cache.dirs[''],          undefined);
  // Other directories untouched.
  assert.ok(cache.dirs['NotesOther']);
});

test('invalidateCacheSubtree is a no-op when cache is null/undefined/empty', () => {
  assert.doesNotThrow(() => invalidateCacheSubtree(null,      'Notes'));
  assert.doesNotThrow(() => invalidateCacheSubtree(undefined, 'Notes'));
  assert.doesNotThrow(() => invalidateCacheSubtree({},        'Notes'));
});
