/**
 * Obsidian Web - HTTP/WebSocket server.
 *
 * Serves three things:
 *   1. The custom src/client-mobile/ files (boot.js, shims, HTML) — the
 *      mobile runtime is the only runtime (desktop src/client was archived,
 *      see git tag archive/desktop-runtime).
 *   2. Obsidian's untouched renderer files from vendor/obsidian-mobile/.
 *   3. A file system API at /api/fs/* and a watcher at /api/watch.
 */

const express = require('express');
const compression = require('compression');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');

const config = require('./config');
const systemPlugins = require('./system-plugins');
const createFsRouter = require('./api/fs');
const createElectronRouter = require('./api/electron');
const createVaultsRouter = require('./api/vaults');
const createBootstrapRouter = require('./api/bootstrap');
const { warmUpBootstrapCache } = require('./api/bootstrap');
const createProxyRouter = require('./api/proxy');
const createSystemPluginFilesRouter = require('./api/system-plugin-files');
const attachWatchServer = require('./api/watch');
const { createVaultEvents } = require('./api/vault-events');
const { createMediaRouter } = require('./media');
const { createNodeBridgeRouter, attachNodeBridgeProcServer } = require('./api/node-bridge');
const VaultRegistry = require('./vault-registry');
const { createAuth } = require('./auth');
const { createSharing } = require('./shares');
const { loginPage, pageHeaders } = require('./shares/html');

// Only same-site paths may be redirect targets (no open redirect via ?next=).
function safeLocalPath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('\\') ? p : '/';
}

