/**
 * Live vault changes over WebSocket (/api/watch?vault=<id>&client=<id>).
 *
 * Every session that has a vault open keeps one of these sockets: web tabs
 * (client-mobile/shims/capacitor-shim.js, which turns the events into
 * Obsidian's own watch callbacks) and the native Obsidian plugin
 * markport-sync. Messages are { type, path } with type one of add, change,
 * unlink, addDir, unlinkDir and path relative to the vault.
 *
 * Two sources feed them:
 *
 *   - api/vault-events.js: changes made through /api/fs, pushed the moment
 *     the request is handled, to every session except the one that made it
 *     (matched by the `client` id the request and the socket both carry).
 *   - chokidar: changes made by anything else (a sync tool, a shell, SMB).
 *     Disk also reports the changes from /api/fs a moment later; those
 *     echoes are dropped (vault-events isEcho).
 *
 * On filesystems that do not support inotify (rclone/FUSE, NFS, SMB, …)
 * set WATCH_POLLING=true so chokidar falls back to stat-based polling.
 * Set WATCH_POLL_INTERVAL to control the poll interval in ms.
 *
 * Each unique vault root gets exactly ONE shared chokidar watcher, regardless
 * of how many WebSocket connections are open. When the last client for a
 * vault disconnects the watcher is closed, freeing OS resources (inotify
 * watches or polling timers).
 *
 * Clients that cannot send cookies (markport-sync, outside a browser) pass
 * their API token as the subprotocol "markport-token.<token>" next to
 * "markport" (see auth.js); the server answers with "markport".
 */

const chokidar = require('chokidar');
const fsp = require('fs/promises');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('../config');

const PING_INTERVAL_MS = 30 * 1000;

function isHidden(rel) {
  return rel.split('/').some((s) => s.startsWith('.'));
}

