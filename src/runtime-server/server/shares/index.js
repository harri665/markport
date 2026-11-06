/**
 * Sharing: wiring between the share store, scopes, auth and the HTTP routes.
 * See store.js (what a share is), scope.js (what it can reach), pages.js
 * (the static pages) and fs-router.js (the editor's file API).
 */

'use strict';

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { ShareStore, normalizeRel } = require('./store');
const { Scope } = require('./scope');
const { createSharePages, shareTitle } = require('./pages');
const createShareFsRouter = require('./fs-router');

function createSharing({ vaultRegistry, dataDir, auth }) {
  const shares = new ShareStore(path.join(dataDir, 'shares.json'));
  const shareDataRoot = path.join(dataDir, 'shares');

  const scopes = {
    forShare(share) {
      const vault = vaultRegistry.get(share.vault);
      return vault ? new Scope(share, vault.path, shareDataRoot) : null;
    },
  };

  // Can this request use this share's virtual vault? Returns a Scope, or
  // { status, error } when it can't.
  async function checkShare(req, share) {
    if (shares.isExpired(share)) return { status: 410, error: 'this share has expired' };
    if (!auth.hasGrant(req, share)) return { status: 401, error: 'open the share link first' };
    const scope = scopes.forShare(share);
    if (!scope || !(await scope.exists())) return { status: 404, error: 'the shared item no longer exists' };
    return scope;
  }

  function ownerOnly(req, res, next) {
    if (auth.isOwner(req)) return next();
    res.status(401).json({ error: 'login required', code: 'EAUTH' });
  }

  function requestShare(req) {
    const id = (req.query && req.query.vault) || (req.body && req.body.vault);
    return id ? shares.get(id) : null;
  }

  // /api/fs: share vaults → the scoped router; everything else → owner only.
  const shareFs = createShareFsRouter();
  async function fsGate(req, res, next) {
    const share = requestShare(req);
    if (!share) return ownerOnly(req, res, next);
    const scope = await checkShare(req, share);
    if (!(scope instanceof Scope)) return res.status(scope.status).json({ error: scope.error, code: 'EACCES' });
    req.shareScope = scope;
    shareFs(req, res, (err) => {
      if (err) return next(err);
      res.status(404).json({ error: 'not found', code: 'ENOENT' });
    });
  }

  // The virtual vault entry a share's editor sees for itself.
  function vaultEntry(share, scope) {
    return { path: '/' + shareTitle(scope), ts: share.createdAt, open: true, share: true };
  }

  // /api/vaults/list for someone who is not the owner: only the edit shares
  // this browser holds a grant for.
  async function grantedVaults(req) {
    const out = {};
    for (const id of auth.grantedShareIds(req)) {
      const share = shares.get(id);
      if (!share || share.permission !== 'edit') continue;
      const scope = await checkShare(req, share);
      if (scope instanceof Scope) out[id] = vaultEntry(share, scope);
    }
    return out;
  }

  // /api/bootstrap for a share vault: never the precomputed cache (it covers
  // the whole vault) - just the scoped tree.
  async function bootstrapGate(req, res, next) {
    const share = requestShare(req);
    if (!share) return ownerOnly(req, res, next);
    const scope = await checkShare(req, share);
    if (!(scope instanceof Scope)) return res.status(scope.status).json({ error: scope.error });
    const { buildElectronValues } = require('../api/bootstrap');
    const entry = vaultEntry(share, scope);
    const fakeRegistry = { get: (id) => (id === share.id ? entry : null), list: () => ({ [share.id]: entry }) };
    // `dirs` (built through the scope, like every other share read) is what
    // the client builds Obsidian's file list from; file contents are not
    // preloaded and stay per-request.
    res.json({ disabled: true, electron: buildElectronValues(share.id, fakeRegistry), fs: {}, dirs: await scope.tree() });
  }

  // ── owner API: /api/shares ────────────────────────────────────────────────
  function ownerApi() {
    const router = express.Router();
    router.use(ownerOnly);

    router.get('/', async (req, res) => {
      const list = shares.list(typeof req.query.vault === 'string' ? req.query.vault : null);
      const out = await Promise.all(list.map(async (s) => {
        const scope = scopes.forShare(s);
        return Object.assign(ShareStore.describe(s), {
          expired: shares.isExpired(s),
          missing: !scope || !(await scope.exists()),
        });
      }));
      out.sort((a, b) => b.createdAt - a.createdAt);
      res.json({ authEnabled: auth.enabled, shares: out });
    });

    router.post('/', express.json({ limit: '16kb' }), async (req, res) => {
      const body = req.body || {};
      const vault = vaultRegistry.get(body.vault);
      if (!vault) return res.status(404).json({ error: 'unknown vault' });
      const rel = normalizeRel(body.path);
      if (rel === null) return res.status(400).json({ error: 'invalid path' });
      if (rel.split('/').some((s) => s.startsWith('.'))) return res.status(400).json({ error: 'hidden files and folders cannot be shared' });
      let st;
      try { st = await fsp.stat(path.join(vault.path, ...(rel ? rel.split('/') : []))); } catch (_) {
        return res.status(404).json({ error: 'no such file or folder' });
      }
      const kind = st.isDirectory() ? 'folder' : 'file';
      if (kind === 'file' && !rel.toLowerCase().endsWith('.md')) return res.status(400).json({ error: 'only notes and folders can be shared' });
      try {
        const share = shares.create({
          vault: body.vault,
          path: rel,
          kind,
          permission: body.permission,
          password: body.password || null,
          expiresAt: body.expiresAt || null,
          slug: body.slug || null,
        });
        res.json({ share: Object.assign(ShareStore.describe(share), { expired: false, missing: false }), authEnabled: auth.enabled });
      } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
      }
    });

    // Change a share's custom link: { slug: 'new-name' }, or { slug: null } to
    // go back to the id-only link. The old custom link stops working at once.
    router.patch('/:id', express.json({ limit: '4kb' }), async (req, res) => {
      if (!shares.get(req.params.id)) return res.status(404).json({ error: 'no such share' });
      if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'slug')) return res.status(400).json({ error: 'nothing to change' });
      try {
        const share = shares.setSlug(req.params.id, req.body.slug);
        const scope = scopes.forShare(share);
        res.json({ share: Object.assign(ShareStore.describe(share), { expired: shares.isExpired(share), missing: !scope || !(await scope.exists()) }) });
      } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
      }
    });

    router.delete('/:id', async (req, res) => {
      const share = shares.get(req.params.id);
      if (!share) return res.status(404).json({ error: 'no such share' });
      shares.remove(share.id);
      // Drop the share's private settings. Its .trash (notes recipients
      // deleted) is kept so the owner can still recover them.
      await fsp.rm(path.join(shareDataRoot, share.id, 'config'), { recursive: true, force: true }).catch(() => {});
      await fsp.rmdir(path.join(shareDataRoot, share.id)).catch(() => {});
      res.json({ ok: true });
    });

    return router;
  }

  // Shell routes /vault/<shareId>[/note]: edit shares open the editor once the
  // link has been opened (grant cookie); otherwise go through /s/<id>/edit,
  // which asks for the password and sets the grant.
  async function vaultShell(req, res, share, notePath, sendShell) {
    const note = notePath ? '?note=' + encodeURIComponent(notePath) : '';
    if (shares.isExpired(share) || share.permission !== 'edit' || !auth.hasGrant(req, share)) {
      return res.redirect(303, ShareStore.basePath(share) + '/edit' + note);
    }
    const scope = scopes.forShare(share);
    if (!scope || !(await scope.exists())) return res.redirect(303, ShareStore.basePath(share));
    res.setHeader('Referrer-Policy', 'no-referrer');
    sendShell();
  }

  // For the file watcher: a share vault's root and an event-path filter.
  async function watchTarget(req, vaultId) {
    const share = shares.get(vaultId);
    if (!share) return null;
    const scope = await checkShare(req, share);
    if (!(scope instanceof Scope)) return { error: scope.error };
    if (scope.isFile) {
      return { root: scope.contentRoot, filter: (rel) => (rel === scope.fileName ? rel : null) };
    }
    return { root: scope.contentRoot, filter: (rel) => (rel.split('/').some((s) => s.startsWith('.')) ? null : rel) };
  }

  if (!auth.enabled && shares.list().length) {
    console.warn('[shares] MARKPORT_PASSWORD is not set: share links are scoped, but the rest of the app is open to anyone who can reach it.');
  }

  return {
    shares,
    scopes,
    ownerOnly,
    fsGate,
    bootstrapGate,
    grantedVaults,
    vaultShell,
    watchTarget,
    ownerApi,
    pages: createSharePages({ shares, auth, scopes }),
  };
}

module.exports = { createSharing };
