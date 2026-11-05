/**
 * Share links, persisted to <data dir>/shares.json.
 *
 * A share is { id, vault, path, kind, permission, passwordHash, createdAt,
 * expiresAt }:
 *   - id          32 hex chars, the secret in the link. Doubles as the id of
 *                 the share's virtual vault (/vault/<id>), which the server
 *                 scopes to `path`.
 *   - vault       id of the owner's vault (vault-registry)
 *   - path        vault-relative path of the shared folder ('' = whole vault)
 *                 or note, '/'-separated
 *   - kind        'folder' | 'file'
 *   - permission  'view' | 'edit'
 *   - passwordHash  'scrypt$<salt>$<hash>' or null
 *   - expiresAt   epoch ms or null
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ID_RE = /^[0-9a-f]{32}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Normalise a vault-relative path: '/'-separated, no leading/trailing '/',
// no '.' or '..' segments. Returns null if it tries to escape.
function normalizeRel(p) {
  if (typeof p !== 'string') return null;
  const segs = [];
  for (const s of p.replace(/\\/g, '/').split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') return null;
    segs.push(s);
  }
  return segs.join('/');
}

class ShareStore {
  constructor(file) {
    this.file = file;
    this.shares = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[shares] unreadable shares file, starting empty:', err.message);
      return {};
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.shares, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  static isShareId(id) {
    return typeof id === 'string' && ID_RE.test(id);
  }

  // The share if it exists, whether or not it has expired.
  get(id) {
    if (!ShareStore.isShareId(id)) return null;
    return Object.prototype.hasOwnProperty.call(this.shares, id) ? this.shares[id] : null;
  }

  isExpired(share) {
    return !!(share.expiresAt && share.expiresAt <= Date.now());
  }

  list(vaultId) {
    return Object.values(this.shares).filter((s) => !vaultId || s.vault === vaultId);
  }

  create({ vault, path: relPath, kind, permission, password, expiresAt }) {
    const rel = normalizeRel(relPath);
    if (rel === null) throw Object.assign(new Error('invalid path'), { status: 400 });
    if (kind !== 'file' && kind !== 'folder') throw Object.assign(new Error('kind must be file or folder'), { status: 400 });
    if (kind === 'file' && !rel) throw Object.assign(new Error('a file share needs a file path'), { status: 400 });
    if (permission !== 'view' && permission !== 'edit') throw Object.assign(new Error('permission must be view or edit'), { status: 400 });
    let exp = null;
    if (expiresAt != null && expiresAt !== '') {
      exp = Number(expiresAt);
      if (!Number.isFinite(exp) || exp <= Date.now()) throw Object.assign(new Error('expiry must be in the future'), { status: 400 });
    }
    if (password != null && typeof password !== 'string') throw Object.assign(new Error('invalid password'), { status: 400 });
    const share = {
      id: crypto.randomBytes(16).toString('hex'),
      vault,
      path: rel,
      kind,
      permission,
      passwordHash: password ? hashPassword(password) : null,
      createdAt: Date.now(),
      expiresAt: exp,
    };
    this.shares[share.id] = share;
    this.save();
    return share;
  }

  remove(id) {
    if (!this.get(id)) return false;
    delete this.shares[id];
    this.save();
    return true;
  }

  // Keep shares pointing at their item when the owner renames or moves it
  // (or one of its parent folders) inside the same vault.
  renamed(vaultId, oldRel, newRel) {
    const from = normalizeRel(oldRel);
    const to = normalizeRel(newRel);
    if (!from || to === null) return;
    let changed = false;
    for (const s of Object.values(this.shares)) {
      if (s.vault !== vaultId) continue;
      if (s.path === from) { s.path = to; changed = true; }
      else if (s.path.startsWith(from + '/')) { s.path = to + s.path.slice(from.length); changed = true; }
    }
    if (changed) this.save();
  }

  // What the owner's UI sees - never the password hash.
  static describe(share) {
    return {
      id: share.id,
      vault: share.vault,
      path: share.path,
      kind: share.kind,
      permission: share.permission,
      hasPassword: !!share.passwordHash,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
    };
  }
}

module.exports = { ShareStore, hashPassword, verifyPassword, normalizeRel };
