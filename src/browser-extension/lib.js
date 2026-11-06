/**
 * Pure helpers shared by background.js (via importScripts) and the tests
 * (via require). No chrome.* APIs in here.
 */
(function (root) {
  'use strict';

  const DEFAULT_ORIGINS = ['http://127.0.0.1:3500', 'http://localhost:3500'];
  const MAX_BYTES = 50 * 1024 * 1024;
  // Desktop Obsidian: the plugin listens on the first free port from here
  // (src/plugins/markport-clipper/main.js has the same two numbers).
  const BASE_PORT = 27150;
  const PORT_COUNT = 10;

  // The pairing key shown in the plugin's settings: 48 hex characters.
  function normalizeKey(value) {
    const s = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{48}$/.test(s) ? s : null;
  }

  // Each open vault gets one id per way in, so a vault open both in Markport
  // and in desktop Obsidian shows up twice, labelled.
  function vaultId(kind, name) { return kind + ':' + name; }
  function vaultLabel(kind, name) { return name + (kind === 'desktop' ? ' (Obsidian)' : ' (Markport)'); }

  // "https://notes.example.com/vault/abc" -> "https://notes.example.com"; junk -> null.
  function normalizeOrigin(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    let s = value.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin;
    } catch (_) {
      return null;
    }
  }

  function originMatches(url, origins) {
    let o;
    try { o = new URL(url).origin; } catch (_) { return false; }
    return origins.some((x) => normalizeOrigin(x) === o);
  }

  // Content-Type is often missing or "application/octet-stream" (S3, CDNs),
  // so look at the first bytes too.
  function sniffMime(bytes) {
    const b = bytes;
    const at = (i, arr) => arr.every((v, j) => b[i + j] === v);
    if (b.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (b.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (b.length >= 6 && (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return 'image/gif';
    if (b.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
    if (b.length >= 12 && at(4, [0x66, 0x74, 0x79, 0x70])) {
      const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
      if (/^(heic|heix|mif1|msf1)$/.test(brand)) return 'image/heic';
    }
    if (b.length >= 2 && at(0, [0x42, 0x4d])) return 'image/bmp';
    if (b.length >= 4 && at(0, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
    if (b.length >= 4 && (at(0, [0x49, 0x49, 0x2a, 0x00]) || at(0, [0x4d, 0x4d, 0x00, 0x2a]))) return 'image/tiff';
    // SVG is text: look for an <svg tag near the start, after an optional XML prolog / BOM / comments.
    let head = '';
    for (let i = 0; i < Math.min(b.length, 1024); i++) head += String.fromCharCode(b[i]);
    if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
    return null;
  }

  function resolveMime(headerType, bytes) {
    const t = String(headerType || '').split(';')[0].trim().toLowerCase();
    if (t.startsWith('image/')) return t;
    return sniffMime(bytes);
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  // Which open vault to save into: the one picked last, otherwise the most
  // recently used Markport tab, otherwise desktop Obsidian.
  function pickVault(vaults, preferredId) {
    if (!vaults.length) return null;
    const byRecent = vaults.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return byRecent.find((v) => v.id === preferredId) || byRecent[0];
  }

  // The order of the folder menu's grid: the folder an image was last saved
  // to first (top left), then the other recent ones, the default folder, and
  // every other folder in tree order. Recent folders that are no longer in
  // the vault (deleted or renamed since) are left out.
  function folderGrid(target, recent, folders, exclude) {
    const all = Array.isArray(folders) ? folders : [];
    const known = new Set(all);
    const skip = new Set(Array.isArray(exclude) ? exclude : []);
    const out = [];
    const add = (f) => { if (typeof f === 'string' && !out.includes(f) && !skip.has(f)) out.push(f); };
    for (const f of Array.isArray(recent) ? recent : []) if (!all.length || known.has(f)) add(f);
    add(target);
    all.forEach(add);
    return out;
  }

  // The folders starred in the image library (its Favorites), in their
  // order, without duplicates and without ones the vault no longer has.
  function favoriteFolders(favorites, folders) {
    const all = Array.isArray(folders) ? folders : null;
    const known = all && new Set(all);
    const out = [];
    for (const f of Array.isArray(favorites) ? favorites : []) {
      if (typeof f !== 'string' || out.includes(f) || (known && !known.has(f))) continue;
      out.push(f);
    }
    return out;
  }

  // The folder menu's tree: parent path -> its subfolders, by name. The
  // vault root is ''. A folder whose parent is missing from the list still
  // gets one, so nothing is left out of the tree.
  function folderTree(folders) {
    const kids = new Map([['', []]]);
    const seen = new Set(['']);
    const add = (f) => {
      if (seen.has(f)) return;
      seen.add(f);
      const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
      add(parent);
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(f);
    };
    for (const f of Array.isArray(folders) ? folders : []) if (typeof f === 'string' && f) add(f);
    const name = (f) => f.slice(f.lastIndexOf('/') + 1);
    for (const list of kids.values()) {
      list.sort((a, b) => name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: 'base' }));
    }
    return kids;
  }

  // A selection in CSS pixels of a viewport (vw x vh) -> the same area in a
  // capture of that viewport (bw x bh device pixels), clamped to the capture.
  // Scaling by capture/viewport rather than devicePixelRatio also covers
  // page zoom. Returns null when nothing is left.
  function cropRect(rect, vw, vh, bw, bh) {
    if (!rect || !(vw > 0) || !(vh > 0)) return null;
    const sx = bw / vw;
    const sy = bh / vh;
    const x = Math.max(0, Math.round(rect.x * sx));
    const y = Math.max(0, Math.round(rect.y * sy));
    const w = Math.min(bw, Math.round((rect.x + rect.w) * sx)) - x;
    const h = Math.min(bh, Math.round((rect.y + rect.h) * sy)) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  const api = {
    DEFAULT_ORIGINS, MAX_BYTES, BASE_PORT, PORT_COUNT,
    normalizeOrigin, originMatches, normalizeKey, vaultId, vaultLabel,
    sniffMime, resolveMime, bytesToBase64, pickVault, folderGrid, favoriteFolders, folderTree, cropRect,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarkportLib = api;
})(typeof self !== 'undefined' ? self : this);
