/**
 * MCP endpoint (Streamable HTTP, stateless): lets an app like Claude read and
 * change the vaults, signed in through OAuth (mcp/oauth.js).
 *
 *   POST /mcp   JSON-RPC: initialize, ping, tools/list, tools/call; the
 *               answer is plain JSON. Notifications get 202.
 *   GET  /mcp   405: this server sends no messages of its own.
 *
 * The tools work through this server's own /api/fs, over loopback with an
 * owner token, exactly as markport-sync and other API clients do. So writes
 * go through the same write path, and every open Obsidian session sees them
 * live.
 *
 * Options, from config.mcp:
 *   plainPunctuation  refuse writes that add em/en dashes or emoji to notes
 *                     (MARKPORT_MCP_PLAIN_PUNCTUATION=true). Only new lines
 *                     are checked; text already in a note passes.
 *   instructionsFile  extra instructions for the app, sent on every
 *                     initialize (default <data>/mcp-instructions.md, read
 *                     each time, so edits apply without a restart).
 */

'use strict';

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CLIENT = 'markport-mcp';
const MAX_TEXT = 1024 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_LIST = 5000;

const TEXT_EXT = /\.(md|markdown|txt|canvas|base|json|css|js|mjs|ts|csv|tsv|ya?ml|html?|xml|svg|ini|toml|log|tex|bib|sh|py)$/i;
const NOTE_EXT = /\.(md|txt|canvas)$/i;
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const BANNED = [
  [/[—―]/u, 'em dash (use "-", a comma, or two sentences)'],
  [/–/u, 'en dash (use "-")'],
  [/\p{Extended_Pictographic}/u, 'emoji or pictograph'],
];

const BASE_INSTRUCTIONS = [
  'These tools read and change the Obsidian vaults on a Markport server.',
  'Start with list_vaults, then list_files or search. Do not guess paths.',
  'Paths are relative to the vault root and use "/".',
  'Read a note before you change it. Prefer edit_file for small changes, and keep the note\'s formatting, frontmatter and [[wikilinks]].',
  'Changes show up at once in every open Obsidian session. delete moves things into the vault\'s .trash folder.',
].join('\n');

class ToolError extends Error {}

const clean = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

function text(s) {
  return { content: [{ type: 'text', text: String(s) }] };
}

function checkStyle(newText, oldText, p) {
  const old = new Set(String(oldText).split(/\r?\n/));
  const problems = [];
  String(newText).split(/\r?\n/).forEach((line, i) => {
    if (old.has(line)) return;
    for (const [re, what] of BANNED) {
      if (re.test(line)) problems.push('  line ' + (i + 1) + ': ' + what + ': ' + line.trim().slice(0, 120));
    }
  });
  if (problems.length) {
    throw new ToolError('Not written: ' + p + ' would get characters these notes don\'t use.\n' + problems.join('\n') +
      '\nRewrite those lines in plain punctuation and try again.');
  }
}

const vaultArg = { type: 'string', description: 'Vault name or id, from list_vaults. May be left out when there is only one vault.' };

