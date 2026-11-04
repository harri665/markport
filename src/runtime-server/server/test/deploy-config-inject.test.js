/**
 * Integration test for the Node server's deploy-config inject (docs/plans/
 * deploy-config.md §4 Commit 3) — sendHtmlWithCacheBust() must replace the
 * <!-- OW_CONFIG_INJECT --> marker in the served index.html with a literal
 * `<script>window.__owConfigInjected={...}</script>` built from the real
 * src/config/deploy-config.json, positioned BEFORE the deploy-config.js tag
 * (order is critical — see deploy-config.js comment: otherwise the loader
 * silently falls back to DEFAULTS).
 *
 * Mirrors the same injection build-assets.sh does at build-time for the CF
 * deploy — this is the serve-time counterpart for runtime-server.
 */

'use strict';

const assert = require('assert/strict');
const http = require('http');
const test = require('node:test');

const { createApp } = require('../index');
const realDeployConfig = require('../../../config/deploy-config.json');

async function startTestServer() {
  // No appConfig override — projectRoot stays the real repo root, so the
  // server reads the REAL src/config/deploy-config.json (same file
  // build-assets.sh reads), just like it would in production.
  const app = createApp({});
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('GET / injects window.__owConfigInjected built from the real deploy-config.json', async (t) => {
  const server = await startTestServer();
  t.after(server.close);

  const res = await fetch(server.baseUrl + '/');
  assert.equal(res.status, 200);
  const html = await res.text();

  const expectedSnippet = '<script>window.__owConfigInjected=' + JSON.stringify(realDeployConfig) + '</script>';
  assert.ok(html.includes(expectedSnippet), 'served HTML contains the injected config snippet');

  // The marker itself must be gone (fully replaced, not left alongside).
  assert.ok(!html.includes('<!-- OW_CONFIG_INJECT -->'), 'marker comment is replaced, not left in place');
});

test('GET / injects the config snippet BEFORE the deploy-config.js script tag (order is load-bearing)', async (t) => {
  const server = await startTestServer();
  t.after(server.close);

  const res = await fetch(server.baseUrl + '/');
  const html = await res.text();

  // Search for the actual <script> tags, not bare substrings — the doc
  // comment above the marker also mentions both "window.__owConfigInjected="
  // and "deploy-config.js" in prose, which would false-positive a plain
  // indexOf() on those bare strings.
  const injectIdx = html.indexOf('<script>window.__owConfigInjected=');
  const loaderIdx = html.indexOf('src="/client-mobile/deploy-config.js');
  assert.ok(injectIdx !== -1, 'injected snippet present');
  assert.ok(loaderIdx !== -1, 'deploy-config.js tag present');
  assert.ok(injectIdx < loaderIdx, 'injected snippet precedes the deploy-config.js loader tag');
});

test('GET /mobile and /vault/:id also serve the same index.html with the injected config', async (t) => {
  const server = await startTestServer();
  t.after(server.close);

  for (const route of ['/mobile', '/vault/abc123']) {
    const res = await fetch(server.baseUrl + route);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<script>window.__owConfigInjected='), `${route} injects config`);
  }
});