function createApp(appConfig = {}) {
  // Merge with the default config so partial overrides (used by tests) don't
  // crash on missing fields like clientMobilePath. Explicit overrides still win.
  appConfig = Object.assign({}, config, appConfig);
  const app = express();
  // The usual deployment is behind a reverse proxy on the same host or a
  // private network: trust its X-Forwarded-* headers there, so HTTPS is
  // detected (Secure cookies) and rate limits see the real client address.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  const vaultRegistry = new VaultRegistry(appConfig.registryPath);
  // Session secret, shares.json and per-share data live next to the registry.
  const dataDir = appConfig.dataDir || path.dirname(appConfig.registryPath);
  const auth = createAuth({ password: appConfig.ownerPassword, dataDir });
  const sharing = createSharing({ vaultRegistry, dataDir, auth });
  // Changes made through /api/fs, pushed live to the other sessions (watch.js).
  const vaultEvents = createVaultEvents();
  app.locals.auth = auth;
  app.locals.sharing = sharing;
  app.locals.vaultEvents = vaultEvents;
  if (appConfig.vaultsDir) {
    const ids = vaultRegistry.syncDir(appConfig.vaultsDir, appConfig.defaultVaultName);
    console.log(`[vaults] ${ids.length} vault(s) in ${appConfig.vaultsDir}`);
  }

  // Compression — critical for /api/bootstrap (38MB uncompressed → ~6MB).
  // Brotli gives ~84% reduction, gzip ~79%. The middleware auto-selects based
  // on Accept-Encoding: browsers get brotli, curl/other tools get gzip.
  app.use(compression({ level: 6 }));

  // Request logging - very chatty, but invaluable while we are still
  // figuring out what Obsidian asks for during boot.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const url = req.originalUrl;
      // Skip noisy static assets to keep the log readable.
      if (!url.startsWith('/api') && !url.startsWith('/i18n') && !url.startsWith('/lib') && url !== '/') {
        return;
      }
      console.log(`${req.method} ${res.statusCode} ${url} (${ms}ms)`);
    });
    next();
  });

  // Inject ?v=<cacheBust> into all client script/link tags so browsers pick up
  // changes automatically. The bust value is recomputed at server startup from
  // client/ and client-mobile/ file mtimes — no manual ?v=N bump needed.
  const cacheBust = appConfig.clientCacheBust || 'dev';

  // deploy-config inject (docs/plans/deploy-config.md §4 Commit 3) — read once
  // per app (not per-request), mirrors what build-assets.sh does for the CF
  // deploy: replace the <!-- OW_CONFIG_INJECT --> marker in index.html with a
  // literal <script>window.__owConfigInjected={...}</script>, positioned
  // before the deploy-config.js tag (already the case in the source
  // index.html). If the config file is missing/unreadable the snippet stays
  // empty — the marker is replaced with '' (no injected script), so
  // deploy-config.js falls back to its DEFAULTS, same zero-regression
  // behavior as the CF build's "no config" case.
  let deployConfigSnippet = '';
  try {
    const deployConfigPath = path.join(appConfig.projectRoot, 'src', 'config', 'deploy-config.json');
    const deployConfig = JSON.parse(fs.readFileSync(deployConfigPath, 'utf8'));
    deployConfigSnippet = '<script>window.__owConfigInjected=' + JSON.stringify(deployConfig) + '</script>';
  } catch (err) {
    console.warn('[deploy-config] could not read src/config/deploy-config.json — window.__owConfig will use client-side DEFAULTS:', err.message);
  }

  async function sendHtmlWithCacheBust(res, filePath) {
    try {
      let html = await fsp.readFile(filePath, 'utf8');
      // Inject (or replace) ?v=<bust> on all /client/ and /client-mobile/ script and link tags.
      // Handles both: existing ?v=3 and paths without any query string.
      html = html.replace(/((?:src|href)="\/client(?:-mobile)?\/[^"]*?)(\?v=[^"&]*)?"(?=[^>]*>)/g,
        (_, prefix) => `${prefix}?v=${cacheBust}"`);
      html = html.replace('<!-- OW_CONFIG_INJECT -->', deployConfigSnippet);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(html);
    } catch (err) {
      res.status(500).send('Error loading page: ' + err.message);
    }
  }

  // Never leak a share link (or a vault id) to other sites through Referer.
  app.use((req, res, next) => {
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // ── Owner login (auth.js) ────────────────────────────────────────────────
  app.get('/login', (req, res) => {
    const next = safeLocalPath(req.query.next);
    if (!auth.enabled || auth.isOwner(req)) return res.redirect(303, next);
    pageHeaders(res);
    res.send(loginPage(next));
  });
  app.post('/login', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
    const next = safeLocalPath(req.body && req.body.next);
    if (!auth.enabled) return res.redirect(303, next);
    const key = auth.clientKey(req);
    pageHeaders(res);
    if (auth.loginLimiter.blocked(key)) {
      return res.status(429).send(loginPage(next, 'Too many attempts. Try again in a few minutes.'));
    }
    if (!auth.checkPassword(String((req.body && req.body.password) || ''))) {
      auth.loginLimiter.fail(key);
      return res.status(401).send(loginPage(next, 'Wrong password.'));
    }
    auth.loginLimiter.reset(key);
    auth.setOwnerSession(req, res);
    res.redirect(303, next);
  });
  app.all('/logout', (req, res) => {
    auth.clearOwnerSession(req, res);
    res.redirect(303, auth.enabled ? '/login' : '/');
  });
  app.get('/api/auth/status', (req, res) => {
    res.json({ authEnabled: auth.enabled, owner: auth.isOwner(req) });
  });
  // Password → API token, for clients that can't keep the login cookie (the
  // native Obsidian plugin markport-sync). Same limiter as /login.
  app.post('/api/auth/token', express.json({ limit: '8kb' }), (req, res) => {
    if (!auth.enabled) return res.json({ authEnabled: false, token: null });
    const key = auth.clientKey(req);
    if (auth.loginLimiter.blocked(key)) {
      return res.status(429).json({ error: 'too many attempts, try again in a few minutes', code: 'ERATE' });
    }
    if (!auth.checkPassword(String((req.body && req.body.password) || ''))) {
      auth.loginLimiter.fail(key);
      return res.status(401).json({ error: 'wrong password', code: 'EAUTH' });
    }
    auth.loginLimiter.reset(key);
    res.json(Object.assign({ authEnabled: true }, auth.issueApiToken()));
  });

  // ── Share links (shares/pages.js) - public, scoped by the link ───────────
  app.use('/s', sharing.pages);

  function ownerPage(req, res, next) {
    if (auth.isOwner(req)) return next();
    res.redirect(303, '/login?next=' + encodeURIComponent(req.originalUrl));
  }
  const sendShell = (res) => sendHtmlWithCacheBust(res, path.join(appConfig.clientMobilePath, 'index.html'));

  // Entry point - mobile is now the only runtime, served at / (finale of the
  // mobile-first epic; see docs/decisions for the collapse-desktop rationale).
  // /mobile is a backwards-compatible alias for existing tunnels/links.
  // Path-based routing (docs/plans/url-routing.md §3ג): /starter is the
  // chooser/onboarding route (ignores auto-resume). Same shell; boot.js reads
  // location.pathname to decide what to render.
  app.get(['/', '/mobile', '/starter', '/starter.html'], ownerPage, (req, res) => sendShell(res));

  // /vault/:id is an open, shareable vault URL and /vault/:id/* a deep link
  // to a note in it (docs/plans/vault-note-deeplink.md §3ד). Not a redirect:
  // the id must stay visible/bookmarkable in the browser URL. A share id
  // opens that share's scoped editor (edit shares only).
  app.get(['/vault/:id', '/vault/:id/*'], (req, res, next) => {
    const share = sharing.shares.get(req.params.id);
    if (share) {
      return sharing.vaultShell(req, res, share, req.params[0] || '', () => sendShell(res)).catch(next);
    }
    ownerPage(req, res, () => sendShell(res));
  });

  // Static files.
  app.use('/client-mobile', express.static(appConfig.clientMobilePath, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
  app.use('/obsidian-mobile', express.static(appConfig.obsidianMobilePath, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // Obsidian's renderer fetches resources via absolute paths like /i18n/he.txt
  // and /lib/... because under Electron those resolve via the app:// protocol
  // to the bundle root. Mirror them onto the obsidian-mobile/ tree (the only
  // runtime left — obsidian-mobile ships its own i18n/ and lib/, no
  // public/sandbox).
  const RESOURCE_DIRS = ['i18n', 'lib'];
  for (const dir of RESOURCE_DIRS) {
    app.use('/' + dir, express.static(path.join(appConfig.obsidianMobilePath, dir), {
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }));
  }

  // Worker scripts. Obsidian creates `new Worker("worker.js")` which under
  // Electron resolves to /Resources/obsidian/worker.js, but in a browser
  // it resolves relative to the document URL. Serve them at the root.
  //
  // THIS IS CRITICAL for the metadata indexer: without worker.js the
  // metadataCache `this.work(t)` call (which postMessage's to the worker
  // and waits for a reply) hangs forever, leaving inProgressTaskCount > 0
  // and blocking everything that waits for onCleanCache (rename, etc.).
  const ROOT_FILES = ['worker.js', 'sim.js'];
  for (const f of ROOT_FILES) {
    app.get('/' + f, (req, res) => {
      res.sendFile(path.join(appConfig.obsidianMobilePath, f), {
        headers: { 'Cache-Control': 'no-cache' },
      });
    });
  }

  // Service Worker (offline + asset-cache — docs/plans/service-worker-offline.md
  // §3ג) — served from the root so its scope covers the whole app
  // (Service-Worker-Allowed:/). __OW_BUILD__ is replaced with the same
  // cache-bust value used for ?v=<bust> on script tags, so a code change
  // (new mtime hash) produces a new SW cache automatically. no-cache on the
  // SW response itself — otherwise the browser could pin an old SW.
  app.get('/sw.js', async (req, res) => {
    try {
      const raw = await fsp.readFile(path.join(appConfig.clientMobilePath, 'sw.js'), 'utf8');
      const src = raw.replace(/__OW_BUILD__/g, cacheBust);
      res.set({
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
      });
      res.send(src);
    } catch (e) {
      res.status(500).send('// sw unavailable');
    }
  });

  // PWA web manifest — served from the root so scope "/" is natural (icons live
  // under /client-mobile/icons/, served by the existing /client-mobile mount).
  app.get('/manifest.webmanifest', (req, res) => {
    res.sendFile(path.join(appConfig.clientMobilePath, 'manifest.webmanifest'), {
      headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' },
    });
  });

  // API routes. Share vaults are routed to their scoped handlers first; every
  // other /api route below the ownerOnly line needs the owner.
  app.use('/api/fs', express.json({ limit: '1mb' }), sharing.fsGate);
  app.use('/api/bootstrap', sharing.bootstrapGate);
  app.get('/api/vaults/list', (req, res, next) => {
    if (auth.isOwner(req)) return next();
    sharing.grantedVaults(req).then((v) => res.json(v), next);
  });
  app.use('/api/shares', sharing.ownerApi());
  app.use('/api', sharing.ownerOnly);

  app.use('/api/bootstrap', createBootstrapRouter(vaultRegistry, appConfig.vaultPath, appConfig.bootstrap));
  app.use('/api/proxy-request', createProxyRouter());
  app.use('/api/vaults', createVaultsRouter(vaultRegistry, appConfig.vaultsDir));
  app.use('/api/node-bridge', createNodeBridgeRouter(vaultRegistry, appConfig.nodeBridge));
  if (appConfig.nodeBridge) console.warn('[node-bridge] ENABLED - anyone who can reach this server can run commands on it as the server user. Keep it behind an authenticating reverse proxy.');
  app.use('/api/fs', createFsRouter(vaultRegistry, appConfig.vaultPath, {
    // Keep share links pointing at an item the owner renames or moves.
    onRename: (vaultId, oldPath, newPath) => sharing.shares.renamed(vaultId, oldPath, newPath),
    events: vaultEvents,
  }));
  app.use('/api/electron', createElectronRouter(vaultRegistry, appConfig.vaultPath));
  // Thumbnails, previews, optimized 3D models and big uploads for the image
  // library plugin. Everything it derives goes to the media cache, outside
  // every vault (media/index.js).
  if (appConfig.media !== false) {
    const media = appConfig.media || {};
    app.locals.media = createMediaRouter(vaultRegistry, {
      cacheDir: media.cacheDir || path.join(dataDir, 'media-cache'),
      maxBytes: media.maxBytes,
      events: vaultEvents,
      housekeeping: media.housekeeping,
    });
    app.use('/api/media', app.locals.media);
  }
  app.use('/api', createSystemPluginFilesRouter());

  app.locals.vaultRegistry = vaultRegistry;
  return app;
}

function startServer(appConfig = config) {
  // Discover system plugins (repo-shipped plugins overlaid onto every vault)
  // before any FS handler runs.
  systemPlugins.init();

  const app = createApp(appConfig);
  const server = http.createServer(app);
  attachWatchServer(server, app.locals.vaultRegistry, appConfig.vaultPath, {
    isOwner: app.locals.auth.isOwner,
    shareTarget: app.locals.sharing.watchTarget,
    events: app.locals.vaultEvents,
  });
  attachNodeBridgeProcServer(server, appConfig.nodeBridge, app.locals.auth.isOwner);

  server.listen(appConfig.port, appConfig.host, () => {
    console.log('==========================================');
    console.log('  Markport');
    console.log('==========================================');
    console.log('  Vault:    ' + appConfig.vaultPath);
    console.log('  Obsidian: ' + appConfig.obsidianMobilePath);
    console.log('  Listening on http://' + appConfig.host + ':' + appConfig.port);
    console.log('  Login:    ' + (app.locals.auth.enabled ? 'owner password (MARKPORT_PASSWORD)' : 'NONE - set MARKPORT_PASSWORD or put an authenticating proxy in front'));
    console.log('==========================================');

    // Pre-build the bootstrap cache in the background so the first browser
    // request is a cache HIT instead of a cold build.
    setImmediate(() => {
      warmUpBootstrapCache(app.locals.vaultRegistry, appConfig.vaultPath, appConfig.bootstrap)
        .catch((err) => console.warn('[bootstrap] warm-up error:', err.message));
    });
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer };
