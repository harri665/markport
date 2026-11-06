'use strict';

/**
 * Markport Clipper: the system plugin (src/plugins/markport-clipper/main.js)
 * and the browser extension's pure helpers (src/browser-extension/lib.js).
 *
 * main.js does require('obsidian'), which only exists inside Obsidian, so a
 * minimal stand-in is served for that one module name. The plugin's real
 * saveImage() then runs against an in-memory vault.
 */

const assert = require('assert/strict');
const test = require('node:test');
const Module = require('module');
const path = require('path');

// ── a stand-in for Obsidian's module ────────────────────────────────────────

class TAbstractFile { constructor(p) { this.path = p; } }
class TFolder extends TAbstractFile { isRoot() { return this.path === '/'; } }
class TFile extends TAbstractFile {}

const notices = [];
const fakeObsidian = {
  Plugin: class { constructor(app, manifest) { this.app = app; this.manifest = manifest; } },
  PluginSettingTab: class {},
  FuzzySuggestModal: class {},
  Setting: class {},
  Notice: class { constructor(msg) { notices.push(msg); } },
  ItemView: class { constructor(leaf) { this.leaf = leaf; } },
  Modal: class { constructor(app) { this.app = app; } },
  Menu: class {},
  setIcon() {},
  TFolder,
  TFile,
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') return fakeObsidian;
  return originalLoad.call(this, request, ...rest);
};
const Plugin = require(path.join(__dirname, '..', '..', 'plugins', 'markport-clipper', 'main.js'));
Module._load = originalLoad;
const { extFromMime, sanitizeName, nameFromUrl, buildFileName, normalizeFolder, uniquePath, buildNote } = Plugin.helpers;

const lib = require(path.join(__dirname, '..', '..', 'browser-extension', 'lib.js'));

function makeVault(initial) {
  const entries = new Map([['/', new TFolder('/')]]);
  for (const p of initial || []) entries.set(p, p.endsWith('/') ? new TFolder(p.slice(0, -1)) : new TFile(p));
  // re-key folders without their trailing slash
  for (const [k, v] of [...entries]) if (k.endsWith('/') && k !== '/') { entries.delete(k); entries.set(v.path, v); }
  const written = new Map();
  return {
    entries,
    written,
    getName: () => 'Test',
    getAbstractFileByPath: (p) => entries.get(p) || null,
    getAllLoadedFiles: () => [...entries.values()],
    async createFolder(p) {
      if (entries.has(p)) throw new Error('exists: ' + p);
      entries.set(p, new TFolder(p));
    },
    async createBinary(p, buf) {
      if (entries.has(p)) throw new Error('exists: ' + p);
      entries.set(p, new TFile(p));
      written.set(p, Buffer.from(buf));
    },
    async create(p, text) {
      if (entries.has(p)) throw new Error('exists: ' + p);
      entries.set(p, new TFile(p));
      written.set(p, text);
    },
  };
}

function makePlugin(vault, settings) {
  const p = new Plugin({ vault }, { id: 'markport-clipper' });
  p.settings = Object.assign({ targetFolder: '', createNote: false, showNotice: false }, settings);
  p.saveData = async (d) => { p.saved = JSON.parse(JSON.stringify(d)); };
  return p;
}

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');

// ── naming ──────────────────────────────────────────────────────────────────

test('extFromMime maps image types and ignores parameters', () => {
  assert.equal(extFromMime('image/jpeg'), 'jpg');
  assert.equal(extFromMime('image/svg+xml; charset=utf-8'), 'svg');
  assert.equal(extFromMime('IMAGE/WEBP'), 'webp');
  assert.equal(extFromMime('text/html'), null);
  assert.equal(extFromMime(undefined), null);
});

test('sanitizeName drops characters Obsidian or Windows refuse', () => {
  assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n'), 'a b c d e f g h i j k l m n');
  assert.equal(sanitizeName('  ..hidden.  '), 'hidden');
  assert.equal(sanitizeName('x'.repeat(300)).length, 100);
});

test('nameFromUrl reads the last path segment and a known image extension', () => {
  assert.deepEqual(nameFromUrl('https://x.com/a/photo%20one.JPEG?w=200'), { base: 'photo one', ext: 'jpg' });
  assert.deepEqual(nameFromUrl('https://x.com/render/abc'), { base: 'abc', ext: null });
  assert.deepEqual(nameFromUrl('data:image/png;base64,AAA'), { base: '', ext: null });
  assert.deepEqual(nameFromUrl('not a url'), { base: '', ext: null });
});

