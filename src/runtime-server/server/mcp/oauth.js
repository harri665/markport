/**
 * OAuth 2.1 sign-in for the MCP endpoint (mcp/server.js), so an app like
 * Claude can be connected to Markport without copying a token around.
 *
 * Markport is its own authorization server. The flow, as the MCP spec has it:
 *
 *   1. The app calls /mcp, gets 401 with a link to
 *      /.well-known/oauth-protected-resource, which names this server as the
 *      authorization server; /.well-known/oauth-authorization-server lists
 *      the endpoints below.
 *   2. It identifies itself: by registering (POST /oauth/register, RFC 7591),
 *      or with a client id that is the URL of its metadata document (Client
 *      ID Metadata Documents), fetched from an allowed host only.
 *   3. It sends the owner's browser to /oauth/authorize. The page says which
 *      app asks and where the browser goes back to; the owner types the
 *      Markport password to allow it. PKCE (S256) is required.
 *   4. The app trades the code for an access token (1 hour) and a refresh
 *      token (90 days, renewed on every use) at POST /oauth/token.
 *
 * Nothing but connections is stored: client ids, codes and tokens are
 * signed (auth.seal), and tied to the password. Each connection is a grant
 * in <data>/oauth-grants.json; revoking it (at /oauth/connections) signs that
 * app out at once. Changing the password signs every app out.
 *
 * Where the browser may be sent back to is limited to MARKPORT_OAUTH_REDIRECT_HOSTS
 * (default claude.ai, claude.com) plus loopback addresses (apps running on
 * the owner's own computer), so a link made by someone else can't send a
 * code to their site even if the owner types the password.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('../shares/render');
const { shell, messagePage, pageHeaders, PAGE_CSP } = require('../shares/html');

const ACCESS_TTL = 60 * 60 * 1000;
const REFRESH_TTL = 90 * 86400 * 1000;
const CODE_TTL = 5 * 60 * 1000;
const CLIENT_TTL = 10 * 365 * 86400 * 1000;
const SCOPE = 'vault';
const CIMD_TTL = 10 * 60 * 1000;

function hostList(v, fallback) {
  const s = v === undefined || v === null || v === '' ? fallback : String(v);
  return s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function hostMatches(host, list) {
  host = String(host || '').toLowerCase();
  return list.some((h) => h === '*' || host === h || host.endsWith('.' + h));
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function b64urlSha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('base64url');
}

function oauthError(res, status, error, description) {
  res.status(status).json({ error, error_description: description });
}

function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

// The connections: { id: { client (sha256 of the client id), clientName,
// redirectHost, createdAt, usedAt, n } }.
// n counts refresh-token rotations: only the newest refresh token works.
class GrantStore {
  constructor(file) {
    this.file = file;
    this.grants = {};
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (v && typeof v.grants === 'object') this.grants = v.grants;
    } catch (_) { /* none yet */ }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ grants: this.grants }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  create(fields) {
    const id = crypto.randomBytes(12).toString('base64url');
    this.grants[id] = Object.assign({ createdAt: Date.now(), usedAt: Date.now(), n: 0 }, fields);
    this.save();
    return id;
  }

  get(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(this.grants, id) ? this.grants[id] : null;
  }

  remove(id) {
    if (!this.get(id)) return false;
    delete this.grants[id];
    this.save();
    return true;
  }

  list() {
    return Object.entries(this.grants).map(([id, g]) => Object.assign({ id }, g));
  }
}

