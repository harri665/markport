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
 *   defaultVault      the vault (name or id) a call means when it names none
 *                     (MARKPORT_MCP_DEFAULT_VAULT). Without it, a server
 *                     with several vaults needs `vault` on every call.
 *
 * What the app is told has to stay small. Apps cut a server's instructions
 * off at about 2000 characters, and refuse or truncate a tool result of more
 * than some tens of thousands. So the instructions lead with when to use
 * these tools, and listings, searches and reads are capped and say how to
 * get the rest.
 */

'use strict';

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CLIENT = 'markport-mcp';
const MAX_TEXT = 60000;          // characters of a file in one read_file answer
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_LIST = 400;            // files in one list_files answer
const SEARCH_LINES = 60;         // lines in one search answer, unless asked
const LINES_PER_NOTE = 5;

const TEXT_EXT = /\.(md|markdown|txt|canvas|base|json|css|js|mjs|ts|csv|tsv|ya?ml|html?|xml|svg|ini|toml|log|tex|bib|sh|py)$/i;
const NOTE_EXT = /\.(md|txt|canvas)$/i;
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const BANNED = [
  [/[—―]/u, 'em dash (use "-", a comma, or two sentences)'],
  [/–/u, 'en dash (use "-")'],
  [/\p{Extended_Pictographic}/u, 'emoji or pictograph'],
];

