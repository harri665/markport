'use strict';

/**
 * Markport Clipper - background service worker.
 *
 *   picker.js (on any page)  --runtime message-->  here
 *   here  --fetch-->  the image bytes
 *   here  -->  the Markport Clipper plugin (src/plugins/markport-clipper/main.js)
 *
 * Two ways to reach the plugin; both are tried every time vaults are listed:
 *
 *   Markport    a tab on a Markport origin (Options; default 127.0.0.1:3500
 *               and localhost:3500). The plugin's window.__markportClipper is
 *               called with scripting.executeScript in the page's MAIN world.
 *   Desktop     regular Obsidian. The plugin listens on 127.0.0.1, ports
 *               BASE_PORT..BASE_PORT+PORT_COUNT-1, and wants a pairing key
 *               (copied from its settings into Options).
 */

importScripts('lib.js');
const {
  DEFAULT_ORIGINS, MAX_BYTES, BASE_PORT, PORT_COUNT,
  normalizeOrigin, originMatches, normalizeKey, vaultId, vaultLabel,
  resolveMime, bytesToBase64, pickVault, cropRect,
} = self.MarkportLib;

const MENU_ID = 'markport-save-image';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: 'Save image to Markport / Obsidian', contexts: ['image'] });
});

async function getOrigins() {
  const { origins } = await chrome.storage.sync.get({ origins: DEFAULT_ORIGINS });
  return (Array.isArray(origins) ? origins : DEFAULT_ORIGINS).map(normalizeOrigin).filter(Boolean);
}

// Every lookup has a deadline. A tab can hold a script injection forever:
// Edge's sleeping tabs and Chrome's Memory Saver freeze background tabs, and
// a frozen page runs nothing until it is shown again.
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' did not answer within ' + (ms / 1000) + ' s')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function getKeys() {
  const { desktopKeys } = await chrome.storage.local.get({ desktopKeys: [] });
  return (Array.isArray(desktopKeys) ? desktopKeys : []).map(normalizeKey).filter(Boolean);
}

// -- Markport: a vault open in a tab -----------------------------------------

async function callTab(tabId, method, arg) {
  const [res] = await withTimeout(chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [method, arg === undefined ? null : arg],
    func: async (m, a) => {
      const c = window.__markportClipper;
      if (!c || typeof c[m] !== 'function') {
        // Say why, when Obsidian can tell: the fixes differ.
        const p = window.app && window.app.plugins;
        const id = 'markport-clipper';
        let why = '';
        if (p && typeof p.isEnabled === 'function' && !p.isEnabled()) {
          why = ' Community plugins are off in this vault (Settings > Community plugins).';
        } else if (p && p.manifests && !Object.keys(p.manifests).length) {
          // Not even Markport's other system plugin: Obsidian could not read
          // the vault's plugin config. Seen with cloud-sync placeholders
          // (NextCloud/OneDrive "online-only" files) when the client isn't running.
          why = ' No plugin at all loaded here: Markport could not read this vault\'s .obsidian/community-plugins.json.'
            + ' If the vault is in a synced folder (NextCloud, OneDrive...), make sure the sync app is running and the'
            + ' vault is kept on this device, then reload the tab.';
        } else if (p && p.manifests && !p.manifests[id]) {
          why = ' Obsidian does not see it installed: restart the Markport server so it picks up system plugins.';
        } else if (p && p.enabledPlugins && !p.enabledPlugins.has(id)) {
          why = ' It is installed but not enabled: Settings > Community plugins > Markport - Image Clipper.';
        }
        return { error: 'The Markport Clipper plugin is not loaded in this vault.' + why };
      }
      try { return { value: await c[m](a) }; } catch (e) { return { error: String((e && e.message) || e) }; }
    },
  }), method === 'save' ? 60000 : 3000, 'The Markport tab');
  const out = res && res.result;
  if (!out) throw new Error('The Markport tab did not answer.');
  if (out.error) throw new Error(out.error);
  return out.value;
}

const ASLEEP = 'The tab is asleep (Edge sleeping tabs / Chrome Memory Saver) and did not wake up when reloaded. '
  + 'Switch to it once, or exclude this site: Edge Settings > System and performance > "Never put these sites to sleep".';

// How long a reloaded tab gets to boot the vault and load the plugin.
const WAKE_MS = self.__markportWakeMs || 30000;