// opts: { auth, dataDir, publicUrl, redirectHosts, cimdHosts, fetch }
function createOAuth(opts) {
  const { auth } = opts;
  const grants = new GrantStore(path.join(opts.dataDir, 'oauth-grants.json'));
  const redirectHosts = hostList(opts.redirectHosts, 'claude.ai,claude.com');
  const cimdHosts = hostList(opts.cimdHosts, 'claude.ai,claude.com,anthropic.com');
  const doFetch = opts.fetch || fetch;
  const usedCodes = new Map();   // code id -> expiry
  const cimdCache = new Map();   // url -> { at, client }

  function base(req) {
    if (opts.publicUrl) return String(opts.publicUrl).replace(/\/+$/, '');
    return req.protocol + '://' + req.get('host');
  }

  function resourceMetadataUrl(req) {
    return base(req) + '/.well-known/oauth-protected-resource';
  }

  function redirectAllowed(uri) {
    let u;
    try { u = new URL(uri); } catch (_) { return false; }
    if (u.hash) return false;
    if (u.protocol === 'http:') return isLoopback(u.hostname);
    if (u.protocol !== 'https:') return false;
    return isLoopback(u.hostname) || hostMatches(u.hostname, redirectHosts);
  }

  // A client id: our own signed registration, or the https URL of the app's
  // metadata document. -> { id, name, redirectUris } or null.
  async function resolveClient(clientId) {
    if (typeof clientId !== 'string' || !clientId) return null;
    if (/^https:\/\//i.test(clientId)) return fetchClientDocument(clientId);
    const d = auth.unseal('oauth-client', clientId);
    if (!d || !Array.isArray(d.r)) return null;
    return { id: clientId, name: typeof d.n === 'string' && d.n ? d.n : 'An app', redirectUris: d.r };
  }

  async function fetchClientDocument(url) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    if (u.protocol !== 'https:' || !hostMatches(u.hostname, cimdHosts)) return null;
    const hit = cimdCache.get(url);
    if (hit && Date.now() - hit.at < CIMD_TTL) return hit.client;
    let doc;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const r = await doFetch(url, { signal: ctl.signal, redirect: 'error', headers: { Accept: 'application/json' } });
      clearTimeout(timer);
      if (!r.ok) return null;
      const text = await r.text();
      if (text.length > 64 * 1024) return null;
      doc = JSON.parse(text);
    } catch (_) {
      return null;
    }
    if (!doc || doc.client_id !== url || !Array.isArray(doc.redirect_uris)) return null;
    const client = {
      id: url,
      name: typeof doc.client_name === 'string' && doc.client_name ? doc.client_name.slice(0, 100) : u.hostname,
      redirectUris: doc.redirect_uris.filter((x) => typeof x === 'string'),
    };
    cimdCache.set(url, { at: Date.now(), client });
    return client;
  }

  function issueTokens(grantId, g) {
    return {
      access_token: auth.seal('mcp-access', { g: grantId }, ACCESS_TTL),
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL / 1000),
      refresh_token: auth.seal('mcp-refresh', { g: grantId, n: g.n }, REFRESH_TTL),
      scope: SCOPE,
    };
  }

  // The connection an MCP request's access token belongs to, or null.
  function verifyAccess(req) {
    const t = auth.requestToken(req);
    const d = t && auth.unseal('mcp-access', t);
    if (!d) return null;
    const g = grants.get(d.g);
    return g ? Object.assign({ id: d.g }, g) : null;
  }

  // ── pages ──
  function consentPage(req, res, client, p, error, status) {
    let host = '';
    try { host = new URL(p.redirect_uri).host; } catch (_) { /* validated before */ }
    const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
      .map((k) => (p[k] ? '<input type="hidden" name="' + k + '" value="' + escapeHtml(p[k]) + '">' : ''))
      .join('');
    const form = '<form method="post" action="/oauth/authorize" class="mp-form">' + hidden +
      '<label>Password<input type="password" name="password" autocomplete="current-password" autofocus></label>' +
      (error ? '<p class="mp-error">' + escapeHtml(error) + '</p>' : '') +
      '<button type="submit" name="decision" value="allow" class="mod-cta">Allow</button> ' +
      '<button type="submit" name="decision" value="deny">Deny</button></form>';
    pageHeaders(res);
    // The form ends in a redirect to the app; browsers apply form-action to it.
    let origin = '';
    try { origin = new URL(p.redirect_uri).origin; } catch (_) { /* none */ }
    res.set('Content-Security-Policy', PAGE_CSP.replace("form-action 'self'", "form-action 'self' " + origin));
    res.status(status || 200).send(messagePage('Connect ' + client.name,
      client.name + ' wants to read and change the notes in all your Markport vaults. ' +
      'After you allow it, you go back to ' + host + '. Enter your Markport password to allow it.', { form }));
  }

  function errorPage(res, status, message) {
    pageHeaders(res);
    res.status(status).send(messagePage('Can\'t connect', message));
  }

  // Checks what /oauth/authorize was sent. -> { client } or { page } (an error
  // to show, never redirect: the redirect itself isn't trusted yet) or
  // { redirect } (an error the app should get).
  async function checkAuthorize(p) {
    const client = await resolveClient(p.client_id);
    if (!client) return { page: 'This app is unknown to Markport. Start connecting it again from the app.' };
    if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri) || !redirectAllowed(p.redirect_uri)) {
      return { page: 'This app asked to send you back to an address Markport doesn\'t allow.' };
    }
    if (p.response_type !== undefined && p.response_type !== 'code') return { client, redirect: 'unsupported_response_type' };
    if (!p.code_challenge || (p.code_challenge_method || 'plain') !== 'S256') return { client, redirect: 'invalid_request' };
    return { client };
  }

  function backTo(req, res, p, params) {
    const u = new URL(p.redirect_uri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (p.state) u.searchParams.set('state', p.state);
    u.searchParams.set('iss', base(req));
    res.redirect(302, u.toString());
  }

  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '32kb' });
  const json = express.json({ limit: '32kb' });

  router.get('/.well-known/oauth-protected-resource', cors, (req, res) => {
    res.json({
      resource: base(req) + '/mcp',
      authorization_servers: [base(req)],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Markport',
    });
  });
  router.get('/.well-known/oauth-protected-resource/mcp', cors, (req, res) => res.redirect(307, '/.well-known/oauth-protected-resource'));
  router.options('/.well-known/*', cors);

  router.get('/.well-known/oauth-authorization-server', cors, (req, res) => {
    const b = base(req);
    res.json({
      issuer: b,
      authorization_endpoint: b + '/oauth/authorize',
      token_endpoint: b + '/oauth/token',
      registration_endpoint: b + '/oauth/register',
      scopes_supported: [SCOPE],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  router.options('/oauth/register', cors);
  router.post('/oauth/register', cors, json, (req, res) => {
    if (!auth.enabled) return oauthError(res, 400, 'invalid_request', 'Markport has no password set, so it can\'t sign apps in.');
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((x) => typeof x === 'string') : [];
    if (!uris.length || uris.length > 10) return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris is required.');
    const bad = uris.find((u) => !redirectAllowed(u));
    if (bad) return oauthError(res, 400, 'invalid_redirect_uri', 'Markport does not allow redirects to ' + bad + '.');
    const name = typeof b.client_name === 'string' ? b.client_name.trim().slice(0, 100) : '';
    const clientId = auth.seal('oauth-client', { r: uris, n: name }, CLIENT_TTL);
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name || undefined,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    });
  });

  router.get('/oauth/authorize', async (req, res, next) => {
    try {
      if (!auth.enabled) return errorPage(res, 400, 'Markport has no password set, so it can\'t sign apps in.');
      const p = req.query;
      const c = await checkAuthorize(p);
      if (c.page) return errorPage(res, 400, c.page);
      if (c.redirect) return backTo(req, res, p, { error: c.redirect });
      consentPage(req, res, c.client, p);
    } catch (err) {
      next(err);
    }
  });

  router.post('/oauth/authorize', form, async (req, res, next) => {
    try {
      if (!auth.enabled) return errorPage(res, 400, 'Markport has no password set, so it can\'t sign apps in.');
      const p = req.body || {};
      const c = await checkAuthorize(p);
      if (c.page) return errorPage(res, 400, c.page);
      if (c.redirect) return backTo(req, res, p, { error: c.redirect });
      if (p.decision !== 'allow') return backTo(req, res, p, { error: 'access_denied' });
      const key = auth.clientKey(req);
      if (auth.loginLimiter.blocked(key)) return consentPage(req, res, c.client, p, 'Too many attempts. Try again in a few minutes.', 429);
      if (!auth.checkPassword(String(p.password || ''))) {
        auth.loginLimiter.fail(key);
        return consentPage(req, res, c.client, p, 'Wrong password.', 401);
      }
      auth.loginLimiter.reset(key);
      const code = auth.seal('oauth-code', {
        j: crypto.randomBytes(9).toString('base64url'),
        c: c.client.id,
        n: c.client.name,
        r: p.redirect_uri,
        ch: p.code_challenge,
      }, CODE_TTL);
      backTo(req, res, p, { code });
    } catch (err) {
      next(err);
    }
  });

  router.options('/oauth/token', cors);
  router.post('/oauth/token', cors, form, json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!auth.enabled) return oauthError(res, 400, 'invalid_request', 'Markport has no password set.');
    const b = req.body || {};
    const now = Date.now();
    for (const [j, exp] of usedCodes) if (exp < now) usedCodes.delete(j);

    if (b.grant_type === 'authorization_code') {
      const d = auth.unseal('oauth-code', b.code);
      if (!d || usedCodes.has(d.j)) return oauthError(res, 400, 'invalid_grant', 'The code is invalid, expired or used.');
      if (b.client_id && b.client_id !== d.c) return oauthError(res, 400, 'invalid_grant', 'The code was issued to another app.');
      if (b.redirect_uri && b.redirect_uri !== d.r) return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match.');
      if (typeof b.code_verifier !== 'string' || b64urlSha256(b.code_verifier) !== d.ch) {
        return oauthError(res, 400, 'invalid_grant', 'code_verifier does not match.');
      }
      usedCodes.set(d.j, now + CODE_TTL);
      let host = '';
      try { host = new URL(d.r).host; } catch (_) { /* kept empty */ }
      const id = grants.create({ client: b64urlSha256(d.c), clientName: d.n, redirectHost: host });
      return res.json(issueTokens(id, grants.get(id)));
    }

    if (b.grant_type === 'refresh_token') {
      const d = auth.unseal('mcp-refresh', b.refresh_token);
      const g = d && grants.get(d.g);
      if (!g || g.n !== d.n) return oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid, expired or revoked.');
      if (b.client_id && b64urlSha256(b.client_id) !== g.client) return oauthError(res, 400, 'invalid_grant', 'The token was issued to another app.');
      g.n += 1;
      g.usedAt = now;
      grants.save();
      return res.json(issueTokens(d.g, g));
    }

    oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  // ── the owner's list of connected apps ──
  router.get('/oauth/connections', (req, res) => {
    if (!auth.isOwner(req)) return res.redirect(303, '/login?next=' + encodeURIComponent('/oauth/connections'));
    const rows = grants.list().sort((a, b) => b.createdAt - a.createdAt).map((g) =>
      '<li><strong>' + escapeHtml(g.clientName || 'An app') + '</strong> (' + escapeHtml(g.redirectHost || '') + ')<br>' +
      'Connected ' + escapeHtml(new Date(g.createdAt).toISOString().slice(0, 10)) +
      ', last signed in ' + escapeHtml(new Date(g.usedAt).toISOString().slice(0, 10)) +
      '<form method="post" action="/oauth/connections/revoke" class="mp-form">' +
      '<input type="hidden" name="id" value="' + escapeHtml(g.id) + '">' +
      '<button type="submit">Disconnect</button></form></li>').join('');
    pageHeaders(res);
    res.send(shell({
      title: 'Connected apps',
      bodyClass: 'theme-dark mp-share-page',
      body: '<div class="mp-card"><h1>Connected apps</h1>' +
        (rows ? '<p>These apps can read and change your vaults.</p><ul>' + rows + '</ul>' : '<p>No apps are connected.</p>') +
        '</div>',
    }));
  });

  router.post('/oauth/connections/revoke', form, (req, res) => {
    if (!auth.isOwner(req)) return res.redirect(303, '/login?next=' + encodeURIComponent('/oauth/connections'));
    grants.remove(req.body && req.body.id);
    res.redirect(303, '/oauth/connections');
  });

  return { router, verifyAccess, resourceMetadataUrl, grants };
}

module.exports = { createOAuth };