test('buildFileName: the bytes decide the extension, junk names fall back to alt, then page title', () => {
  assert.equal(buildFileName({ url: 'https://x.com/cat.jpg', mime: 'image/webp' }), 'cat.webp');
  assert.equal(buildFileName({ url: 'https://x.com/image.png', mime: 'image/png', alt: 'A red fox' }), 'A red fox.png');
  assert.equal(buildFileName({ url: 'https://cdn.x.com/3f9a0c2e8b7d4a1f9e6c', mime: 'image/jpeg', alt: '', pageTitle: 'Gallery: Foxes' }), 'Gallery Foxes.jpg');
  assert.equal(buildFileName({ url: 'data:image/png;base64,AA', mime: 'image/png' }), 'image.png');
  assert.equal(buildFileName({ url: 'https://x.com/logo.svg', mime: '' }), 'logo.svg');
});

test('normalizeFolder trims slashes and refuses ".."', () => {
  assert.equal(normalizeFolder('/Inbox/Images/'), 'Inbox/Images');
  assert.equal(normalizeFolder('a\\b'), 'a/b');
  assert.equal(normalizeFolder(''), '');
  assert.equal(normalizeFolder(null), '');
  assert.throws(() => normalizeFolder('a/../b'), /\.\./);
});

test('uniquePath numbers duplicates the way Obsidian does', () => {
  const taken = new Set(['Clips/cat.png', 'Clips/cat 1.png']);
  assert.equal(uniquePath('Clips', 'cat.png', (p) => taken.has(p)), 'Clips/cat 2.png');
  assert.equal(uniquePath('', 'dog.png', () => false), 'dog.png');
});

test('buildNote embeds the image and records where it came from', () => {
  const note = buildNote('Clips/cat.png', { url: 'https://x.com/cat.png', pageUrl: 'https://x.com/p', pageTitle: 'Cats [1]' }, '2026-11-04T00:00:00.000Z');
  assert.match(note, /^---\nsource: "https:\/\/x.com\/cat.png"\npage: "https:\/\/x.com\/p"\ntitle: "Cats \[1\]"\nsaved: 2026-11-04T00:00:00.000Z\n---/);
  assert.match(note, /!\[\[Clips\/cat.png\]\]/);
  assert.match(note, /From \[Cats 1\]\(<https:\/\/x.com\/p>\)/);
});

// ── saving through the plugin ───────────────────────────────────────────────

// ── image library helpers ───────────────────────────────────────────────────

const H = Plugin.helpers;

test('library search: every word somewhere, every #tag on the image (or under it)', () => {
  const item = { path: 'Clips/red car.png', tags: ['cars/old', 'red'], note: 'from the museum', source: 'https://x.com/a.png', title: '' };
  assert.deepEqual(H.parseQuery('Red  #cars'), { words: ['red'], tags: ['cars'], colors: [] });
  assert.equal(H.matchesQuery(item, H.parseQuery('car museum')), true);
  assert.equal(H.matchesQuery(item, H.parseQuery('#cars')), true, 'a parent tag matches');
  assert.equal(H.matchesQuery(item, H.parseQuery('#cars/old red')), true);
  assert.equal(H.matchesQuery(item, H.parseQuery('#car')), false, 'a tag prefix is not a parent');
  assert.equal(H.matchesQuery(item, H.parseQuery('blue')), false);
});

test('library search: tag: and color: terms, and color words match the palette', () => {
  const teal = { path: 'Ref/alley.png', tags: ['night'], note: '', source: '', title: '', colors: ['#3e6f72', '#1e2a36'] };
  const red = { path: 'Ref/brick.png', tags: [], note: '', source: '', title: '', colors: ['#c0392b'] };
  const q = H.parseQuery('tag:night color:teal');
  assert.deepEqual(q.tags, ['night']);
  assert.deepEqual(q.colors, [H.hexToRgb('#2f8f8a')]);
  assert.equal(H.matchesQuery(teal, q), true);
  assert.equal(H.matchesQuery(red, H.parseQuery('color:teal')), false);
  assert.equal(H.matchesQuery(red, H.parseQuery('red')), true, 'a color word matches the palette');
  assert.equal(H.matchesQuery(red, H.parseQuery('color:#c03a2c')), true, 'a hex color, with tolerance');
  assert.deepEqual(H.parseQuery('color:plaid').words, ['plaid'], 'an unknown color is searched as a word');
  assert.equal(H.matchesQuery({ path: 'x.png', tags: [] }, H.parseQuery('color:red')), false, 'no colors known yet');
  assert.deepEqual(H.colorTarget('#abc'), [170, 187, 204]);
  assert.equal(H.colorTarget('nope'), null);
});

