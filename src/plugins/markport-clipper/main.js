'use strict';

/**
 * Markport - Image Clipper.
 *
 * The vault side of an Eagle-style image collector. The browser extension in
 * src/browser-extension/ lets you click images on any web page and sends them
 * here to be written into the vault. Writing through app.vault means the same
 * code works in desktop Obsidian, Markport server vaults (/api/fs), and
 * Markport in-browser vaults (OPFS, folder vaults).
 *
 * The plugin is an ordinary Obsidian plugin (CommonJS, no build) and is used
 * in two places, with a different way in for the extension in each:
 *
 *  - Markport (system plugin, from src/plugins/): the extension calls the
 *    global window.__markportClipper with chrome.scripting.executeScript in
 *    the Markport tab's MAIN world. Only code already running on that origin -
 *    the app itself, or an extension with access to it - can call it.
 *
 *  - Desktop Obsidian (copied into <vault>/.obsidian/plugins/markport-clipper/):
 *    there is no tab to inject into, so the plugin listens on 127.0.0.1,
 *    from port 27150 up (one port per open vault). Every request but /ping
 *    needs the pairing key shown in the plugin's settings, and requests a web
 *    page could make (a web Origin, or a Host other than loopback, which is
 *    what DNS rebinding looks like) are refused. No CORS headers are sent:
 *    the extension's service worker has host permission and does not need
 *    them, and no web page gets them.
 *
 * The target folder lives in this plugin's data.json, so it is per vault and
 * the same whether it was picked in the extension's bar, from a folder's
 * right-click menu, or with the "Choose clip folder" command.
 */

const obsidian = require('obsidian');

const API_VERSION = 1;
const MAX_BYTES = 50 * 1024 * 1024;
// base64 of MAX_BYTES plus the JSON around it.
const MAX_BODY = Math.ceil(MAX_BYTES / 3) * 4 + 64 * 1024;

// Desktop: the extension probes BASE_PORT .. BASE_PORT + PORT_COUNT - 1
// (src/browser-extension/lib.js has the same two numbers).
const BASE_PORT = 27150;
const PORT_COUNT = 10;

const DEFAULT_SETTINGS = {
  targetFolder: '',       // '' = vault root
  createNote: false,      // also write "<image>.md" with the source link
  showNotice: true,
  pairingKey: '',         // desktop only; generated on first load
  boardsFolder: 'Boards', // where "New board" puts its .canvas files
};

// ── Pure helpers (exported for tests) ───────────────────────────────────────

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/apng': 'png',
};
const IMAGE_EXTS = new Set(Object.values(EXT_BY_MIME).concat(['jpeg', 'tif', 'jfif']));

function extFromMime(mime) {
  if (typeof mime !== 'string') return null;
  return EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()] || null;
}

// Characters Obsidian refuses in file names (\ / :) or that break links
// (# ^ [ ] |), plus the ones Windows refuses, plus control characters.
function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100)
    .trim();
}

// "https://x.com/a/photo%20one.jpg?w=200" -> { base: "photo one", ext: "jpg" }
function nameFromUrl(url) {
  if (typeof url !== 'string' || /^(data|blob):/i.test(url)) return { base: '', ext: null };
  let pathname;
  try { pathname = new URL(url).pathname; } catch (_) { return { base: '', ext: null }; }
  let last = pathname.split('/').filter(Boolean).pop() || '';
  try { last = decodeURIComponent(last); } catch (_) { /* keep raw */ }
  const m = /^(.*)\.([A-Za-z0-9]{2,5})$/.exec(last);
  if (m && IMAGE_EXTS.has(m[2].toLowerCase())) {
    const ext = m[2].toLowerCase();
    return { base: m[1], ext: ext === 'jpeg' || ext === 'jfif' ? 'jpg' : ext === 'tif' ? 'tiff' : ext };
  }
  return { base: m ? m[1] : last, ext: null };
}

// A URL segment that says nothing about the image ("image", "1", "a3f9c0...")
// is worse than the alt text or the page title.
function isMeaningless(base) {
  return !base || base.length < 3 || /^(image|img|photo|picture|file|download|media|original|default|index|unnamed)$/i.test(base)
    || /^[0-9a-f-]{16,}$/i.test(base);
}

function buildFileName(info) {
  const fromUrl = nameFromUrl(info && info.url);
  const candidates = [fromUrl.base, info && info.alt, info && info.pageTitle];
  let base = '';
  for (const c of candidates) {
    const s = sanitizeName(c || '');
    if (!isMeaningless(s)) { base = s; break; }
  }
  if (!base) base = sanitizeName(fromUrl.base) || 'image';
  // The bytes decide the extension: a ".jpg" URL that serves WebP is WebP.
  const ext = extFromMime(info && info.mime) || fromUrl.ext || 'png';
  return base + '.' + ext;
}

function normalizeFolder(folder) {
  if (typeof folder !== 'string') return '';
  const parts = folder.replace(/\\/g, '/').split('/').map((p) => p.trim()).filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error('Folder path may not contain "..": ' + folder);
  return parts.join('/');
}

function joinPath(folder, name) {
  return folder ? folder + '/' + name : name;
}