// A sleeping tab can't run scripts: a discarded one refuses them, a frozen one
// holds them until it is shown. Reloading it in the background wakes it
// without switching to it (it is what the browser does anyway when you click
// a sleeping tab). Nothing live is lost: Obsidian has already written the
// vault to disk. Then wait for the vault to boot and the plugin to answer.
async function wakeTab(tabId) {
  await chrome.tabs.reload(tabId);
  const deadline = Date.now() + WAKE_MS;
  let last, loadedAt = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try { return await callTab(tabId, 'info'); } catch (e) { last = e; }
    // Loaded, but no plugin for a while: a start screen, not a slow vault.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) break;
    if (tab.status === 'complete' && !loadedAt) loadedAt = Date.now();
    if (loadedAt && Date.now() - loadedAt > WAKE_MS / 3 && /not loaded/.test(String(last && last.message))) break;
  }
  throw last || new Error('The tab did not load');
}

// Returns { vaults, checks }: checks says what was tried and why it failed,
// for the Options page's "Find vaults".
async function findTabVaults() {
  const origins = await getOrigins();
  const tabs = (await chrome.tabs.query({})).filter((t) => t.url && originMatches(t.url, origins));
  const checks = [];
  if (!tabs.length) checks.push({ where: 'Markport', ok: false, detail: 'No tab open at ' + origins.join(' or ') });
  const found = await Promise.all(tabs.map(async (t) => {
    const where = 'Markport tab "' + (t.title || t.url) + '"';
    let info, woke = false;
    try {
      if (t.discarded || t.frozen) {
        woke = true;
        info = await wakeTab(t.id);
      } else {
        try {
          info = await callTab(t.id, 'info');
        } catch (e) {
          // No answer from a background tab: asleep, even if the browser
          // doesn't say so (Edge doesn't always set tab.frozen).
          if (t.active || !/did not answer within/.test(String(e && e.message))) throw e;
          woke = true;
          info = await wakeTab(t.id);
        }
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      const detail = woke && /did not answer within|did not load|Cannot access/.test(msg) ? ASLEEP
        : /not loaded/.test(msg) && !/\/vault\//.test(t.url) ? 'No vault open in this tab (start screen)'
        : msg;
      checks.push({ where, ok: false, detail });
      return null;
    }
    // Ask the browser not to discard it again (Chrome's Memory Saver honors this).
    chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
    checks.push({ where, ok: true, detail: 'vault "' + info.vault + '"' + (woke ? ' (the tab was asleep; reloaded it to wake it)' : '') });
    return { kind: 'tab', tabId: t.id, lastAccessed: t.lastAccessed || 0, info };
  }));
  return { vaults: found.filter(Boolean), checks };
}

// -- Desktop Obsidian: a local HTTP server per open vault --------------------

async function callHttp(port, key, method, arg) {
  const base = 'http://127.0.0.1:' + port;
  const opts = { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' };
  let res;
  if (method === 'info') {
    res = await fetch(base + '/info', Object.assign(opts, { signal: AbortSignal.timeout(2000) }));
  } else {
    const path = method === 'setTarget' ? '/target' : '/save';
    const body = method === 'setTarget' ? { folder: arg } : arg;
    opts.headers['Content-Type'] = 'application/json';
    res = await fetch(base + path, Object.assign(opts, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }));
  }
  let out;
  try { out = await res.json(); } catch (_) { throw new Error('Obsidian answered with HTTP ' + res.status); }
  if (!res.ok || out.error) throw new Error(out.error || 'HTTP ' + res.status);
  return out.value;
}

async function findDesktopVaults() {
  const keys = await getKeys();
  const checks = [];
  const ports = Array.from({ length: PORT_COUNT }, (_, i) => BASE_PORT + i);
  const found = await Promise.all(ports.map(async (port) => {
    try {
      const ping = await fetch('http://127.0.0.1:' + port + '/ping', { cache: 'no-store', signal: AbortSignal.timeout(800) }).then((r) => r.json());
      if (!ping || ping.app !== 'markport-clipper') return null;
    } catch (_) {
      return null;   // nothing listening: the usual case
    }
    const where = 'Obsidian on port ' + port;
    if (!keys.length) {
      checks.push({ where, ok: false, detail: 'Obsidian is running the plugin, but no pairing key is saved in Options' });
      return { kind: 'desktop', port, unpaired: true };
    }
    for (const key of keys) {
      try {
        const info = await callHttp(port, key, 'info');
        checks.push({ where, ok: true, detail: 'vault "' + info.vault + '"' });
        return { kind: 'desktop', port, key, lastAccessed: 0, info };
      } catch (_) { /* a different vault's key - try the next */ }
    }
    checks.push({ where, ok: false, detail: 'None of the saved pairing keys is this vault\'s' });
    return { kind: 'desktop', port, unpaired: true };
  }));
  if (!checks.length) checks.push({ where: 'Obsidian (desktop)', ok: false, detail: 'Not running, or the plugin is not enabled in any open vault (ports ' + BASE_PORT + '-' + (BASE_PORT + PORT_COUNT - 1) + ')' });
  return { vaults: found.filter((d) => d && !d.unpaired), unpaired: found.filter((d) => d && d.unpaired).length, checks };
}

// -- Both --------------------------------------------------------------------

function callPlugin(v, method, arg) {
  return v.kind === 'tab' ? callTab(v.tabId, method, arg) : callHttp(v.port, v.key, method, arg);
}

// The last lookup, { at, result }: lets the drag popup list folders at once.
// Kept in storage.session too, since the browser stops this worker after
// 30 s idle; session storage is memory-only and not visible to web pages.
let lastFound = null;

async function getLastFound() {
  if (lastFound) return lastFound;
  try { return (await chrome.storage.session.get('lastFound')).lastFound || null; } catch (_) { return null; }
}

async function findVaults() {
  const [tabs, desktop] = await Promise.all([
    findTabVaults().catch((e) => ({ vaults: [], checks: [{ where: 'Markport', ok: false, detail: String(e.message || e) }] })),
    findDesktopVaults().catch((e) => ({ vaults: [], unpaired: 0, checks: [{ where: 'Obsidian (desktop)', ok: false, detail: String(e.message || e) }] })),
  ]);
  const byId = new Map();
  for (const v of tabs.vaults.concat(desktop.vaults)) {
    v.id = vaultId(v.kind === 'tab' ? 'markport' : 'desktop', v.info.vault);
    v.label = vaultLabel(v.kind === 'tab' ? 'markport' : 'desktop', v.info.vault);
    const prev = byId.get(v.id);
    if (!prev || v.lastAccessed > prev.lastAccessed) byId.set(v.id, v);   // same vault in two tabs
  }
  const result = { vaults: [...byId.values()], unpaired: desktop.unpaired, checks: tabs.checks.concat(desktop.checks) };
  lastFound = { at: Date.now(), result };
  try { chrome.storage.session.set({ lastFound }).catch(() => {}); } catch (_) { /* no session storage */ }
  return result;
}

async function noVaultMessage(unpaired) {
  if (unpaired) {
    return 'Obsidian is running, but this extension is not paired with that vault. '
      + 'Copy the pairing key from Obsidian (Settings > Markport - Image Clipper) into this extension\'s options.';
  }
  const origins = await getOrigins();
  return 'No vault found. Open one in Obsidian (with the Markport Clipper plugin) or in Markport at ' + origins[0]
    + '. Options > Find vaults shows what was checked.';
}

async function targetsReply(found) {
  const { lastVault } = await chrome.storage.local.get('lastVault');
  const { recentFolders } = await chrome.storage.local.get({ recentFolders: {} });
  const selected = pickVault(found.vaults, lastVault);
  return {
    vaults: found.vaults.map((v) => Object.assign(describe(v), { recent: recentFolders[v.id] || [] })),
    selected: selected ? selected.id : null,
    message: found.vaults.length ? null : await noVaultMessage(found.unpaired),
    checks: found.checks,
  };
}

async function rememberFolder(id, folder) {
  const { recentFolders } = await chrome.storage.local.get({ recentFolders: {} });
  const list = (recentFolders[id] || []).filter((f) => f !== folder);
  list.unshift(folder);
  recentFolders[id] = list.slice(0, 5);
  await chrome.storage.local.set({ recentFolders, lastVault: id });
}

async function resolveVault(id) {
  const { vaults, unpaired } = await findVaults();
  const { lastVault } = await chrome.storage.local.get('lastVault');
  const v = pickVault(vaults, id || lastVault);
  if (!v) throw new Error(await noVaultMessage(unpaired));
  return v;
}

function describe(v) {
  return { id: v.id, label: v.label, target: v.info.target, folders: v.info.folders };
}

// -- Getting the image bytes -------------------------------------------------

function headBytes(b64) {
  const s = atob(b64.slice(0, 1368));   // 1368 base64 chars = 1026 bytes
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function fetchHere(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('The image is larger than 50 MB');
  return { data: bytesToBase64(bytes), mime: resolveMime(res.headers.get('content-type'), bytes) };
}

// In the page itself: needed for blob: URLs, and for images that only load
// with the page's own origin (referer checks, same-origin session cookies).
async function fetchInPage(url, tabId, frameId) {
  const [res] = await chrome.scripting.executeScript({
    target: frameId ? { tabId, frameIds: [frameId] } : { tabId },
    args: [url, MAX_BYTES],
    func: async (u, max) => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) return { error: 'HTTP ' + r.status };
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length > max) return { error: 'The image is larger than 50 MB' };
        let bin = '';
        for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        return { data: btoa(bin), type: r.headers.get('content-type') || '' };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    },
  });
  const out = res && res.result;
  if (!out || out.error) throw new Error((out && out.error) || 'Could not read the image in the page');
  return { data: out.data, mime: resolveMime(out.type, headBytes(out.data)) };
}

