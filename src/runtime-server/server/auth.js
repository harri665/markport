/**
 * Owner login and share-link grants.
 *
 * Markport has one owner. With MARKPORT_PASSWORD set, every request is one of:
 *
 *   owner      - carries a valid `mp_owner` session cookie (from /login)
 *   share      - addresses a share vault and carries that share's grant
 *                cookie (`mp_sg_<shareId>`, set when the share link is opened,
 *                after its password if it has one). Scoped to that share only.
 *   anonymous  - everything else: may only reach /login, /s/<id> share pages
 *                and the app's static files.
 *
 * Clients outside a browser (the native Obsidian plugin markport-sync) can't
 * keep that cookie, so they trade the password for an API token once
 * (POST /api/auth/token) and send it on every request as the
 * `X-Markport-Token` header (or `Authorization: Bearer`), and on WebSockets
 * as the subprotocol `markport-token.<token>`. A token counts as the owner.
 * Like the cookie it is tied to the password: changing the password revokes
 * every token.
 *
 * Without MARKPORT_PASSWORD there is no owner login (the pre-sharing behaviour:
 * anyone who reaches the server is the owner, so a reverse proxy has to guard
 * it). Share vaults are scoped either way.
 *
 * Cookies are HMAC-signed with a secret stored next to the vault registry, so
 * sessions survive restarts. Changing the password invalidates every owner
 * session; revoking a share (or changing its password) invalidates its grants.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OWNER_COOKIE = 'mp_owner';
const GRANT_PREFIX = 'mp_sg_';
const SESSION_DAYS = 30;
const API_TOKEN_DAYS = 365;
const WS_TOKEN_PREFIX = 'markport-token.';

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function loadSecret(dataDir) {
  const file = path.join(dataDir, 'session-secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch (_) { /* first start */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || Object.prototype.hasOwnProperty.call(out, k)) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* skip bad */ }
  }
  return out;
}

// Works on both Express requests and the raw IncomingMessage of a WebSocket
// upgrade (no req.secure there).
function isHttps(req) {
  if (req.secure) return true;
  const xf = req.headers && req.headers['x-forwarded-proto'];
  return typeof xf === 'string' && xf.split(',')[0].trim() === 'https';
}

function cookieString(req, name, value, maxAgeSec) {
  const parts = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push('Max-Age=' + Math.max(0, Math.floor(maxAgeSec)));
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function appendSetCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', value);
  else res.setHeader('Set-Cookie', [].concat(prev, value));
}

// Simple fixed-window limiter for password attempts (login and share unlock).
function createLimiter(max, windowMs) {
  const hits = new Map();
  return {
    blocked(key) {
      const e = hits.get(key);
      if (!e) return false;
      if (Date.now() - e.start > windowMs) { hits.delete(key); return false; }
      return e.count >= max;
    },
    fail(key) {
      const now = Date.now();
      const e = hits.get(key);
      if (!e || now - e.start > windowMs) hits.set(key, { start: now, count: 1 });
      else e.count++;
      if (hits.size > 10000) hits.clear();   // bound memory under a flood
    },
    reset(key) { hits.delete(key); },
  };
}

function createAuth({ password, dataDir }) {
  const enabled = typeof password === 'string' && password.length > 0;
  const secret = loadSecret(dataDir);
  // Ties owner sessions to the current password.
  const pwFingerprint = enabled ? sha256('pw:' + password).toString('hex').slice(0, 16) : '';
  const loginLimiter = createLimiter(10, 15 * 60 * 1000);
  const unlockLimiter = createLimiter(10, 15 * 60 * 1000);

  function sign(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  }

  function makeToken(kind, subject, exp) {
    return exp + '.' + sign(kind + '|' + subject + '|' + exp);
  }

  function verifyToken(token, kind, subject) {
    if (typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot < 1) return false;
    const exp = Number(token.slice(0, dot));
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    return safeEqual(token.slice(dot + 1), sign(kind + '|' + subject + '|' + exp));
  }

  function cookies(req) {
    if (!req._mpCookies) req._mpCookies = parseCookies(req.headers && req.headers.cookie);
    return req._mpCookies;
  }

  // The API token a non-browser client sent, if any.
  function requestToken(req) {
    const h = req.headers || {};
    if (typeof h['x-markport-token'] === 'string') return h['x-markport-token'].trim();
    const a = h.authorization;
    if (typeof a === 'string' && /^Bearer\s+/i.test(a)) return a.replace(/^Bearer\s+/i, '').trim();
    const p = h['sec-websocket-protocol'];
    if (typeof p === 'string') {
      for (const part of p.split(',')) {
        const t = part.trim();
        if (t.startsWith(WS_TOKEN_PREFIX)) return t.slice(WS_TOKEN_PREFIX.length);
      }
    }
    return null;
  }

  function isOwner(req) {
    if (!enabled) return true;
    if (verifyToken(cookies(req)[OWNER_COOKIE], 'owner', pwFingerprint)) return true;
    const token = requestToken(req);
    return !!token && verifyToken(token, 'api', pwFingerprint);
  }

  function issueApiToken() {
    const expiresAt = Date.now() + API_TOKEN_DAYS * 86400 * 1000;
    return { token: makeToken('api', pwFingerprint, expiresAt), expiresAt };
  }

  function checkPassword(candidate) {
    if (!enabled || typeof candidate !== 'string') return false;
    return crypto.timingSafeEqual(sha256('cmp:' + candidate), sha256('cmp:' + password));
  }

  function setOwnerSession(req, res) {
    const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
    appendSetCookie(res, cookieString(req, OWNER_COOKIE, makeToken('owner', pwFingerprint, exp), SESSION_DAYS * 86400));
  }

  function clearOwnerSession(req, res) {
    appendSetCookie(res, cookieString(req, OWNER_COOKIE, '', 0));
  }

  // A grant's subject includes the share's password hash, so changing the
  // password (or re-creating the share) invalidates outstanding grants.
  function grantSubject(share) {
    return share.id + ':' + (share.passwordHash || '-');
  }

  function hasGrant(req, share) {
    return verifyToken(cookies(req)[GRANT_PREFIX + share.id], 'grant', grantSubject(share));
  }

  function setGrant(req, res, share) {
    let ttl = SESSION_DAYS * 86400 * 1000;
    if (share.expiresAt) ttl = Math.min(ttl, share.expiresAt - Date.now());
    if (ttl <= 0) return;
    const exp = Date.now() + ttl;
    appendSetCookie(res, cookieString(req, GRANT_PREFIX + share.id, makeToken('grant', grantSubject(share), exp), ttl / 1000));
  }

  // Ids of every share this request holds a grant for (used by the share
  // editor's vault list, which is requested without a vault id).
  function grantedShareIds(req) {
    return Object.keys(cookies(req))
      .filter((k) => k.startsWith(GRANT_PREFIX))
      .map((k) => k.slice(GRANT_PREFIX.length));
  }

  function clientKey(req) {
    return (req.ip || (req.socket && req.socket.remoteAddress) || '?');
  }

  return {
    enabled,
    isOwner,
    checkPassword,
    setOwnerSession,
    clearOwnerSession,
    issueApiToken,
    hasGrant,
    setGrant,
    grantedShareIds,
    clientKey,
    loginLimiter,
    unlockLimiter,
  };
}

module.exports = { createAuth, createLimiter, parseCookies, isHttps, safeEqual };