// "a.png" -> "a 1.png" -> "a 2.png" ... - the same scheme Obsidian uses.
function uniquePath(folder, fileName, exists) {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  let candidate = joinPath(folder, fileName);
  for (let i = 1; exists(candidate); i++) candidate = joinPath(folder, base + ' ' + i + ext);
  return candidate;
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function yamlString(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

function buildNote(imagePath, info, savedAt) {
  const lines = ['---'];
  if (info.url && !/^(data|blob):/i.test(info.url)) lines.push('source: ' + yamlString(info.url));
  if (info.pageUrl) lines.push('page: ' + yamlString(info.pageUrl));
  if (info.pageTitle) lines.push('title: ' + yamlString(info.pageTitle));
  lines.push('saved: ' + savedAt);
  lines.push('---', '', '![[' + imagePath + ']]', '');
  if (info.pageUrl) lines.push('From [' + (info.pageTitle || info.pageUrl).replace(/[[\]]/g, '') + '](<' + info.pageUrl + '>)', '');
  return lines.join('\n');
}

// ── Library helpers (pure, exported for tests) ──────────────────────────────

function formatBytes(n) {
  if (!(n >= 0)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : String(n)) + ' ' + units[i];
}

function normalizeTag(t) {
  return String(t == null ? '' : t).trim().replace(/^#+/, '').replace(/[\s,]+/g, '-').replace(/^-+|-+$/g, '');
}

// Color words the search understands, as "color:teal" or a plain "teal".
const COLOR_NAMES = {
  red: '#d23c3c', orange: '#e8862e', yellow: '#e8d13a', gold: '#c9a227', green: '#4e9a4a', olive: '#7d7f3a',
  teal: '#2f8f8a', cyan: '#3cc0d0', blue: '#3b6fd1', navy: '#1f2f5a', indigo: '#4b4e9d', purple: '#7d4ba8',
  violet: '#9a6fd8', pink: '#e07aa8', magenta: '#c43c9a', brown: '#7a5134', beige: '#d8c8a8', tan: '#c19a6b',
  white: '#f2f2f0', gray: '#8a8d92', grey: '#8a8d92', black: '#141414', maroon: '#6b2230',
};
const COLOR_DISTANCE = 90;   // RGB distance that still counts as "that color"

function hexToRgb(hex) {
  let s = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// "teal" or "#3e6f72" -> [r, g, b]; anything else -> null.
function colorTarget(s) {
  const t = String(s || '').toLowerCase();
  if (COLOR_NAMES[t]) return hexToRgb(COLOR_NAMES[t]);
  return /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.test(t) ? hexToRgb(t) : null;
}

// Is `rgb` close to one of the image's main colors (the first four)?
function paletteHas(colors, rgb) {
  return (colors || []).slice(0, 4).some((c) => {
    const x = hexToRgb(c);
    return x && Math.hypot(x[0] - rgb[0], x[1] - rgb[1], x[2] - rgb[2]) < COLOR_DISTANCE;
  });
}

// "red car #cars/old color:teal" -> { words: ['red', 'car'], tags: ['cars/old'], colors: [[47, 143, 138]] }
// "tag:x" is the same as "#x". An unknown color after "color:" is searched as a word.
function parseQuery(q) {
  const words = [];
  const tags = [];
  const colors = [];
  for (const t of String(q || '').toLowerCase().split(/\s+/).filter(Boolean)) {
    if (t.length > 1 && t.startsWith('#')) tags.push(t.slice(1));
    else if (t.length > 4 && t.startsWith('tag:')) tags.push(t.slice(4).replace(/^#/, ''));
    else if (/^colou?r:./.test(t)) {
      const v = t.slice(t.indexOf(':') + 1);
      const rgb = colorTarget(v);
      if (rgb) colors.push(rgb); else words.push(v);
    } else words.push(t);
  }
  return { words, tags, colors };
}

function hasTag(tags, tag) {
  const want = tag.toLowerCase();
  return (tags || []).some((t) => { const x = t.toLowerCase(); return x === want || x.startsWith(want + '/'); });
}

// item: { path, tags, note, source, title, colors }. Every word must appear
// somewhere (a color word may instead match the image's colors), every #tag
// must be on the image (or a parent of one of its tags), every color: must be
// one of the image's main colors.
function matchesQuery(item, query) {
  const hay = [item.path, item.note, item.source, item.title, (item.tags || []).join(' ')].join('\n').toLowerCase();
  return query.words.every((w) => hay.includes(w) || (COLOR_NAMES[w] && paletteHas(item.colors, hexToRgb(COLOR_NAMES[w]))))
    && query.tags.every((t) => hasTag(item.tags, t))
    && (query.colors || []).every((rgb) => paletteHas(item.colors, rgb));
}

// Library metadata is keyed by vault path; keep it attached when a file or a
// whole folder moves, and drop it when they are deleted. Returns whether
// anything changed.
function renameLibraryKeys(library, oldPath, newPath) {
  let changed = false;
  for (const key of Object.keys(library)) {
    let next = null;
    if (key === oldPath) next = newPath;
    else if (key.startsWith(oldPath + '/')) next = newPath + key.slice(oldPath.length);
    if (next !== null) {
      library[next] = library[key];
      delete library[key];
      changed = true;
    }
  }
  return changed;
}

function dropLibraryKeys(library, p) {
  let changed = false;
  for (const key of Object.keys(library)) {
    if (key === p || key.startsWith(p + '/')) { delete library[key]; changed = true; }
  }
  return changed;
}

// Up to `max` clearly different dominant colors in RGBA pixel data, most
// common first, as "#rrggbb". Transparent pixels are ignored.
function dominantColors(px, max) {
  const buckets = new Map();
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
    let b = buckets.get(key);
    if (!b) { b = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, b); }
    b.n++; b.r += px[i]; b.g += px[i + 1]; b.b += px[i + 2];
  }
  const out = [];
  for (const b of [...buckets.values()].sort((x, y) => y.n - x.n)) {
    const c = [b.r / b.n, b.g / b.n, b.b / b.n];
    if (out.some((o) => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) < 48)) continue;
    out.push(c);
    if (out.length >= (max || 6)) break;
  }
  return out.map((c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''));
}

function generateKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Decide whether a request to the desktop server may proceed.
 * headers: Node's lower-cased request headers. Returns null when allowed,
 * otherwise { status, error }.
 */
function checkRequest(headers, port, key, needsKey) {
  const host = String(headers.host || '').toLowerCase();
  if (!['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port].includes(host)) {
    return { status: 403, error: 'Bad Host header' };
  }
  const origin = headers.origin;
  if (origin && !/^(chrome|moz|safari-web)-extension:\/\//i.test(origin)) {
    return { status: 403, error: 'Requests from web pages are not accepted' };
  }
  if (needsKey) {
    const m = /^Bearer (\S+)$/.exec(String(headers.authorization || ''));
    if (!m || !sameSecret(m[1], key)) return { status: 401, error: 'Wrong or missing pairing key' };
  }
  return null;
}

// ── Folder picker inside Obsidian ───────────────────────────────────────────

class FolderSuggestModal extends obsidian.FuzzySuggestModal {
  constructor(app, folders, onChoose) {
    super(app);
    this.folders = folders;
    this.onChoose = onChoose;
    this.setPlaceholder('Folder for clipped images');
  }
  getItems() { return this.folders; }
  getItemText(folder) { return folder || '/'; }
  onChooseItem(folder) { this.onChoose(folder); }
}

class ClipperSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new obsidian.Setting(containerEl)
      .setName('Clip folder')
      .setDesc('Where images clicked in the browser are saved. You can also right-click a folder and choose "Save clipped images here".')
      .addText((text) => text
        .setPlaceholder('/ (vault root)')
        .setValue(this.plugin.settings.targetFolder)
        .onChange(async (value) => {
          try {
            this.plugin.settings.targetFolder = normalizeFolder(value);
            await this.plugin.saveSettings();
          } catch (e) { new obsidian.Notice(e.message); }
        }));
    new obsidian.Setting(containerEl)
      .setName('Create a note for each image')
      .setDesc('Next to every image, write a note that embeds it and records the page it came from.')
      .addToggle((t) => t.setValue(this.plugin.settings.createNote).onChange(async (v) => {
        this.plugin.settings.createNote = v;
        await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl)
      .setName('Show a notice when an image is saved')
      .addToggle((t) => t.setValue(this.plugin.settings.showNotice).onChange(async (v) => {
        this.plugin.settings.showNotice = v;
        await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl)
      .setName('Boards folder')
      .setDesc('Where new boards are created. A board is a .canvas file, so it also opens in Obsidian\'s Canvas.')
      .addText((text) => text
        .setPlaceholder('/ (vault root)')
        .setValue(this.plugin.settings.boardsFolder)
        .onChange(async (value) => {
          try {
            this.plugin.settings.boardsFolder = normalizeFolder(value);
            await this.plugin.saveSettings();
          } catch (e) { new obsidian.Notice(e.message); }
        }));
    new obsidian.Setting(containerEl)
      .setName('Library accent')
      .setDesc('The color of selections, groups and pen strokes in the image library.')
      .addDropdown((d) => {
        for (const [value, text] of ACCENTS) d.addOption(value, text);
        d.setValue(this.plugin.settings.libraryUi.accent || 'amber');
        d.onChange((v) => this.plugin.setAccent(v));
      });

    if (this.plugin.isMarkport()) {
      new obsidian.Setting(containerEl)
        .setName('Browser extension')
        .setDesc('Running in Markport: the Markport Clipper extension finds this vault through its open tab. No pairing needed.');
      return;
    }
    if (!this.plugin.canServe()) {
      new obsidian.Setting(containerEl)
        .setName('Browser extension')
        .setDesc('The browser extension can only reach desktop Obsidian or Markport, not this app.');
      return;
    }

    const port = this.plugin.port;
    new obsidian.Setting(containerEl)
      .setName('Pairing key')
      .setDesc('Paste this into the Markport Clipper extension\'s settings once. ' + (port
        ? 'Listening on 127.0.0.1:' + port + '.'
        : 'Not listening: ' + (this.plugin.serverError || 'no free port in ' + BASE_PORT + '-' + (BASE_PORT + PORT_COUNT - 1)) + '.'))
      .addText((text) => {
        text.setValue(this.plugin.settings.pairingKey).setDisabled(true);
        text.inputEl.style.width = '24em';
        text.inputEl.style.fontFamily = 'var(--font-monospace)';
      })
      .addButton((b) => b.setButtonText('Copy').onClick(async () => {
        await navigator.clipboard.writeText(this.plugin.settings.pairingKey);
        new obsidian.Notice('Pairing key copied');
      }))
      .addButton((b) => b.setButtonText('New key').setWarning().onClick(async () => {
        this.plugin.settings.pairingKey = generateKey();
        await this.plugin.saveSettings();
        new obsidian.Notice('New pairing key - paste it into the extension again');
        this.display();
      }));
  }
}

// ── Small modals ────────────────────────────────────────────────────────────

class PromptModal extends obsidian.Modal {
  constructor(app, title, placeholder, onSubmit, value) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.onSubmit = onSubmit;
    this.value = value || '';
  }
  onOpen() {
    this.titleEl.setText(this.title);
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'mpl-prompt', attr: { placeholder: this.placeholder } });
    input.value = this.value;
    const submit = () => { const v = input.value; this.close(); this.onSubmit(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const btns = this.contentEl.createDiv({ cls: 'modal-button-container' });
    btns.createEl('button', { cls: 'mod-cta', text: 'OK' }).addEventListener('click', submit);
    btns.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  onClose() { this.contentEl.empty(); }
}

class ConfirmModal extends obsidian.Modal {
  constructor(app, title, text, cta, onYes) {
    super(app);
    Object.assign(this, { title, text, cta, onYes });
  }
  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: this.text });
    const btns = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const yes = btns.createEl('button', { cls: 'mod-warning', text: this.cta });
    yes.addEventListener('click', () => { this.close(); this.onYes(); });
    btns.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    setTimeout(() => yes.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}

// ── Boards: Obsidian .canvas files (JSON Canvas) ────────────────────────────
//
// A board is an ordinary .canvas file, so it also opens in Obsidian's Canvas
// and syncs like any other file. Images are "file" nodes, sticky notes "text"
// nodes, groups "group" nodes; edges and node types the board does not draw
// are kept exactly as they were. Pen strokes have no JSON Canvas type, so they
// live in a top-level "markport" field:
//
//   "markport": { "strokes": [{ "id", "points": [x0, y0, x1, y1, ...], "width", "color"? }] }
//
// Obsidian's own Canvas does not know that field and may drop it when it
// saves a board you edited there.

function newNodeId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function parseCanvas(text) {
  let data = {};
  if (text && String(text).trim()) {
    try { data = JSON.parse(text); } catch (_) { throw new Error('This board file is not valid JSON'); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('This board file is not a canvas');
  data.nodes = (Array.isArray(data.nodes) ? data.nodes : []).filter((n) => n && typeof n === 'object' && typeof n.id === 'string');
  data.edges = Array.isArray(data.edges) ? data.edges : [];
  for (const n of data.nodes) {
    for (const k of ['x', 'y']) n[k] = Number.isFinite(Number(n[k])) ? Number(n[k]) : 0;
    for (const k of ['width', 'height']) n[k] = Number(n[k]) > 0 ? Number(n[k]) : 200;
  }
  const mp = data.markport && typeof data.markport === 'object' && !Array.isArray(data.markport) ? data.markport : {};
  mp.strokes = (Array.isArray(mp.strokes) ? mp.strokes : []).filter((s) => s && typeof s.id === 'string'
    && Array.isArray(s.points) && s.points.length >= 4 && s.points.length % 2 === 0 && s.points.every(Number.isFinite));
  data.markport = mp;
  return data;
}

function serializeCanvas(data) {
  const out = Object.assign({}, data);
  const mp = Object.assign({}, data.markport);
  if (!mp.strokes || !mp.strokes.length) delete mp.strokes;
  if (Object.keys(mp).length) out.markport = mp; else delete out.markport;
  return JSON.stringify(out, null, '\t');
}

function canvasImagePaths(data) {
  const out = new Set();
  for (const n of (data && data.nodes) || []) if (n.type === 'file' && typeof n.file === 'string') out.add(n.file);
  return out;
}

// An image (or a folder of them) moved: point the board's file nodes at the new path.
function renameInCanvas(data, oldPath, newPath) {
  let changed = false;
  for (const n of data.nodes) {
    if (n.type !== 'file' || typeof n.file !== 'string') continue;
    if (n.file === oldPath) { n.file = newPath; changed = true; }
    else if (n.file.startsWith(oldPath + '/')) { n.file = newPath + n.file.slice(oldPath.length); changed = true; }
  }
  return changed;
}

function strokeBox(s) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < s.points.length; i += 2) {
    x0 = Math.min(x0, s.points[i]); x1 = Math.max(x1, s.points[i]);
    y0 = Math.min(y0, s.points[i + 1]); y1 = Math.max(y1, s.points[i + 1]);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// The box around some nodes and strokes, or null when there are none.
function boxAround(nodes, strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const boxes = (nodes || []).concat((strokes || []).map(strokeBox));
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function inside(b, g) {
  return b.x >= g.x && b.y >= g.y && b.x + b.width <= g.x + g.width && b.y + b.height <= g.y + g.height;
}

function overlaps(b, r) {
  return b.x < r.x + r.width && b.x + b.width > r.x && b.y < r.y + r.height && b.y + b.height > r.y;
}

// The pan/zoom that shows `box` centred in a w × h viewport, never above 100%.
function fitView(box, w, h, pad) {
  if (!box || !(w > 0) || !(h > 0)) return { x: (w || 0) / 2, y: (h || 0) / 2, zoom: 1 };
  const p = pad == null ? 40 : pad;
  const zoom = Math.max(0.05, Math.min(1, (w - 2 * p) / Math.max(1, box.width), (h - 2 * p) / Math.max(1, box.height)));
  return { x: (w - box.width * zoom) / 2 - box.x * zoom, y: (h - box.height * zoom) / 2 - box.y * zoom, zoom };
}

// The pen samples faster than it moves: drop points closer than `tol` to
// the last one kept (the end point always stays), and round to 0.1.
function simplifyPoints(flat, tol) {
  const n = flat.length;
  if (n < 4) return flat.slice();
  const out = [flat[0], flat[1]];
  for (let i = 2; i + 1 < n; i += 2) {
    const dx = flat[i] - out[out.length - 2];
    const dy = flat[i + 1] - out[out.length - 1];
    if (dx * dx + dy * dy >= tol * tol) out.push(flat[i], flat[i + 1]);
  }
  if (out[out.length - 2] !== flat[n - 2] || out[out.length - 1] !== flat[n - 1]) out.push(flat[n - 2], flat[n - 1]);
  if (out.length === 2) out.push(flat[n - 2], flat[n - 1]);
  return out.map((v) => Math.round(v * 10) / 10);
}

function strokePath(flat) {
  let d = 'M' + flat[0] + ' ' + flat[1];
  for (let i = 2; i + 1 < flat.length; i += 2) d += 'L' + flat[i] + ' ' + flat[i + 1];
  return d;
}

// JSON Canvas preset colors 1-6, or a hex color.
const CANVAS_COLORS = { 1: '#E5484D', 2: '#F2994A', 3: '#E8C547', 4: '#4CB782', 5: '#45B7C9', 6: '#9B6CF0' };
function canvasColor(c) {
  if (c == null || c === '') return null;
  return CANVAS_COLORS[c] || (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? String(c) : null);
}

function boardName(path) {
  return String(path || '').split('/').pop().replace(/\.canvas$/i, '');
}

// ── Plain DOM helpers for the board and the pinned window ───────────────────
//
// The pinned window can be a Document Picture-in-Picture window, whose
// prototypes Obsidian has not extended (no createDiv, toggleClass, ...). The
// board code therefore builds everything with document.createElement from
// this window and plain DOM calls; nodes created here keep working after they
// are moved into the other window.

function h(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, parent, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k of Object.keys(attrs || {})) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

// The design's own line icons (16 × 16, 1.5 px stroke). A string is a path.
const ICONS = {
  sideClose: [{ t: 'rect', x: 2, y: 2.5, width: 12, height: 11, rx: 2 }, 'M6 2.5v11', 'M11 6l-2 2 2 2'],
  sideOpen: [{ t: 'rect', x: 2, y: 2.5, width: 12, height: 11, rx: 2 }, 'M6 2.5v11', 'M9 6l2 2-2 2'],
  fill: ['M2 6V2h4', 'M10 2h4v4', 'M14 10v4h-4', 'M6 14H2v-4'],
  left: ['M10 4L6 8l4 4'],
  right: ['M6 4l4 4-4 4'],
  prev: ['M10 3L5 8l5 5'],
  next: ['M6 3l5 5-5 5'],
  info: [{ t: 'circle', cx: 8, cy: 8, r: 6 }, 'M8 7.5V11', 'M8 5v.01'],
  close: ['M3 3l10 10', 'M13 3L3 13'],
  select: ['M3 2l9 5-4 1-2 4z'],
  draw: ['M2 14l3-1 8-8-2-2-8 8z'],
  note: ['M3 3h10v7l-3 3H3z', 'M10 13v-3h3'],
  group: [{ t: 'rect', x: 2, y: 2, width: 12, height: 12, rx: 2, 'stroke-dasharray': '2 2' }],
  pin: ['M6 2h4l-1 4 3 3H4l3-3z', 'M8 9v5'],
  openWin: ['M9 2h5v5', 'M14 2L8 8', 'M12 10v4H2V4h4'],
  plus: ['M8 3v10', 'M3 8h10'],
  logo: [{ t: 'circle', cx: 6.8, cy: 6.8, r: 4.4 }, 'M10 10l3.6 3.6'],
};

function dicon(parent, name, size) {
  const svg = svgEl('svg', null, {
    width: size || 15, height: size || 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  });
  for (const part of ICONS[name] || []) {
    if (typeof part === 'string') svgEl('path', svg, { d: part });
    else {
      const attrs = Object.assign({}, part);
      delete attrs.t;
      svgEl(part.t, svg, attrs);
    }
  }
  parent.appendChild(svg);
  return svg;
}

function dbutton(parent, iconName, label, onClick, cls) {
  const b = h('button', 'mpl-ib' + (cls ? ' ' + cls : ''), parent);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  dicon(b, iconName);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

// Some themes (Obsidian's mobile and tablet ones among them) use translucent
// backgrounds. Floating panels must be opaque, so resolve the theme's colors
// and pin them on `el` as --mpl-page-solid / --mpl-bar-solid with alpha 1.
function solidColors(el) {
  const win = el.ownerDocument.defaultView || window;
  const probe = h('div', null, el);
  const read = (name) => {
    probe.style.backgroundColor = 'var(' + name + ')';
    const m = /rgba?\(([^)]+)\)/.exec(win.getComputedStyle(probe).backgroundColor);
    if (!m) return null;
    const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? 'rgb(' + v[0] + ', ' + v[1] + ', ' + v[2] + ')' : null;
  };
  const page = read('--background-primary');
  const bar = read('--background-secondary');
  probe.remove();
  if (page) el.style.setProperty('--mpl-page-solid', page);
  if (bar) el.style.setProperty('--mpl-bar-solid', bar);
}

// Copy this window's styles and theme classes into a new (pinned) window.
function copyStyles(from, to) {
  for (const node of from.querySelectorAll('link[rel="stylesheet"], style')) {
    const copy = node.cloneNode(true);
    if (copy.tagName === 'LINK') copy.href = node.href;
    to.head.appendChild(copy);
  }
  for (const sheet of from.adoptedStyleSheets || []) {
    try {
      const st = h('style');
      st.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
      to.head.appendChild(st);
    } catch (_) { /* not readable */ }
  }
  const base = h('style');
  base.textContent = 'html,body{margin:0;height:100%;overflow:hidden}';
  to.head.appendChild(base);
  to.documentElement.className = from.documentElement.className;
  const htmlStyle = from.documentElement.getAttribute('style');
  if (htmlStyle) to.documentElement.setAttribute('style', htmlStyle);
  to.body.className = from.body.className;
  const bodyStyle = from.body.getAttribute('style');
  if (bodyStyle) to.body.setAttribute('style', bodyStyle);
}

// ── A board's data, shared by every view showing it ─────────────────────────

class BoardStore {
  constructor(plugin, path) {
    this.plugin = plugin;
    this.path = path;
    this.data = null;
    this.error = '';
    this.loaded = false;
    this.loading = null;
    this.lastText = null;   // what the file holds as far as we know (our own writes included)
    this.saveTimer = null;
    this.listeners = new Set();
  }

  get name() { return boardName(this.path); }

  file() {
    const f = this.plugin.app.vault.getAbstractFileByPath(this.path);
    return f instanceof obsidian.TFile ? f : null;
  }

  ensureLoaded() {
    if (!this.loaded && !this.loading) this.load();
  }

  async load() {
    const f = this.file();
    if (!f) {
      this.data = null;
      this.error = 'This board file no longer exists.';
      this.loaded = true;
      this.emit();
      return;
    }
    this.loading = (async () => {
      try {
        const text = await this.plugin.app.vault.read(f);
        if (this.saveTimer) return;                       // a local edit is waiting to be saved: it wins
        if (this.data && text === this.lastText) return;  // our own write coming back
        this.lastText = text;
        this.data = parseCanvas(text);
        this.error = '';
        this.plugin.indexBoard(this.path, this.data);
      } catch (e) {
        this.data = null;
        this.error = (e && e.message) || String(e);
      }
      this.loaded = true;
      this.emit();
    })();
    try { await this.loading; } finally { this.loading = null; }
  }

  // Something on the board changed: redraw everywhere, save soon.
  change() {
    if (!this.data) return;
    this.plugin.indexBoard(this.path, this.data);
    this.emit();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 500);
  }

  async save() {
    this.saveTimer = null;
    const f = this.file();
    if (!f || !this.data) return;
    const text = serializeCanvas(this.data);
    if (text === this.lastText) return;
    this.lastText = text;
    try {
      await this.plugin.app.vault.modify(f, text);
    } catch (e) {
      new obsidian.Notice('Could not save the board: ' + ((e && e.message) || e));
    }
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.save();
    }
  }

  gone() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.data = null;
    this.error = 'This board file no longer exists.';
    this.emit();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch (e) { console.error('[markport-clipper]', e); }
    }
  }
}

// ── The board canvas ────────────────────────────────────────────────────────
//
// Draws one BoardStore into a host element and edits it. Used by the
// library's board panel and by the pinned mini window.
//
//   select (V)  click to select, Shift/Ctrl to add; drag to move (a group
//               takes what lies inside it); drag empty space to pan, Shift-
//               drag to select a box; corner handle to resize; Delete removes
//   draw (D)    freehand strokes in the accent color
//   note (N)    click to add a sticky note (or double-click empty space)
//   group (G)   drag a box, or press G with things selected to group them
//
// Wheel pans, Ctrl/Cmd + wheel (or a pinch) zooms, Shift+1 fits the board.

const NOTE_W = 220;
const NOTE_H = 140;
const IMG_W = 260;
const TOOLS = [
  ['select', 'select', 'Select (V)', 'v'],
  ['draw', 'draw', 'Draw (D)', 'd'],
  ['note', 'note', 'Note (N)', 'n'],
  ['group', 'group', 'Group (G)', 'g'],
];

function clampZoom(z) { return Math.min(8, Math.max(0.05, z)); }

class BoardCanvas {
  constructor(host, plugin, opts) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.opts = opts || {};
    this.store = null;
    this.unsub = null;
    this.view = null;
    this.needFit = true;
    this.tool = 'select';
    this.sel = new Set();        // node and stroke ids
    this.els = new Map();        // node id -> element
    this.strokeEls = new Map();  // stroke id -> <g>
    this.pointers = new Map();
    this.gesture = null;
    this.editing = null;
    this.pendingAspect = new Set();
    this.spaceDown = false;

    this.el = h('div', 'mpl-canvas', host);
    this.el.tabIndex = 0;
    this.el.dataset.tool = 'select';
    this.world = h('div', 'mpl-world', this.el);
    this.nodeLayer = h('div', 'mpl-nodes', this.world);
    this.svg = svgEl('svg', this.world, { class: 'mpl-strokes', width: '1', height: '1' });
    this.marquee = h('div', 'mpl-marquee', this.el);
    this.emptyEl = h('div', 'mpl-canvas-empty', this.el);

    if (!this.opts.mini) {
      const tools = h('div', 'mpl-tools', this.el);
      tools.setAttribute('role', 'toolbar');
      this.toolBtns = {};
      for (const [id, ic, label] of TOOLS) {
        const b = dbutton(tools, ic, label, () => {
          if (id === 'group' && this.sel.size) this.groupSelection();
          else this.setTool(this.tool === id ? 'select' : id);
          this.el.focus({ preventScroll: true });
        }, 'mpl-tool');
        b.setAttribute('title', label);
        this.toolBtns[id] = b;
      }
      this.actions = h('div', 'mpl-sel-actions', this.el);
      const full = h('button', 'mpl-pill', this.actions);
      full.type = 'button';
      full.setAttribute('aria-label', 'Full screen (F)');
      dicon(full, 'fill', 13);
      h('span', null, full, 'F');
      full.addEventListener('click', (e) => { e.stopPropagation(); this.fullForSelection(); });
      const det = h('button', 'mpl-pill', this.actions);
      det.type = 'button';
      det.setAttribute('aria-label', 'Details (I)');
      dicon(det, 'info', 13);
      h('span', null, det, 'Details');
      det.addEventListener('click', (e) => { e.stopPropagation(); if (this.opts.onDetails) this.opts.onDetails(); });
      this.paintTools();
    }

    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', (e) => this.onUp(e, true));
    this.el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.el.addEventListener('dblclick', (e) => this.onDbl(e));
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('keyup', (e) => { if (e.key === ' ') this.spaceDown = false; });
    this.el.addEventListener('blur', () => { this.spaceDown = false; });
    this.el.addEventListener('contextmenu', (e) => this.onMenu(e));
    this.el.addEventListener('dragover', (e) => this.onDragOver(e));
    this.el.addEventListener('dragleave', (e) => { if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('is-drop'); });
    this.el.addEventListener('drop', (e) => this.onDrop(e));

    const win = this.el.ownerDocument.defaultView || window;
    if (win.ResizeObserver) {
      this.resizeObs = new win.ResizeObserver(() => this.refreshSize());
      this.resizeObs.observe(this.el);
    }
  }

  get data() { return this.store && this.store.data; }

  destroy() {
    if (this.unsub) this.unsub();
    if (this.resizeObs) this.resizeObs.disconnect();
    clearTimeout(this.viewTimer);
    this.el.remove();
  }

  setStore(store) {
    if (this.unsub) this.unsub();
    this.unsub = null;
    this.store = store;
    this.sel.clear();
    this.editing = null;
    this.gesture = null;
    this.nodeLayer.replaceChildren();
    this.svg.replaceChildren();
    this.els.clear();
    this.strokeEls.clear();
    const saved = store && this.opts.getView ? this.opts.getView(store.path) : null;
    this.view = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.zoom > 0 ? Object.assign({}, saved) : null;
    this.needFit = !this.view;
    this.autoFit = false;
    if (store) {
      this.unsub = store.on(() => this.render());
      store.ensureLoaded();
    }
    this.render();
    this.selChanged();
  }

  // A board that was fitted automatically stays fitted as its panel resizes,
  // until you pan or zoom it yourself.
  refreshSize() {
    if ((this.needFit || this.autoFit) && this.data && this.el.clientWidth) this.fit();
    this.placeActions();
  }

  // -- drawing --------------------------------------------------------------

  render() {
    const data = this.data;
    const empty = !data || (!data.nodes.length && !data.markport.strokes.length);
    this.el.classList.toggle('is-empty', empty);
    this.emptyEl.textContent = !this.store ? ''
      : this.store.error ? 'Could not open this board: ' + this.store.error
        : !data ? 'Loading…'
          : this.opts.mini ? 'Drag images up from the library below.'
            : 'Drag images here from the library, or drop files from your computer. Double-click to add a note.';
    if (!data) {
      this.nodeLayer.replaceChildren();
      this.svg.replaceChildren();
      this.els.clear();
      this.strokeEls.clear();
      this.applyView();
      this.placeActions();
      return;
    }
    if (this.needFit && this.el.clientWidth) this.fit(true);

    const live = new Set();
    const order = data.nodes.filter((n) => n.type === 'group').concat(data.nodes.filter((n) => n.type !== 'group'));
    let prev = null;
    for (const n of order) {
      live.add(n.id);
      let e = this.els.get(n.id);
      if (!e || e._type !== n.type) {
        if (e) e.remove();
        e = this.makeNode(n);
        this.els.set(n.id, e);
      }
      this.paintNode(e, n);
      const want = prev ? prev.nextSibling : this.nodeLayer.firstChild;
      if (want !== e) this.nodeLayer.insertBefore(e, want);
      prev = e;
    }
    for (const [id, e] of this.els) if (!live.has(id)) { e.remove(); this.els.delete(id); }

    for (const s of data.markport.strokes) {
      live.add(s.id);
      let g = this.strokeEls.get(s.id);
      if (!g) {
        g = svgEl('g', null, { class: 'mpl-stroke' });
        g.dataset.id = s.id;
        g._vis = svgEl('path', g, { class: 'mpl-stroke-line' });
        g._hit = svgEl('path', g, { class: 'mpl-stroke-hit' });
        this.strokeEls.set(s.id, g);
      }
      this.paintStroke(g, s);
      this.svg.appendChild(g);
    }
    for (const [id, g] of this.strokeEls) if (!live.has(id)) { g.remove(); this.strokeEls.delete(id); }

    let pruned = false;
    for (const id of [...this.sel]) if (!live.has(id)) { this.sel.delete(id); pruned = true; }
    this.applyView();
    if (pruned) this.selChanged(); else this.paintSelection();
  }

  makeNode(n) {
    const e = h('div', 'mpl-bn mpl-bn-' + String(n.type || 'unknown').replace(/[^a-z]/gi, ''));
    e._type = n.type;
    e.dataset.id = n.id;
    if (n.type === 'group') e._label = h('div', 'mpl-bn-glabel', e);
    else if (n.type === 'text') e._body = h('div', 'mpl-bn-note', e);
    else if (n.type === 'file') e._body = h('div', 'mpl-bn-img', e);
    else e._body = h('div', 'mpl-bn-card', e);
    h('div', 'mpl-bn-handle', e);
    return e;
  }

  paintNode(e, n) {
    if (!e) return;
    const s = e.style;
    s.left = n.x + 'px';
    s.top = n.y + 'px';
    s.width = n.width + 'px';
    s.height = n.height + 'px';
    const c = canvasColor(n.color);
    if (c) s.setProperty('--mpl-node-color', c); else s.removeProperty('--mpl-node-color');
    if (n.type === 'group') {
      e._label.textContent = 'GROUP · ' + (n.label || 'Untitled');
    } else if (n.type === 'text') {
      if (e._text !== n.text && this.editing !== n.id) {
        e._text = n.text;
        this.renderText(e._body, n.text || '');
      }
    } else if (n.type === 'file') {
      if (e._file !== n.file) {
        e._file = n.file;
        this.renderFile(e, n);
      }
    } else if (e._shown !== (n.url || n.type)) {
      e._shown = n.url || n.type;
      e._body.textContent = n.type === 'link' ? (n.url || '') : 'Unsupported card: ' + n.type;
    }
  }

  renderFile(e, n) {
    const body = e._body;
    body.replaceChildren();
    e.classList.remove('is-missing', 'is-doc');
    const f = this.app.vault.getAbstractFileByPath(n.file);
    if (isImageFile(f)) {
      const img = h('img', null, body);
      img.draggable = false;
      img.alt = f.basename;
      img.decoding = 'async';
      img.addEventListener('load', () => {
        if (!this.pendingAspect.has(n.id) || !(img.naturalWidth > 0)) return;
        this.pendingAspect.delete(n.id);
        n.height = Math.round(n.width * img.naturalHeight / img.naturalWidth);
        this.commit();
      });
      img.addEventListener('error', () => { e.classList.add('is-missing'); body.textContent = f.name; });
      img.src = this.app.vault.getResourcePath(f);
    } else {
      e.classList.add(f ? 'is-doc' : 'is-missing');
      body.textContent = (f ? '' : 'Missing: ') + String(n.file || '').split('/').pop();
    }
  }

  renderText(el, text) {
    el.replaceChildren();
    const md = obsidian.MarkdownRenderer;
    if (el.ownerDocument === document && md && this.opts.component) {
      if (typeof md.render === 'function') { md.render(this.app, text, el, this.store.path, this.opts.component); return; }
      if (typeof md.renderMarkdown === 'function') { md.renderMarkdown(text, el, this.store.path, this.opts.component); return; }
    }
    el.classList.add('is-plain');
    el.textContent = text;
  }

  paintStroke(g, s) {
    const d = strokePath(s.points);
    if (g._d !== d) {
      g._d = d;
      g._vis.setAttribute('d', d);
      g._hit.setAttribute('d', d);
    }
    g._vis.style.strokeWidth = String(s.width || 3);
    const c = canvasColor(s.color);
    if (c) g._vis.style.stroke = c; else g._vis.style.removeProperty('stroke');
  }

  applyView() {
    const v = this.view || { x: 0, y: 0, zoom: 1 };
    this.world.style.transform = 'translate(' + v.x + 'px, ' + v.y + 'px) scale(' + v.zoom + ')';
    let g = 24 * v.zoom;
    while (g < 10) g *= 2;
    this.el.style.backgroundSize = g + 'px ' + g + 'px';
    this.el.style.backgroundPosition = v.x + 'px ' + v.y + 'px';
    if (this.opts.onView) this.opts.onView(v);
    this.placeActions();
  }

  paintSelection() {
    for (const [id, e] of this.els) e.classList.toggle('is-selected', this.sel.has(id));
    for (const [id, g] of this.strokeEls) g.classList.toggle('is-selected', this.sel.has(id));
    this.el.classList.toggle('one-selected', this.sel.size === 1);
    this.placeActions();
  }

  selChanged() {
    this.paintSelection();
    if (this.opts.onSelect) this.opts.onSelect(this);
  }

  placeActions() {
    if (!this.actions) return;
    const nodes = this.selectedImageNodes();
    const n = nodes.length === 1 && this.sel.size === 1 && !this.gesture ? nodes[0] : null;
    this.actions.classList.toggle('is-visible', !!n);
    if (!n) return;
    const v = this.view || { x: 0, y: 0, zoom: 1 };
    this.actions.style.left = Math.round(n.x * v.zoom + v.x) + 'px';
    this.actions.style.top = Math.round((n.y + n.height) * v.zoom + v.y + 10) + 'px';
  }

  setTool(t) {
    this.tool = t;
    this.el.dataset.tool = t;
    this.paintTools();
  }

  paintTools() {
    if (!this.toolBtns) return;
    for (const id of Object.keys(this.toolBtns)) {
      this.toolBtns[id].classList.toggle('is-active', id === this.tool);
      this.toolBtns[id].setAttribute('aria-pressed', String(id === this.tool));
    }
  }

  // -- queries --------------------------------------------------------------

  node(id) { return this.data ? this.data.nodes.find((n) => n.id === id) : null; }
  stroke(id) { return this.data ? this.data.markport.strokes.find((s) => s.id === id) : null; }

  isImageNode(n) {
    return !!n && n.type === 'file' && isImageFile(this.app.vault.getAbstractFileByPath(n.file));
  }

  imageNodes() { return this.data ? this.data.nodes.filter((n) => this.isImageNode(n)) : []; }

  selectedImageNodes() {
    return this.data ? this.data.nodes.filter((n) => this.sel.has(n.id) && this.isImageNode(n)) : [];
  }

  selectedImageFiles() {
    const seen = new Set();
    const out = [];
    for (const n of this.selectedImageNodes()) {
      if (seen.has(n.file)) continue;
      seen.add(n.file);
      out.push(this.app.vault.getAbstractFileByPath(n.file));
    }
    return out;
  }

  clearSelection() {
    if (!this.sel.size) return;
    this.sel.clear();
    this.paintSelection();
  }

  selectNode(n) {
    if (!n) return;
    this.sel = new Set([n.id]);
    this.selChanged();
  }

  fullFor(n) {
    if (!this.opts.onFull) return;
    const nodes = this.imageNodes();
    const i = nodes.indexOf(n);
    if (i < 0) return;
    this.opts.onFull(nodes.map((x) => this.app.vault.getAbstractFileByPath(x.file)), i, (j) => this.selectNode(nodes[j]));
  }

  fullForSelection() {
    const nodes = this.selectedImageNodes();
    if (nodes.length) this.fullFor(nodes[0]);
  }

  // -- coordinates ----------------------------------------------------------

  toWorld(cx, cy) {
    const r = this.el.getBoundingClientRect();
    const v = this.view || { x: 0, y: 0, zoom: 1 };
    return { x: (cx - r.left - v.x) / v.zoom, y: (cy - r.top - v.y) / v.zoom };
  }

  zoomAt(cx, cy, z) {
    const r = this.el.getBoundingClientRect();
    const v = this.view || { x: 0, y: 0, zoom: 1 };
    const zoom = clampZoom(z);
    this.autoFit = false;
    const wx = (cx - r.left - v.x) / v.zoom;
    const wy = (cy - r.top - v.y) / v.zoom;
    this.view = { zoom, x: cx - r.left - wx * zoom, y: cy - r.top - wy * zoom };
    this.applyView();
    this.viewChangedSoon();
  }

  zoomBy(f) {
    const r = this.el.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, ((this.view && this.view.zoom) || 1) * f);
  }

  fit(quiet) {
    const data = this.data;
    if (!data) return;
    this.view = fitView(boxAround(data.nodes, data.markport.strokes), this.el.clientWidth, this.el.clientHeight, 48);
    this.needFit = false;
    this.autoFit = true;
    if (!quiet) this.applyView();
    this.viewChanged();
  }

  viewChanged() {
    if (this.store && this.view && this.opts.saveView) {
      const v = this.view;
      this.opts.saveView(this.store.path, { x: Math.round(v.x), y: Math.round(v.y), zoom: Math.round(v.zoom * 1000) / 1000 });
    }
  }

  viewChangedSoon() {
    clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => this.viewChanged(), 300);
  }

  // -- pointer --------------------------------------------------------------

  onDown(e) {
    if (e.target.closest('.mpl-tools, .mpl-sel-actions, .mpl-edit')) return;
    this.el.focus({ preventScroll: true });
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.el.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
    if (!this.data || !this.view) return;

    if (this.pointers.size === 2) {
      // A second finger: whatever the first one started becomes a pinch.
      if (this.gesture && this.gesture.path) this.gesture.path.remove();
      const [a, b] = [...this.pointers.values()];
      this.gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: Object.assign({}, this.view) };
      this.marquee.style.display = 'none';
      return;
    }
    if (this.pointers.size > 2) return;

    const start = { pointerId: e.pointerId, cx: e.clientX, cy: e.clientY, p: this.toWorld(e.clientX, e.clientY), moved: false };
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      e.preventDefault();
      this.gesture = Object.assign(start, { kind: 'pan', v0: Object.assign({}, this.view) });
      return;
    }
    if (e.button !== 0) return;

    if (this.tool === 'draw') {
      const path = svgEl('path', this.svg, { class: 'mpl-stroke-line is-live' });
      this.gesture = Object.assign(start, { kind: 'draw', points: [start.p.x, start.p.y], path });
      return;
    }
    if (this.tool === 'note') {
      this.addNote(start.p);
      this.setTool('select');
      return;
    }
    if (this.tool === 'group') {
      this.gesture = Object.assign(start, { kind: 'group' });
      return;
    }

    const nodeEl = e.target.closest('.mpl-bn');
    const strokeEl = e.target.closest('.mpl-stroke');
    const id = nodeEl ? nodeEl.dataset.id : strokeEl ? strokeEl.dataset.id : null;
    if (nodeEl && e.target.closest('.mpl-bn-handle')) {
      const n = this.node(id);
      if (n) {
        this.gesture = Object.assign(start, { kind: 'resize', n, w0: n.width, h0: n.height, keep: n.type === 'file' && this.isImageNode(n) });
        return;
      }
    }
    if (id) {
      const add = e.shiftKey || e.ctrlKey || e.metaKey;
      const wasSel = this.sel.has(id);
      if (!wasSel) {
        if (add) this.sel.add(id); else this.sel = new Set([id]);
        this.selChanged();
      }
      this.gesture = Object.assign(start, { kind: 'move', id, wasSel, add, items: this.moveSet() });
      return;
    }
    if (e.shiftKey) {
      this.gesture = Object.assign(start, { kind: 'marquee', base: new Set(this.sel) });
      return;
    }
    this.gesture = Object.assign(start, { kind: 'pan', v0: Object.assign({}, this.view), clear: true });
  }

  // What a drag moves: the selection, plus whatever lies inside selected groups.
  moveSet() {
    const data = this.data;
    const nodes = new Set();
    const strokes = new Set();
    for (const id of this.sel) {
      const n = this.node(id);
      if (n) {
        nodes.add(n);
        if (n.type === 'group') {
          for (const m of data.nodes) if (m !== n && inside(m, n)) nodes.add(m);
          for (const s of data.markport.strokes) if (inside(strokeBox(s), n)) strokes.add(s);
        }
      } else {
        const s = this.stroke(id);
        if (s) strokes.add(s);
      }
    }
    return [...nodes].map((n) => ({ n, x0: n.x, y0: n.y })).concat([...strokes].map((s) => ({ s, p0: s.points.slice() })));
  }

  onMove(e) {
    const pt = this.pointers.get(e.pointerId);
    if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      const [a, b] = [...this.pointers.values()];
      if (!a || !b) return;
      const r = this.el.getBoundingClientRect();
      const zoom = clampZoom(g.v0.zoom * Math.hypot(a.x - b.x, a.y - b.y) / g.d0);
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const wx = (g.c0.x - r.left - g.v0.x) / g.v0.zoom;
      const wy = (g.c0.y - r.top - g.v0.y) / g.v0.zoom;
      this.view = { zoom, x: c.x - r.left - wx * zoom, y: c.y - r.top - wy * zoom };
      this.autoFit = false;
      this.applyView();
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    const dx = e.clientX - g.cx;
    const dy = e.clientY - g.cy;
    if (g.kind === 'draw') {
      const p = this.toWorld(e.clientX, e.clientY);
      g.points.push(p.x, p.y);
      g.path.setAttribute('d', strokePath(g.points));
      g.moved = true;
      return;
    }
    if (!g.moved && Math.hypot(dx, dy) < 3) return;
    if (!g.moved) { g.moved = true; this.placeActions(); }
    const z = this.view.zoom;
    if (g.kind === 'pan') {
      this.autoFit = false;
      this.view = { zoom: g.v0.zoom, x: g.v0.x + dx, y: g.v0.y + dy };
      this.applyView();
    } else if (g.kind === 'move') {
      for (const it of g.items) {
        if (it.n) {
          it.n.x = Math.round(it.x0 + dx / z);
          it.n.y = Math.round(it.y0 + dy / z);
          this.paintNode(this.els.get(it.n.id), it.n);
        } else {
          it.s.points = it.p0.map((v, i) => Math.round((v + (i % 2 ? dy : dx) / z) * 10) / 10);
          const sg = this.strokeEls.get(it.s.id);
          if (sg) this.paintStroke(sg, it.s);
        }
      }
    } else if (g.kind === 'resize') {
      const w = Math.max(40, g.w0 + dx / z);
      const hh = g.keep ? w * g.h0 / g.w0 : Math.max(30, g.h0 + dy / z);
      g.n.width = Math.round(w);
      g.n.height = Math.round(hh);
      this.paintNode(this.els.get(g.n.id), g.n);
    } else if (g.kind === 'group' || g.kind === 'marquee') {
      const r = this.el.getBoundingClientRect();
      const m = this.marquee.style;
      m.display = 'block';
      m.left = (Math.min(g.cx, e.clientX) - r.left) + 'px';
      m.top = (Math.min(g.cy, e.clientY) - r.top) + 'px';
      m.width = Math.abs(dx) + 'px';
      m.height = Math.abs(dy) + 'px';
      if (g.kind === 'marquee') {
        const q = this.toWorld(e.clientX, e.clientY);
        const box = { x: Math.min(g.p.x, q.x), y: Math.min(g.p.y, q.y), width: Math.abs(q.x - g.p.x), height: Math.abs(q.y - g.p.y) };
        this.sel = new Set(g.base);
        for (const n of this.data.nodes) if (n.type === 'group' ? inside(n, box) : overlaps(n, box)) this.sel.add(n.id);
        for (const s of this.data.markport.strokes) if (overlaps(strokeBox(s), box)) this.sel.add(s.id);
        this.paintSelection();
      }
    }
  }

  onUp(e, cancelled) {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (this.pointers.size < 2) { this.gesture = null; this.viewChanged(); }
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    this.gesture = null;
    this.marquee.style.display = 'none';
    if (g.kind === 'pan') {
      if (g.moved) this.viewChanged();
      else if (g.clear && this.sel.size) { this.sel.clear(); this.selChanged(); }
    } else if (g.kind === 'move') {
      if (g.moved) this.commit();
      else if (g.add && g.wasSel) { this.sel.delete(g.id); this.selChanged(); }
      else if (!g.add && g.wasSel && this.sel.size > 1) { this.sel = new Set([g.id]); this.selChanged(); }
    } else if (g.kind === 'resize') {
      if (g.moved) this.commit();
    } else if (g.kind === 'draw') {
      g.path.remove();
      if (!cancelled && g.points.length >= 4) {
        const pts = simplifyPoints(g.points, 1.5 / this.view.zoom);
        this.data.markport.strokes.push({ id: newNodeId(), points: pts, width: 3 });
        this.commit();
      }
    } else if (g.kind === 'group') {
      const q = this.toWorld(e.clientX, e.clientY);
      const box = { x: Math.min(g.p.x, q.x), y: Math.min(g.p.y, q.y), width: Math.abs(q.x - g.p.x), height: Math.abs(q.y - g.p.y) };
      if (!cancelled && g.moved && box.width > 20 && box.height > 20) this.addGroup(box);
      this.setTool('select');
    } else if (g.kind === 'marquee') {
      this.selChanged();
    }
    this.placeActions();
  }

  onWheel(e) {
    if (!this.view) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(e.clientX, e.clientY, this.view.zoom * Math.exp(-e.deltaY * unit * 0.0025));
    } else {
      const sx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const sy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      this.autoFit = false;
      this.view = { zoom: this.view.zoom, x: this.view.x - sx * unit, y: this.view.y - sy * unit };
      this.applyView();
      this.viewChangedSoon();
    }
  }

  onDbl(e) {
    if (!this.data || !this.view || e.target.closest('.mpl-tools, .mpl-sel-actions, .mpl-edit')) return;
    const nodeEl = e.target.closest('.mpl-bn');
    const n = nodeEl && this.node(nodeEl.dataset.id);
    if (n) {
      if (n.type === 'text') this.editText(n);
      else if (n.type === 'group') this.renameGroup(n);
      else if (this.isImageNode(n)) this.fullFor(n);
      else if (n.type === 'file') {
        const f = this.app.vault.getAbstractFileByPath(n.file);
        if (f instanceof obsidian.TFile) this.app.workspace.getLeaf('tab').openFile(f);
      } else if (n.type === 'link' && n.url) window.open(n.url, '_blank', 'noopener');
      return;
    }
    if (this.tool === 'select' && !e.target.closest('.mpl-stroke')) this.addNote(this.toWorld(e.clientX, e.clientY));
  }

  onKey(e) {
    if (e.target !== this.el || !this.data) return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === ' ') { this.spaceDown = true; stop(); return; }
    if ((k === 'Delete' || k === 'Backspace') && this.sel.size) { this.deleteSelected(); stop(); return; }
    if (k === 'Escape') {
      if (this.tool !== 'select') { this.setTool('select'); stop(); } else if (this.sel.size) { this.sel.clear(); this.selChanged(); stop(); }
      return;
    }
    if (mod && k.toLowerCase() === 'a') {
      this.sel = new Set(this.data.nodes.map((n) => n.id).concat(this.data.markport.strokes.map((s) => s.id)));
      this.selChanged();
      stop();
      return;
    }
    if (e.shiftKey && e.code === 'Digit1') { this.fit(); stop(); return; }
    if (mod || e.altKey) return;
    if (k === 'f' || k === 'F') { if (this.selectedImageNodes().length) { this.fullForSelection(); stop(); } return; }
    if (k === 'i' || k === 'I') { if (this.selectedImageNodes().length && this.opts.onDetails) { this.opts.onDetails(); stop(); } return; }
    if (k === '+' || k === '=') { this.zoomBy(1.25); stop(); return; }
    if (k === '-') { this.zoomBy(0.8); stop(); return; }
    if (this.opts.mini) return;
    const tool = { v: 'select', d: 'draw', p: 'draw', n: 'note', g: 'group' }[k.toLowerCase()];
    if (tool) {
      if (tool === 'group' && this.sel.size) this.groupSelection(); else this.setTool(tool);
      stop();
    }
  }

  onMenu(e) {
    if (!this.data || this.el.ownerDocument !== document || e.target.closest('.mpl-edit')) return;
    e.preventDefault();
    const nodeEl = e.target.closest('.mpl-bn');
    const strokeEl = e.target.closest('.mpl-stroke');
    const id = nodeEl ? nodeEl.dataset.id : strokeEl ? strokeEl.dataset.id : null;
    const menu = new obsidian.Menu();
    if (!id) {
      const p = this.toWorld(e.clientX, e.clientY);
      menu.addItem((i) => i.setTitle('Add note here').setIcon('sticky-note').onClick(() => this.addNote(p)));
      menu.addItem((i) => i.setTitle('Zoom to fit').setIcon('maximize').onClick(() => this.fit()));
      menu.showAtMouseEvent(e);
      return;
    }
    if (!this.sel.has(id)) { this.sel = new Set([id]); this.selChanged(); }
    const n = this.node(id);
    if (n && this.isImageNode(n)) {
      menu.addItem((i) => i.setTitle('Full screen').setIcon('maximize-2').onClick(() => this.fullFor(n)));
      if (this.opts.onDetails) menu.addItem((i) => i.setTitle('Details').setIcon('info').onClick(() => this.opts.onDetails()));
      menu.addItem((i) => i.setTitle('Open image').setIcon('image').onClick(() => {
        this.app.workspace.getLeaf('tab').openFile(this.app.vault.getAbstractFileByPath(n.file));
      }));
      menu.addSeparator();
    }
    if (n && n.type === 'text') menu.addItem((i) => i.setTitle('Edit note').setIcon('pencil').onClick(() => this.editText(n)));
    if (n && n.type === 'group') menu.addItem((i) => i.setTitle('Rename group').setIcon('pencil').onClick(() => this.renameGroup(n)));
    if (n && n.type !== 'group') {
      menu.addItem((i) => i.setTitle('Bring to front').setIcon('arrow-up').onClick(() => this.restack(true)));
      menu.addItem((i) => i.setTitle('Send to back').setIcon('arrow-down').onClick(() => this.restack(false)));
    }
    if (this.sel.size > 1 || (n && n.type !== 'group')) {
      menu.addItem((i) => i.setTitle('Group').setIcon('group').onClick(() => this.groupSelection()));
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(this.sel.size > 1 ? 'Remove ' + this.sel.size + ' from board' : 'Remove from board')
      .setIcon('trash-2').onClick(() => this.deleteSelected()));
    menu.showAtMouseEvent(e);
  }

  // -- edits ----------------------------------------------------------------

  commit() {
    if (this.store) this.store.change();
  }

  restack(front) {
    const data = this.data;
    const moving = data.nodes.filter((n) => this.sel.has(n.id) && n.type !== 'group');
    const rest = data.nodes.filter((n) => !moving.includes(n));
    data.nodes = front ? rest.concat(moving) : moving.concat(rest);
    this.commit();
  }

  deleteSelected() {
    const data = this.data;
    data.nodes = data.nodes.filter((n) => !this.sel.has(n.id));
    data.markport.strokes = data.markport.strokes.filter((s) => !this.sel.has(s.id));
    const ids = new Set(data.nodes.map((n) => n.id));
    data.edges = data.edges.filter((ed) => !ed || ((!ed.fromNode || ids.has(ed.fromNode)) && (!ed.toNode || ids.has(ed.toNode))));
    this.sel.clear();
    this.commit();
    this.selChanged();
  }

  addNote(p) {
    const n = { id: newNodeId(), type: 'text', text: '', x: Math.round(p.x - NOTE_W / 2), y: Math.round(p.y - 24), width: NOTE_W, height: NOTE_H };
    this.data.nodes.push(n);
    this.commit();
    this.sel = new Set([n.id]);
    this.selChanged();
    this.editText(n, true);
  }

  addGroup(box, select) {
    const g = { id: newNodeId(), type: 'group', label: '', x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    this.data.nodes.unshift(g);
    this.commit();
    this.sel = new Set([g.id]);
    this.selChanged();
    this.renameGroup(g);
    return g;
  }

  groupSelection() {
    const nodes = this.data.nodes.filter((n) => this.sel.has(n.id));
    const strokes = this.data.markport.strokes.filter((s) => this.sel.has(s.id));
    const box = boxAround(nodes, strokes);
    if (!box) { this.setTool('group'); return; }
    this.addGroup({ x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 });
  }

  editText(n, isNew) {
    const e = this.els.get(n.id);
    if (!e || this.editing === n.id) return;
    this.editing = n.id;
    const ta = h('textarea', 'mpl-edit mpl-edit-note', e);
    ta.value = n.text || '';
    ta.spellcheck = true;
    ta.setAttribute('aria-label', 'Note text');
    e._body.style.visibility = 'hidden';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.editing = null;
      const v = ta.value;
      ta.remove();
      e._body.style.visibility = '';
      if (!v.trim() && (isNew || !n.text)) {
        this.data.nodes = this.data.nodes.filter((x) => x !== n);
        this.sel.delete(n.id);
        this.commit();
        this.selChanged();
      } else if (v !== n.text) {
        n.text = v;
        this.commit();
      } else {
        e._text = undefined;
        this.paintNode(e, n);
      }
      this.el.focus({ preventScroll: true });
    };
    ta.addEventListener('blur', finish);
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); ta.blur(); }
    });
    ta.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    ta.addEventListener('dblclick', (ev) => ev.stopPropagation());
    setTimeout(() => ta.focus(), 0);
  }

  renameGroup(g) {
    const e = this.els.get(g.id);
    if (!e || e.querySelector('.mpl-edit')) return;
    const input = h('input', 'mpl-edit mpl-edit-label', e);
    input.type = 'text';
    input.value = g.label || '';
    input.placeholder = 'Group name';
    input.setAttribute('aria-label', 'Group name');
    e._label.style.visibility = 'hidden';
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      input.remove();
      e._label.style.visibility = '';
      if (keep && v !== (g.label || '')) { g.label = v; this.commit(); }
      this.el.focus({ preventScroll: true });
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  // -- drag and drop --------------------------------------------------------

  onDragOver(e) {
    if (!this.data || !this.view) return;
    const types = [...((e.dataTransfer && e.dataTransfer.types) || [])];
    if (!types.includes('application/x-markport-images') && !(types.includes('Files') && this.opts.importFiles)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    this.el.classList.add('is-drop');
  }

  async onDrop(e) {
    this.el.classList.remove('is-drop');
    if (!this.data || !this.view) return;
    const raw = e.dataTransfer.getData('application/x-markport-images');
    const files = [...(e.dataTransfer.files || [])];
    if (!raw && !(files.length && this.opts.importFiles)) return;
    e.preventDefault();
    e.stopPropagation();
    const p = this.toWorld(e.clientX, e.clientY);
    let paths = [];
    if (raw) {
      try { paths = JSON.parse(raw); } catch (_) { /* ignore */ }
    } else {
      paths = await this.opts.importFiles(files);
    }
    this.place(paths, p);
    this.el.focus({ preventScroll: true });
  }

  // Put images on the board in a row starting at p (world coordinates).
  place(paths, p) {
    if (!this.data || !Array.isArray(paths)) return;
    const added = [];
    let x = p.x - IMG_W / 2;
    for (const path of paths) {
      if (!isImageFile(this.app.vault.getAbstractFileByPath(path))) continue;
      const d = this.plugin.dims(path);
      const hh = Math.round(d ? IMG_W * d[1] / d[0] : IMG_W * 3 / 4);
      const n = { id: newNodeId(), type: 'file', file: path, x: Math.round(x), y: Math.round(p.y - hh / 2), width: IMG_W, height: hh };
      if (!d) this.pendingAspect.add(n.id);
      this.data.nodes.push(n);
      added.push(n.id);
      x += IMG_W + 16;
    }
    if (!added.length) return;
    this.commit();
    this.sel = new Set(added);
    this.selChanged();
  }
}

// ── The pinned mini window ──────────────────────────────────────────────────
//
// One board, small, with a strip of library images to drag onto it. Shown in
// a Document Picture-in-Picture window (Chrome/Edge: floats over every app),
// in an Obsidian popout window (desktop Obsidian), or as a floating panel in
// the library view.

class MiniBoard {
  constructor(host, plugin, path, opts) {
    this.plugin = plugin;
    this.opts = opts || {};
    this.store = plugin.board(path);
    this.root = h('div', 'mpl mpl-mini', host);
    this.root.dataset.accent = plugin.settings.libraryUi.accent || 'amber';
    solidColors(this.root);

    this.bar = h('div', 'mpl-mini-bar', this.root);
    this.titleEl = h('span', 'mpl-mini-title', this.bar);
    h('span', 'mpl-badge-pin', this.bar, this.opts.mode === 'pip' ? 'PINNED · OVER APPS' : 'PINNED');
    h('span', 'mpl-spacer', this.bar);
    dbutton(this.bar, 'pin', 'Unpin', () => this.opts.onUnpin && this.opts.onUnpin());
    dbutton(this.bar, 'openWin', 'Open in the library', () => this.opts.onOpenMain && this.opts.onOpenMain());

    const boardHost = h('div', 'mpl-mini-board', this.root);
    this.board = new BoardCanvas(boardHost, plugin, {
      mini: true,
      importFiles: (files) => plugin.importFiles(files, plugin.settings.targetFolder),
    });
    this.board.setStore(this.store);

    const lib = h('div', 'mpl-mini-lib', this.root);
    const row = h('div', 'mpl-mini-row', lib);
    const label = h('label', 'mpl-lbl', row, 'Library');
    this.searchEl = h('input', 'mpl-field mpl-mono', row);
    this.searchEl.type = 'search';
    this.searchEl.placeholder = '#tag  color:teal  words…';
    this.searchEl.setAttribute('aria-label', 'Search the library');
    this.searchEl.spellcheck = false;
    label.addEventListener('click', () => this.searchEl.focus());
    this.searchEl.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.renderStrip(), 120);
    });
    this.stripEl = h('div', 'mpl-mini-strip', lib);
    this.statusEl = h('div', 'mpl-mini-status', lib);

    this.unsub = this.store.on(() => this.paintTitle());
    this.paintTitle();
    this.renderStrip();
  }

  paintTitle() { this.titleEl.textContent = this.store.name; }

  renderStrip() {
    const files = this.plugin.searchImages(this.searchEl.value);
    this.stripEl.replaceChildren();
    for (const f of files.slice(0, 80)) {
      const t = h('div', 'mpl-mini-thumb', this.stripEl);
      t.draggable = true;
      t.title = f.basename;
      const d = this.plugin.dims(f.path);
      if (d) t.style.aspectRatio = String(clampAspect(d[0] / d[1]));
      const img = h('img', null, t);
      img.loading = 'lazy';
      img.draggable = false;
      img.alt = f.basename;
      img.src = this.plugin.app.vault.getResourcePath(f);
      t.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-markport-images', JSON.stringify([f.path]));
        e.dataTransfer.setData('text/plain', '!' + this.plugin.app.fileManager.generateMarkdownLink(f, ''));
        e.dataTransfer.effectAllowed = 'copy';
      });
      t.addEventListener('dblclick', () => {
        const el = this.board.el;
        const r = el.getBoundingClientRect();
        this.board.place([f.path], this.board.toWorld(r.left + r.width / 2, r.top + r.height / 2));
      });
    }
    this.statusEl.textContent = 'Drag up to add · ' + files.length + (files.length === 1 ? ' match' : ' matches');
  }

  destroy() {
    clearTimeout(this.searchTimer);
    if (this.unsub) this.unsub();
    this.board.destroy();
    this.root.remove();
  }
}

