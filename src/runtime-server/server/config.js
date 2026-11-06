const path = require('path');

// Repo root — three levels up from src/runtime-server/server/.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// Single source of truth for the Obsidian app version we ship.
// Both bootstrap.js and electron.js import this instead of hardcoding it.
const APP_VERSION = '1.12.7';

// Virtual path that the renderer sees as its vault root.
// Must match the value the client shims use (src/client-mobile/shims VAULT_BASE).
const VAULT_BASE = '/vault';

const crypto = require('crypto');
const fsSync = require('fs');

function parsePort(raw) {
  if (!raw) return 3500;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid PORT value: "${raw}". Must be an integer between 1 and 65535.`);
  }
  return n;
}

/**
 * Compute a short cache-buster string from the mtimes of all files under
 * the src/client-mobile/ directory. Changes to any client file automatically
 * produce a new bust value without any manual ?v= bump.
 *
 * Returns a 6-char hex string, e.g. "a3f7c2".
 */
function computeClientCacheBust(clientPath) {
  try {
    const hash = crypto.createHash('sha1');
    function walk(dir) {
      let entries;
      try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); }
      catch (_) { return; }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(abs);
        } else {
          try {
            const s = fsSync.statSync(abs);
            hash.update(abs + ':' + s.mtimeMs);
          } catch (_) {}
        }
      }
    }
    walk(clientPath);
    return hash.digest('hex').slice(0, 6);
  } catch (_) {
    return 'dev';
  }
}

const CLIENT_MOBILE_PATH = path.resolve(PROJECT_ROOT, 'src', 'client-mobile');
const OBSIDIAN_MOBILE_PATH = path.resolve(PROJECT_ROOT, 'vendor', 'obsidian-mobile');

module.exports = {
  port: parsePort(process.env.PORT),
  host: process.env.HOST || '127.0.0.1',
  vaultPath: path.resolve(PROJECT_ROOT, process.env.VAULT_PATH || 'user-data/demo-vault'),
  registryPath: path.resolve(PROJECT_ROOT, process.env.VAULT_REGISTRY || 'user-data/registry.json'),
  // Optional. When set, every top-level folder in it is registered as a vault
  // at startup (see VaultRegistry.syncDir); DEFAULT_VAULT_NAME is created when
  // it is empty. Used by the Docker image, where it points at the data volume.
  vaultsDir: process.env.VAULTS_DIR ? path.resolve(PROJECT_ROOT, process.env.VAULTS_DIR) : null,
  defaultVaultName: process.env.DEFAULT_VAULT_NAME || 'Notes',
  // Owner login (auth.js). When set, the whole app asks for this password,
  // and share links (/s/<id>) are the only way in without it. When empty,
  // there is no login - put an authenticating reverse proxy in front.
  ownerPassword: process.env.MARKPORT_PASSWORD || '',
  // Real Node APIs for desktop-only plugins (api/node-bridge.js). Remote code
  // execution by design - off unless explicitly enabled.
  nodeBridge: process.env.MARKPORT_NODE_BRIDGE === 'true',
  obsidianMobilePath: OBSIDIAN_MOBILE_PATH,
  clientMobilePath: CLIENT_MOBILE_PATH,
  projectRoot: PROJECT_ROOT,
  appVersion: APP_VERSION,
  vaultBase: VAULT_BASE,
  // Computed once at startup from src/client-mobile/ file mtimes. Used by
  // client-mobile/index.html to inject ?v=<bust> on all client scripts — no
  // manual ?v=N bump needed. Mobile is the only runtime (desktop src/client
  // was archived — see git tag archive/desktop-runtime).
  clientCacheBust: computeClientCacheBust(CLIENT_MOBILE_PATH),
  // Set WATCH_POLLING=true when the vault lives on a filesystem that does not
  // support inotify (rclone/FUSE, NFS, SMB, …).  Without polling chokidar
  // will never fire any events on those mounts.
  watchPolling: process.env.WATCH_POLLING === 'true',
  watchPollInterval: process.env.WATCH_POLL_INTERVAL
    ? parseInt(process.env.WATCH_POLL_INTERVAL, 10)
    : 3500,
  // Image library media service (media/index.js): where thumbnails, previews
  // and optimized models are cached - never inside a vault - and how big that
  // cache may grow. Default: <data>/media-cache, 5 GB.
  media: {
    cacheDir: process.env.MARKPORT_MEDIA_CACHE ? path.resolve(PROJECT_ROOT, process.env.MARKPORT_MEDIA_CACHE) : null,
    maxBytes: (parseInt(process.env.MARKPORT_MEDIA_CACHE_MB || '5120', 10) || 5120) * 1024 * 1024,
  },
  // MCP endpoint for apps like Claude (mcp/server.js), signed in with OAuth
  // (mcp/oauth.js). Needs MARKPORT_PASSWORD.
  mcp: {
    enabled: process.env.MARKPORT_MCP !== 'false',
    // The address apps reach this server at, e.g. https://notes.example.com.
    // Default: worked out from each request (Host, X-Forwarded-Proto).
    publicUrl: process.env.MARKPORT_PUBLIC_URL || '',
    // Where the sign-in may send the browser back to (besides loopback).
    redirectHosts: process.env.MARKPORT_OAUTH_REDIRECT_HOSTS || 'claude.ai,claude.com',
    // Hosts whose client metadata documents are fetched (an app's client id
    // is then the URL of that document).
    clientHosts: process.env.MARKPORT_OAUTH_CLIENT_HOSTS || 'claude.ai,claude.com,anthropic.com',
    // Refuse writes that add em/en dashes or emoji to notes.
    plainPunctuation: process.env.MARKPORT_MCP_PLAIN_PUNCTUATION === 'true',
    // Extra instructions for the app. Default: <data>/mcp-instructions.md.
    instructionsFile: process.env.MARKPORT_MCP_INSTRUCTIONS_FILE ? path.resolve(PROJECT_ROOT, process.env.MARKPORT_MCP_INSTRUCTIONS_FILE) : '',
  },
  bootstrap: {
    // Master switch. When false, /api/bootstrap returns { disabled: true }
    // immediately without scanning the vault. Useful for minimal deployments
    // where the round-trip-saving isn't worth the precompute.
    enabled: process.env.BOOTSTRAP_DISABLED !== 'true',

    // Per-file size cap (KB). Files larger than this get stat-only in the
    // response — content is fetched on demand.
    maxFileKB: parseInt(process.env.BOOTSTRAP_MAX_FILE_KB || '500', 10),

    // Total response size cap (MB) on the UNCOMPRESSED JSON. When the
    // accumulated file content would exceed this, the server stops adding
    // content but still returns dirs+electron. Marks response with
    // { capped: true }.
    maxTotalMB: parseInt(process.env.BOOTSTRAP_MAX_TOTAL_MB || '50', 10),
  },
};