// opts.isOwner(req)            owner-login check (auth.js)
// opts.shareTarget(req, id)    for a share vault: { root, filter(rel) → rel|null }
//                              or { error }; null when id is not a share
// opts.events                  api/vault-events.js hub (optional)
function attachWatchServer(httpServer, vaultRegistry, fallbackVaultRoot, opts = {}) {
  const events = opts.events || null;
  // noServer + explicit routing, not `{ server, path }`: with `server`, ws
  // answers every upgrade on any OTHER path with a 400, which would kill the
  // node bridge's WebSocket (api/node-bridge.js) on the same HTTP server.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('markport') ? 'markport' : false),
  });
  httpServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/api/watch') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // Shared watchers: vaultRoot → { watcher, clients: Map<ws, { filter, client }> }
  // filter(rel) returns the path to send that client, or null to skip it.
  const sharedWatchers = new Map();

  if (config.watchPolling) {
    console.log(`[watch] polling mode enabled (interval ${config.watchPollInterval}ms)`);
  }

  function getVaultRoot(req) {
    const url = new URL(req.url, 'http://localhost');
    const vaultId = url.searchParams.get('vault');
    if (vaultId) {
      const vault = vaultRegistry.get(vaultId);
      return vault ? vault.path : null;
    }
    return fallbackVaultRoot;
  }

  function send(ws, message) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  // Send one change to the clients of one watcher. skipClient: the session
  // that made the change.
  function deliver(entry, eventType, relative, skipClient) {
    if (!relative || isHidden(relative)) return;
    for (const [ws, c] of entry.clients) {
      if (skipClient && c.client === skipClient) continue;
      const rel = c.filter ? c.filter(relative) : relative;
      if (rel != null) send(ws, { type: eventType, path: rel });
    }
  }

  function getOrCreateWatcher(vaultRoot) {
    if (sharedWatchers.has(vaultRoot)) {
      return sharedWatchers.get(vaultRoot);
    }

    const clients = new Map();
    const watcher = chokidar.watch(vaultRoot, {
      ignored: (p) => path.basename(p).startsWith('.'),
      ignoreInitial: true,
      persistent: true,
      usePolling: config.watchPolling,
      interval: config.watchPolling ? config.watchPollInterval : undefined,
      binaryInterval: config.watchPolling ? config.watchPollInterval : undefined,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    function broadcast(message) {
      for (const ws of clients.keys()) send(ws, message);
    }

    async function onDiskEvent(eventType, absolutePath, stats) {
      if (events) {
        if ((eventType === 'add' || eventType === 'change') && !stats) {
          try { stats = await fsp.stat(absolutePath); } catch (_) { stats = null; }
        }
        if (events.isEcho(absolutePath, eventType, stats)) return;
      }
      const relative = path.relative(vaultRoot, absolutePath).split(path.sep).join('/');
      deliver(entry, eventType, relative, null);
    }

    watcher.on('ready', () => broadcast({ type: 'ready' }));
    for (const t of ['add', 'change', 'unlink', 'addDir', 'unlinkDir']) {
      watcher.on(t, (p, stats) => { onDiskEvent(t, p, stats).catch((err) => console.error('[watch]', err)); });
    }
    watcher.on('error', (err) => {
      console.error('[watch] error:', err);
      broadcast({ type: 'error', message: err.message });
    });

    const entry = { watcher, clients };
    sharedWatchers.set(vaultRoot, entry);
    console.log(`[watch] started watcher for ${vaultRoot}`);
    return entry;
  }

  // A change made through /api/fs: every watcher whose root holds the path
  // (the vault's, and a share's rooted at a folder inside it).
  function onApiChange(ev) {
    for (const [root, entry] of sharedWatchers) {
      if (ev.abs !== root && !ev.abs.startsWith(root + path.sep)) continue;
      const relative = path.relative(root, ev.abs).split(path.sep).join('/');
      deliver(entry, ev.type, relative, ev.origin);
    }
  }
  if (events) events.on(onApiChange);

  async function resolveTarget(req) {
    const vaultId = new URL(req.url, 'http://localhost').searchParams.get('vault');
    const share = vaultId && opts.shareTarget ? await opts.shareTarget(req, vaultId) : null;
    if (share) return share.error ? { error: share.error } : share;
    if (opts.isOwner && !opts.isOwner(req)) return { error: 'login required' };
    const root = getVaultRoot(req);
    return root ? { root, filter: null } : { error: 'unknown vault' };
  }

  // Ping every client so reverse proxies don't drop idle sockets, and so a
  // client that vanished (laptop lid closed) is noticed and cleaned up.
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._mpAlive === false) { ws.terminate(); continue; }
      ws._mpAlive = false;
      try { ws.ping(); } catch (_) { /* closing */ }
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref();

  wss.on('connection', async (ws, req) => {
    ws._mpAlive = true;
    ws.on('pong', () => { ws._mpAlive = true; });
    let target;
    try { target = await resolveTarget(req); } catch (err) { target = { error: err.message }; }
    if (target.error) {
      send(ws, { type: 'error', message: target.error });
      ws.close();
      return;
    }
    if (ws.readyState !== 1) return;   // closed while we checked

    const client = (new URL(req.url, 'http://localhost').searchParams.get('client') || '').slice(0, 100) || null;
    const vaultRoot = path.resolve(target.root);
    const entry = getOrCreateWatcher(vaultRoot);
    entry.clients.set(ws, { filter: target.filter, client });
    console.log(`[watch] client connected for ${vaultRoot} (${entry.clients.size} total)`);
    send(ws, { type: 'hello', client });

    ws.on('close', () => {
      entry.clients.delete(ws);
      console.log(`[watch] client disconnected for ${vaultRoot} (${entry.clients.size} remaining)`);
      if (entry.clients.size === 0 && sharedWatchers.get(vaultRoot) === entry) {
        entry.watcher.close();
        sharedWatchers.delete(vaultRoot);
        console.log(`[watch] closed watcher for ${vaultRoot} (no more clients)`);
      }
    });
  });

  httpServer.on('close', () => {
    clearInterval(pingTimer);
    if (events) events.off(onApiChange);
    for (const { watcher } of sharedWatchers.values()) {
      watcher.close();
    }
    sharedWatchers.clear();
    wss.close();
  });

  return { wss, sharedWatchers };
}

module.exports = attachWatchServer;
