'use strict';

/**
 * The MCP endpoint (mcp/server.js) and its OAuth sign-in (mcp/oauth.js),
 * end to end against a real server: discovery, registration, the consent
 * page, PKCE, refresh-token rotation, revoking a connection, and the tools
 * changing a vault.
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createApp } = require('../index');

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function setup(t, mcp = {}) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'markport-mcp-'));
  const app = createApp({
    registryPath: path.join(tmp, 'registry.json'),
    vaultPath: path.join(tmp, 'default'),
    vaultsDir: path.join(tmp, 'vaults'),
    defaultVaultName: 'Notes',
    ownerPassword: 'pw',
    media: false,
    mcp: Object.assign({ enabled: true }, mcp),
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const vaultDir = path.join(tmp, 'vaults', 'Notes');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  return { app, base, vaultDir, tmp };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function register(base, redirect = REDIRECT) {
  const r = await fetch(base + '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }),
  });
  return { status: r.status, body: await r.json() };
}

async function approve(base, clientId, { password = 'pw', challenge, state = 'st-1', decision = 'allow' } = {}) {
  const form = new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, state,
    code_challenge: challenge, code_challenge_method: 'S256', decision, password,
  });
  return fetch(base + '/oauth/authorize', {
    method: 'POST', body: form, redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function token(base, params) {
  const r = await fetch(base + '/oauth/token', {
    method: 'POST', body: new URLSearchParams(params),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return { status: r.status, body: await r.json() };
}

// Registers, approves and trades the code: { clientId, tokens }.
async function connect(base) {
  const { body: client } = await register(base);
  const { verifier, challenge } = pkce();
  const r = await approve(base, client.client_id, { challenge });
  const code = new URL(r.headers.get('location')).searchParams.get('code');
  const { body } = await token(base, {
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT,
  });
  return { clientId: client.client_id, tokens: body };
}

function rpc(base, accessToken) {
  let id = 0;
  return async (method, params) => {
    const r = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + accessToken },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
  };
}

test('an app finds the sign-in from a 401 and the metadata', async (t) => {
  const { base } = await setup(t);
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  const www = r.headers.get('www-authenticate');
  assert.match(www, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);

  const pr = await (await fetch(base + '/.well-known/oauth-protected-resource')).json();
  assert.equal(pr.resource, base + '/mcp');
  assert.deepEqual(pr.authorization_servers, [base]);
  const as = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer, base);
  assert.equal(as.token_endpoint, base + '/oauth/token');
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
});

test('sign-in: only allowed redirects, the password, PKCE, single-use codes', async (t) => {
  const { base } = await setup(t);

  const evil = await register(base, 'https://evil.example/cb');
  assert.equal(evil.status, 400);
  assert.equal(evil.body.error, 'invalid_redirect_uri');
  assert.equal((await register(base, 'http://localhost:33418/callback')).status, 201, 'apps on this computer');

  const { status, body: client } = await register(base);
  assert.equal(status, 201);
  const { verifier, challenge } = pkce();

  // The consent page names the app and where the browser goes back to.
  const page = await fetch(base + '/oauth/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'x',
  }));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Claude wants to read and change/);
  assert.match(html, /claude\.ai/);
  assert.match(page.headers.get('content-security-policy'), /form-action 'self' https:\/\/claude\.ai/);

  // A redirect the app didn't register is never followed.
  const other = await fetch(base + '/oauth/authorize?' + new URLSearchParams({
    client_id: client.client_id, redirect_uri: 'https://claude.ai/other', code_challenge: challenge, code_challenge_method: 'S256',
  }), { redirect: 'manual' });
  assert.equal(other.status, 400);

  // No PKCE: the app is told so.
  const noPkce = await fetch(base + '/oauth/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT }), { redirect: 'manual' });
  assert.equal(noPkce.status, 302);
  assert.equal(new URL(noPkce.headers.get('location')).searchParams.get('error'), 'invalid_request');

  assert.equal((await approve(base, client.client_id, { challenge, password: 'nope' })).status, 401);
  const denied = await approve(base, client.client_id, { challenge, decision: 'deny' });
  assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'), 'access_denied');

  const ok = await approve(base, client.client_id, { challenge, state: 'st-9' });
  assert.equal(ok.status, 302);
  const back = new URL(ok.headers.get('location'));
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'st-9');
  assert.equal(back.searchParams.get('iss'), base);
  const code = back.searchParams.get('code');

  const wrong = await token(base, { grant_type: 'authorization_code', code, code_verifier: 'not-it', client_id: client.client_id });
  assert.equal(wrong.body.error, 'invalid_grant');
  const good = await token(base, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
  assert.equal(good.status, 200);
  assert.equal(good.body.token_type, 'Bearer');
  assert.ok(good.body.access_token && good.body.refresh_token);
  const again = await token(base, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
  assert.equal(again.body.error, 'invalid_grant', 'a code works once');

  // Not an owner API token: /api stays closed to it.
  const api = await fetch(base + '/api/vaults/list', { headers: { Authorization: 'Bearer ' + good.body.access_token } });
  assert.deepEqual(await api.json(), {});
});

test('refresh tokens rotate, and disconnecting signs the app out', async (t) => {
  const { base, app } = await setup(t);
  const { clientId, tokens } = await connect(base);
  const call = rpc(base, tokens.access_token);
  assert.equal((await call('ping')).status, 200);

  const r1 = await token(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(r1.status, 200);
  const old = await token(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(old.body.error, 'invalid_grant', 'only the newest refresh token works');
  assert.equal((await rpc(base, r1.body.access_token)('ping')).status, 200);

  const [conn] = app.locals.oauth.grants.list();
  assert.equal(conn.clientName, 'Claude');
  assert.equal(conn.redirectHost, 'claude.ai');
  app.locals.oauth.grants.remove(conn.id);
  assert.equal((await rpc(base, r1.body.access_token)('ping')).status, 401);
  const after = await token(base, { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: clientId });
  assert.equal(after.body.error, 'invalid_grant');
});

test('the tools read, search and change a vault', async (t) => {
  const { base, vaultDir, tmp } = await setup(t, { plainPunctuation: true });
  await fsp.writeFile(path.join(tmp, 'mcp-instructions.md'), 'Notes for Claude end in -c.md.');
  await fsp.mkdir(path.join(vaultDir, 'Projects'), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, 'Projects', 'Plan.md'), '# Plan\n\nShip the thing.\nSee [[Other]].\n');
  await fsp.writeFile(path.join(vaultDir, 'pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const { tokens } = await connect(base);
  const call = rpc(base, tokens.access_token);
  const tool = async (name, args) => {
    const r = await call('tools/call', { name, arguments: args });
    assert.equal(r.status, 200);
    return r.body.result;
  };
  const out = (res) => res.content.map((c) => c.text).join('');
  // Reads go through the API: a write right after another is buffered there
  // for a few seconds before it reaches the disk.

  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.body.result.serverInfo.name, 'markport');
  assert.match(init.body.result.instructions, /list_vaults/);
  assert.match(init.body.result.instructions, /end in -c\.md/);
  const note = await fetch(base + '/mcp', {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens.access_token },
  });
  assert.equal(note.status, 202);

  const list = await call('tools/list');
  const names = list.body.result.tools.map((x) => x.name);
  for (const n of ['list_vaults', 'list_files', 'read_file', 'search', 'write_file', 'edit_file', 'append_to_file', 'move', 'delete']) {
    assert.ok(names.includes(n), n);
  }

  assert.match(out(await tool('list_vaults', {})), /\tNotes$/m);
  assert.match(out(await tool('list_files', {})), /^Projects\/Plan\.md\t/m);
  assert.match(out(await tool('read_file', { vault: 'notes', path: 'Projects/Plan.md' })), /Ship the thing/);
  const img = await tool('read_file', { path: 'pic.png' });
  assert.equal(img.content[0].type, 'image');
  assert.equal(img.content[0].mimeType, 'image/png');
  assert.match(out(await tool('search', { query: 'ship' })), /Projects\/Plan\.md:3: Ship the thing\./);

  await tool('write_file', { path: 'Inbox/New.md', content: 'hello\n' });
  assert.equal(await fsp.readFile(path.join(vaultDir, 'Inbox', 'New.md'), 'utf8'), 'hello\n');
  // A write right after another is buffered by the server for a few seconds
  // before it reaches the disk, so read through the API from here on.
  await tool('append_to_file', { path: 'Inbox/New.md', content: 'more' });
  assert.equal(out(await tool('read_file', { path: 'Inbox/New.md' })), 'hello\nmore');

  await tool('edit_file', { path: 'Projects/Plan.md', old_text: 'Ship the thing.', new_text: 'Ship it on Friday.' });
  assert.match(out(await tool('read_file', { path: 'Projects/Plan.md' })), /Ship it on Friday\.\nSee \[\[Other\]\]/);
  const missing = await tool('edit_file', { path: 'Projects/Plan.md', old_text: 'nope', new_text: 'x' });
  assert.equal(missing.isError, true);

  // Plain punctuation: a new line with an em dash is refused, the note is unchanged.
  const dash = await tool('append_to_file', { path: 'Inbox/New.md', content: 'one — two' });
  assert.equal(dash.isError, true);
  assert.match(out(dash), /em dash/);
  assert.equal(out(await tool('read_file', { path: 'Inbox/New.md' })), 'hello\nmore');

  await tool('move', { from: 'Inbox/New.md', to: 'Inbox/Renamed.md' });
  assert.equal((await tool('move', { from: 'Inbox/Renamed.md', to: 'Projects/Plan.md' })).isError, true, 'never replaces');
  await tool('delete', { path: 'Inbox/Renamed.md' });
  assert.equal(await fsp.readFile(path.join(vaultDir, '.trash', 'Inbox', 'Renamed.md'), 'utf8'), 'hello\nmore');
  assert.equal(await fsp.readFile(path.join(vaultDir, 'Inbox', 'Renamed.md'), 'utf8').catch(() => null), null);

  // An unknown method is a JSON-RPC error; GET is not supported.
  assert.equal((await call('resources/list')).body.error.code, -32601);
  const get = await fetch(base + '/mcp', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
  assert.equal(get.status, 405);
});
