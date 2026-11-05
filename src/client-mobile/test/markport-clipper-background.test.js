'use strict';

/**
 * Markport Clipper: src/browser-extension/background.js, run in a vm with a
 * fake chrome.* API. Covers finding vaults (including tabs that never answer,
 * which is what Edge's sleeping tabs do to script injection), the
 * diagnostics the Options page shows, and saving into a chosen folder.
 */

const assert = require('assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', '..', 'browser-extension');

function event() {
  const listeners = [];
  return { addListener: (f) => listeners.push(f), listeners };
}

function loadBackground({ tabs, desktop }) {
  const store = { sync: {}, local: {}, session: {} };
  const area = (name) => ({
    async get(defaults) {
      if (typeof defaults === 'string') return { [defaults]: store[name][defaults] };
      return Object.assign({}, defaults, store[name]);
    },
    async set(obj) { Object.assign(store[name], JSON.parse(JSON.stringify(obj))); },   // chrome.storage stores copies
  });
  const calls = [];
  const chrome = {
    runtime: { onInstalled: event(), onMessage: event(), openOptionsPage() {} },
    contextMenus: { create() {}, onClicked: event() },
    action: { onClicked: event(), setBadgeText() {}, setBadgeBackgroundColor() {} },
    commands: { onCommand: event() },
    storage: { sync: area('sync'), local: area('local'), session: area('session'), onChanged: event() },
    tabs: {
      query: async () => tabs.map((t) => Object.assign({}, t, { behavior: undefined })),
      get: async (id) => Object.assign({}, tabs.find((t) => t.id === id), { behavior: undefined, status: 'complete' }),
      // What the browser does to a sleeping tab when it is reloaded.
      reload: async (id) => { const t = tabs.find((x) => x.id === id); t.reloads = (t.reloads || 0) + 1; t.frozen = false; t.discarded = false; },
      update: async (id, props) => { Object.assign(tabs.find((t) => t.id === id), props); },
    },
    scripting: {
      async executeScript({ target, args, world }) {
        const tab = tabs.find((t) => t.id === target.tabId);
        if (world !== 'MAIN') throw new Error('unexpected injection');
        calls.push({ tabId: tab.id, method: args[0], arg: args[1] });
        if (tab.discarded) throw new Error('Cannot access contents of the page.');
        return tab.behavior(args[0], args[1], tab);
      },
    },
  };
  const sandbox = {
    chrome,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, AbortSignal, TextEncoder,
    atob, btoa,
    fetch: async (url) => {
      const m = /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(url);
      if (m && desktop && desktop[m[1]]) return desktop[m[1]](url);
      if (m) throw new TypeError('fetch failed');   // nothing listening
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), { headers: { 'content-type': 'image/png' } });
    },
  };
  sandbox.self = sandbox;
  sandbox.__markportWakeMs = 1500;
  sandbox.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), sandbox);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), sandbox);

  const onMessage = chrome.runtime.onMessage.listeners[0];
  const send = (msg, sender) => new Promise((resolve) => {
    // Real extension messages are serialized; so are these.
    onMessage(msg, sender || { tab: { id: 99, url: 'https://pics.example/page', title: 'Pics' } }, (r) => resolve(JSON.parse(JSON.stringify(r))));
  });
  return { send, calls, store };
}

const info = (vault, target) => ({ apiVersion: 1, vault, target: target || '', folders: ['', 'Clips', 'Clips/Web'] });
const answers = (vault, saved) => async (method, arg) => {
  if (method === 'info') return [{ result: { value: info(vault, 'Clips') } }];
  if (method === 'save') { saved.push(arg); return [{ result: { value: { path: (arg.folder || 'Clips') + '/x.png' } } }]; }
  if (method === 'setTarget') return [{ result: { value: info(vault, arg) } }];
  return [{ result: { error: 'unknown' } }];
};

