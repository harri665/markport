/**
 * Public share pages, /s/<id>/...
 *
 *   (<id> is the share id or its custom link)
 *   GET  /s/<id>                 file share: the note; folder share: its index
 *   GET  /s/<id>/n/<path>        a note (or subfolder) inside a folder share
 *   GET  /s/<id>/raw/<path>      a file inside the share (images, PDFs, ...),
 *                                or "Linked files/<name>" for an embedded
 *                                attachment that lives outside it
 *   GET  /s/<id>/theme.css       the owner's theme + enabled CSS snippets
 *   GET  /s/<id>/edit?note=      edit shares: open the editor (/vault/<id>/...)
 *   POST /s/<id>/unlock          password-protected shares
 *
 * Opening any of these (after the password, if there is one) sets the share's
 * grant cookie, which the editor's API requests then carry. Paths are always
 * share-relative and go through the same Scope.resolve() as the editor's
 * /api/fs, so a page can reach exactly what the editor can.
 */

'use strict';

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { vaultIndex, LINKED, ext } = require('./scope');
const { renderNote, escapeHtml, encodePath, basenameNoMd } = require('./render');
const { shell, messagePage, unlockPage, pageHeaders } = require('./html');
const { verifyPassword, ShareStore } = require('./store');
const { createLimiter } = require('../auth');

const basePath = (share) => ShareStore.basePath(share);

const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_TREE_ENTRIES = 3000;
const RAW_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

function safeNext(next, share) {
  const home = basePath(share);
  if (typeof next !== 'string' || next.includes('\\') || next.startsWith('//')) return home;
  const ok = ['/s/' + share.id, '/vault/' + share.id].concat(share.slug ? ['/s/' + share.slug] : [])
    .some((p) => next === p || next.startsWith(p + '/') || next.startsWith(p + '?'));
  return ok ? next : home;
}

function shareTitle(scope) {
  if (scope.isFile) return basenameNoMd(scope.share.path);
  if (scope.share.path) return scope.share.path.slice(scope.share.path.lastIndexOf('/') + 1);
  return path.basename(scope.vaultRoot);
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) || {}; } catch (_) { return {}; }
}