// Leads with when to use the tools: an app that also has local files and
// other document services has to be told that the notes are here.
const BASE_INSTRUCTIONS = [
  'The user\'s Obsidian notes live here. Use these tools whenever they mention their notes, vault, Obsidian or a note by name, or ask to write something down, save it or look something up. Do that instead of writing a local file or using another document service.',
  'Find notes with search (words in any order) or list_files. A note\'s name alone works as a path for reading and editing.',
  'Read a note before you change it. Prefer edit_file for small changes, and keep its formatting, frontmatter and [[wikilinks]].',
  'Changes show at once in open Obsidian sessions. delete moves things to the vault\'s .trash.',
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

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

function vaultLines(list) {
  return list.map((v) => v.id + '  ' + v.name).join('\n');
}

// A vault by id, by name, or by a part of its name that only one vault has.
function findVault(list, arg) {
  const byId = list.find((v) => v.id === arg);
  if (byId) return byId;
  const a = String(arg).trim().toLowerCase();
  let hits = list.filter((v) => v.name.toLowerCase() === a);
  if (!hits.length && a) hits = list.filter((v) => v.name.toLowerCase().includes(a));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new ToolError('"' + arg + '" matches several vaults; use an id:\n' + vaultLines(hits));
  throw new ToolError('No vault "' + arg + '". Vaults:\n' + vaultLines(list));
}

const vaultArg = { type: 'string', description: 'Vault name or id. Leave it out to use the default vault (the server\'s instructions name it), or the only one.' };
const pathArg = (what) => ({ type: 'string', description: what + ', relative to the vault root, e.g. "Projects/Plan.md".' });

const TOOLS = [
  {
    name: 'list_vaults',
    title: 'List vaults',
    description: 'List the user\'s Obsidian vaults on this Markport server (id and name), and say which one is the default.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_files',
    title: 'List files',
    description: 'List the notes and other files in the user\'s Obsidian vault, or in one folder of it, with size and last change. A big vault or folder comes back as its subfolders with file counts: list one of those next. Hidden folders (.obsidian, .trash) are left out.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, folder: { type: 'string', description: 'Folder to list; empty for the whole vault.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_folder',
    title: 'List folder',
    description: 'The entries of one folder of the user\'s Obsidian vault (not recursive), including hidden ones such as .obsidian.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, folder: { type: 'string', description: 'Folder; empty for the vault root.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_file',
    title: 'Read note or file',
    description: 'Read a note (or other text file) from the user\'s Obsidian vault. The path may be just the note\'s name, without its folder or ".md"; the answer then starts with where it was found. A long file comes in parts: read on with offset. Images (png, jpg, gif, webp) are returned as images.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultArg,
        path: pathArg('The note or file'),
        offset: { type: 'integer', description: 'Line to start at (first line is 1).' },
        limit: { type: 'integer', description: 'Most lines to return.' },
      },
      required: ['path'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search',
    title: 'Search notes',
    description: 'Search the user\'s Obsidian notes (.md, .canvas, .txt) by content and file name, case-insensitive. Every word of the query must be in the note, in any order and anywhere in it; put "a phrase" in quotes to keep it together. Best matches first, a few lines of each.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultArg,
        query: { type: 'string', description: 'Words to find, or a regular expression with regex: true. Fewer words find more.' },
        folder: { type: 'string', description: 'Only search this folder.' },
        regex: { type: 'boolean' },
        max_results: { type: 'integer', description: 'Most lines to return (default ' + SEARCH_LINES + ').' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_file',
    title: 'Write note or file',
    description: 'Create a note (or other file) in the user\'s Obsidian vault, or replace all of an existing one. This is how to write something down or save a new note for the user. Missing folders are created.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, path: pathArg('The file to write, with its extension'), content: { type: 'string' } }, required: ['path', 'content'] },
    annotations: { destructiveHint: true },
  },
  {
    name: 'edit_file',
    title: 'Edit note or file',
    description: 'Change part of a note in the user\'s Obsidian vault: replace one exact piece of text. old_text must appear exactly once, unless replace_all is true. The path may be just the note\'s name.',
    inputSchema: {
      type: 'object',
      properties: { vault: vaultArg, path: pathArg('The note or file'), old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
      required: ['path', 'old_text', 'new_text'],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'append_to_file',
    title: 'Append to note or file',
    description: 'Add text to the end of a note in the user\'s Obsidian vault, on a new line. Good for adding to a log, a list or an inbox note. Creates the file if it is missing.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, path: pathArg('The note or file'), content: { type: 'string' } }, required: ['path', 'content'] },
    annotations: { destructiveHint: false },
  },
  {
    name: 'create_folder',
    title: 'Create folder',
    description: 'Create a folder in the user\'s Obsidian vault (and any missing parents).',
    inputSchema: { type: 'object', properties: { vault: vaultArg, path: pathArg('The folder') }, required: ['path'] },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'move',
    title: 'Move or rename',
    description: 'Move or rename a note, file or folder in the user\'s Obsidian vault. Needs the exact path. Refuses to replace something that already exists.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    annotations: { destructiveHint: false },
  },
  {
    name: 'copy',
    title: 'Copy',
    description: 'Copy a note, file or folder in the user\'s Obsidian vault. Needs the exact path. Refuses to replace something that already exists.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    annotations: { destructiveHint: false },
  },
  {
    name: 'delete',
    title: 'Delete',
    description: 'Move a note, file or folder of the user\'s Obsidian vault into its .trash folder, as Obsidian does. Needs the exact path. It can be restored from there.',
    inputSchema: { type: 'object', properties: { vault: vaultArg, path: pathArg('The file or folder') }, required: ['path'] },
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

  async function listVaults(api) {
    const v = await api('GET', '/api/vaults/list');
    return Object.entries(v).map(([id, rec]) => ({ id, name: path.basename(String(rec.path || '').replace(/[\\/]+$/, '')) }));
  }

  // The vault a call without `vault` means: the only one, or the configured
  // default. null when there are several and no (valid) default.
  function defaultOf(list) {
    if (list.length === 1) return list[0];
    if (!opts.defaultVault) return null;
    try { return findVault(list, opts.defaultVault); } catch (_) { return null; }
  }

  // Which vaults there are and what the main one holds, so the app can go
  // straight to the right place instead of finding out by failing.
  async function whereThingsAre(req) {
    const api = apiFor(req);
    const list = await listVaults(api);
    if (!list.length) return '';
    const main = defaultOf(list);
    const lines = [];
    if (list.length === 1) lines.push('There is one vault, "' + main.name + '".');
    else {
      lines.push('Vaults: ' + list.map((v) => v.name).slice(0, 12).join(', ') + '.');
      lines.push(main ? 'The notes are in "' + main.name + '": leave vault out to use it.' : 'Pass vault on every call.');
    }
    if (main) {
      const entries = await api('GET', '/api/fs/readdir', { query: { vault: main.id, path: '' } });
      const folders = entries.filter((e) => e.isDirectory && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b));
      if (folders.length) {
        lines.push('Its top folders: ' + folders.slice(0, 12).map((n) => n.slice(0, 40)).join(', ') + (folders.length > 12 ? ', and ' + (folders.length - 12) + ' more' : '') + '.');
      }
    }
    return lines.join('\n');
  }

  async function instructions(req) {
    let extra = '';
    try { extra = (await fsp.readFile(instructionsFile, 'utf8')).trim(); } catch (_) { /* none */ }
    let where = '';
    try { where = await whereThingsAre(req); } catch (err) { console.error('[mcp] instructions', err); }
    return [BASE_INSTRUCTIONS + (where ? '\n' + where : ''), extra].filter(Boolean).join('\n\n');
  }

  async function callTool(req, name, args) {
    const api = apiFor(req);
    args = args && typeof args === 'object' ? args : {};

    let known = null;
    const vaults = () => known || (known = listVaults(api));

    async function vaultInfo() {
      const list = await vaults();
      if (args.vault) return findVault(list, args.vault);
      const main = defaultOf(list);
      if (main) return main;
      if (!list.length) throw new ToolError('This server has no vaults.');
      throw new ToolError('Say which vault: ' + list.map((v) => v.name).join(', '));
    }

    const vault = async () => (await vaultInfo()).id;

    const tree = (v, folder) => api('GET', '/api/fs/tree', { query: { vault: v, path: folder || '' } });

    // The file a path means. An app often has a note's name but not its
    // folder or its ".md", so a path that isn't there falls back to the one
    // file in the vault with that name, as a [[wikilink]] would. With
    // `exact` (moving, deleting) nothing is assumed: the error names it.
    async function find(v, p, exact) {
      const st = await stat(v, p);
      if (st) return { path: p, st };
      const base = baseName(p).toLowerCase();
      const names = /\.md$/i.test(p) ? [base] : [base, base + '.md'];
      const files = (await tree(v)).files;
      const rank = (f) => (f.path.toLowerCase() === p.toLowerCase() + '.md' ? 0 : 1);
      const same = files.filter((f) => names.includes(baseName(f.path).toLowerCase())).sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
      if (same.length && rank(same[0]) === 0) same.length = 1;   // the path itself, plus ".md"
      if (same.length === 1 && !exact) return { path: same[0].path, st: await stat(v, same[0].path) };
      const list = (fs) => fs.slice(0, 10).map((f) => '  ' + f.path).join('\n');
      if (same.length === 1) throw new ToolError('Not found: ' + p + '. Did you mean:\n' + list(same));
      if (same.length > 1) throw new ToolError('Not found: ' + p + '. ' + same.length + ' files have that name; give the full path:\n' + list(same));
      const words = base.replace(/\.[^.]+$/, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
      const near = files.map((f) => ({ path: f.path, n: words.filter((w) => f.path.toLowerCase().includes(w)).length }))
        .filter((f) => f.n).sort((a, b) => b.n - a.n || a.path.localeCompare(b.path));
      throw new ToolError('Not found: ' + p + (near.length ? '. Close names:\n' + list(near) : '. Find it with search or list_files.'));
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
        const main = list.length > 1 ? defaultOf(list) : null;
        return text(list.length ? list.map((v) => v.id + '\t' + v.name + (v === main ? '\t(default)' : '')).join('\n') : 'No vaults.');
      }

      case 'list_files': {
        const v = await vault();
        const folder = clean(args.folder);
        const t = await tree(v, folder);
        const files = t.files.sort((a, b) => a.path.localeCompare(b.path));
        const line = (f) => f.path + '\t' + f.size + '\t' + new Date(f.mtime).toISOString().slice(0, 16).replace('T', ' ');
        const total = files.length + ' files, ' + t.dirs.length + ' folders';
        if (files.length <= MAX_LIST) return text(files.map(line).join('\n') + '\n\n' + total);
        // Too many for one answer: this folder's own files, and a count for
        // each folder in it.
        const skip = folder ? folder.length + 1 : 0;
        const own = [];
        const counts = new Map();
        for (const f of files) {
          const cut = f.path.indexOf('/', skip);
          if (cut < 0) own.push(f);
          else counts.set(f.path.slice(0, cut), (counts.get(f.path.slice(0, cut)) || 0) + 1);
        }
        let out = total + ' in ' + (folder ? folder + '/' : 'this vault') + ': too many to list at once.';
        if (counts.size) out += '\n\nFolders:\n' + [...counts].map(([d, n]) => d + '/\t' + n + ' files').join('\n');
        if (own.length) {
          out += '\n\nFiles directly in ' + (folder ? folder + '/' : 'the vault root') + ':\n' + own.slice(0, MAX_LIST).map(line).join('\n');
          if (own.length > MAX_LIST) out += '\n(' + (own.length - MAX_LIST) + ' more not shown)';
        }
        return text(out + '\n\n' + (counts.size ? 'List one of the folders, or use search.' : 'Use search to find one.'));
      }

      case 'list_folder': {
        const v = await vault();
        const entries = await api('GET', '/api/fs/readdir', { query: { vault: v, path: clean(args.folder) } });
        entries.sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name));
        return text(entries.map((e) => (e.isDirectory ? e.name + '/' : e.name + '\t' + (e.stats ? e.stats.size : ''))).join('\n') || '(empty)');
      }

      case 'read_file': {
        const v = await vault();
        const asked = need('path');
        const { path: p, st } = await find(v, asked);
        if (st.isDirectory) throw new ToolError(p + ' is a folder. Use list_folder.');
        const found = p === asked ? '' : '[' + p + ']\n';
        const ext = (p.match(/\.([^./]+)$/) || [])[1];
        const mime = ext && IMAGE_TYPES[ext.toLowerCase()];
        if (mime) {
          if (st.size > MAX_IMAGE) return text(p + ' is an image of ' + st.size + ' bytes, too big to return.');
          const data = await api('GET', '/api/fs/read', { query: { vault: v, path: p }, raw: true });
          const image = { type: 'image', data: data.toString('base64'), mimeType: mime };
          return { content: found ? [{ type: 'text', text: found.trim() }, image] : [image] };
        }
        const data = await api('GET', '/api/fs/read', { query: { vault: v, path: p }, raw: true });
        const head = data.subarray(0, 8000);
        if (!TEXT_EXT.test(p) && head.includes(0)) return text(p + ' is a binary file of ' + data.length + ' bytes.');
        const s = data.toString('utf8');
        const from = Math.max(1, parseInt(args.offset, 10) || 1);
        const want = parseInt(args.limit, 10) > 0 ? parseInt(args.limit, 10) : Infinity;
        if (from === 1 && want === Infinity && s.length <= MAX_TEXT) return text(found + s);
        // A part of it: whole lines, from `offset`, as many as fit.
        const lines = s.split('\n');
        if (from > lines.length) throw new ToolError(p + ' has ' + lines.length + ' lines.');
        const part = [];
        let size = 0;
        let i = from - 1;
        for (; i < lines.length && part.length < want; i++) {
          if (part.length && size + lines[i].length > MAX_TEXT) break;
          part.push(lines[i].slice(0, MAX_TEXT));
          size += lines[i].length + 1;
        }
        let note = '';
        if (from > 1 || i < lines.length) {
          note = '\n\n[lines ' + from + ' to ' + i + ' of ' + lines.length + (i < lines.length ? '; read on with offset: ' + (i + 1) : '') + ']';
        }
        return text(found + part.join('\n') + note);
      }

      case 'search': {
        const where = await vaultInfo();
        const v = where.id;
        const q = String(args.query || '').trim();
        if (!q) throw new ToolError('Missing query.');
        let re = null;
        let words = [];
        if (args.regex) {
          try { re = new RegExp(q, 'i'); } catch (e) { throw new ToolError('Bad regular expression: ' + e.message); }
        } else {
          // Words, each of which the note must have somewhere; "a phrase" stays whole.
          words = (q.match(/"[^"]+"|\S+/g) || []).map((w) => w.replace(/^"|"$/g, '').toLowerCase()).filter(Boolean);
          words = [...new Set(words)];
          if (!words.length) throw new ToolError('Missing query.');
        }
        const hitsIn = (s) => (re ? (re.test(s) ? 1 : 0) : words.filter((w) => s.includes(w)).length);
        const max = Math.max(1, Math.min(500, Number(args.max_results) || SEARCH_LINES));
        const t = await tree(v, clean(args.folder));
        const notes = t.files.filter((f) => NOTE_EXT.test(f.path) && f.size < 2000000).map((f) => f.path).sort();
        const found = [];
        const queue = [...notes];
        await Promise.all(Array.from({ length: 8 }, async () => {
          while (queue.length) {
            const p = queue.shift();
            const body = (await readText(v, p).catch(() => null)) || '';
            const name = re ? p : p.toLowerCase();
            const have = re ? (re.test(p) || re.test(body) ? 1 : 0) : hitsIn(name + '\n' + body.toLowerCase());
            if (!have) continue;
            const lines = [];
            body.split(/\r?\n/).forEach((l, i) => {
              const n = hitsIn(re ? l : l.toLowerCase());
              if (n) lines.push({ no: i + 1, text: l.trim().slice(0, 200), score: n * 2 + (/^#{1,6}\s/.test(l) ? 1 : 0) });
            });
            const inName = hitsIn(re ? baseName(p) : baseName(name));
            const best = lines.reduce((m, l) => Math.max(m, l.score), 0);
            found.push({ path: p, all: re ? true : have === words.length, inName, lines, score: have * 10000 + inName * 1000 + best * 50 + Math.min(lines.length, 40) });
          }
        }));
        found.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
        const whole = found.filter((f) => f.all);
        const shown = whole.length ? whole : found;
        if (!shown.length) {
          const others = (await vaults()).filter((x) => x.id !== v).map((x) => x.name);
          return text('No matches for ' + JSON.stringify(q) + ' in the ' + notes.length + ' notes of "' + where.name + '"' + (args.folder ? ' under ' + clean(args.folder) : '') +
            '. Try fewer or other words' + (others.length ? ', or another vault (' + others.join(', ') + ')' : '') + '.');
        }
        const out = [];
        let used = 0;
        let listed = 0;
        for (const f of shown) {
          if (used >= max) break;
          listed++;
          used++;
          out.push(f.path + (f.inName ? '  (name matches)' : ''));
          const top = [...f.lines].sort((a, b) => b.score - a.score || a.no - b.no).slice(0, Math.min(LINES_PER_NOTE, Math.max(1, max - used))).sort((a, b) => a.no - b.no);
          for (const l of top) out.push('  ' + l.no + ': ' + l.text);
          used += top.length;
          if (f.lines.length > top.length) out.push('  (' + (f.lines.length - top.length) + ' more lines match)');
        }
        let summary = whole.length || re
          ? shown.length + ' of ' + notes.length + ' notes in "' + where.name + '" match'
          : 'No note in "' + where.name + '" has all of these words. ' + shown.length + ' of ' + notes.length + ' have some of them';
        if (listed < shown.length) summary += ' (best ' + listed + ' shown; narrow the query or raise max_results for more)';
        return text(out.join('\n') + '\n\n' + summary + '.');
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
        const { path: p, st } = await find(v, need('path'));
        if (st.isDirectory) throw new ToolError(p + ' is a folder.');
        const cur = await readText(v, p);
        if (cur === null) throw new ToolError('Not found: ' + p);
        let oldText = String(args.old_text || '');
        let newText = String(args.new_text === undefined ? '' : args.new_text);
        if (!oldText) throw new ToolError('old_text is empty.');
        // A note with Windows line ends: the app sends plain "\n".
        if (!cur.includes(oldText) && cur.includes('\r\n')) {
          const crlf = (x) => x.replace(/\r?\n/g, '\r\n');
          if (cur.includes(crlf(oldText))) { oldText = crlf(oldText); newText = crlf(newText); }
        }
        const count = cur.split(oldText).length - 1;
        if (!count) throw new ToolError('old_text was not found in ' + p + '. Read the file again and copy the text exactly.');
        if (count > 1 && !args.replace_all) throw new ToolError('old_text appears ' + count + ' times in ' + p + '. Include more of the text around it, or pass replace_all.');
        const next = args.replace_all ? cur.split(oldText).join(newText) : cur.replace(oldText, () => newText);
        await write(v, p, next, cur);
        return text('Edited ' + p + ' (' + (args.replace_all ? count : 1) + ' replacement' + ((args.replace_all ? count : 1) === 1 ? '' : 's') + ').');
      }

      case 'append_to_file': {
        const v = await vault();
        let p = need('path');
        // A bare name that isn't in the root: the one note of that name, if
        // there is one. Otherwise the file is created, as asked.
        if (!p.includes('/') && !(await stat(v, p))) {
          try { p = (await find(v, p)).path; } catch (_) { /* a new file */ }
        }
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
        await find(v, from, true);
        if (await stat(v, to)) throw new ToolError(to + ' already exists.');
        await api('POST', '/api/fs/rename', { json: { vault: v, oldPath: from, newPath: to, overwrite: false } });
        return text('Moved ' + from + ' to ' + to + '.');
      }

      case 'copy': {
        const v = await vault();
        const from = need('from');
        const to = need('to');
        await find(v, from, true);
        if (await stat(v, to)) throw new ToolError(to + ' already exists.');
        await api('POST', '/api/fs/copy', { json: { vault: v, src: from, dest: to } });
        return text('Copied ' + from + ' to ' + to + '.');
      }

      case 'delete': {
        const v = await vault();
        const p = need('path');
        if (p === '.trash' || p.startsWith('.trash/')) throw new ToolError('That is already in the trash.');
        await find(v, p, true);
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
          instructions: await instructions(req),
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