async function getImage(url, tabId, frameId) {
  if (/^data:/i.test(url)) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(url);
    if (!m) throw new Error('Unreadable data: URL');
    const data = m[2] ? m[3] : btoa(unescape(encodeURIComponent(decodeURIComponent(m[3]))));
    return { data, mime: resolveMime(m[1], headBytes(data)) };
  }
  if (/^blob:/i.test(url)) return fetchInPage(url, tabId, frameId);
  try {
    return await fetchHere(url);
  } catch (first) {
    try { return await fetchInPage(url, tabId, frameId); } catch (_) { throw first; }
  }
}

// -- Saving ------------------------------------------------------------------

async function save(req, tab, frameId) {
  const v = await resolveVault(req.vault);
  const img = req.inline || await getImage(req.src, tab.id, frameId);
  if (!img.mime) throw new Error('That is not an image file.');
  const result = await callPlugin(v, 'save', {
    data: img.data,
    mime: img.mime,
    url: req.src,
    alt: req.alt || '',
    pageUrl: tab.url,
    pageTitle: tab.title,
    // Dropped on a folder in the drag popup: that folder, this once.
    folder: typeof req.folder === 'string' ? req.folder : undefined,
  });
  await rememberFolder(v.id, typeof req.folder === 'string' ? req.folder : v.info.target);
  return { label: v.label, path: result.path, notePath: result.notePath };
}