test('boards: .canvas files parse leniently, keep what they do not draw, and round-trip', () => {
  const src = JSON.stringify({
    nodes: [
      { id: 'a', type: 'file', file: 'Ref/x.png', x: 10, y: 20, width: 100, height: 80, custom: 1 },
      { id: 'b', type: 'text', text: 'hi', x: '5', y: null, width: -1, height: 50 },
      { id: 'c', type: 'weird', x: 0, y: 0, width: 10, height: 10 },
      { nope: true },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    other: 'kept',
    markport: { strokes: [{ id: 's', points: [0, 0, 10, 10], width: 3 }, { id: 'bad', points: [1, 2, 3] }] },
  });
  const d = H.parseCanvas(src);
  assert.deepEqual(d.nodes.map((n) => n.id), ['a', 'b', 'c']);
  assert.equal(d.nodes[0].custom, 1, 'unknown properties stay');
  assert.deepEqual([d.nodes[1].x, d.nodes[1].y, d.nodes[1].width], [5, 0, 200], 'bad numbers are repaired');
  assert.deepEqual(d.markport.strokes.map((s) => s.id), ['s'], 'malformed strokes are dropped');
  const out = JSON.parse(H.serializeCanvas(d));
  assert.equal(out.other, 'kept');
  assert.equal(out.edges.length, 1);
  assert.equal(out.markport.strokes.length, 1);
  // No strokes: no "markport" field at all, so plain canvases stay plain.
  assert.deepEqual(JSON.parse(H.serializeCanvas(H.parseCanvas(''))), { nodes: [], edges: [] });
  assert.throws(() => H.parseCanvas('{oops'), /not valid JSON/);
  assert.throws(() => H.parseCanvas('[1]'), /not a canvas/);
});

test('boards: image paths, renames, bounds, fit and pen strokes', () => {
  const d = H.parseCanvas(JSON.stringify({ nodes: [
    { id: 'a', type: 'file', file: 'A/x.png', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b', type: 'file', file: 'A/B/y.png', x: 200, y: 50, width: 100, height: 50 },
    { id: 'c', type: 'file', file: 'AB/z.png', x: 0, y: 0, width: 10, height: 10 },
  ] }));
  assert.deepEqual([...H.canvasImagePaths(d)], ['A/x.png', 'A/B/y.png', 'AB/z.png']);
  assert.equal(H.renameInCanvas(d, 'A', 'C'), true);
  assert.deepEqual(d.nodes.map((n) => n.file), ['C/x.png', 'C/B/y.png', 'AB/z.png'], 'a folder prefix is not a sibling');
  assert.equal(H.renameInCanvas(d, 'nothing', 'else'), false);

  const box = H.boxAround(d.nodes, [{ points: [-50, 10, 0, 300] }]);
  assert.deepEqual(box, { x: -50, y: 0, width: 350, height: 300 });
  assert.equal(H.boxAround([], []), null);
  const v = H.fitView({ x: 0, y: 0, width: 1000, height: 500 }, 600, 400, 50);
  assert.equal(v.zoom, 0.5);
  assert.deepEqual([v.x, v.y], [50, 75], 'centred');
  assert.equal(H.fitView({ x: 0, y: 0, width: 10, height: 10 }, 600, 400).zoom, 1, 'never above 100%');

  const pts = H.simplifyPoints([0, 0, 0.2, 0.1, 0.4, 0.2, 5, 5, 5.1, 5.1, 10.04, 10.06], 1);
  assert.deepEqual(pts, [0, 0, 5, 5, 10, 10.1], 'close points dropped, end kept, rounded');
  assert.equal(H.strokePath([0, 0, 5, 5]), 'M0 0L5 5');
  assert.equal(H.canvasColor('4'), '#4CB782');
  assert.equal(H.canvasColor('#123456'), '#123456');
  assert.equal(H.canvasColor('red'), null);
  assert.equal(H.boardName('Boards/Alley Scene.canvas'), 'Alley Scene');
});

test('media: numbered frames look like a flipbook; items quack like files', () => {
  assert.equal(H.looksLikeSequence(['walk_01.png', 'walk_02.png', 'walk_10.png']), true);
  assert.equal(H.looksLikeSequence(['a.png', 'b.png']), false, 'no numbers');
  assert.equal(H.looksLikeSequence(['walk_1.png', 'run_2.png']), false, 'different names');
  assert.equal(H.looksLikeSequence(['one_1.png']), false, 'one file is not a sequence');
  const frames = [{ name: '1.png', stat: { mtime: 5, ctime: 2, size: 10 } }, { name: '2.png', stat: { mtime: 9, ctime: 3, size: 20 } }];
  const fb = new H.MediaItem('flipbook', { path: 'Art/Walk.flipbook', name: 'Walk.flipbook', parent: null }, frames);
  assert.equal(fb.basename, 'Walk');
  assert.equal(fb.extension, 'flipbook');
  assert.deepEqual(fb.stat, { mtime: 9, ctime: 2, size: 30 });
  assert.equal(fb.frame(1).file, frames[1]);
  assert.equal(fb.frame(99).file, frames[1], 'clamped');
});

test('library metadata follows renames of files and folders, and goes on delete', () => {
  const lib = { 'A/x.png': { tags: ['t'] }, 'A/B/y.png': { note: 'n' }, 'AB/z.png': { note: 'keep' } };
  assert.equal(H.renameLibraryKeys(lib, 'A', 'C'), true);
  assert.deepEqual(Object.keys(lib).sort(), ['AB/z.png', 'C/B/y.png', 'C/x.png']);
  assert.equal(H.renameLibraryKeys(lib, 'nothing', 'else'), false);
  assert.equal(H.dropLibraryKeys(lib, 'C/B'), true);
  assert.deepEqual(Object.keys(lib).sort(), ['AB/z.png', 'C/x.png']);
});

test('normalizeTag, formatBytes and dominantColors', () => {
  assert.equal(H.normalizeTag('  #Road trip, '), 'Road-trip');
  assert.equal(H.formatBytes(512), '512 B');
  assert.equal(H.formatBytes(1536), '1.5 KB');
  assert.equal(H.formatBytes(5 * 1024 * 1024), '5.0 MB');
  // 3 red pixels, 1 blue, 1 transparent: red first, blue second, transparent ignored.
  const px = [250, 10, 10, 255, 252, 12, 8, 255, 248, 9, 11, 255, 10, 20, 240, 255, 0, 255, 0, 0];
  assert.deepEqual(H.dominantColors(px, 6), ['#fa0a0a', '#0a14f0']);
});

test('saveImage records where a clip came from, for the library', async () => {
  const vault = makeVault([]);
  const p = makePlugin(vault, {});
  await p.saveImage({ data: PNG_B64, mime: 'image/png', url: 'https://x.com/cat.png', pageUrl: 'https://x.com/p', pageTitle: 'Cats' });
  clearTimeout(p.libraryTimer);
  const m = p.settings.library['cat.png'];
  assert.equal(m.source, 'https://x.com/cat.png');
  assert.equal(m.page, 'https://x.com/p');
  assert.equal(m.title, 'Cats');
  assert.equal(typeof m.added, 'number');
});

test('saveImage writes the bytes into the target folder, creating it', async () => {
  const vault = makeVault();
  const p = makePlugin(vault, { targetFolder: 'Inspiration/Logos' });
  const r = await p.saveImage({ data: PNG_B64, mime: 'image/png', url: 'https://x.com/brand.png' });
  assert.equal(r.path, 'Inspiration/Logos/brand.png');
  assert.ok(vault.entries.get('Inspiration') instanceof TFolder);
  assert.ok(vault.entries.get('Inspiration/Logos') instanceof TFolder);
  assert.deepEqual([...vault.written.get(r.path)], [...Buffer.from(PNG_B64, 'base64')]);
  assert.equal(r.notePath, undefined);
});

test('saveImage never overwrites, and an explicit folder overrides the target', async () => {
  const vault = makeVault(['Other/', 'Other/brand.png']);
  const p = makePlugin(vault, { targetFolder: 'Clips' });
  const r = await p.saveImage({ data: PNG_B64, mime: 'image/png', url: 'https://x.com/brand.png', folder: 'Other' });
  assert.equal(r.path, 'Other/brand 1.png');
});

test('saveImage refuses non-images, empty data, and a folder path that is a file', async () => {
  const vault = makeVault(['Notes.md']);
  const p = makePlugin(vault);
  await assert.rejects(p.saveImage({ data: PNG_B64, mime: 'text/html' }), /Not an image/);
  await assert.rejects(p.saveImage({ data: '', mime: 'image/png' }), /empty/);
  await assert.rejects(p.saveImage({ mime: 'image/png' }), /No image data/);
  await assert.rejects(p.saveImage({ data: PNG_B64, mime: 'image/png', folder: 'Notes.md' }), /is a file/);
});

test('saveImage with createNote writes a note next to the image', async () => {
  const vault = makeVault();
  const p = makePlugin(vault, { targetFolder: 'Clips', createNote: true });
  const r = await p.saveImage({ data: PNG_B64, mime: 'image/png', url: 'https://x.com/cat.png', pageUrl: 'https://x.com/', pageTitle: 'X' });
  assert.equal(r.notePath, 'Clips/cat.md');
  assert.match(vault.written.get('Clips/cat.md'), /!\[\[Clips\/cat.png\]\]/);
});

test('setTarget stores the folder and info() lists folders without dot-folders', async () => {
  const vault = makeVault(['A/', 'A/B/', '.obsidian/', 'A/.hidden/']);
  const p = makePlugin(vault);
  const info = await p.setTarget('/New/Sub/', true);
  assert.equal(p.saved.targetFolder, 'New/Sub');
  assert.equal(info.target, 'New/Sub');
  assert.equal(info.vault, 'Test');
  assert.deepEqual(info.folders, ['', 'A', 'A/B', 'New', 'New/Sub']);
});

// ── extension helpers ───────────────────────────────────────────────────────

test('normalizeOrigin / originMatches compare scheme, host and port only', () => {
  assert.equal(lib.normalizeOrigin('https://notes.example.com/vault/abc'), 'https://notes.example.com');
  assert.equal(lib.normalizeOrigin('localhost:3500'), 'http://localhost:3500');
  assert.equal(lib.normalizeOrigin('ftp://x'), null);
  assert.equal(lib.normalizeOrigin(''), null);
  assert.ok(lib.originMatches('http://127.0.0.1:3500/vault/1', lib.DEFAULT_ORIGINS));
  assert.ok(!lib.originMatches('http://127.0.0.1:3501/vault/1', lib.DEFAULT_ORIGINS));
});

test('resolveMime trusts an image Content-Type, otherwise sniffs the bytes', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const avif = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
  const svg = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const html = new TextEncoder().encode('<!DOCTYPE html><html>');
  assert.equal(lib.resolveMime('image/gif', html), 'image/gif');
  assert.equal(lib.resolveMime('application/octet-stream', png), 'image/png');
  assert.equal(lib.resolveMime('', jpg), 'image/jpeg');
  assert.equal(lib.resolveMime(null, webp), 'image/webp');
  assert.equal(lib.resolveMime(null, avif), 'image/avif');
  assert.equal(lib.resolveMime('text/plain', svg), 'image/svg+xml');
  assert.equal(lib.resolveMime('text/html', html), null);
});

test('bytesToBase64 handles buffers larger than one chunk', () => {
  const bytes = new Uint8Array(100000).map((_, i) => i % 251);
  assert.equal(lib.bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('pickVault prefers the last-used vault, then the most recent tab', () => {
  const vaults = [
    { id: 'desktop:A', lastAccessed: 0 },
    { id: 'markport:A', lastAccessed: 1 },
    { id: 'markport:B', lastAccessed: 5 },
  ];
  assert.equal(lib.pickVault(vaults, 'desktop:A').id, 'desktop:A');
  assert.equal(lib.pickVault(vaults, 'gone').id, 'markport:B');
  assert.equal(lib.pickVault([], 'markport:A'), null);
});

test('folderGrid puts the folder used last at the top left, then recent, default, the rest', () => {
  const folders = ['', 'Clips', 'Clips/Web', 'Notes'];
  assert.deepEqual(lib.folderGrid('Clips', ['Notes', 'Clips/Web'], folders), ['Notes', 'Clips/Web', 'Clips', '']);
  // No recent folders yet: the default comes first.
  assert.deepEqual(lib.folderGrid('Clips', [], folders), ['Clips', '', 'Clips/Web', 'Notes']);
  // A recent folder deleted since is dropped; the vault root is a real folder.
  assert.deepEqual(lib.folderGrid('', ['Gone', ''], folders), ['', 'Clips', 'Clips/Web', 'Notes']);
  // Junk in storage does not break the menu.
  assert.deepEqual(lib.folderGrid(undefined, null, undefined), []);
});

test('folderTree nests folders under their parents, sorted by name', () => {
  const t = lib.folderTree(['', 'Notes', 'Clips/Web', 'Clips', 'Clips/2 b', 'Clips/10 a', 'Deep/a/b']);
  assert.deepEqual(t.get(''), ['Clips', 'Deep', 'Notes']);
  assert.deepEqual(t.get('Clips'), ['Clips/2 b', 'Clips/10 a', 'Clips/Web']);
  // "Deep" and "Deep/a" are not in the list, but "Deep/a/b" still has a path to it.
  assert.deepEqual(t.get('Deep'), ['Deep/a']);
  assert.deepEqual(t.get('Deep/a'), ['Deep/a/b']);
  assert.equal(t.has('Notes'), false, 'a folder with no subfolders has no entry');
  assert.deepEqual([...lib.folderTree(null)], [['', []]]);
});

test('vault ids and labels keep the same vault apart in Markport and in Obsidian', () => {
  assert.notEqual(lib.vaultId('desktop', 'Notes'), lib.vaultId('markport', 'Notes'));
  assert.equal(lib.vaultLabel('desktop', 'Notes'), 'Notes (Obsidian)');
  assert.equal(lib.vaultLabel('markport', 'Notes'), 'Notes (Markport)');
});

test('cropRect maps a page selection onto the captured screenshot', () => {
  // 2x display: the capture has twice the pixels of the viewport.
  assert.deepEqual(lib.cropRect({ x: 10, y: 20, w: 100, h: 50 }, 800, 600, 1600, 1200), { x: 20, y: 40, w: 200, h: 100 });
  // Page zoom: the scale comes from capture / viewport, not devicePixelRatio.
  assert.deepEqual(lib.cropRect({ x: 0, y: 0, w: 400, h: 300 }, 800, 600, 1000, 750), { x: 0, y: 0, w: 500, h: 375 });
  // Clamped to the capture; nothing left -> null.
  assert.deepEqual(lib.cropRect({ x: 700, y: 500, w: 300, h: 300 }, 800, 600, 800, 600), { x: 700, y: 500, w: 100, h: 100 });
  assert.equal(lib.cropRect({ x: 900, y: 0, w: 50, h: 50 }, 800, 600, 800, 600), null);
  assert.equal(lib.cropRect({ x: 0, y: 0, w: 10, h: 10 }, 0, 600, 800, 600), null);
});

test('normalizeKey accepts exactly the keys the plugin generates', () => {
  const key = Plugin.helpers.generateKey();
  assert.match(key, /^[0-9a-f]{48}$/);
  assert.notEqual(key, Plugin.helpers.generateKey());
  assert.equal(lib.normalizeKey('  ' + key.toUpperCase() + ' '), key);
  assert.equal(lib.normalizeKey(key.slice(1)), null);
  assert.equal(lib.normalizeKey('z'.repeat(48)), null);
  assert.equal(Plugin.helpers.BASE_PORT, lib.BASE_PORT);
  assert.equal(Plugin.helpers.PORT_COUNT, lib.PORT_COUNT);
});

// ── desktop Obsidian: the plugin's local HTTP server ────────────────────────

const http = require('http');
const KEY = 'ab'.repeat(24);

test('checkRequest: loopback Host only, no web Origins, key on everything but /ping', () => {
  const { checkRequest } = Plugin.helpers;
  const ok = { host: '127.0.0.1:27150', authorization: 'Bearer ' + KEY };
  assert.equal(checkRequest(ok, 27150, KEY, true), null);
  assert.equal(checkRequest({ host: 'localhost:27150', origin: 'chrome-extension://abc', authorization: 'Bearer ' + KEY }, 27150, KEY, true), null);
  assert.equal(checkRequest({ host: '127.0.0.1:27150' }, 27150, KEY, false), null);
  assert.equal(checkRequest({ ...ok, host: 'evil.example:27150' }, 27150, KEY, true).status, 403);   // DNS rebinding
  assert.equal(checkRequest({ ...ok, host: '127.0.0.1:27151' }, 27150, KEY, true).status, 403);
  assert.equal(checkRequest({ ...ok, origin: 'https://evil.example' }, 27150, KEY, true).status, 403);
  assert.equal(checkRequest({ ...ok, origin: 'null' }, 27150, KEY, true).status, 403);
  assert.equal(checkRequest({ host: '127.0.0.1:27150' }, 27150, KEY, true).status, 401);
  assert.equal(checkRequest({ ...ok, authorization: 'Bearer ' + 'cd'.repeat(24) }, 27150, KEY, true).status, 401);
  assert.equal(checkRequest({ ...ok, authorization: 'Bearer ' }, 27150, '', true).status, 401);   // no key set: refuse
});

function request(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function startDesktopPlugin(t, settings) {
  const vault = makeVault(['Clips/']);
  const p = makePlugin(vault, Object.assign({ pairingKey: KEY, targetFolder: 'Clips' }, settings));
  // Take a free base port, and hold it, so the plugin has to move up one.
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const base = blocker.address().port;
  t.after(() => blocker.close());
  const port = await p.startServer(base, 3);
  t.after(() => p.server && p.server.close());
  return { p, vault, port, base };
}

test('startServer skips a port that is in use, and /ping needs no key', async (t) => {
  const { port, base } = await startDesktopPlugin(t);
  assert.ok(port > base && port < base + 3, 'should move past the busy port, got ' + port);
  const r = await request(port, 'GET', '/ping');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { app: 'markport-clipper', apiVersion: 1 });
  assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS for web pages');
});

test('desktop server: info, setTarget and save, all with the pairing key', async (t) => {
  const { vault, port } = await startDesktopPlugin(t);
  const auth = { Authorization: 'Bearer ' + KEY };
  const json = Object.assign({ 'Content-Type': 'application/json' }, auth);

  const info = await request(port, 'GET', '/info', { headers: auth });
  assert.equal(info.status, 200);
  assert.equal(info.json.value.vault, 'Test');
  assert.equal(info.json.value.target, 'Clips');

  const target = await request(port, 'POST', '/target', { headers: json, body: { folder: 'Clips/Web' } });
  assert.equal(target.status, 200);
  assert.equal(target.json.value.target, 'Clips/Web');

  const saved = await request(port, 'POST', '/save', { headers: json, body: { data: PNG_B64, mime: 'image/png', url: 'https://x.com/pic.png' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.value.path, 'Clips/Web/pic.png');
  assert.deepEqual([...vault.written.get('Clips/Web/pic.png')], [...Buffer.from(PNG_B64, 'base64')]);

  const bad = await request(port, 'POST', '/save', { headers: json, body: { data: PNG_B64, mime: 'text/html' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Not an image/);
});

test('desktop server refuses web pages, a wrong key, non-JSON bodies, and unknown routes', async (t) => {
  const { vault, port } = await startDesktopPlugin(t);
  const good = { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const body = { data: PNG_B64, mime: 'image/png', url: 'https://x.com/pic.png' };

  assert.equal((await request(port, 'POST', '/save', { headers: { ...good, Origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await request(port, 'POST', '/save', { headers: { ...good, Host: 'evil.example:' + port }, body })).status, 403);
  assert.equal((await request(port, 'POST', '/save', { headers: { 'Content-Type': 'application/json' }, body })).status, 401);
  // A cross-site form or no-cors fetch can only send "simple" content types.
  assert.equal((await request(port, 'POST', '/save', { headers: { ...good, 'Content-Type': 'text/plain' }, body })).status, 415);
  assert.equal((await request(port, 'POST', '/save', { headers: good, body: '{not json' })).status, 400);
  assert.equal((await request(port, 'GET', '/files', { headers: good })).status, 404);
  assert.equal((await request(port, 'OPTIONS', '/save', { headers: good })).status, 404);
  assert.equal(vault.written.size, 0, 'nothing may be written by a refused request');
});