test('sleeping Markport tabs are woken by reloading them; one that stays asleep is explained', async () => {
  const saved = [];
  const awake = answers('Demo', saved);
  // A frozen or discarded tab only runs scripts after it is reloaded.
  const afterReload = (vault) => (m, a, tab) => (tab.reloads ? answers(vault, saved)(m, a) : new Promise(() => {}));
  const tabs = [
    { id: 1, url: 'http://127.0.0.1:3500/vault/a', title: 'Demo - Markport', lastAccessed: 5, behavior: awake },
    { id: 2, url: 'http://127.0.0.1:3500/vault/b', title: 'Stuck - Markport', lastAccessed: 9, behavior: () => new Promise(() => {}) },
    { id: 3, url: 'http://localhost:3500/vault/c', title: 'Frozen - Markport', frozen: true, behavior: afterReload('Frozen') },
    { id: 4, url: 'http://localhost:3500/vault/d', title: 'Discarded - Markport', discarded: true, behavior: afterReload('Discarded') },
    { id: 5, url: 'http://127.0.0.1:3500/vault/e', title: 'Unflagged - Markport', behavior: afterReload('Unflagged') },
    { id: 6, url: 'https://elsewhere.example/', title: 'Other', behavior: () => { throw new Error('must not be called'); } },
  ];
  const { send } = loadBackground({ tabs });
  const t0 = Date.now();
  const r = await send({ type: 'targets' });
  const ms = Date.now() - t0;
  assert.ok(r.ok, r.error);
  assert.ok(ms < 10000, 'lookup took ' + ms + ' ms');
  assert.deepEqual(r.value.vaults.map((v) => v.label).sort(),
    ['Demo (Markport)', 'Discarded (Markport)', 'Frozen (Markport)', 'Unflagged (Markport)']);
  const byWhere = Object.fromEntries(r.value.checks.map((c) => [c.where, c]));
  assert.equal(byWhere['Markport tab "Demo - Markport"'].detail, 'vault "Demo"');
  for (const name of ['Frozen', 'Discarded', 'Unflagged']) {
    assert.match(byWhere['Markport tab "' + name + ' - Markport"'].detail, /was asleep; reloaded it/);
  }
  assert.equal(byWhere['Markport tab "Stuck - Markport"'].ok, false);
  assert.match(byWhere['Markport tab "Stuck - Markport"'].detail, /asleep.*did not wake up/s);
  assert.ok(!('Markport tab "Other"' in byWhere));
  assert.equal(tabs[0].reloads, undefined, 'an awake tab is not reloaded');
  assert.equal(tabs[1].reloads, 1, 'a stuck tab is reloaded once');
  assert.equal(tabs[0].autoDiscardable, false);
});

test('the active tab is never reloaded, even if it is slow', async () => {
  const tabs = [{ id: 1, url: 'http://127.0.0.1:3500/vault/a', title: 'Busy', active: true, behavior: () => new Promise(() => {}) }];
  const { send } = loadBackground({ tabs });
  const r = await send({ type: 'targets' });
  assert.match(r.value.checks[0].detail, /did not answer within 3 s/);
  assert.equal(tabs[0].reloads, undefined);
});

test('no vault anywhere: a message, and checks saying where it looked', async () => {
  const { send } = loadBackground({ tabs: [] });
  const r = await send({ type: 'targets' });
  assert.ok(r.ok);
  assert.equal(r.value.vaults.length, 0);
  assert.match(r.value.message, /No vault found/);
  assert.match(r.value.checks[0].detail, /No tab open at http:\/\/127\.0\.0\.1:3500 or http:\/\/localhost:3500/);
});

test('the start screen is reported as "no vault open", not as an error', async () => {
  const { send } = loadBackground({
    tabs: [{ id: 1, url: 'http://127.0.0.1:3500/starter', title: 'Markport', behavior: async () => [{ result: { error: 'The Markport Clipper plugin is not loaded in this vault.' } }] }],
  });
  const r = await send({ type: 'targets' });
  assert.match(r.value.checks[0].detail, /start screen/);
});

test('saving with a folder (the drag popup) passes it through and remembers it as recent', async () => {
  const saved = [];
  const { send, store } = loadBackground({
    tabs: [{ id: 1, url: 'http://127.0.0.1:3500/vault/a', title: 'Demo', behavior: answers('Demo', saved) }],
  });
  const r = await send({ type: 'save', vault: 'markport:Demo', folder: 'Clips/Web', src: 'https://pics.example/cat.png', alt: 'cat' });
  assert.ok(r.ok, r.error);
  assert.equal(r.value.path, 'Clips/Web/x.png');
  assert.equal(saved[0].folder, 'Clips/Web');
  assert.equal(saved[0].mime, 'image/png');
  assert.equal(saved[0].pageUrl, 'https://pics.example/page');
  // The image's own address goes to the plugin too: it is the "Source" the library records.
  assert.equal(saved[0].url, 'https://pics.example/cat.png');
  assert.deepEqual(store.local.recentFolders['markport:Demo'], ['Clips/Web']);

  const plain = await send({ type: 'save', vault: 'markport:Demo', src: 'https://pics.example/dog.png' });
  assert.ok(plain.ok);
  assert.equal(saved[1].folder, undefined, 'pick mode saves into the target folder');

  const targets = await send({ type: 'targets', cached: true });
  assert.deepEqual(targets.value.vaults[0].recent, ['Clips', 'Clips/Web']);
});

test('desktop Obsidian: found with a pairing key, explained without one', async () => {
  const KEY = 'ab'.repeat(24);
  const desktop = {
    27151: async (url) => {
      if (url.endsWith('/ping')) return Response.json({ app: 'markport-clipper', apiVersion: 1 });
      return Response.json({ value: info('Notes') });
    },
  };
  const unpaired = loadBackground({ tabs: [], desktop });
  const r1 = await unpaired.send({ type: 'targets' });
  assert.equal(r1.value.vaults.length, 0);
  assert.match(r1.value.message, /not paired/);
  assert.match(r1.value.checks.find((c) => c.where === 'Obsidian on port 27151').detail, /no pairing key/);

  const paired = loadBackground({ tabs: [], desktop });
  paired.store.local.desktopKeys = [KEY];
  const r2 = await paired.send({ type: 'targets' });
  assert.deepEqual(r2.value.vaults.map((v) => v.label), ['Notes (Obsidian)']);
});