const TOOLS = [
  {
    name: 'list_vaults',
    title: 'List vaults',
    description: 'List the vaults on this Markport server (id and name).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_files',
    title: 'List files',
    description: 'Every file in a vault, or in one folder of it, with size and last change. Hidden folders (.obsidian, .trash) are left out.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, folder: { type: 'string', description: 'Folder to list; empty for the whole vault.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_folder',
    title: 'List folder',
    description: 'The entries of one folder (not recursive), including hidden ones such as .obsidian.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, folder: { type: 'string', description: 'Folder; empty for the vault root.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_file',
    title: 'Read file',
    description: 'Read a note or other text file. Images (png, jpg, gif, webp) are returned as images.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, path: { type: 'string' } }, required: ['path'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search',
    title: 'Search notes',
    description: 'Find text in the vault\'s notes (.md, .canvas, .txt), case-insensitive. Matches file names too.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultArg,
        query: { type: 'string', description: 'Text to find, or a regular expression with regex: true.' },
        folder: { type: 'string', description: 'Only search this folder.' },
        regex: { type: 'boolean' },
        max_results: { type: 'integer', description: 'Most matching lines to return (default 200).' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_file',
    title: 'Write file',
    description: 'Create a file, or replace all of an existing one. Missing folders are created.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    annotations: { destructiveHint: true },
  },
  {
    name: 'edit_file',
    title: 'Edit file',
    description: 'Replace one exact piece of text in a file. old_text must appear exactly once, unless replace_all is true.',
    inputSchema: {
      type: 'object',
      properties: { vault: vaultArg, path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
      required: ['path', 'old_text', 'new_text'],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'append_to_file',
    title: 'Append to file',
    description: 'Add text to the end of a file, on a new line. Creates the file if it is missing.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    annotations: { destructiveHint: false },
  },
  {
    name: 'create_folder',
    title: 'Create folder',
    description: 'Create a folder (and any missing parents).',
    inputSchema: { type: 'object', properties: { vault: vaultArg, path: { type: 'string' } }, required: ['path'] },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'move',
    title: 'Move or rename',
    description: 'Move or rename a file or folder. Refuses to replace something that already exists.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    annotations: { destructiveHint: false },
  },
  {
    name: 'copy',
    title: 'Copy',
    description: 'Copy a file or folder. Refuses to replace something that already exists.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    annotations: { destructiveHint: false },
  },
  {
    name: 'delete',
    title: 'Delete',
    description: 'Move a file or folder into the vault\'s .trash folder, as Obsidian does. It can be restored from there.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, path: { type: 'string' } }, required: ['path'] },
    annotations: { destructiveHint: true },
  },
];

// opts: { auth, oauth, dataDir, plainPunctuation, instructionsFile, version }
function createMcpRouter(opts) {
  const { auth, oauth } = opts;
  const instructionsFile = opts.instructionsFile || path.join(opts.dataDir, 'mcp-instructions.md');
  let ownerToken = null;

  function token() {
    if (!ownerToken || ownerToken.expiresAt - Date.now() < 86400 * 1000) ownerToken = auth.issueApiToken();
    return ownerToken.token;
  }

  // This server's own /api, over the connection the request came in on.
  function apiFor(req) {
    let host = String(req.socket.localAddress || '127.0.0.1');
    if (host.startsWith('::ffff:')) host = host.slice(7);
    if (host === '::' || host === '0.0.0.0') host = '127.0.0.1';
    if (host.includes(':')) host = '[' + host + ']';
    const origin = 'http://' + host + ':' + req.socket.localPort;

    return async function api(method, route, { query, json, body, raw } = {}) {
      const u = new URL(origin + route);
      for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      u.searchParams.set('client', CLIENT);
      const headers = { 'X-Markport-Token': token() };
      let payload;
      if (json) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(Object.assign({ client: CLIENT }, json)); }
      else if (body !== undefined) { headers['Content-Type'] = 'application/octet-stream'; payload = body; }
      const res = await fetch(u, { method, headers, body: payload, redirect: 'manual' });
      if (!res.ok) {
        let msg = await res.text().catch(() => '');
        try { msg = JSON.parse(msg).error || msg; } catch (_) { /* plain text */ }
        const err = new ToolError(res.status === 404 ? 'Not found.' : 'HTTP ' + res.status + ': ' + String(msg).slice(0, 300));
        err.status = res.status;
        throw err;
      }
      if (raw) return Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get('content-type') || '';
      return ct.includes('json') ? res.json() : res.text();
    };
  }

  async function instructions() {
    let extra = '';
    try { extra = (await fsp.readFile(instructionsFile, 'utf8')).trim(); } catch (_) { /* none */ }
    return extra ? BASE_INSTRUCTIONS + '\n\n' + extra : BASE_INSTRUCTIONS;
  }

  async function callTool(req, name, args) {
    const api = apiFor(req);
    args = args && typeof args === 'object' ? args : {};

    async function vaults() {
      const v = await api('GET', '/api/vaults/list');
      return Object.entries(v).map(([id, rec]) => ({ id, name: path.basename(String(rec.path || '').replace(/[\\/]+$/, '')) }));
    }

    async function vault() {
      const list = await vaults();
      const arg = args.vault;
      if (!arg) {
        if (list.length === 1) return list[0].id;
        throw new ToolError('Say which vault: ' + list.map((v) => v.name).join(', '));
      }
      const byId = list.find((v) => v.id === arg);
      if (byId) return byId.id;
      const byName = list.filter((v) => v.name.toLowerCase() === String(arg).toLowerCase());
      if (byName.length === 1) return byName[0].id;
      if (byName.length > 1) throw new ToolError('"' + arg + '" matches several vaults; use an id:\n' + byName.map((v) => v.id + '  ' + v.name).join('\n'));
      throw new ToolError('No vault "' + arg + '". Vaults:\n' + list.map((v) => v.id + '  ' + v.name).join('\n'));
    }

    function need(key) {
      const v = clean(args[key]);
      if (!v) throw new ToolError('Missing ' + key + '.');
      return v;
    }

    async function stat(v, p) {
      try { return await api('GET', '/api/fs/stat', { query: { vault: v, path: p } }); }
      catch (e) { if (e.status === 404) return null; throw e; }
    }

    async function readText(v, p) {
      try { return (await api('GET', '/api/fs/read', { query: { vault: v, path: p }, raw: true })).toString('utf8'); }
      catch (e) { if (e.status === 404) return null; throw e; }
    }

    async function write(v, p, content, oldText) {
      if (opts.plainPunctuation && NOTE_EXT.test(p)) checkStyle(content, oldText || '', p);
      const r = await api('PUT', '/api/fs/write', { query: { vault: v, path: p }, body: Buffer.from(content, 'utf8') });
      return r && typeof r.size === 'number' ? r.size : Buffer.byteLength(content);
    }

    switch (name) {
      case 'list_vaults': {
        const list = await vaults();
        return text(list.length ? list.map((v) => v.id + '\t' + v.name).join('\n') : 'No vaults.');
      }

      case 'list_files': {
        const v = await vault();
        const t = await api('GET', '/api/fs/tree', { query: { vault: v, path: clean(args.folder) } });
        const files = t.files.sort((a, b) => a.path.localeCompare(b.path));
        const lines = files.slice(0, MAX_LIST).map((f) => f.path + '\t' + f.size + '\t' + new Date(f.mtime).toISOString().slice(0, 16).replace('T', ' '));
        let out = lines.join('\n') + '\n\n' + files.length + ' files, ' + t.dirs.length + ' folders';
        if (files.length > MAX_LIST) out += ' (first ' + MAX_LIST + ' shown; list a folder for the rest)';
        return text(out);
      }

      case 'list_folder': {
        const v = await vault();
        const entries = await api('GET', '/api/fs/readdir', { query: { vault: v, path: clean(args.folder) } });
        entries.sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name));
        return text(entries.map((e) => (e.isDirectory ? e.name + '/' : e.name + '\t' + (e.stats ? e.stats.size : ''))).join('\n') || '(empty)');
      }

      case 'read_file': {
        const v = await vault();
        const p = need('path');
        const st = await stat(v, p);
        if (!st) throw new ToolError('Not found: ' + p);
        if (st.isDirectory) throw new ToolError(p + ' is a folder. Use list_folder.');
        const ext = (p.match(/\.([^./]+)$/) || [])[1];
        const mime = ext && IMAGE_TYPES[ext.toLowerCase()];
        if (mime) {
          if (st.size > MAX_IMAGE) return text(p + ' is an image of ' + st.size + ' bytes, too big to return.');
          const data = await api('GET', '/api/fs/read', { query: { vault: v, path: p }, raw: true });
          return { content: [{ type: 'image', data: data.toString('base64'), mimeType: mime }] };
        }
        const data = await api('GET', '/api/fs/read', { query: { vault: v, path: p }, raw: true });
        const head = data.subarray(0, 8000);
        if (!TEXT_EXT.test(p) && head.includes(0)) return text(p + ' is a binary file of ' + data.length + ' bytes.');
        let s = data.subarray(0, MAX_TEXT).toString('utf8');
        if (data.length > MAX_TEXT) s += '\n\n[cut off: the file has ' + data.length + ' bytes, the first ' + MAX_TEXT + ' are shown]';
        return text(s);
      }

      case 'search': {
        const v = await vault();
        const q = String(args.query || '');
        if (!q) throw new ToolError('Missing query.');
        let re = null;
        if (args.regex) {
          try { re = new RegExp(q, 'i'); } catch (e) { throw new ToolError('Bad regular expression: ' + e.message); }
        }
        const needle = q.toLowerCase();
        const match = (line) => (re ? re.test(line) : line.toLowerCase().includes(needle));
        const max = Math.max(1, Math.min(2000, Number(args.max_results) || 200));
        const t = await api('GET', '/api/fs/tree', { query: { vault: v, path: clean(args.folder) } });
        const notes = t.files.filter((f) => NOTE_EXT.test(f.path) && f.size < 2000000).map((f) => f.path).sort();
        const results = new Map();
        const queue = [...notes];
        await Promise.all(Array.from({ length: 8 }, async () => {
          while (queue.length) {
            const p = queue.shift();
            const hits = [];
            if (match(p)) hits.push('(file name)');
            const body = await readText(v, p).catch(() => null);
            if (body) body.split(/\r?\n/).forEach((l, i) => { if (match(l)) hits.push((i + 1) + ': ' + l.trim().slice(0, 200)); });
            if (hits.length) results.set(p, hits);
          }
        }));
        const out = [];
        let total = 0;
        for (const p of notes) {
          for (const l of results.get(p) || []) {
            total++;
            if (out.length < max) out.push(p + ':' + l);
          }
        }
        let summary = total + ' matches in ' + results.size + ' of ' + notes.length + ' notes';
        if (total > out.length) summary += ' (first ' + out.length + ' shown)';
        return text((out.length ? out.join('\n') + '\n\n' : '') + summary);
      }

      case 'write_file': {
        const v = await vault();
        const p = need('path');
        const content = String(args.content === undefined ? '' : args.content);
        const old = opts.plainPunctuation && NOTE_EXT.test(p) ? await readText(v, p) : null;
        const size = await write(v, p, content, old);
        return text('Wrote ' + size + ' bytes to ' + p + '.');
      }

      case 'edit_file': {
        const v = await vault();
        const p = need('path');
        const cur = await readText(v, p);
        if (cur === null) throw new ToolError('Not found: ' + p);
        const oldText = String(args.old_text || '');
        const newText = String(args.new_text === undefined ? '' : args.new_text);
        if (!oldText) throw new ToolError('old_text is empty.');
        const count = cur.split(oldText).length - 1;
        if (!count) throw new ToolError('old_text was not found in ' + p + '. Read the file again and copy the text exactly.');
        if (count > 1 && !args.replace_all) throw new ToolError('old_text appears ' + count + ' times in ' + p + '. Include more of the text around it, or pass replace_all.');
        const next = args.replace_all ? cur.split(oldText).join(newText) : cur.replace(oldText, () => newText);
        await write(v, p, next, cur);
        return text('Edited ' + p + ' (' + (args.replace_all ? count : 1) + ' replacement' + ((args.replace_all ? count : 1) === 1 ? '' : 's') + ').');
      }

      case 'append_to_file': {
        const v = await vault();
        const p = need('path');
        const add = String(args.content === undefined ? '' : args.content);
        const cur = (await readText(v, p)) || '';
        if (opts.plainPunctuation && NOTE_EXT.test(p)) checkStyle(add, '', p);
        const sep = cur.length && !cur.endsWith('\n') ? '\n' : '';
        await api('PUT', '/api/fs/write', { query: { vault: v, path: p }, body: Buffer.from(cur + sep + add, 'utf8') });
        return text('Appended ' + Buffer.byteLength(add) + ' bytes to ' + p + '.');
      }

      case 'create_folder': {
        const v = await vault();
        const p = need('path');
        await api('POST', '/api/fs/mkdir', { json: { vault: v, path: p, recursive: true } });
        return text('Created ' + p + '/.');
      }

      case 'move': {
        const v = await vault();
        const from = need('from');
        const to = need('to');
        if (!(await stat(v, from))) throw new ToolError('Not found: ' + from);
        if (await stat(v, to)) throw new ToolError(to + ' already exists.');
        await api('POST', '/api/fs/rename', { json: { vault: v, oldPath: from, newPath: to, overwrite: false } });
        return text('Moved ' + from + ' to ' + to + '.');
      }

      case 'copy': {
        const v = await vault();
        const from = need('from');
        const to = need('to');
        if (!(await stat(v, from))) throw new ToolError('Not found: ' + from);
        if (await stat(v, to)) throw new ToolError(to + ' already exists.');
        await api('POST', '/api/fs/copy', { json: { vault: v, src: from, dest: to } });
        return text('Copied ' + from + ' to ' + to + '.');
      }

      case 'delete': {
        const v = await vault();
        const p = need('path');
        if (p === '.trash' || p.startsWith('.trash/')) throw new ToolError('That is already in the trash.');
        if (!(await stat(v, p))) throw new ToolError('Not found: ' + p);
        let dest = '.trash/' + p;
        if (await stat(v, dest)) {
          const dot = dest.lastIndexOf('.');
          const slash = dest.lastIndexOf('/');
          const stamp = ' ' + Date.now();
          dest = dot > slash + 1 ? dest.slice(0, dot) + stamp + dest.slice(dot) : dest + stamp;
        }
        await api('POST', '/api/fs/rename', { json: { vault: v, oldPath: p, newPath: dest, overwrite: false } });
        return text('Moved ' + p + ' to ' + dest + '.');
      }

      default:
        throw new ToolError('Unknown tool: ' + name);
    }
  }

  async function handle(req, msg) {
    const isRequest = msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null;
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: isRequest ? msg.id : null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
    if (!isRequest) return null;   // a notification: nothing to answer

    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params && msg.params.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'markport', title: 'Markport', version: opts.version || '0.0.0' },
          instructions: await instructions(),
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const p = msg.params || {};
        if (!TOOLS.some((t) => t.name === p.name)) return fail(-32602, 'Unknown tool: ' + p.name);
        try {
          return reply(await callTool(req, p.name, p.arguments));
        } catch (err) {
          if (!(err instanceof ToolError)) console.error('[mcp]', p.name, err);
          return reply({ content: [{ type: 'text', text: err.message || String(err) }], isError: true });
        }
      }
      default:
        return fail(-32601, 'Method not found: ' + msg.method);
    }
  }

  const router = express.Router();

  router.use((req, res, next) => {
    if (!auth.enabled) return res.status(404).json({ error: 'MCP needs MARKPORT_PASSWORD to be set.' });
    if (req.method === 'OPTIONS') return next();
    if (!oauth.verifyAccess(req)) {
      res.set('WWW-Authenticate', 'Bearer resource_metadata="' + oauth.resourceMetadataUrl(req) + '"' +
        (auth.requestToken(req) ? ', error="invalid_token"' : ''));
      return res.status(401).json({ error: 'invalid_token', error_description: 'Sign in through OAuth.' });
    }
    next();
  });

  router.post('/', express.json({ limit: '20mb' }), async (req, res) => {
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(req, m)))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await handle(req, body);
    if (!out) return res.status(202).end();
    res.json(out);
  });

  router.all('/', (req, res) => {
    res.set('Allow', 'POST');
    res.status(405).json({ error: 'Use POST.' });
  });

  return router;
}

module.exports = { createMcpRouter, TOOLS };