const PIN_VIEW = 'markport-image-board-pin';

class PinnedBoardView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.path = '';
    this.mini = null;
  }
  getViewType() { return PIN_VIEW; }
  getDisplayText() { return this.path ? 'Pinned: ' + boardName(this.path) : 'Pinned board'; }
  getIcon() { return 'pin'; }
  getState() { return { board: this.path }; }
  async setState(state, result) {
    if (state && typeof state.board === 'string' && state.board !== this.path) {
      this.path = state.board;
      this.mount();
    }
    return super.setState(state, result);
  }
  async onOpen() {
    this.contentEl.addClass('mpl-pin-view');
    this.mount();
  }
  mount() {
    if (this.mini) this.mini.destroy();
    this.mini = null;
    this.contentEl.empty();
    if (!this.path) return;
    this.mini = new MiniBoard(this.contentEl, this.plugin, this.path, {
      mode: 'popout',
      onUnpin: () => this.leaf.detach(),
      onOpenMain: () => { this.plugin.openLibrary(this.path); this.leaf.detach(); },
    });
  }
  async onClose() {
    if (this.mini) this.mini.destroy();
    this.mini = null;
  }
}

// ── Image library view ──────────────────────────────────────────────────────
//
// One window for collecting and composing references. Below a top bar
// (board tabs, search), left to right:
//
//   sidebar   Library / Folders / Smart folders / Tags, with counts. Collapses
//             into a 52 px rail of colored initial chips.
//   grid      masonry of the images in the current folder or search. Click /
//             Ctrl / Shift to select; F full screen, I details, Enter opens,
//             drag onto the board to place, onto a folder to move, into a
//             note to embed; drop files from the computer to import.
//   board     the active board (a .canvas file): place, group and annotate.
//
// The grid and the board each have Fill window and Minimize; minimizing one
// while the other is minimized reopens the other, so the window is never
// empty. Details is a floating panel over the layout (I, or the Details
// button), and full screen is an overlay that steps through the same list.
//
// Tags, notes, colors and clip sources are kept in this plugin's data.json,
// keyed by path, and follow the file when it is renamed or moved.