function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function cssFontList(v) {
  return typeof v === 'string' && /^[\w\s,'".-]{1,200}$/.test(v) ? v : null;
}

async function ownerLook(scope) {
  const [appearance, app] = await Promise.all([
    readJson(path.join(scope.ownerConfigDir, 'appearance.json')),
    readJson(path.join(scope.ownerConfigDir, 'app.json')),
  ]);
  const light = appearance.theme === 'moonstone';
  const style = [];
  const hsl = hexToHsl(appearance.accentColor);
  if (hsl) style.push('--accent-h:' + hsl.h, '--accent-s:' + hsl.s + '%', '--accent-l:' + hsl.l + '%');
  if (Number.isFinite(appearance.baseFontSize)) style.push('--font-text-size:' + Math.min(40, Math.max(8, appearance.baseFontSize)) + 'px');
  const fonts = { textFontFamily: '--font-text-override', interfaceFontFamily: '--font-interface-override', monospaceFontFamily: '--font-monospace-override' };
  for (const [k, v] of Object.entries(fonts)) {
    const f = cssFontList(appearance[k]);
    if (f) style.push(v + ':' + f);
  }
  const hasTheme = !!(appearance.cssTheme || (Array.isArray(appearance.enabledCssSnippets) && appearance.enabledCssSnippets.length));
  return {
    bodyClass: (light ? 'theme-light' : 'theme-dark') + ' mp-share-page markdown-preview-view-host' +
      (app.readableLineLength === false ? '' : ' is-readable-line-width') + (appearance.showInlineTitle === false ? '' : ' show-inline-title'),
    bodyStyle: style.join(';'),
    hasTheme,
    breaks: !app.strictLineBreaks,
    appearance,
  };
}

function createSharePages({ shares, auth, scopes }) {
  const router = express.Router();
  // Custom links can be guessed, so a client that keeps opening links that
  // don't exist is stopped: after 30 misses in 15 minutes every /s/ lookup
  // from it gets 429 until the window passes.
  const missLimiter = createLimiter(30, 15 * 60 * 1000);

  router.get('/-/share.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'share.css'), { headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'text/css; charset=utf-8' } });
  });

  function sendMessage(res, status, title, message) {
    pageHeaders(res);
    res.status(status).send(messagePage(title, message));
  }

  async function load(req, res) {
    const client = auth.clientKey(req);
    if (missLimiter.blocked(client)) {
      sendMessage(res, 429, 'Too many requests', 'Too many links that don\'t exist were opened from here. Try again in a few minutes.');
      return null;
    }
    const share = shares.lookup(req.params.id);
    if (!share) {
      missLimiter.fail(client);
      sendMessage(res, 404, 'Link not found', 'This link doesn\'t exist, or it was revoked.');
      return null;
    }
    if (shares.isExpired(share)) { sendMessage(res, 410, 'Link expired', 'This shared link has expired.'); return null; }
    const scope = scopes.forShare(share);
    if (!scope || !(await scope.exists())) { sendMessage(res, 404, 'No longer available', 'The shared item was moved or deleted.'); return null; }
    return { share, scope };
  }

  // Load the share and check its password. Sets req.share / req.scope.
  async function access(req, res, next) {
    try {
      const loaded = await load(req, res);
      if (!loaded) return;
      if (!auth.hasGrant(req, loaded.share)) {
        if (loaded.share.passwordHash) {
          pageHeaders(res);
          return res.status(401).send(unlockPage(loaded.share, req.originalUrl));
        }
        auth.setGrant(req, res, loaded.share);
      }
      req.share = loaded.share;
      req.scope = loaded.scope;
      next();
    } catch (err) {
      next(err);
    }
  }

  router.post('/:id/unlock', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res, next) => {
    try {
      const loaded = await load(req, res);
      if (!loaded) return;
      const { share } = loaded;
      const nextUrl = safeNext(req.body && req.body.next, share);
      if (!share.passwordHash) return res.redirect(303, nextUrl);
      const key = auth.clientKey(req) + '|' + share.id;
      pageHeaders(res);
      if (auth.unlockLimiter.blocked(key)) return res.status(429).send(unlockPage(share, nextUrl, 'Too many attempts. Try again in a few minutes.'));
      if (!verifyPassword(String((req.body && req.body.password) || ''), share.passwordHash)) {
        auth.unlockLimiter.fail(key);
        return res.status(401).send(unlockPage(share, nextUrl, 'Wrong password.'));
      }
      auth.unlockLimiter.reset(key);
      auth.setGrant(req, res, share);
      res.redirect(303, nextUrl);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/theme.css', access, async (req, res) => {
    const { scope } = req;
    const look = await ownerLook(scope);
    const parts = [];
    const read = async (rel) => {
      const abs = path.join(scope.ownerConfigDir, ...rel.split('/'));
      if (!abs.startsWith(scope.ownerConfigDir + path.sep)) return;
      try { parts.push('/* ' + rel.replace(/\*\//g, '') + ' */\n' + (await fsp.readFile(abs, 'utf8'))); } catch (_) { /* missing */ }
    };
    const theme = look.appearance.cssTheme;
    if (typeof theme === 'string' && theme && !/[\\/]|\.\./.test(theme)) {
      const before = parts.length;
      await read('themes/' + theme + '/theme.css');
      if (parts.length === before) await read('themes/' + theme + '.css');   // pre-1.0 theme layout
    }
    for (const s of Array.isArray(look.appearance.enabledCssSnippets) ? look.appearance.enabledCssSnippets : []) {
      if (typeof s === 'string' && !/[\\/]|\.\./.test(s)) await read('snippets/' + s + '.css');
    }
    res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(parts.join('\n\n'));
  });

  router.get('/:id/raw/*', access, async (req, res) => {
    try {
      const r = await req.scope.resolve(req.params[0], 'read');
      if (r.area !== 'content' && r.area !== 'linked') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      const st = await fsp.stat(r.abs);
      if (!st.isFile()) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': RAW_CSP, 'Referrer-Policy': 'no-referrer' });
      res.sendFile(r.abs, { dotfiles: 'allow' });
    } catch (err) {
      res.status(err.code === 'EACCES' ? 403 : 404).type('text/plain').send('Not found');
    }
  });

  router.get('/:id/edit', access, (req, res) => {
    const { share, scope } = req;
    let note = typeof req.query.note === 'string' ? req.query.note : '';
    if (scope.isFile) note = scope.fileName;
    if (share.permission !== 'edit') {
      return res.redirect(303, basePath(share) + (note && !scope.isFile ? '/n/' + encodePath(note) : ''));
    }
    res.redirect(303, '/vault/' + share.id + (note ? '/' + encodePath(note) : ''));
  });

  router.get('/:id', access, (req, res, next) => {
    if (req.scope.isFile) return renderNotePage(req, res, req.scope.share.path).catch(next);
    renderFolderPage(req, res, '').catch(next);
  });

  router.get('/:id/n/*', access, async (req, res, next) => {
    try {
      const { scope } = req;
      if (scope.isFile) return res.redirect(303, basePath(scope.share));
      const r = await scope.resolve(req.params[0], 'read').catch(() => null);
      if (!r || (r.area !== 'content' && r.area !== 'root')) return sendMessage(res, 404, 'Not found', 'There is no such note in this share.');
      const st = await fsp.stat(r.abs).catch(() => null);
      if (!st) return sendMessage(res, 404, 'Not found', 'There is no such note in this share.');
      const vaultRel = scope.toVaultRel(req.params[0]);
      if (st.isDirectory()) return renderFolderPage(req, res, vaultRel);
      if (!vaultRel.toLowerCase().endsWith('.md')) return res.redirect(303, basePath(scope.share) + '/raw/' + encodePath(req.params[0]));
      return renderNotePage(req, res, vaultRel);
    } catch (err) {
      next(err);
    }
  });

  // ── page assembly ──────────────────────────────────────────────────────────

  function noteUrl(scope, rel) {
    const base = basePath(scope.share);
    return scope.isFile ? base : base + '/n/' + encodePath(scope.toShareRel(rel));
  }

  function crumbs(scope, vaultRel, isDir) {
    const base = basePath(scope.share);
    const root = '<a href="' + base + '">' + escapeHtml(shareTitle(scope)) + '</a>';
    if (scope.isFile) return '<span class="mp-current">' + escapeHtml(shareTitle(scope)) + '</span>';
    const inside = vaultRel ? scope.toShareRel(vaultRel) : '';
    if (!inside) return '<span class="mp-current">' + escapeHtml(shareTitle(scope)) + '</span>';
    const segs = inside.split('/');
    const out = [root];
    segs.forEach((s, i) => {
      const last = i === segs.length - 1;
      const label = last && !isDir ? basenameNoMd(s) : s;
      if (last) out.push('<span class="mp-current">' + escapeHtml(label) + '</span>');
      else out.push('<a href="' + base + '/n/' + encodePath(segs.slice(0, i + 1).join('/')) + '">' + escapeHtml(s) + '</a>');
    });
    return out.join('<span class="mp-sep">/</span>');
  }

  // Nested tree of the share's files (share-relative), for the sidebar.
  function buildTree(scope, index) {
    const root = { dirs: new Map(), files: [] };
    let count = 0;
    for (const f of index.files) {
      if (!scope.inScope(f)) continue;
      if (++count > MAX_TREE_ENTRIES) break;
      const segs = scope.toShareRel(f).split('/');
      let node = root;
      for (const s of segs.slice(0, -1)) {
        if (!node.dirs.has(s)) node.dirs.set(s, { dirs: new Map(), files: [] });
        node = node.dirs.get(s);
      }
      node.files.push(segs[segs.length - 1]);
    }
    return root;
  }

  function renderTree(scope, node, prefix, current, small) {
    const base = basePath(scope.share);
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    let html = '<ul' + (prefix ? '' : ' class="mp-tree"') + '>';
    for (const name of [...node.dirs.keys()].sort(coll.compare)) {
      const rel = prefix ? prefix + '/' + name : name;
      const open = small || (current && (current === rel || current.startsWith(rel + '/')));
      html += '<li><details' + (open ? ' open' : '') + '><summary>' + escapeHtml(name) + '</summary>' +
        renderTree(scope, node.dirs.get(name), rel, current, small) + '</details></li>';
    }
    for (const name of node.files.sort(coll.compare)) {
      const rel = prefix ? prefix + '/' + name : name;
      const isMd = name.toLowerCase().endsWith('.md');
      const href = base + (isMd ? '/n/' : '/raw/') + encodePath(rel);
      html += '<li><a href="' + escapeHtml(href) + '"' + (rel === current ? ' class="is-active"' : '') + '>' +
        escapeHtml(isMd ? name.slice(0, -3) : name) + (isMd ? '' : '<span class="mp-ext">' + escapeHtml(ext(name)) + '</span>') + '</a></li>';
    }
    return html + '</ul>';
  }

  async function layout(req, res, { vaultRel, isDir, title, contentHtml, index }) {
    const { scope, share } = req;
    const look = await ownerLook(scope);
    let nav = '';
    if (!scope.isFile) {
      const tree = buildTree(scope, index);
      const current = vaultRel ? scope.toShareRel(vaultRel) : '';
      nav = '<details class="mp-share-nav" open><summary class="mp-nav-toggle">Files</summary>' +
        renderTree(scope, tree, '', current, index.files.length < 200) + '</details>';
    }
    let action = '';
    if (share.permission === 'edit') {
      const note = !isDir && vaultRel ? scope.toShareRel(vaultRel) : '';
      action = '<a class="mp-button" href="' + basePath(share) + '/edit' + (note ? '?note=' + encodeURIComponent(note) : '') + '">Open in editor</a>';
    } else {
      action = '<span class="mp-badge">View only</span>';
    }
    const body =
      '<div class="mp-share"><header class="mp-share-header"><div class="mp-share-crumbs">' + crumbs(scope, vaultRel, isDir) + '</div>' + action + '</header>' +
      '<div class="mp-share-body">' + nav +
      '<main class="mp-share-content markdown-reading-view"><div class="markdown-preview-view markdown-rendered node-insert-event' +
      (look.bodyClass.includes('is-readable-line-width') ? ' is-readable-line-width' : '') + '"><div class="markdown-preview-sizer markdown-preview-section">' +
      (look.bodyClass.includes('show-inline-title') ? '<div class="inline-title">' + escapeHtml(title) + '</div>' : '<h1>' + escapeHtml(title) + '</h1>') +
      contentHtml + '</div></div></main></div></div>';
    pageHeaders(res);
    res.send(shell({
      title: title + (scope.isFile ? '' : ' · ' + shareTitle(scope)),
      bodyClass: look.bodyClass,
      bodyStyle: look.bodyStyle,
      head: look.hasTheme ? '<link rel="stylesheet" href="' + basePath(share) + '/theme.css">' : '',
      body,
    }));
  }

  async function renderNotePage(req, res, vaultRel) {
    const { scope } = req;
    const abs = path.join(scope.vaultRoot, ...vaultRel.split('/'));
    const st = await fsp.stat(abs);
    if (st.size > MAX_NOTE_BYTES) return sendMessage(res, 413, 'Too large', 'This note is too large to display.');
    const [text, index, linked, look] = await Promise.all([
      fsp.readFile(abs, 'utf8'), vaultIndex(scope.vaultRoot), scope.linked(), ownerLook(scope),
    ]);
    const ctx = {
      scope,
      index,
      linked,
      breaks: look.breaks,
      noteUrl: (rel) => noteUrl(scope, rel),
      rawUrl: (rel) => {
        const inside = scope.toShareRel(rel);
        if (inside != null) return basePath(scope.share) + '/raw/' + encodePath(inside);
        return basePath(scope.share) + '/raw/' + encodePath(LINKED + '/' + linked.byVault.get(rel));
      },
      readNote: async (rel) => {
        const p = path.join(scope.vaultRoot, ...rel.split('/'));
        const s = await fsp.stat(p);
        if (s.size > MAX_NOTE_BYTES) throw new Error('too large');
        return fsp.readFile(p, 'utf8');
      },
    };
    const html = await renderNote(text, vaultRel, ctx);
    await layout(req, res, { vaultRel, isDir: false, title: basenameNoMd(vaultRel), contentHtml: html, index });
  }

  async function renderFolderPage(req, res, vaultRel) {
    const { scope } = req;
    const index = await vaultIndex(scope.vaultRoot);
    const shareRel = vaultRel ? scope.toShareRel(vaultRel) : '';
    const entries = await scope.list(shareRel);
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const items = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || !e.abs) continue;
      const st = await fsp.stat(e.abs).catch(() => null);
      if (!st) continue;
      items.push({ name: e.name, dir: st.isDirectory() });
    }
    items.sort((a, b) => (a.dir === b.dir ? coll.compare(a.name, b.name) : a.dir ? -1 : 1));
    const base = basePath(scope.share);
    const list = items.length
      ? '<ul class="mp-listing">' + items.map((it) => {
        const rel = shareRel ? shareRel + '/' + it.name : it.name;
        const isMd = it.name.toLowerCase().endsWith('.md');
        const href = base + (it.dir || isMd ? '/n/' : '/raw/') + encodePath(rel);
        return '<li><a class="internal-link' + (it.dir ? ' mp-folder' : '') + '" href="' + escapeHtml(href) + '">' + escapeHtml(isMd ? it.name.slice(0, -3) : it.name) + '</a></li>';
      }).join('') + '</ul>'
      : '<p>This folder is empty.</p>';
    const title = shareRel ? shareRel.slice(shareRel.lastIndexOf('/') + 1) : shareTitle(scope);
    await layout(req, res, { vaultRel, isDir: true, title, contentHtml: list, index });
  }

  // Errors: generic page, details only in the server log.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    console.error('[share-pages]', err);
    sendMessage(res, 500, 'Something went wrong', 'This page could not be displayed.');
  });

  return router;
}

module.exports = { createSharePages, shareTitle, safeNext };