// -- Screenshots (capture mode, picker.js) -----------------------------------

// The visible part of the tab, cropped to the rectangle drawn in the page.
// picker.js hides its overlay before asking, so it is not in the picture.
async function capture(req, tab) {
  if (!tab) throw new Error('No tab to capture');
  let url;
  try {
    url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    throw new Error('Could not capture this page: ' + String((e && e.message) || e));
  }
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const vp = req.viewport || {};
  const c = cropRect(req.rect, vp.w, vp.h, bitmap.width, bitmap.height);
  if (!c) throw new Error('The selection is empty');
  const canvas = new OffscreenCanvas(c.w, c.h);
  canvas.getContext('2d').drawImage(bitmap, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('The screenshot is larger than 50 MB');
  return { data: bytesToBase64(bytes), mime: 'image/png', w: c.w, h: c.h };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'targets': {
        // cached: answer from the last lookup if it is recent (the drag
        // popup has to appear while the drag is still going), and then
        // the caller asks again without it for a fresh list - which may
        // take a few seconds if a Markport tab has to be woken up.
        const prev = msg.cached && await getLastFound();
        if (prev && Date.now() - prev.at < 10 * 60000 && prev.result.vaults.length) {
          return targetsReply(prev.result);
        }
        return targetsReply(await findVaults());
      }
      case 'setTarget': {
        const v = await resolveVault(msg.vault);
        v.info = await callPlugin(v, 'setTarget', msg.folder);
        await rememberFolder(v.id, v.info.target);
        return describe(v);
      }
      case 'save':
        return save(msg, sender.tab, sender.frameId);
      case 'capture':
        return capture(msg, sender.tab);
      case 'openOptions':
        chrome.runtime.openOptionsPage();
        return {};
      default:
        throw new Error('Unknown message');
    }
  })().then(
    (value) => sendResponse({ ok: true, value }),
    (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
  );
  return true;   // async sendResponse
});

// -- Turning capture mode on -------------------------------------------------

async function togglePicker(tab) {
  if (!tab || !tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib.js', 'find-image.js', 'menu.js', 'picker.js'] });
  } catch (e) {
    // chrome://, the Web Store, the PDF viewer... - pages extensions may not touch.
    flashBadge(tab.id, '\u00d7', '#b3261e');
  }
}

chrome.action.onClicked.addListener(togglePicker);
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-picker') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  togglePicker(tab);
});

// -- Right-click > Save image ------------------------------------------------

function flashBadge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 2500);
}

function toastInPage(tabId, text, isError) {
  chrome.scripting.executeScript({
    target: { tabId },
    args: [text, !!isError],
    func: (t, err) => {
      const el = document.createElement('div');
      el.textContent = t;
      el.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:420px;padding:10px 14px;'
        + 'border-radius:8px;font:13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.35);'
        + 'background:' + (err ? '#b3261e' : '#2b2b2b');
      document.documentElement.appendChild(el);
      setTimeout(() => el.remove(), err ? 7000 : 3500);
    },
  }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;
  try {
    const r = await save({ src: info.srcUrl }, tab, info.frameId);
    flashBadge(tab.id, '\u2713', '#2e7d32');
    toastInPage(tab.id, 'Saved to ' + r.label + ': ' + r.path);
  } catch (e) {
    flashBadge(tab.id, '!', '#b3261e');
    toastInPage(tab.id, 'Markport Clipper: ' + e.message, true);
  }
});