const LIBRARY_VIEW = 'markport-image-library';
const PAGE = 240;            // thumbnails added per scroll step
const GAP = 8;               // px between cards (matches styles.css)
const SORTS = [
  ['added', 'Date added'],
  ['modified', 'Date modified'],
  ['name', 'Name'],
  ['size', 'File size'],
];
const THUMBS = [['Small', 110], ['Medium', 160], ['Large', 230], ['Extra large', 320]];
const DAY = 24 * 3600 * 1000;
const NARROW = 760;          // px: below this, one main panel at a time
// Muted chip colors for folders without a known image color, tags, smart folders.
const CHIP_COLORS = ['#3E6F72', '#8E4F3E', '#A8876A', '#4B4E7D', '#C98A3E', '#7A8C6E', '#5C3F4F', '#47525E', '#34505A', '#9C6B48'];

function isImageFile(f) {
  return f instanceof obsidian.TFile && IMAGE_EXTS.has(String(f.extension || '').toLowerCase());
}

function isCanvasFile(f) {
  return f instanceof obsidian.TFile && String(f.extension || '').toLowerCase() === 'canvas';
}

function parentPath(f) {
  return f.parent && !(f.parent.isRoot && f.parent.isRoot()) ? f.parent.path : '';
}

function clampAspect(a) { return Math.min(3, Math.max(0.35, a)); }

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function sameFilter(a, b) { return a.kind === b.kind && (a.value || '') === (b.value || ''); }

function hashColor(s) {
  let x = 0;
  for (const ch of String(s)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return CHIP_COLORS[x % CHIP_COLORS.length];
}

// Dark text on light chips, light text on dark ones.
function chipText(hex) {
  const rgb = hexToRgb(hex);
  return rgb && rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150 ? '#1A1B1F' : '#F2F0EA';
}

class ImageLibraryView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.filter = { kind: 'all' };   // all | recent | untagged | folder | tag | smart (value)
    this.query = '';
    this.selected = new Set();       // paths selected in the grid
    this.anchor = null;              // TFile, for Shift-click ranges
    this.items = [];                 // the filtered, sorted TFiles
    this.limit = PAGE;
    this.cards = new Map();          // TFile -> { el, path, mtime, thumb }
    this.aspects = new Map();        // path -> width / height
    this.dims = new Map();           // path -> [w, h]
    this.collapsed = new Set();      // folder paths folded in the sidebar
    this.colCount = 0;
    this.built = false;
    this.focusIn = 'grid';           // where the selection lives: grid | board
    this.detailsOpen = false;
    this.full = null;                // { list, i, label, onStep }
    this.onBoard = new Set();        // image paths on the active board
    this.store = null;
    this.narrow = false;
    this.eff = { sideMin: false, gridMin: false, boardMin: false };
  }

  getViewType() { return LIBRARY_VIEW; }
  getDisplayText() { return 'Image library'; }
  getIcon() { return 'images'; }

  getState() { return { filter: this.filter }; }
  async setState(state, result) {
    if (state && state.filter && state.filter.kind) this.filter = state.filter;
    if (this.built) this.refresh();
    return super.setState(state, result);
  }

  ui() { return this.plugin.settings.libraryUi; }
  meta(path) { return this.plugin.settings.library[path] || null; }

  // -- building -------------------------------------------------------------

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('mpl-view');
    this.rootEl = root.createDiv({ cls: 'mpl', attr: { tabindex: '0' } });
    this.rootEl.dataset.accent = this.ui().accent || 'amber';
    solidColors(this.rootEl);
    this.registerEvent(this.app.workspace.on('css-change', () => {
      solidColors(this.rootEl);
      if (this.floatMini) solidColors(this.floatMini.root);
    }));
    this.buildTop(this.rootEl.createDiv({ cls: 'mpl-top' }));
    this.bodyEl = this.rootEl.createDiv({ cls: 'mpl-body' });
    // Containers get no aria-label: Obsidian shows aria-labels as hover tooltips.
    this.sideEl = this.bodyEl.createEl('aside', { cls: 'mpl-side' });
    this.railEl = this.bodyEl.createEl('aside', { cls: 'mpl-rail' });
    this.buildGridPanel();
    this.buildBoardPanel();
    this.detailsEl = this.bodyEl.createEl('aside', { cls: 'mpl-details' });
    this.fullEl = this.rootEl.createDiv({ cls: 'mpl-full', attr: { role: 'dialog', tabindex: '-1' } });
    this.fullEl.addEventListener('keydown', (e) => this.onFullKey(e));

    this.registerDomEvent(this.rootEl, 'keydown', (e) => this.onKey(e));

    const vault = this.app.vault;
    for (const ev of ['create', 'delete', 'modify']) {
      this.registerEvent(vault.on(ev, (f) => {
        if (isImageFile(f) || f instanceof obsidian.TFolder) this.scheduleRefresh(ev === 'modify' ? f : null);
      }));
    }
    this.registerEvent(vault.on('rename', (f, oldPath) => {
      if (this.selected.delete(oldPath)) this.selected.add(f.path);
      const fv = this.filter.kind === 'folder' ? this.filter.value : null;
      if (fv && (fv === oldPath || fv.startsWith(oldPath + '/'))) this.filter = { kind: 'folder', value: f.path + fv.slice(oldPath.length) };
      if (isImageFile(f) || f instanceof obsidian.TFolder) this.scheduleRefresh();
    }));

    this.resizeObs = new ResizeObserver(() => {
      const narrow = this.rootEl.clientWidth > 0 && this.rootEl.clientWidth < NARROW;
      if (narrow !== this.narrow) { this.narrow = narrow; this.applyPanels(); return; }
      const width = this.gridEl.clientWidth;
      if (width && this.columnsFor(width) !== this.colCount) this.layout();
    });
    this.resizeObs.observe(this.rootEl);
    this.resizeObs.observe(this.scrollEl);
    this.moreObs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && this.items.length > this.limit) {
        this.limit += PAGE;
        this.layout();
      }
    }, { root: this.scrollEl, rootMargin: '800px' });
    this.moreObs.observe(this.sentinel);

    this.built = true;
    this.plugin.libraryViews.add(this);
    this.applyPanels();
    this.renderTabs();
    this.mountBoard();
    this.app.workspace.onLayoutReady(() => this.refresh());
  }

  async onClose() {
    this.plugin.libraryViews.delete(this);
    if (this.resizeObs) this.resizeObs.disconnect();
    if (this.moreObs) this.moreObs.disconnect();
    if (this.storeUnsub) this.storeUnsub();
    if (this.board) this.board.destroy();
    if (this.floatMini) this.floatMini.destroy();
    clearTimeout(this.refreshTimer);
    clearTimeout(this.layoutTimer);
  }

  iconButton(parent, icon, label, onClick) {
    const b = parent.createEl('button', { cls: 'mpl-ib', attr: { 'aria-label': label, type: 'button' } });
    obsidian.setIcon(b, icon);
    b.addEventListener('click', onClick);
    return b;
  }

  buildTop(bar) {
    const logo = bar.createDiv({ cls: 'mpl-logo' });
    dicon(logo, 'logo', 20);
    logo.createSpan({ text: 'Library' });

    this.tabsEl = bar.createEl('nav', { cls: 'mpl-tabs' });

    const wrap = bar.createDiv({ cls: 'mpl-search-wrap' });
    this.searchEl = wrap.createEl('input', {
      cls: 'mpl-field mpl-search',
      attr: { type: 'search', placeholder: 'Search names, tags, colors…  #tag  color:teal', 'aria-label': 'Search library', spellcheck: 'false' },
    });
    this.saveSearchBtn = this.iconButton(wrap, 'bookmark-plus', 'Save this search as a smart folder', () => this.saveSmart());
    this.saveSearchBtn.addClass('mpl-save-search');
    this.searchEl.addEventListener('input', () => {
      this.query = this.searchEl.value;
      this.limit = PAGE;
      this.saveSearchBtn.toggleClass('is-visible', !!this.query.trim());
      this.update();
    });
  }

  buildGridPanel() {
    const p = this.gridPanel = this.bodyEl.createEl('section', { cls: 'mpl-panel mpl-grid-panel' });
    const head = p.createDiv({ cls: 'mpl-phead' });
    this.headingEl = head.createSpan({ cls: 'mpl-ptitle' });
    this.totalEl = head.createSpan({ cls: 'mpl-pcount' });
    head.createSpan({ cls: 'mpl-spacer' });
    this.iconButton(head, 'image-plus', 'Import images…', () => this.fileInput.click());
    this.iconButton(head, 'arrow-up-down', 'Sort and thumbnail size', (e) => this.viewMenu(e));
    this.gridMaxBtn = dbutton(head, 'fill', 'Fill window', () => this.maxPanel('grid'));
    dbutton(head, 'left', 'Minimize', () => this.togglePanel('grid'));

    const main = p.createDiv({ cls: 'mpl-grid-main' });
    this.scrollEl = main.createDiv({ cls: 'mpl-scroll' });
    this.gridEl = this.scrollEl.createDiv({ cls: 'mpl-grid' });
    this.emptyEl = this.scrollEl.createDiv({ cls: 'mpl-empty' });
    this.sentinel = this.scrollEl.createDiv({ cls: 'mpl-sentinel' });
    this.dropEl = main.createDiv({ cls: 'mpl-drop' });
    this.fileInput = main.createEl('input', { attr: { type: 'file', multiple: '', accept: 'image/*' } });
    this.fileInput.style.display = 'none';
    this.fileInput.addEventListener('change', () => {
      const files = [...this.fileInput.files];
      this.fileInput.value = '';
      this.importFiles(files, this.importFolder());
    });
    // Click on empty space clears the selection.
    this.scrollEl.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.mpl-card')) return;
      if (this.selected.size) {
        this.selected.clear();
        this.anchor = null;
        this.paintSelection();
        this.selectionChanged();
      }
    });
    this.wireImportDrop(main);

    this.splitEl = p.createDiv({ cls: 'mpl-split', attr: { 'aria-hidden': 'true' } });
    this.wireSplit();

    this.gridStrip = this.bodyEl.createDiv({ cls: 'mpl-strip mpl-grid-strip' });
    dbutton(this.gridStrip, 'right', 'Restore images', () => this.togglePanel('grid'));
    this.gridStripLabel = this.gridStrip.createSpan({ cls: 'mpl-strip-label' });
  }

  buildBoardPanel() {
    const p = this.boardPanel = this.bodyEl.createEl('section', { cls: 'mpl-panel mpl-board-panel' });
    const head = p.createDiv({ cls: 'mpl-phead' });
    this.boardTitleEl = head.createSpan({ cls: 'mpl-ptitle' });
    head.createSpan({ cls: 'mpl-pcount', text: 'board' });
    head.createSpan({ cls: 'mpl-spacer' });
    this.zoomBtn = head.createEl('button', { cls: 'mpl-zoom', text: '100%', attr: { 'aria-label': 'Zoom to fit (Shift+1)', title: 'Zoom to fit (Shift+1)' } });
    this.zoomBtn.addEventListener('click', () => this.board.fit());
    this.pinBtn = head.createEl('button', { cls: 'mpl-btn mpl-btn-small', text: 'Pin over app…', attr: { title: 'Keep this board in a small window over your other apps' } });
    this.pinBtn.addEventListener('click', () => this.plugin.pinBoard(this.ui().board, this));
    this.boardMaxBtn = dbutton(head, 'fill', 'Fill window', () => this.maxPanel('board'));
    dbutton(head, 'right', 'Minimize board', () => this.togglePanel('board'));

    this.boardWrap = p.createDiv({ cls: 'mpl-board-wrap' });
    const ui = this.ui();
    this.board = new BoardCanvas(this.boardWrap, this.plugin, {
      component: this,
      getView: (path) => ui.views[path],
      saveView: (path, v) => { ui.views[path] = v; this.plugin.saveLibrarySoon(); },
      onSelect: () => this.boardSelected(),
      onFull: (files, i, onStep) => this.openFull(files, i, 'on ' + (this.store ? this.store.name : 'board'), onStep),
      onDetails: () => this.openDetails(),
      onView: (v) => { if (this.zoomBtn) this.zoomBtn.setText(Math.round(v.zoom * 100) + '%'); },
      importFiles: (files) => this.importFiles(files, this.importFolder(), true),
    });
    this.noBoardEl = this.boardWrap.createDiv({ cls: 'mpl-noboard' });
    this.noBoardEl.createDiv({ cls: 'mpl-noboard-title', text: 'No board open' });
    this.noBoardEl.createDiv({ cls: 'mpl-noboard-sub', text: 'A board is a free canvas for placing, grouping and annotating images. It is saved as a .canvas file in your vault.' });
    const btns = this.noBoardEl.createDiv({ cls: 'mpl-noboard-btns' });
    btns.createEl('button', { cls: 'mpl-btn-accent', text: 'New board' }).addEventListener('click', () => this.newBoard());
    btns.createEl('button', { cls: 'mpl-btn', text: 'Open board…' }).addEventListener('click', () => this.chooseBoard());

    // Obsidian's status bar floats over the bottom right corner: keep controls out of it.
    const foot = p.createDiv({ cls: 'mpl-pfoot' });
    foot.createSpan({ cls: 'mpl-hint', text: 'Select an image · F full screen · I details · drag empty space to pan · Ctrl+wheel to zoom' });

    this.boardStrip = this.bodyEl.createDiv({ cls: 'mpl-strip mpl-board-strip' });
    dbutton(this.boardStrip, 'left', 'Restore board', () => this.togglePanel('board'));
    this.boardStripLabel = this.boardStrip.createSpan({ cls: 'mpl-strip-label' });
  }

  // Drag the grid's right edge to give the grid or the board more room.
  wireSplit() {
    let start = null;
    this.splitEl.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, w: this.gridPanel.getBoundingClientRect().width };
      this.splitEl.setPointerCapture(e.pointerId);
      this.rootEl.addClass('is-resizing');
      e.preventDefault();
    });
    this.splitEl.addEventListener('pointermove', (e) => {
      if (!start) return;
      const max = Math.max(260, this.bodyEl.clientWidth - 360);
      const w = Math.round(Math.min(max, Math.max(220, start.w + e.clientX - start.x)));
      this.rootEl.style.setProperty('--mpl-grid-w', w + 'px');
      this.layout();
    });
    const end = () => {
      if (!start) return;
      start = null;
      this.rootEl.removeClass('is-resizing');
      this.ui().gridW = Math.round(this.gridPanel.getBoundingClientRect().width);
      this.plugin.saveLibrarySoon();
      this.board.refreshSize();
    };
    this.splitEl.addEventListener('pointerup', end);
    this.splitEl.addEventListener('pointercancel', end);
  }

  viewMenu(e) {
    const ui = this.ui();
    const menu = new obsidian.Menu();
    for (const [value, text] of SORTS) {
      menu.addItem((i) => i.setTitle('Sort: ' + text).setChecked(ui.sort === value).onClick(() => {
        ui.sort = value;
        this.plugin.saveLibrarySoon();
        this.update();
      }));
    }
    menu.addSeparator();
    for (const [text, px] of THUMBS) {
      menu.addItem((i) => i.setTitle(text + ' thumbnails').setChecked(ui.thumb === px).onClick(() => {
        ui.thumb = px;
        this.plugin.saveLibrarySoon();
        this.layout();
      }));
    }
    menu.showAtMouseEvent(e);
  }

  // -- panels ---------------------------------------------------------------

  applyPanels() {
    const ui = this.ui();
    // The button that was clicked may be about to disappear with its panel:
    // keep the keyboard in the view.
    const hadFocus = this.rootEl.contains(document.activeElement);
    let gridMin = !!ui.gridMin;
    let boardMin = !!ui.boardMin;
    if (gridMin && boardMin) boardMin = false;
    if (this.narrow && !gridMin && !boardMin) boardMin = true;   // one main panel at a time
    this.eff = { sideMin: !!ui.sideMin, gridMin, boardMin };
    const r = this.rootEl;
    r.toggleClass('side-min', this.eff.sideMin);
    r.toggleClass('grid-min', gridMin);
    r.toggleClass('board-min', boardMin);
    r.toggleClass('is-narrow', this.narrow);
    if (ui.gridW) r.style.setProperty('--mpl-grid-w', ui.gridW + 'px');
    const gridMax = boardMin && this.eff.sideMin && !gridMin;
    const boardMax = gridMin && this.eff.sideMin && !boardMin;
    this.gridMaxBtn.setAttribute('aria-label', gridMax ? 'Restore layout' : 'Fill window with images');
    this.boardMaxBtn.setAttribute('aria-label', boardMax ? 'Restore layout' : 'Fill window with the board');
    this.gridMaxBtn.toggleClass('is-active', gridMax);
    this.boardMaxBtn.toggleClass('is-active', boardMax);
    if (hadFocus && !(document.activeElement && document.activeElement.offsetParent)) this.rootEl.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      this.layout();
      this.board.refreshSize();
    });
  }

  togglePanel(which) {
    const ui = this.ui();
    const e = this.eff;
    if (which === 'grid') {
      if (!e.gridMin) { ui.gridMin = true; ui.boardMin = false; } else { ui.gridMin = false; if (this.narrow) ui.boardMin = true; }
    } else if (!e.boardMin) { ui.boardMin = true; ui.gridMin = false; } else { ui.boardMin = false; if (this.narrow) ui.gridMin = true; }
    ui.restore = null;
    this.applyPanels();
    this.plugin.saveLibrarySoon();
  }

  // Fill window: hide the others; again restores what was there before.
  maxPanel(which) {
    const ui = this.ui();
    const e = this.eff;
    const isMax = which === 'grid' ? (e.boardMin && e.sideMin && !e.gridMin) : (e.gridMin && e.sideMin && !e.boardMin);
    if (isMax) {
      Object.assign(ui, ui.restore || { sideMin: false, gridMin: false, boardMin: false });
      ui.restore = null;
    } else {
      ui.restore = { sideMin: !!ui.sideMin, gridMin: !!ui.gridMin, boardMin: !!ui.boardMin };
      ui.sideMin = true;
      ui.gridMin = which !== 'grid';
      ui.boardMin = which === 'grid';
    }
    this.applyPanels();
    this.plugin.saveLibrarySoon();
  }

  toggleSide() {
    const ui = this.ui();
    ui.sideMin = !ui.sideMin;
    ui.restore = null;
    this.applyPanels();
    this.plugin.saveLibrarySoon();
  }

  // -- data -----------------------------------------------------------------

  allImages() { return this.plugin.allImages(); }
  info(f) { return this.plugin.imageInfo(f); }
  added(f) { return this.plugin.added(f); }

  smartFolder(name) { return (this.ui().smart || []).find((s) => s.name === name) || null; }

  inFilter(f, filter) {
    switch (filter.kind) {
      case 'recent': return this.added(f) >= Date.now() - 7 * DAY;
      case 'untagged': return !(this.info(f).tags.length);
      case 'folder': return f.path.startsWith(filter.value + '/');
      case 'tag': return hasTag(this.info(f).tags, filter.value);
      case 'smart': {
        const s = this.smartFolder(filter.value);
        return !!s && matchesQuery(this.info(f), parseQuery(s.query));
      }
      default: return true;
    }
  }

  computeItems(all) {
    const q = parseQuery(this.query);
    const smart = this.filter.kind === 'smart' ? this.smartFolder(this.filter.value) : null;
    const sq = smart ? parseQuery(smart.query) : null;
    const items = all.filter((f) => (sq ? matchesQuery(this.info(f), sq) : this.inFilter(f, this.filter))
      && (!this.query || matchesQuery(this.info(f), q)));
    const sort = this.ui().sort;
    const by = {
      added: (a, b) => this.added(b) - this.added(a),
      modified: (a, b) => b.stat.mtime - a.stat.mtime,
      name: (a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: 'base' }),
      size: (a, b) => b.stat.size - a.stat.size,
    }[sort] || ((a, b) => this.added(b) - this.added(a));
    return items.sort(by);
  }

  scheduleRefresh(modified) {
    // A changed image must load again: its card is rebuilt (new mtime).
    if (modified) this.aspects.delete(modified.path);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 120);
  }

  refresh() {
    if (!this.built) return;
    const all = this.allImages();
    const live = new Set(all);
    for (const f of [...this.cards.keys()]) if (!live.has(f)) this.cards.delete(f);
    const paths = new Set(all.map((f) => f.path));
    for (const p of [...this.selected]) if (!paths.has(p)) this.selected.delete(p);
    for (const f of all) {
      if (this.aspects.has(f.path)) continue;
      const m = this.meta(f.path);
      if (m && m.w && m.h) { this.aspects.set(f.path, clampAspect(m.w / m.h)); this.dims.set(f.path, [m.w, m.h]); }
    }
    if (this.filter.kind === 'folder' && !(this.app.vault.getAbstractFileByPath(this.filter.value) instanceof obsidian.TFolder)) {
      this.filter = { kind: 'all' };
    }
    if (this.filter.kind === 'smart' && !this.smartFolder(this.filter.value)) this.filter = { kind: 'all' };
    this.renderSidebar(all);
    this.update(all);
    this.renderDetails();
  }

  // Filter, sort and lay out again (no sidebar rebuild).
  update(all) {
    this.items = this.computeItems(all || this.allImages());
    const label = this.filterLabel(this.filter);
    this.headingEl.setText(label);
    this.totalEl.setText(String(this.items.length));
    this.gridStripLabel.setText(label + ' · ' + this.items.length);
    this.layout();
  }

  filterLabel(f) {
    if (f.kind === 'recent') return 'Added this week';
    if (f.kind === 'untagged') return 'Untagged';
    if (f.kind === 'folder') return f.value.split('/').pop();
    if (f.kind === 'tag') return '#' + f.value;
    if (f.kind === 'smart') return f.value;
    return 'All images';
  }

  setFilter(f) {
    this.filter = f;
    this.limit = PAGE;
    // Narrow panes: the sidebar floats over the grid; get it out of the way.
    if (this.narrow && !this.ui().sideMin) { this.ui().sideMin = true; this.applyPanels(); }
    this.scrollEl.scrollTop = 0;
    this.renderSidebar(this.allImages());
    this.update();
    this.app.workspace.requestSaveLayout();
  }

  // -- sidebar --------------------------------------------------------------

  renderSidebar(all) {
    const side = this.sideEl;
    const rail = this.railEl;
    side.empty();
    rail.empty();
    const head = side.createDiv({ cls: 'mpl-side-head' });
    head.createSpan({ cls: 'mpl-lbl', text: 'Library' });
    dbutton(head, 'sideClose', 'Collapse sidebar', () => this.toggleSide());
    dbutton(rail, 'sideOpen', 'Expand sidebar', () => this.toggleSide(), 'mpl-rail-open');

    const week = Date.now() - 7 * DAY;
    const byAdded = all.slice().sort((a, b) => this.added(b) - this.added(a));

    // Folders that hold images somewhere below them: recursive counts, and the
    // main color of the newest image whose colors are known, for the chip.
    const counts = new Map();
    const colors = new Map();
    for (const f of byAdded) {
      const c = (this.meta(f.path) || {}).colors;
      let p = parentPath(f);
      while (p) {
        counts.set(p, (counts.get(p) || 0) + 1);
        if (c && c[0] && !colors.has(p)) colors.set(p, c[0]);
        const i = p.lastIndexOf('/');
        p = i < 0 ? '' : p.slice(0, i);
      }
    }

    const sections = [];
    sections.push({
      title: 'Library',
      rows: [
        { label: 'All images', count: all.length, filter: { kind: 'all' } },
        { label: 'Untagged', count: all.filter((f) => !this.info(f).tags.length).length, filter: { kind: 'untagged' } },
      ],
    });

    const folderRows = [];
    const tree = (folder, depth) => {
      const kids = folder.children
        .filter((c) => c instanceof obsidian.TFolder && counts.has(c.path))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const c of kids) {
        const hasKids = c.children.some((k) => k instanceof obsidian.TFolder && counts.has(k.path));
        const folded = this.collapsed.has(c.path);
        folderRows.push({
          label: c.name, count: counts.get(c.path), filter: { kind: 'folder', value: c.path },
          depth, caret: hasKids ? (folded ? 'closed' : 'open') : 'none', folder: c.path,
          color: colors.get(c.path) || hashColor(c.path),
        });
        if (hasKids && !folded) tree(c, depth + 1);
      }
    };
    tree(this.app.vault.getRoot(), 0);
    sections.push({ title: 'Folders', rows: folderRows, empty: 'No folders with images yet' });

    const smartRows = [{ label: 'Added this week', count: all.filter((f) => this.added(f) >= week).length, filter: { kind: 'recent' }, color: '#4B4E7D' }];
    for (const s of this.ui().smart || []) {
      const q = parseQuery(s.query);
      smartRows.push({
        label: s.name, count: all.filter((f) => matchesQuery(this.info(f), q)).length,
        filter: { kind: 'smart', value: s.name }, color: hashColor('smart:' + s.name), smart: s,
      });
    }
    sections.push({ title: 'Smart folders', rows: smartRows });

    const tagCounts = new Map();
    for (const f of all) for (const t of this.info(f).tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    if (tagCounts.size) {
      sections.push({
        title: 'Tags',
        rows: [...tagCounts].sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => ({
          label: t, count: n, filter: { kind: 'tag', value: t }, color: hashColor('tag:' + t), initial: '#',
        })),
      });
    }

    const list = side.createDiv({ cls: 'mpl-side-list' });
    const railList = rail.createDiv({ cls: 'mpl-rail-list' });
    sections.forEach((sec, i) => {
      // The panel's own "Library" heading doubles as the first section's.
      if (i) list.createDiv({ cls: 'mpl-lbl mpl-side-title', text: sec.title });
      if (i) railList.createDiv({ cls: 'mpl-rail-sep' });
      for (const o of sec.rows) {
        this.sideRow(list, o);
        this.railChip(railList, o);
      }
      if (!sec.rows.length && sec.empty) list.createDiv({ cls: 'mpl-side-empty', text: sec.empty });
    });
  }

  chip(parent, o, cls) {
    const c = parent.createSpan({ cls: 'mpl-chip' + (cls ? ' ' + cls : ''), text: o.initial || (o.label.charAt(0) || '?').toUpperCase() });
    if (o.color) {
      c.style.background = o.color;
      c.style.color = chipText(o.color);
    } else c.addClass('is-neutral');
    return c;
  }

  sideRow(parent, o) {
    const row = parent.createDiv({ cls: 'mpl-row', attr: { role: 'button', tabindex: '0' } });
    if (sameFilter(o.filter, this.filter)) row.addClass('is-active');
    row.style.paddingLeft = (8 + (o.depth || 0) * 14) + 'px';
    if (o.caret) {
      const caret = row.createSpan({ cls: 'mpl-caret' });
      if (o.caret !== 'none') {
        obsidian.setIcon(caret, 'chevron-down');
        caret.toggleClass('is-collapsed', o.caret === 'closed');
        caret.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.collapsed.has(o.folder)) this.collapsed.delete(o.folder); else this.collapsed.add(o.folder);
          this.renderSidebar(this.allImages());
        });
      }
    }
    this.chip(row, o);
    row.createSpan({ cls: 'mpl-label', text: o.label });
    row.createSpan({ cls: 'mpl-count', text: o.count.toLocaleString() });
    this.wireRow(row, o);
    return row;
  }

  railChip(parent, o) {
    const c = this.chip(parent, o, 'mpl-rchip');
    c.setAttribute('role', 'button');
    c.setAttribute('tabindex', '0');
    c.setAttribute('aria-label', o.label + ' (' + o.count + ')');
    if (sameFilter(o.filter, this.filter)) c.addClass('is-active');
    this.wireRow(c, o);
  }

  wireRow(el, o) {
    el.addEventListener('click', () => this.setFilter(o.filter));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.setFilter(o.filter); }
    });
    if (o.folder != null) {
      el.addEventListener('contextmenu', (e) => {
        const menu = new obsidian.Menu();
        menu.addItem((i) => i.setTitle('Save clipped images here').setIcon('image-down')
          .setChecked(this.plugin.settings.targetFolder === o.folder)
          .onClick(() => this.plugin.setTarget(o.folder)));
        menu.showAtMouseEvent(e);
      });
      this.dropTarget(el, o.folder);
    }
    if (o.smart) {
      el.addEventListener('contextmenu', (e) => {
        const menu = new obsidian.Menu();
        menu.addItem((i) => i.setTitle('Edit search…').setIcon('search').onClick(() => this.editSmart(o.smart)));
        menu.addItem((i) => i.setTitle('Rename…').setIcon('pencil').onClick(() => this.renameSmart(o.smart)));
        menu.addItem((i) => i.setTitle('Delete smart folder').setIcon('trash-2').onClick(() => this.deleteSmart(o.smart)));
        menu.showAtMouseEvent(e);
      });
    }
  }

  // -- smart folders (saved searches) ---------------------------------------

  uniqueSmartName(name, except) {
    const taken = new Set((this.ui().smart || []).filter((s) => s !== except).map((s) => s.name));
    let n = name;
    for (let i = 2; taken.has(n); i++) n = name + ' ' + i;
    return n;
  }

  saveSmart() {
    const query = this.query.trim();
    if (!query) return;
    new PromptModal(this.app, 'Save as smart folder', 'Name', (v) => {
      const ui = this.ui();
      const name = this.uniqueSmartName(String(v).trim() || query);
      ui.smart = (ui.smart || []).concat([{ name, query }]);
      this.plugin.saveLibrarySoon();
      this.query = '';
      this.searchEl.value = '';
      this.saveSearchBtn.removeClass('is-visible');
      this.setFilter({ kind: 'smart', value: name });
    }, query).open();
  }

  editSmart(s) {
    new PromptModal(this.app, 'Search for "' + s.name + '"', '#tag  color:teal  words', (v) => {
      if (!String(v).trim()) return;
      s.query = String(v).trim();
      this.plugin.saveLibrarySoon();
      this.refresh();
    }, s.query).open();
  }

  renameSmart(s) {
    new PromptModal(this.app, 'Rename smart folder', 'Name', (v) => {
      const name = this.uniqueSmartName(String(v).trim() || s.name, s);
      const active = this.filter.kind === 'smart' && this.filter.value === s.name;
      s.name = name;
      if (active) this.filter = { kind: 'smart', value: name };
      this.plugin.saveLibrarySoon();
      this.refresh();
    }, s.name).open();
  }

  deleteSmart(s) {
    const ui = this.ui();
    ui.smart = (ui.smart || []).filter((x) => x !== s);
    this.plugin.saveLibrarySoon();
    this.refresh();
  }

  // A sidebar folder: drop thumbnails on it to move them, or files from the
  // computer to import them there.
  dropTarget(row, folder) {
    const accepts = (e) => {
      const types = [...(e.dataTransfer && e.dataTransfer.types || [])];
      return types.includes('application/x-markport-images') || types.includes('Files');
    };
    row.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      row.addClass('is-drop');
      e.dataTransfer.dropEffect = [...e.dataTransfer.types].includes('Files') ? 'copy' : 'move';
    });
    row.addEventListener('dragleave', () => row.removeClass('is-drop'));
    row.addEventListener('drop', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      row.removeClass('is-drop');
      this.dropEl.removeClass('is-visible');
      const raw = e.dataTransfer.getData('application/x-markport-images');
      if (raw) {
        let paths = [];
        try { paths = JSON.parse(raw); } catch (_) { /* ignore */ }
        const files = paths.map((p) => this.app.vault.getAbstractFileByPath(p)).filter(isImageFile);
        this.moveFiles(files, folder);
      } else if (e.dataTransfer.files.length) {
        this.importFiles([...e.dataTransfer.files], folder);
      }
    });
  }

  // -- the grid -------------------------------------------------------------

  columnsFor(width) {
    const thumb = this.ui().thumb;
    return Math.max(1, Math.floor((width + GAP) / (thumb + GAP)));
  }

  // Masonry: each card goes into the shortest column, in sort order, so
  // reading left to right, top to bottom roughly follows the sort.
  layout() {
    if (!this.built) return;
    const width = this.gridEl.clientWidth;
    if (!width) return;
    const n = this.columnsFor(width);
    const colW = (width - GAP * (n - 1)) / n;
    this.colCount = n;
    const cols = [];
    const heights = new Array(n).fill(0);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const c = document.createElement('div');
      c.className = 'mpl-col';
      cols.push(c);
      frag.appendChild(c);
    }
    for (const f of this.items.slice(0, this.limit)) {
      let k = 0;
      for (let i = 1; i < n; i++) if (heights[i] < heights[k] - 1) k = i;
      cols[k].appendChild(this.card(f));
      heights[k] += colW / (this.aspects.get(f.path) || 4 / 3) + GAP;
    }
    this.gridEl.replaceChildren(frag);

    this.emptyEl.empty();
    this.emptyEl.toggleClass('is-visible', !this.items.length);
    if (!this.items.length) {
      obsidian.setIcon(this.emptyEl.createDiv({ cls: 'mpl-empty-icon' }), 'image-off');
      this.emptyEl.createDiv({ cls: 'mpl-empty-title', text: this.query ? 'No matches' : 'No images here' });
      this.emptyEl.createDiv({
        cls: 'mpl-empty-sub',
        text: this.query ? 'Try other words, or clear the search.' : 'Drop images here, or clip them from the browser.',
      });
    }
    this.paintSelection();
  }

  scheduleLayout() {
    clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => this.layout(), 150);
  }

  card(f) {
    const known = this.cards.get(f);
    if (known && known.path === f.path && known.mtime === f.stat.mtime) return known.el;

    const el = document.createElement('div');
    el.className = 'mpl-card';
    el.draggable = true;
    const thumb = el.createDiv({ cls: 'mpl-thumb' });
    const a = this.aspects.get(f.path);
    if (a) thumb.style.aspectRatio = String(a);
    const img = thumb.createEl('img', { attr: { loading: 'lazy', decoding: 'async', alt: f.basename, draggable: 'false' } });
    img.addEventListener('load', () => {
      this.gotSize(f, img.naturalWidth, img.naturalHeight);
      // Colors make "color:teal" searches and folder chips work.
      const m = this.meta(f.path);
      if (!m || !m.colors) {
        const colors = this.computeColors(img);
        if (colors.length) this.plugin.setMeta(f.path, { colors });
      }
    });
    img.addEventListener('error', () => {
      thumb.addClass('is-broken');
      obsidian.setIcon(thumb.createDiv({ cls: 'mpl-broken-icon' }), 'image-off');
    });
    img.src = this.app.vault.getResourcePath(f);
    el.createSpan({ cls: 'mpl-badge', text: 'on board' });
    const acts = el.createDiv({ cls: 'mpl-card-acts' });
    const full = dbutton(acts, 'fill', 'Full screen (F)', () => { this.selectOnly(f, true); this.openFullGrid(f); });
    full.addClass('mpl-card-act');
    const det = dbutton(acts, 'info', 'Details (I)', () => { this.selectOnly(f, true); this.openDetails(); });
    det.addClass('mpl-card-act');
    el.createDiv({ cls: 'mpl-card-name', text: f.basename });

    el.addEventListener('click', (e) => this.onCardClick(e, f));
    el.addEventListener('dblclick', (e) => { if (!e.target.closest('.mpl-card-act')) this.openImage(f); });
    el.addEventListener('contextmenu', (e) => this.cardMenu(e, f));
    el.addEventListener('dragstart', (e) => this.onCardDrag(e, f));
    el.addEventListener('dragend', () => this.dropEl.removeClass('is-visible'));

    const entry = { el, path: f.path, mtime: f.stat.mtime, thumb };
    this.cards.set(f, entry);
    return el;
  }

  gotSize(f, w, hgt) {
    if (!(w > 0 && hgt > 0)) return;
    const a = clampAspect(w / hgt);
    const prev = this.aspects.get(f.path);
    this.aspects.set(f.path, a);
    this.dims.set(f.path, [w, hgt]);
    const entry = this.cards.get(f);
    if (entry) entry.thumb.style.aspectRatio = String(a);
    const m = this.meta(f.path);
    if (!m || m.w !== w || m.h !== hgt) this.plugin.setMeta(f.path, { w, h: hgt });
    if (!prev || Math.abs(prev - a) / a > 0.02) this.scheduleLayout();
    if (this.detailsOpen) this.paintDims(f);
  }

  // -- selection ------------------------------------------------------------

  selectedFiles() {
    return this.items.filter((f) => this.selected.has(f.path));
  }

  // What Details and F act on: the board's selection or the grid's.
  targets() {
    return this.focusIn === 'board' ? this.board.selectedImageFiles() : this.selectedFiles();
  }

  takeFocus(where) {
    this.focusIn = where;
    if (where === 'grid') this.board.clearSelection();
  }

  selectOnly(f, quiet) {
    this.takeFocus('grid');
    this.selected = new Set([f.path]);
    this.anchor = f;
    this.paintSelection();
    if (!quiet) this.selectionChanged();
    const entry = this.cards.get(f);
    if (entry && entry.el.isConnected) entry.el.scrollIntoView({ block: 'nearest' });
  }

  onCardClick(e, f) {
    if (e.target.closest('.mpl-card-act')) return;
    this.rootEl.focus({ preventScroll: true });
    this.takeFocus('grid');
    if (e.shiftKey && this.anchor && this.items.includes(this.anchor)) {
      const i = this.items.indexOf(this.anchor);
      const j = this.items.indexOf(f);
      const range = this.items.slice(Math.min(i, j), Math.max(i, j) + 1).map((x) => x.path);
      this.selected = new Set((e.ctrlKey || e.metaKey) ? [...this.selected, ...range] : range);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(f.path)) this.selected.delete(f.path); else this.selected.add(f.path);
      this.anchor = f;
    } else {
      this.selected = new Set([f.path]);
      this.anchor = f;
    }
    this.paintSelection();
    this.selectionChanged();
  }

  boardSelected() {
    if (this.board.sel.size) {
      this.focusIn = 'board';
      if (this.selected.size) {
        this.selected.clear();
        this.anchor = null;
        this.paintSelection();
      }
    }
    this.selectionChanged();
  }

  selectionChanged() {
    if (this.detailsOpen) this.renderDetails();
  }

  paintSelection() {
    for (const [f, entry] of this.cards) {
      entry.el.toggleClass('is-selected', this.selected.has(f.path));
      entry.el.toggleClass('is-on-board', this.onBoard.has(f.path));
    }
  }

  onKey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (this.full) return;
    if (e.key === 'Escape' && this.detailsOpen) {
      e.preventDefault();
      this.closeDetails();
      return;
    }
    // The board handles its own keys (it is focused when you work on it).
    if (this.boardWrap.contains(t) || (this.floatEl && this.floatEl.contains(t))) return;
    const files = this.selectedFiles();
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === 'a') {
      e.preventDefault();
      this.takeFocus('grid');
      this.selected = new Set(this.items.map((f) => f.path));
      this.paintSelection();
      this.selectionChanged();
    } else if (k === 'Escape' && this.selected.size) {
      e.preventDefault();
      this.selected.clear();
      this.paintSelection();
      this.selectionChanged();
    } else if ((k === 'Delete' || k === 'Backspace') && files.length) {
      e.preventDefault();
      this.confirmDelete(files);
    } else if (k === 'Enter' && files.length === 1) {
      e.preventDefault();
      this.openImage(files[0]);
    } else if (!mod && !e.altKey && (k === 'f' || k === 'F' || k === ' ') && files.length) {
      e.preventDefault();
      this.openFullGrid(files[0]);
    } else if (!mod && !e.altKey && (k === 'i' || k === 'I') && files.length) {
      e.preventDefault();
      if (this.detailsOpen) this.closeDetails(); else this.openDetails();
    } else if ((k === 'ArrowRight' || k === 'ArrowLeft') && this.items.length) {
      e.preventDefault();
      const i = this.anchor ? this.items.indexOf(this.anchor) : -1;
      const next = this.items[Math.max(0, Math.min(this.items.length - 1, i + (k === 'ArrowRight' ? 1 : -1)))];
      if (next) this.selectOnly(next);
    }
  }

  // -- full screen ----------------------------------------------------------

  openFullGrid(f) {
    const i = this.items.indexOf(f);
    if (i < 0) return;
    this.openFull(this.items.slice(), i, 'in ' + this.filterLabel(this.filter), (j) => {
      const g = this.items[j];
      if (g) this.selectOnly(g, true);
    });
  }

  openFull(list, i, label, onStep) {
    const files = list.filter(Boolean);
    if (!files.length) return;
    this.full = { list: files, i: Math.max(0, Math.min(files.length - 1, i)), label, onStep };
    if (this.detailsOpen) { this.detailsOpen = false; this.renderDetails(); }
    this.paintFull();
    this.fullEl.addClass('is-open');
    this.fullEl.focus({ preventScroll: true });
  }

  paintFull() {
    const { list, i, label } = this.full;
    const f = list[i];
    const el = this.fullEl;
    el.empty();
    const top = el.createDiv({ cls: 'mpl-full-top' });
    const nameId = 'mpl-full-name-' + Math.random().toString(36).slice(2);
    top.createSpan({ cls: 'mpl-full-name', text: f.name, attr: { id: nameId } });
    el.setAttribute('aria-labelledby', nameId);
    top.createSpan({ cls: 'mpl-mono mpl-muted', text: (i + 1) + ' / ' + list.length + ' ' + label });
    top.createSpan({ cls: 'mpl-spacer' });
    dbutton(top, 'info', 'Details (I)', () => this.fullToDetails());
    dbutton(top, 'close', 'Close full screen (Esc)', () => this.closeFull());
    const stage = el.createDiv({ cls: 'mpl-full-stage' });
    const prev = dbutton(stage, 'prev', 'Previous image (←)', () => this.stepFull(-1), 'mpl-full-nav');
    const frame = stage.createDiv({ cls: 'mpl-full-frame' });
    const img = frame.createEl('img', { attr: { alt: f.basename } });
    img.src = this.app.vault.getResourcePath(f);
    img.addEventListener('dblclick', () => this.closeFull());
    const next = dbutton(stage, 'next', 'Next image (→)', () => this.stepFull(1), 'mpl-full-nav');
    if (list.length < 2) { prev.disabled = true; next.disabled = true; }
    el.createDiv({ cls: 'mpl-full-hint mpl-mono mpl-muted', text: 'Esc or F to close · ← → to step · I details' });
  }

  stepFull(d) {
    const s = this.full;
    if (!s || s.list.length < 2) return;
    s.i = (s.i + d + s.list.length) % s.list.length;
    if (s.onStep) s.onStep(s.i);
    this.paintFull();
  }

  closeFull() {
    if (!this.full) return;
    this.full = null;
    this.fullEl.removeClass('is-open');
    this.fullEl.empty();
    if (this.focusIn === 'board') this.board.el.focus({ preventScroll: true });
    else this.rootEl.focus({ preventScroll: true });
  }

  fullToDetails() {
    this.closeFull();
    this.openDetails();
  }

  onFullKey(e) {
    e.stopPropagation();
    const k = e.key;
    if (k === 'Escape' || k === 'f' || k === 'F' || k === ' ') { e.preventDefault(); this.closeFull(); }
    else if (k === 'ArrowRight') { e.preventDefault(); this.stepFull(1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); this.stepFull(-1); }
    else if (k === 'i' || k === 'I') { e.preventDefault(); this.fullToDetails(); }
  }

  // -- actions --------------------------------------------------------------

  // Not open(): that name is View.open(containerEl), which Obsidian calls to attach the view.
  openImage(f, how) {
    this.app.workspace.getLeaf(how === 'split' ? 'split' : 'tab').openFile(f);
  }

  embedLink(f) {
    return '!' + this.app.fileManager.generateMarkdownLink(f, '');
  }

  reveal(f) {
    const fe = this.app.internalPlugins && this.app.internalPlugins.getPluginById && this.app.internalPlugins.getPluginById('file-explorer');
    if (fe && fe.instance && fe.instance.revealInFolder) fe.instance.revealInFolder(f);
    else new obsidian.Notice(f.path);
  }

  async copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      new obsidian.Notice('Copied ' + what);
    } catch (_) {
      new obsidian.Notice('Could not copy to the clipboard');
    }
  }

  cardMenu(e, f) {
    e.preventDefault();
    if (!this.selected.has(f.path)) this.selectOnly(f);
    const files = this.selectedFiles();
    const menu = new obsidian.Menu();
    if (files.length === 1) {
      menu.addItem((i) => i.setTitle('Full screen').setIcon('maximize-2').onClick(() => this.openFullGrid(f)));
      menu.addItem((i) => i.setTitle('Details').setIcon('info').onClick(() => this.openDetails()));
      menu.addItem((i) => i.setTitle('Open').setIcon('image').onClick(() => this.openImage(f)));
      menu.addItem((i) => i.setTitle('Open to the right').setIcon('separator-vertical').onClick(() => this.openImage(f, 'split')));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle('Copy embed link').setIcon('link').onClick(() => this.copy(this.embedLink(f), 'embed link')));
      menu.addItem((i) => i.setTitle('Reveal in navigation').setIcon('folder-open').onClick(() => this.reveal(f)));
      menu.addSeparator();
    }
    if (this.store && this.store.data) {
      menu.addItem((i) => i.setTitle('Add to board "' + this.store.name + '"').setIcon('layout-dashboard').onClick(() => this.addToBoard(files)));
    }
    menu.addItem((i) => i.setTitle(files.length > 1 ? 'Add tag to ' + files.length + ' images…' : 'Add tag…').setIcon('tag').onClick(() => this.promptTag(files)));
    menu.addItem((i) => i.setTitle('Move to folder…').setIcon('folder-input').onClick(() => this.promptMove(files)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(files.length > 1 ? 'Delete ' + files.length + ' images' : 'Delete').setIcon('trash-2').onClick(() => this.confirmDelete(files)));
    menu.showAtMouseEvent(e);
  }

  addToBoard(files) {
    if (this.eff.boardMin) this.togglePanel('board');
    requestAnimationFrame(() => {
      const r = this.board.el.getBoundingClientRect();
      this.board.place(files.map((f) => f.path), this.board.toWorld(r.left + r.width / 2, r.top + r.height / 2));
    });
  }

  onCardDrag(e, f) {
    if (!this.selected.has(f.path)) this.selectOnly(f);
    const files = this.selectedFiles();
    e.dataTransfer.setData('application/x-markport-images', JSON.stringify(files.map((x) => x.path)));
    // Dropped into a note, this becomes the embeds.
    e.dataTransfer.setData('text/plain', files.map((x) => this.embedLink(x)).join('\n'));
    e.dataTransfer.effectAllowed = 'copyMove';
    const entry = this.cards.get(f);
    const img = entry && entry.thumb.querySelector('img');
    if (img && img.complete) e.dataTransfer.setDragImage(img, 20, 20);
  }

  promptTag(files) {
    new PromptModal(this.app, files.length > 1 ? 'Tag ' + files.length + ' images' : 'Add tag', 'tag, or several separated by commas', (value) => {
      const add = String(value).split(',').map(normalizeTag).filter(Boolean);
      if (!add.length) return;
      for (const f of files) {
        const tags = this.info(f).tags;
        this.plugin.setMeta(f.path, { tags: [...new Set(tags.concat(add))] });
      }
      this.metaChanged(true);
    }).open();
  }

  promptMove(files) {
    const folders = [''].concat(this.plugin.listFolders());
    new FolderSuggestModal(this.app, folders, (folder) => this.moveFiles(files, folder)).open();
  }

  async moveFiles(files, folder) {
    let moved = 0;
    try {
      await this.plugin.ensureFolder(folder);
      for (const f of files) {
        if (parentPath(f) === folder) continue;
        const target = uniquePath(folder, f.name, (p) => !!this.app.vault.getAbstractFileByPath(p));
        await this.app.fileManager.renameFile(f, target);
        moved++;
      }
    } catch (e) {
      new obsidian.Notice('Move failed: ' + ((e && e.message) || e));
    }
    if (moved) new obsidian.Notice('Moved ' + moved + (moved === 1 ? ' image' : ' images') + ' to ' + (folder || 'the vault root'));
  }

  confirmDelete(files) {
    const what = files.length === 1 ? '"' + files[0].name + '"' : files.length + ' images';
    new ConfirmModal(this.app, 'Delete ' + (files.length === 1 ? 'image' : 'images'), 'Move ' + what + ' to the trash?', 'Delete', async () => {
      for (const f of files) {
        try {
          if (this.app.fileManager.trashFile) await this.app.fileManager.trashFile(f);
          else await this.app.vault.trash(f, true);
        } catch (e) {
          new obsidian.Notice('Could not delete ' + f.name + ': ' + ((e && e.message) || e));
        }
      }
      this.selected.clear();
    }).open();
  }

  // Tags changed: the sidebar counts and maybe the current filter.
  metaChanged(tags) {
    if (tags) {
      this.renderSidebar(this.allImages());
      if (this.filter.kind === 'tag' || this.filter.kind === 'untagged' || this.filter.kind === 'smart' || this.query) this.update();
    }
    this.renderDetails();
  }

  // -- importing ------------------------------------------------------------

  importFolder() {
    return this.filter.kind === 'folder' ? this.filter.value : this.plugin.settings.targetFolder;
  }

  wireImportDrop(main) {
    const fromComputer = (e) => {
      const types = [...(e.dataTransfer && e.dataTransfer.types || [])];
      return types.includes('Files') && !types.includes('application/x-markport-images');
    };
    main.addEventListener('dragover', (e) => {
      if (!fromComputer(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.dropEl.setText('Drop to import into ' + (this.importFolder() || 'the vault root'));
      this.dropEl.addClass('is-visible');
    });
    main.addEventListener('dragleave', (e) => {
      if (!main.contains(e.relatedTarget)) this.dropEl.removeClass('is-visible');
    });
    main.addEventListener('drop', (e) => {
      this.dropEl.removeClass('is-visible');
      if (!fromComputer(e)) return;
      e.preventDefault();
      this.importFiles([...e.dataTransfer.files], this.importFolder());
    });
  }

  async importFiles(files, folder, keepSelection) {
    const tag = this.filter.kind === 'tag' ? this.filter.value : null;
    const done = await this.plugin.importFiles(files, folder, tag);
    if (done.length && !keepSelection) {
      this.takeFocus('grid');
      this.selected = new Set(done);
    }
    return done;
  }

  // -- boards ---------------------------------------------------------------

  renderTabs() {
    const ui = this.ui();
    const el = this.tabsEl;
    el.empty();
    for (const path of ui.boards) {
      const tab = el.createDiv({ cls: 'mpl-tab', attr: { role: 'button', tabindex: '0', title: path } });
      if (path === ui.board) {
        tab.addClass('is-active');
        tab.setAttribute('aria-current', 'page');
      }
      tab.createSpan({ cls: 'mpl-tab-name', text: boardName(path) });
      const x = dbutton(tab, 'close', 'Close board tab', () => this.closeBoard(path), 'mpl-tab-x');
      x.tabIndex = -1;
      tab.addEventListener('click', () => this.activateBoard(path));
      tab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.activateBoard(path); } });
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); this.closeBoard(path); } });
      tab.addEventListener('contextmenu', (e) => this.tabMenu(e, path));
    }
    const add = dbutton(el, 'plus', 'New or open board', (e) => {
      const menu = new obsidian.Menu();
      menu.addItem((i) => i.setTitle('New board…').setIcon('plus').onClick(() => this.newBoard()));
      menu.addItem((i) => i.setTitle('Open board…').setIcon('layout-dashboard').onClick(() => this.chooseBoard()));
      menu.showAtMouseEvent(e);
    }, 'mpl-tab-add');
    add.setAttribute('title', 'New or open board');
  }

  tabMenu(e, path) {
    e.preventDefault();
    const file = this.app.vault.getAbstractFileByPath(path);
    const menu = new obsidian.Menu();
    menu.addItem((i) => i.setTitle('Rename board…').setIcon('pencil').onClick(() => this.renameBoard(path)));
    if (file) {
      menu.addItem((i) => i.setTitle('Open in Canvas').setIcon('layout-dashboard').onClick(() => this.app.workspace.getLeaf('tab').openFile(file)));
      menu.addItem((i) => i.setTitle('Reveal in navigation').setIcon('folder-open').onClick(() => this.reveal(file)));
    }
    menu.addItem((i) => i.setTitle('Pin over app…').setIcon('pin').onClick(() => this.plugin.pinBoard(path, this)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Close tab').setIcon('x').onClick(() => this.closeBoard(path)));
    menu.showAtMouseEvent(e);
  }

  activateBoard(path) {
    const ui = this.ui();
    if (!ui.boards.includes(path)) ui.boards.push(path);
    const changed = ui.board !== path;
    ui.board = path;
    this.plugin.saveLibrarySoon();
    this.renderTabs();
    if (changed || !this.store) this.mountBoard();
    if (this.eff.boardMin) this.togglePanel('board');
  }

  closeBoard(path) {
    const ui = this.ui();
    const i = ui.boards.indexOf(path);
    if (i < 0) return;
    ui.boards.splice(i, 1);
    if (ui.board === path) {
      ui.board = ui.boards[Math.min(i, ui.boards.length - 1)] || '';
      this.mountBoard();
    }
    this.plugin.saveLibrarySoon();
    this.renderTabs();
  }

  mountBoard() {
    const path = this.ui().board;
    if (this.storeUnsub) this.storeUnsub();
    this.storeUnsub = null;
    this.store = path ? this.plugin.board(path) : null;
    if (this.store) this.storeUnsub = this.store.on(() => this.boardDataChanged());
    this.board.setStore(this.store);
    this.boardDataChanged();
  }

  boardDataChanged() {
    const s = this.store;
    this.onBoard = s && s.data ? canvasImagePaths(s.data) : new Set();
    this.paintSelection();
    const name = s ? s.name : 'No board';
    this.boardTitleEl.setText(name);
    this.boardStripLabel.setText('Board · ' + name);
    this.rootEl.toggleClass('no-board', !s);
    this.pinBtn.disabled = !s;
  }

  // The plugin saw boards renamed, deleted or created.
  boardsChanged() {
    const want = this.ui().board;
    this.renderTabs();
    if ((this.store ? this.store.path : '') !== want) this.mountBoard();
    else this.boardDataChanged();
  }

  newBoard() {
    new PromptModal(this.app, 'New board', 'Board name', async (v) => {
      try {
        const path = await this.plugin.createBoard(v);
        this.activateBoard(path);
      } catch (e) {
        new obsidian.Notice('Could not create the board: ' + ((e && e.message) || e));
      }
    }).open();
  }

  chooseBoard() {
    const boards = this.app.vault.getFiles().filter(isCanvasFile).sort((a, b) => b.stat.mtime - a.stat.mtime);
    if (!boards.length) { this.newBoard(); return; }
    new BoardSuggestModal(this.app, boards, (f) => this.activateBoard(f.path)).open();
  }

  renameBoard(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof obsidian.TFile)) return;
    new PromptModal(this.app, 'Rename board', 'Board name', async (v) => {
      const name = sanitizeName(v);
      if (!name || name === file.basename) return;
      const target = joinPath(parentPath(file), name + '.canvas');
      if (this.app.vault.getAbstractFileByPath(target)) { new obsidian.Notice('"' + name + '" already exists in this folder'); return; }
      try { await this.app.fileManager.renameFile(file, target); } catch (e) { new obsidian.Notice('Rename failed: ' + ((e && e.message) || e)); }
    }, file.basename).open();
  }

  // In-app fallback for "Pin over app…": a floating mini window over the library.
  floatBoard(path) {
    this.closeFloat();
    const el = this.floatEl = this.rootEl.createDiv({ cls: 'mpl-float' });
    this.floatMini = new MiniBoard(el, this.plugin, path, {
      mode: 'float',
      onUnpin: () => this.closeFloat(),
      onOpenMain: () => { this.activateBoard(path); this.closeFloat(); },
    });
    let start = null;
    const bar = this.floatMini.bar;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = el.getBoundingClientRect();
      const host = this.rootEl.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left - host.left, top: r.top - host.top };
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!start) return;
      const host = this.rootEl.getBoundingClientRect();
      const left = Math.max(0, Math.min(host.width - 120, start.left + e.clientX - start.x));
      const top = Math.max(0, Math.min(host.height - 40, start.top + e.clientY - start.y));
      Object.assign(el.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
    });
    bar.addEventListener('pointerup', () => { start = null; });
  }

  closeFloat() {
    if (this.floatMini) this.floatMini.destroy();
    if (this.floatEl) this.floatEl.remove();
    this.floatMini = null;
    this.floatEl = null;
  }

  // -- details --------------------------------------------------------------

  openDetails() {
    if (!this.targets().length) return;
    this.detailsOpen = true;
    this.renderDetails();
  }

  closeDetails() {
    this.detailsOpen = false;
    this.renderDetails();
    if (this.focusIn === 'board') this.board.el.focus({ preventScroll: true });
    else this.rootEl.focus({ preventScroll: true });
  }

  renderDetails() {
    if (!this.built) return;
    const el = this.detailsEl;
    el.empty();
    this.tagsEl = null;
    this.dimsEl = null;
    this.picking = false;
    const files = this.detailsOpen ? this.targets() : [];
    if (!files.length) {
      this.detailsOpen = false;
      el.removeClass('is-open');
      return;
    }
    el.addClass('is-open');
    const head = el.createDiv({ cls: 'mpl-dhead' });
    head.createSpan({ cls: 'mpl-lbl', text: files.length > 1 ? files.length + ' images' : 'Details' });
    dbutton(head, 'close', 'Close details (Esc)', () => this.closeDetails());
    if (files.length === 1) { this.inspectOne(el, files[0]); return; }

    el.createDiv({ cls: 'mpl-mono mpl-muted', text: formatBytes(files.reduce((n, f) => n + f.stat.size, 0)) + ' in total' });
    const stack = el.createDiv({ cls: 'mpl-stack' });
    for (const f of files.slice(0, 9)) {
      stack.createEl('img', { attr: { src: this.app.vault.getResourcePath(f), alt: f.basename, loading: 'lazy' } });
    }
    const actions = el.createDiv({ cls: 'mpl-actions' });
    this.action(actions, 'tag', 'Add tag', () => this.promptTag(files));
    this.action(actions, 'folder-input', 'Move', () => this.promptMove(files));
    this.action(actions, 'trash-2', 'Delete', () => this.confirmDelete(files), 'mod-warning');
  }

  action(parent, icon, label, onClick, cls) {
    const b = parent.createEl('button', { cls: 'mpl-action' + (cls ? ' ' + cls : ''), attr: { type: 'button' } });
    obsidian.setIcon(b.createSpan({ cls: 'mpl-action-icon' }), icon);
    b.createSpan({ text: label });
    b.addEventListener('click', onClick);
    return b;
  }

  section(el, title) {
    const s = el.createDiv({ cls: 'mpl-dsec' });
    s.createDiv({ cls: 'mpl-lbl', text: title });
    return s;
  }

  // Full screen from Details: the list the image was selected in.
  fullFromDetails(f) {
    if (this.focusIn === 'board') this.board.fullForSelection();
    else this.openFullGrid(f);
  }

  inspectOne(el, f) {
    const m = this.meta(f.path) || {};
    const preview = el.createDiv({ cls: 'mpl-dpreview', attr: { role: 'button', tabindex: '0', 'aria-label': 'Open full screen' } });
    const img = preview.createEl('img', { attr: { alt: f.basename, draggable: 'false' } });
    img.addEventListener('load', () => {
      this.gotSize(f, img.naturalWidth, img.naturalHeight);
      if (!m.colors) {
        const colors = this.computeColors(img);
        if (colors.length) { this.plugin.setMeta(f.path, { colors }); this.paintPalette(palette, colors); }
      }
    });
    img.src = this.app.vault.getResourcePath(f);
    preview.addEventListener('click', (e) => {
      if (this.picking) { this.sampleAt(img, e); return; }
      this.fullFromDetails(f);
    });
    preview.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.fullFromDetails(f); } });
    this.previewEl = preview;

    // The name, renamed in place (the extension stays).
    const nameBox = el.createDiv({ cls: 'mpl-dname' });
    const nameRow = nameBox.createDiv({ cls: 'mpl-name-row' });
    const name = nameRow.createEl('input', { cls: 'mpl-name-input', attr: { type: 'text', spellcheck: 'false', 'aria-label': 'Name' } });
    name.value = f.basename;
    nameRow.createSpan({ cls: 'mpl-ext', text: '.' + f.extension });
    const commit = async () => {
      const next = sanitizeName(name.value);
      if (!next || next === f.basename) { name.value = f.basename; return; }
      const target = joinPath(parentPath(f), next + '.' + f.extension);
      if (this.app.vault.getAbstractFileByPath(target)) {
        new obsidian.Notice('"' + next + '.' + f.extension + '" already exists in this folder');
        name.value = f.basename;
        return;
      }
      await this.app.fileManager.renameFile(f, target);
    };
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); name.value = f.basename; name.blur(); }
    });
    name.addEventListener('blur', commit);
    this.dimsEl = nameBox.createDiv({ cls: 'mpl-mono mpl-muted' });
    this.paintDims(f);

    const palette = this.section(el, 'Colors').createDiv({ cls: 'mpl-palette' });
    if (m.colors) this.paintPalette(palette, m.colors);

    this.tagsEl = this.section(el, 'Tags').createDiv({ cls: 'mpl-tags' });
    this.paintTags(f);

    const note = this.section(el, 'Note').createEl('textarea', { cls: 'mpl-field mpl-note', attr: { placeholder: 'Add a note…', rows: '3' } });
    note.value = m.note || '';
    let noteTimer = null;
    note.addEventListener('input', () => {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => this.plugin.setMeta(f.path, { note: note.value }), 400);
    });

    if (m.source || m.page) {
      const src = this.section(el, 'Source');
      if (m.page) this.link(src, m.page, m.title);
      if (m.source && m.source !== m.page) this.link(src, m.source);
    }

    const used = this.section(el, 'Used on boards').createDiv({ cls: 'mpl-used', text: '…' });
    this.plugin.boardsUsing(f.path).then((paths) => {
      if (!used.isConnected) return;
      used.empty();
      if (!paths.length) { used.setText('Not on any board yet'); return; }
      for (const p of paths) {
        const a = used.createEl('a', { cls: 'mpl-used-link', text: boardName(p), attr: { href: '#', title: p } });
        a.addEventListener('click', (e) => { e.preventDefault(); this.activateBoard(p); });
      }
    });

    const fields = this.section(el, 'Information').createDiv({ cls: 'mpl-fields' });
    const field = (label, value, cls) => {
      fields.createDiv({ cls: 'mpl-field-label', text: label });
      return fields.createDiv({ cls: 'mpl-field-value' + (cls ? ' ' + cls : ''), text: value == null ? '' : value });
    };
    const folder = parentPath(f);
    const folderEl = field('Folder', folder || 'Vault root', 'is-link');
    folderEl.addEventListener('click', () => this.setFilter(folder ? { kind: 'folder', value: folder } : { kind: 'all' }));
    field('Added', formatDate(this.added(f)));
    field('Modified', formatDate(f.stat.mtime));

    const actions = el.createDiv({ cls: 'mpl-actions' });
    this.action(actions, 'external-link', 'Open', () => this.openImage(f));
    this.action(actions, 'link', 'Copy link', () => this.copy(this.embedLink(f), 'embed link'));
    this.action(actions, 'folder-open', 'Reveal', () => this.reveal(f));
    this.action(actions, 'trash-2', 'Delete', () => this.confirmDelete([f]), 'mod-warning');

    const bottom = el.createDiv({ cls: 'mpl-dbottom' });
    bottom.createEl('button', { cls: 'mpl-btn', text: 'Full screen' }).addEventListener('click', () => this.fullFromDetails(f));
    bottom.createEl('button', { cls: 'mpl-btn-accent', text: 'Pick color' }).addEventListener('click', () => this.pickColor());
  }

  link(parent, url, title) {
    const a = parent.createEl('a', { cls: 'mpl-src external-link', text: title || url.replace(/^https?:\/\//, ''), href: url, attr: { target: '_blank', rel: 'noopener', title: url } });
    return a;
  }

  // EyeDropper where the browser has it (anywhere on screen); otherwise click the preview.
  async pickColor() {
    if (typeof window.EyeDropper === 'function') {
      try {
        const r = await new window.EyeDropper().open();
        if (r && r.sRGBHex) this.copy(r.sRGBHex, r.sRGBHex);
      } catch (_) { /* cancelled */ }
      return;
    }
    if (!this.previewEl) return;
    this.picking = true;
    this.previewEl.addClass('is-picking');
    new obsidian.Notice('Click the preview to pick a color');
  }

  sampleAt(img, e) {
    this.picking = false;
    if (this.previewEl) this.previewEl.removeClass('is-picking');
    const r = img.getBoundingClientRect();
    if (!(img.naturalWidth > 0) || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    try {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      const g = c.getContext('2d', { willReadFrequently: true });
      const sx = Math.floor((e.clientX - r.left) / r.width * img.naturalWidth);
      const sy = Math.floor((e.clientY - r.top) / r.height * img.naturalHeight);
      g.drawImage(img, sx, sy, 1, 1, 0, 0, 1, 1);
      const px = g.getImageData(0, 0, 1, 1).data;
      const hex = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      this.copy(hex, hex);
    } catch (_) {
      new obsidian.Notice('Could not read this image\'s colors');
    }
  }

  paintDims(f) {
    if (!this.dimsEl) return;
    const d = this.dims.get(f.path) || this.plugin.dims(f.path);
    this.dimsEl.setText((d ? d[0] + ' × ' + d[1] + ' · ' : '') + f.extension.toUpperCase() + ' · ' + formatBytes(f.stat.size));
  }

  paintTags(f) {
    const el = this.tagsEl;
    el.empty();
    const tags = this.info(f).tags;
    for (const t of tags) {
      const chip = el.createSpan({ cls: 'mpl-tag', text: t });
      const x = chip.createSpan({ cls: 'mpl-tag-x', attr: { 'aria-label': 'Remove tag ' + t } });
      obsidian.setIcon(x, 'x');
      x.addEventListener('click', () => {
        this.plugin.setMeta(f.path, { tags: tags.filter((y) => y !== t) });
        this.metaChanged(true);
      });
      chip.addEventListener('click', (e) => { if (e.target === chip) this.setFilter({ kind: 'tag', value: t }); });
    }
    const input = el.createEl('input', { cls: 'mpl-tag-input', attr: { type: 'text', placeholder: '+ tag', 'aria-label': 'Add a tag', list: 'mpl-tag-list' } });
    const list = el.createEl('datalist', { attr: { id: 'mpl-tag-list' } });
    const known = new Set();
    for (const g of this.allImages()) for (const t of this.info(g).tags) known.add(t);
    for (const t of known) if (!tags.includes(t)) list.createEl('option', { value: t });
    const add = () => {
      const more = input.value.split(',').map(normalizeTag).filter(Boolean);
      input.value = '';
      if (!more.length) return;
      this.plugin.setMeta(f.path, { tags: [...new Set(tags.concat(more))] });
      this.renderSidebar(this.allImages());
      if (this.filter.kind === 'untagged' || this.filter.kind === 'smart' || this.query) this.update();
      this.paintTags(f);
      this.tagsEl.querySelector('.mpl-tag-input').focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
      if (e.key === 'Escape') { e.stopPropagation(); input.value = ''; input.blur(); }
      if (e.key === 'Backspace' && !input.value && tags.length) {
        this.plugin.setMeta(f.path, { tags: tags.slice(0, -1) });
        this.renderSidebar(this.allImages());
        this.paintTags(f);
        this.tagsEl.querySelector('.mpl-tag-input').focus();
      }
    });
    input.addEventListener('blur', () => { if (input.value.trim()) add(); });
  }

  paintPalette(el, colors) {
    el.empty();
    for (const c of colors) {
      const s = el.createEl('button', { cls: 'mpl-swatch', attr: { 'aria-label': 'Copy ' + c, title: c, type: 'button' } });
      s.style.background = c;
      s.addEventListener('click', () => this.copy(c, c));
    }
  }

  computeColors(img) {
    try {
      const c = document.createElement('canvas');
      c.width = 48;
      c.height = 48;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, 48, 48);
      return dominantColors(g.getImageData(0, 0, 48, 48).data, 6);
    } catch (_) {
      return [];   // a cross-origin image taints the canvas; no palette then
    }
  }
}

class BoardSuggestModal extends obsidian.FuzzySuggestModal {
  constructor(app, boards, onChoose) {
    super(app);
    this.boards = boards;
    this.onChoose = onChoose;
    this.setPlaceholder('Open a board (.canvas file)');
  }
  getItems() { return this.boards; }
  getItemText(f) { return f.path.replace(/\.canvas$/i, ''); }
  onChooseItem(f) { this.onChoose(f); }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const ACCENTS = [['amber', 'Amber'], ['blue', 'Blue'], ['violet', 'Violet'], ['green', 'Green'], ['theme', 'Theme accent']];

class MarkportClipperPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.initLibrary();
    this.libraryViews = new Set();
    this.stores = new Map();        // board path -> BoardStore
    this.boardIndex = null;         // board path -> Set(image paths), built on first use
    this.addSettingTab(new ClipperSettingTab(this.app, this));

    this.registerView(LIBRARY_VIEW, (leaf) => new ImageLibraryView(leaf, this));
    this.registerView(PIN_VIEW, (leaf) => new PinnedBoardView(leaf, this));
    this.addRibbonIcon('images', 'Open image library', () => this.openLibrary());
    this.addCommand({ id: 'open-library', name: 'Open image library', callback: () => this.openLibrary() });
    this.addCommand({ id: 'new-board', name: 'New board', callback: async () => (await this.openLibrary()).newBoard() });
    this.addCommand({ id: 'open-board', name: 'Open board…', callback: async () => (await this.openLibrary()).chooseBoard() });
    this.addCommand({
      id: 'pin-board',
      name: 'Pin the current board over other apps',
      callback: async () => { const v = await this.openLibrary(); if (v) this.pinBoard(this.settings.libraryUi.board, v); },
    });

    // Library metadata follows files and folders around, and goes with them.
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (renameLibraryKeys(this.settings.library, oldPath, file.path)) this.saveLibrarySoon();
      if (isCanvasFile(file)) this.boardRenamed(oldPath, file.path);
      else if (isImageFile(file) || file instanceof obsidian.TFolder) this.relinkBoards(oldPath, file.path);
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (dropLibraryKeys(this.settings.library, file.path)) this.saveLibrarySoon();
      if (isCanvasFile(file)) this.boardDeleted(file.path);
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (!isCanvasFile(file)) return;
      const store = this.stores.get(file.path);
      if (store) store.load();
      else if (this.boardIndex) this.readCanvasPaths(file).then((s) => { if (this.boardIndex) this.boardIndex.set(file.path, s); });
    }));
    this.registerEvent(this.app.vault.on('create', (file) => {
      if (isCanvasFile(file) && this.boardIndex) this.readCanvasPaths(file).then((s) => { if (this.boardIndex) this.boardIndex.set(file.path, s); });
    }));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('markport-clipper-status');
    this.statusEl.setAttribute('aria-label', 'Folder for clipped images - click to change');
    this.registerDomEvent(this.statusEl, 'click', () => this.chooseFolder());
    this.updateStatus();

    this.addCommand({
      id: 'choose-folder',
      name: 'Choose clip folder',
      callback: () => this.chooseFolder(),
    });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof obsidian.TFolder)) return;
      const path = file.isRoot() ? '' : file.path;
      menu.addItem((item) => item
        .setTitle(path === this.settings.targetFolder ? 'Clipped images go here' : 'Save clipped images here')
        .setIcon('image-down')
        .setChecked(path === this.settings.targetFolder)
        .onClick(() => this.setTarget(path)));
    }));

    // Keep the target valid when its folder is renamed or deleted.
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof obsidian.TFolder)) return;
      const t = this.settings.targetFolder;
      if (t === oldPath || t.startsWith(oldPath + '/')) this.setTarget(file.path + t.slice(oldPath.length), true);
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file instanceof obsidian.TFolder && file.path === this.settings.targetFolder) this.setTarget('', true);
    }));

    if (this.isMarkport()) {
      const plugin = this;
      window.__markportClipper = {
        apiVersion: API_VERSION,
        info: async () => { await plugin.markportNameSettled(); return plugin.info(); },
        setTarget: (folder) => plugin.setTarget(folder),
        save: (payload) => plugin.saveImage(payload),
      };
    } else if (this.canServe()) {
      if (!this.settings.pairingKey) {
        this.settings.pairingKey = generateKey();
        await this.saveData(this.settings);
      }
      this.app.workspace.onLayoutReady(() => this.startServer());
    }
  }

  // ── library metadata (tags, notes, clip sources, sizes), in data.json ────

  initLibrary() {
    if (!this.settings.library || typeof this.settings.library !== 'object') this.settings.library = {};
    const ui = Object.assign({
      sort: 'added', thumb: 160, sideMin: false, gridMin: false, boardMin: false, restore: null,
      gridW: 0, boards: [], board: '', views: {}, smart: [], accent: 'amber',
    }, this.settings.libraryUi);
    // 0.2: a sidebar on/off switch and a docked inspector.
    if ('sidebar' in ui) { if (ui.sidebar === false) ui.sideMin = true; delete ui.sidebar; }
    delete ui.inspector;
    if (!Array.isArray(ui.boards)) ui.boards = [];
    ui.boards = ui.boards.filter((p) => typeof p === 'string' && p);
    if (typeof ui.board !== 'string' || (ui.board && !ui.boards.includes(ui.board))) ui.board = ui.boards[0] || '';
    if (!ui.views || typeof ui.views !== 'object') ui.views = {};
    if (!Array.isArray(ui.smart)) ui.smart = [];
    if (!ACCENTS.some(([v]) => v === ui.accent)) ui.accent = 'amber';
    this.settings.libraryUi = ui;
    if (typeof this.settings.boardsFolder !== 'string') this.settings.boardsFolder = 'Boards';
  }

  setMeta(path, patch) {
    this.initLibrary();
    const next = Object.assign({}, this.settings.library[path], patch);
    for (const k of Object.keys(next)) {
      const v = next[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) delete next[k];
    }
    if (Object.keys(next).length) this.settings.library[path] = next;
    else delete this.settings.library[path];
    this.saveLibrarySoon();
  }

  saveLibrarySoon() {
    clearTimeout(this.libraryTimer);
    this.libraryTimer = setTimeout(() => {
      this.libraryTimer = null;
      this.saveData(this.settings);
    }, 800);
  }

  allImages() { return this.app.vault.getFiles().filter(isImageFile); }

  imageInfo(f) {
    const m = this.settings.library[f.path] || {};
    return { path: f.path, tags: m.tags || [], note: m.note || '', source: m.source || '', title: m.title || '', colors: m.colors || [] };
  }

  added(f) {
    const m = this.settings.library[f.path];
    return (m && m.added) || f.stat.ctime;
  }

  dims(path) {
    const m = this.settings.library[path];
    return m && m.w > 0 && m.h > 0 ? [m.w, m.h] : null;
  }

  // Newest first.
  searchImages(query) {
    const q = parseQuery(query);
    const has = String(query || '').trim();
    return this.allImages()
      .filter((f) => !has || matchesQuery(this.imageInfo(f), q))
      .sort((a, b) => this.added(b) - this.added(a));
  }

  // Write image files from the computer into the vault. Returns the new paths.
  async importFiles(files, folder, tag) {
    const images = files.filter((f) => /^image\//.test(f.type) || IMAGE_EXTS.has((f.name.split('.').pop() || '').toLowerCase()));
    if (!images.length) {
      if (files.length) new obsidian.Notice('Only images can be imported here');
      return [];
    }
    const vault = this.app.vault;
    const exists = (p) => !!vault.getAbstractFileByPath(p);
    const done = [];
    try {
      await this.ensureFolder(folder);
      for (const file of images) {
        const dot = file.name.lastIndexOf('.');
        const ext = (dot > 0 ? file.name.slice(dot + 1) : extFromMime(file.type) || 'png').toLowerCase();
        const base = sanitizeName(dot > 0 ? file.name.slice(0, dot) : file.name) || 'image';
        const p = uniquePath(folder, base + '.' + ext, exists);
        await vault.createBinary(p, await file.arrayBuffer());
        this.setMeta(p, Object.assign({ added: Date.now() }, tag ? { tags: [tag] } : {}));
        done.push(p);
      }
    } catch (e) {
      new obsidian.Notice('Import failed: ' + ((e && e.message) || e));
    }
    if (done.length) new obsidian.Notice('Imported ' + done.length + (done.length === 1 ? ' image' : ' images') + ' into ' + (folder || 'the vault root'));
    return done;
  }

  async openLibrary(boardPath) {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(LIBRARY_VIEW)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: LIBRARY_VIEW, active: true });
    }
    // Obsidian 1.7+ defers views in background tabs until they are shown.
    await workspace.revealLeaf(leaf);
    if (leaf.loadIfDeferred) await leaf.loadIfDeferred();
    const view = leaf.view instanceof ImageLibraryView ? leaf.view : null;
    if (view && boardPath) view.activateBoard(boardPath);
    return view;
  }

  // ── boards ──────────────────────────────────────────────────────────────

  board(path) {
    let s = this.stores.get(path);
    if (!s) {
      s = new BoardStore(this, path);
      this.stores.set(path, s);
    }
    return s;
  }

  async createBoard(name) {
    const folder = normalizeFolder(this.settings.boardsFolder);
    await this.ensureFolder(folder);
    const base = sanitizeName(name) || 'Untitled board';
    const path = uniquePath(folder, base + '.canvas', (p) => !!this.app.vault.getAbstractFileByPath(p));
    await this.app.vault.create(path, serializeCanvas(parseCanvas('')));
    return path;
  }

  indexBoard(path, data) {
    if (this.boardIndex) this.boardIndex.set(path, canvasImagePaths(data));
  }

  async readCanvasPaths(f) {
    try { return canvasImagePaths(parseCanvas(await this.app.vault.cachedRead(f))); } catch (_) { return new Set(); }
  }

  ensureBoardIndex() {
    if (this.boardIndex) return Promise.resolve(this.boardIndex);
    if (!this.indexing) {
      this.indexing = (async () => {
        const idx = new Map();
        for (const f of this.app.vault.getFiles()) if (isCanvasFile(f)) idx.set(f.path, await this.readCanvasPaths(f));
        for (const [p, s] of this.stores) if (s.data) idx.set(p, canvasImagePaths(s.data));
        this.boardIndex = idx;
        this.indexing = null;
        return idx;
      })();
    }
    return this.indexing;
  }

  async boardsUsing(imagePath) {
    const idx = await this.ensureBoardIndex();
    return [...idx].filter(([, s]) => s.has(imagePath)).map(([p]) => p).sort((a, b) => a.localeCompare(b));
  }

  // An image or folder moved: keep boards pointing at it. Obsidian may update
  // canvas links itself; then there is nothing left to change here.
  async relinkBoards(oldPath, newPath) {
    const idx = await this.ensureBoardIndex();
    for (const [cp, set] of idx) {
      if (![...set].some((p) => p === oldPath || p.startsWith(oldPath + '/'))) continue;
      const store = this.stores.get(cp);
      if (store && store.data) {
        if (renameInCanvas(store.data, oldPath, newPath)) store.change();
        continue;
      }
      setTimeout(async () => {
        const f = this.app.vault.getAbstractFileByPath(cp);
        if (!isCanvasFile(f)) return;
        try {
          const data = parseCanvas(await this.app.vault.read(f));
          if (renameInCanvas(data, oldPath, newPath)) await this.app.vault.modify(f, serializeCanvas(data));
        } catch (_) { /* not ours to fix */ }
      }, 300);
    }
  }

  boardRenamed(oldPath, newPath) {
    const ui = this.settings.libraryUi;
    const store = this.stores.get(oldPath);
    if (store) {
      this.stores.delete(oldPath);
      store.path = newPath;
      this.stores.set(newPath, store);
    }
    if (this.boardIndex && this.boardIndex.has(oldPath)) {
      this.boardIndex.set(newPath, this.boardIndex.get(oldPath));
      this.boardIndex.delete(oldPath);
    }
    ui.boards = ui.boards.map((p) => (p === oldPath ? newPath : p));
    if (ui.board === oldPath) ui.board = newPath;
    if (ui.views[oldPath]) { ui.views[newPath] = ui.views[oldPath]; delete ui.views[oldPath]; }
    this.saveLibrarySoon();
    if (store) store.emit();
    for (const v of this.libraryViews) v.boardsChanged();
  }

  boardDeleted(path) {
    const ui = this.settings.libraryUi;
    const store = this.stores.get(path);
    if (store) { store.gone(); this.stores.delete(path); }
    if (this.boardIndex) this.boardIndex.delete(path);
    const i = ui.boards.indexOf(path);
    if (i >= 0) {
      ui.boards.splice(i, 1);
      if (ui.board === path) ui.board = ui.boards[Math.min(i, ui.boards.length - 1)] || '';
    }
    delete ui.views[path];
    this.saveLibrarySoon();
    for (const v of this.libraryViews) v.boardsChanged();
  }

  // "Pin over app…": Picture-in-Picture where the browser has it, else an
  // Obsidian popout window on desktop, else a floating panel in the library.
  async pinBoard(path, view) {
    if (!path) { new obsidian.Notice('Open a board first'); return; }
    const dpip = window.documentPictureInPicture;
    if (dpip && typeof dpip.requestWindow === 'function') {
      try {
        if (dpip.window) dpip.window.close();
        const pip = await dpip.requestWindow({ width: 520, height: 680 });
        copyStyles(document, pip.document);
        const mini = new MiniBoard(pip.document.body, this, path, {
          mode: 'pip',
          onUnpin: () => pip.close(),
          onOpenMain: () => { window.focus(); this.openLibrary(path); pip.close(); },
        });
        this.pipWindow = pip;
        pip.addEventListener('pagehide', () => {
          mini.destroy();
          if (this.pipWindow === pip) this.pipWindow = null;
        });
        return;
      } catch (e) {
        console.warn('[markport-clipper] picture-in-picture failed, falling back', e);
      }
    }
    if (!this.isMarkport() && obsidian.Platform && obsidian.Platform.isDesktopApp && typeof this.app.workspace.openPopoutLeaf === 'function') {
      const leaf = this.app.workspace.openPopoutLeaf({ size: { width: 520, height: 680 } });
      await leaf.setViewState({ type: PIN_VIEW, state: { board: path }, active: true });
      return;
    }
    if (view) view.floatBoard(path);
  }

  setAccent(accent) {
    this.settings.libraryUi.accent = accent;
    this.saveLibrarySoon();
    for (const v of this.libraryViews) {
      if (v.rootEl) v.rootEl.dataset.accent = accent;
      if (v.floatMini) v.floatMini.root.dataset.accent = accent;
    }
  }

  onunload() {
    for (const s of this.stores.values()) s.flush();
    if (this.pipWindow) { try { this.pipWindow.close(); } catch (_) { /* gone */ } }
    if (this.libraryTimer) {
      clearTimeout(this.libraryTimer);
      this.saveData(this.settings);
    }
    if (this.isMarkport() && window.__markportClipper) delete window.__markportClipper;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // A Markport server vault is addressed by id (/vault/<id>), and getName()
  // returns that id until Markport has fetched the folder name, a moment
  // after the vault opens. The extension keys vaults by name, so wait for it.
  async markportNameSettled() {
    const m = /\/vault\/([^/?#]+)/.exec(window.location.pathname);
    const id = m && decodeURIComponent(m[1]);
    for (let i = 0; id && this.app.vault.getName() === id && i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // window.__owPlatform only exists in Markport (see docs/system-plugin-dev-guide.md).
  // It is published as Obsidian's bundle loads, well before any plugin's onload.
  isMarkport() {
    return typeof window.__owPlatform !== 'undefined';
  }

  // Desktop Obsidian has Node's http module; the mobile apps do not. Markport
  // may expose Node to plugins (MARKPORT_NODE_BRIDGE), but a server there
  // would listen inside the container, not on the user's machine.
  canServe() {
    if (this.isMarkport() || !obsidian.Platform.isDesktopApp) return false;
    try { return typeof require('http').createServer === 'function'; } catch (_) { return false; }
  }

  // ── desktop HTTP server ─────────────────────────────────────────────────

  async startServer(basePort, count) {
    const http = require('http');
    const first = basePort || BASE_PORT;
    const n = count || PORT_COUNT;
    for (let port = first; port < first + n; port++) {
      const server = http.createServer((req, res) => this.handleRequest(req, res, port));
      const err = await new Promise((resolve) => {
        server.once('error', resolve);
        server.listen(port, '127.0.0.1', () => resolve(null));
      });
      if (!err) {
        server.on('error', (e) => console.error('[markport-clipper]', e));
        this.server = server;
        this.port = port;
        this.serverError = null;
        return port;
      }
      if (err.code !== 'EADDRINUSE') {
        this.serverError = err.message;
        console.error('[markport-clipper] cannot listen:', err);
        return null;
      }
    }
    this.serverError = 'ports ' + first + '-' + (first + n - 1) + ' are all in use';
    console.error('[markport-clipper] ' + this.serverError);
    return null;
  }

  handleRequest(req, res, port) {
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(text);
    };
    const url = String(req.url || '').split('?')[0];
    const route = req.method + ' ' + url;
    const known = ['GET /ping', 'GET /info', 'POST /target', 'POST /save'];
    if (!known.includes(route)) return send(404, { error: 'Not found' });

    const denied = checkRequest(req.headers, port, this.settings.pairingKey, route !== 'GET /ping');
    if (denied) return send(denied.status, { error: denied.error });

    if (route === 'GET /ping') return send(200, { app: 'markport-clipper', apiVersion: API_VERSION });
    if (route === 'GET /info') return send(200, { value: this.info() });

    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return send(415, { error: 'Send JSON' });
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        send(413, { error: 'The image is larger than ' + (MAX_BYTES >> 20) + ' MB' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (aborted) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return send(400, { error: 'Bad JSON' }); }
      try {
        const value = route === 'POST /target'
          ? await this.setTarget(body && body.folder)
          : await this.saveImage(body);
        send(200, { value });
      } catch (e) {
        send(400, { error: String((e && e.message) || e) });
      }
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.updateStatus();
  }

  updateStatus() {
    if (this.statusEl) this.statusEl.setText('Clips: ' + (this.settings.targetFolder || '/'));
  }

  listFolders() {
    return this.app.vault.getAllLoadedFiles()
      .filter((f) => f instanceof obsidian.TFolder && !f.isRoot())
      .map((f) => f.path)
      .filter((p) => !p.split('/').some((seg) => seg.startsWith('.')))
      .sort((a, b) => a.localeCompare(b));
  }

  info() {
    return {
      apiVersion: API_VERSION,
      vault: this.app.vault.getName(),
      target: this.settings.targetFolder,
      folders: [''].concat(this.listFolders()),
      createNote: this.settings.createNote,
    };
  }

  chooseFolder() {
    new FolderSuggestModal(this.app, [''].concat(this.listFolders()), (f) => this.setTarget(f)).open();
  }

  async ensureFolder(folder) {
    if (!folder) return;
    let path = '';
    for (const seg of folder.split('/')) {
      path = joinPath(path, seg);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof obsidian.TFolder) continue;
      if (existing) throw new Error('"' + path + '" is a file, not a folder');
      await this.app.vault.createFolder(path);
    }
  }

  // Creates the folder if it doesn't exist yet, so the extension can offer
  // "New folder…" with no extra API.
  async setTarget(folder, quiet) {
    const target = normalizeFolder(folder);
    await this.ensureFolder(target);
    this.settings.targetFolder = target;
    await this.saveSettings();
    if (!quiet) new obsidian.Notice('Clipped images will be saved to ' + (target || 'the vault root'));
    return this.info();
  }

  /**
   * payload: { data: base64, mime, url?, pageUrl?, pageTitle?, alt?, folder? }
   * folder, when given, overrides the saved target for this one image.
   * Returns { path, notePath? }.
   */
  async saveImage(payload) {
    if (!payload || typeof payload.data !== 'string') throw new Error('No image data');
    const mime = String(payload.mime || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) throw new Error('Not an image (' + (mime || 'unknown type') + ')');

    const buf = base64ToArrayBuffer(payload.data);
    if (buf.byteLength === 0) throw new Error('The image is empty');
    if (buf.byteLength > MAX_BYTES) throw new Error('The image is larger than ' + (MAX_BYTES >> 20) + ' MB');

    const folder = normalizeFolder(payload.folder != null ? payload.folder : this.settings.targetFolder);
    await this.ensureFolder(folder);

    const vault = this.app.vault;
    const exists = (p) => !!vault.getAbstractFileByPath(p);
    const name = buildFileName({ url: payload.url, mime, alt: payload.alt, pageTitle: payload.pageTitle });
    const path = uniquePath(folder, name, exists);
    await vault.createBinary(path, buf);
    // For the library's inspector: where it came from, and when.
    this.setMeta(path, {
      added: Date.now(),
      source: payload.url && !/^(data|blob):/i.test(payload.url) ? String(payload.url) : '',
      page: payload.pageUrl ? String(payload.pageUrl) : '',
      title: payload.pageTitle ? String(payload.pageTitle) : '',
    });

    let notePath;
    if (this.settings.createNote) {
      notePath = uniquePath(folder, path.slice(folder ? folder.length + 1 : 0).replace(/\.[^.]+$/, '') + '.md', exists);
      await vault.create(notePath, buildNote(path, payload, new Date().toISOString()));
    }

    if (this.settings.showNotice) new obsidian.Notice('Saved ' + path);
    return { path, notePath };
  }
}

module.exports = MarkportClipperPlugin;
module.exports.helpers = {
  extFromMime, sanitizeName, nameFromUrl, buildFileName, normalizeFolder, uniquePath, buildNote,
  generateKey, checkRequest, BASE_PORT, PORT_COUNT,
  formatBytes, normalizeTag, parseQuery, matchesQuery, renameLibraryKeys, dropLibraryKeys, dominantColors,
  hexToRgb, colorTarget, parseCanvas, serializeCanvas, canvasImagePaths, renameInCanvas, boxAround, fitView,
  simplifyPoints, strokePath, canvasColor, boardName,
};
