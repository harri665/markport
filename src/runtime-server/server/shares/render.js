/**
 * Server-side Markdown → HTML for share pages, with Obsidian's syntax:
 * [[wikilinks]], ![[embeds]] (images, audio, video, PDFs, notes), callouts,
 * ==highlights==, #tags, task lists, %%comments%%, footnotes, ^block-ids,
 * $math$ (shown as TeX source - share pages run no JavaScript).
 *
 * The output uses the class names of Obsidian's reading view so app.css and
 * the owner's theme style it. Links only resolve to files the share can
 * reach; everything else renders as an unresolved link. The result is always
 * run through sanitize-html - notes may contain raw HTML, and in an edit share
 * that HTML may have been written by a recipient.
 */

'use strict';

const MarkdownIt = require('markdown-it');
const footnote = require('markdown-it-footnote');
const sanitizeHtml = require('sanitize-html');
const { resolveLinkTarget, extractEmbedTargets, ext, ATTACHMENT_EXT } = require('./scope');

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', '3gp']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'ogv']);
const MAX_EMBED_DEPTH = 2;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slugify(text) {
  return String(text).toLowerCase().trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function encodePath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

function basenameNoMd(rel) {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

// ── preprocessing (outside fenced code only) ────────────────────────────────

function stripFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

function mapOutsideFences(text, fn) {
  const lines = text.split('\n');
  const out = [];
  let buf = [];
  let fence = null;
  const flush = () => { if (buf.length) { out.push(fn(buf.join('\n'))); buf = []; } };
  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence && m) {
      flush();
      fence = m[1];
      out.push(line);
    } else if (fence) {
      out.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^\s*(`+|~+)\s*$/.test(line)) fence = null;
    } else {
      buf.push(line);
    }
  }
  flush();
  return out.join('\n');
}

function preprocess(text) {
  return mapOutsideFences(stripFrontmatter(String(text).replace(/\r\n?/g, '\n')), (s) => s
    .replace(/%%[\s\S]*?%%/g, '')                       // Obsidian comments
    .replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/gm, ''));     // block ids
}

// ── markdown-it plugins ─────────────────────────────────────────────────────

function wikilinkRule(state, silent) {
  const src = state.src;
  let pos = state.pos;
  let embed = false;
  if (src.charCodeAt(pos) === 0x21) {
    if (src.charCodeAt(pos + 1) !== 0x5b || src.charCodeAt(pos + 2) !== 0x5b) return false;
    embed = true;
    pos++;
  } else if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) {
    return false;
  }
  const end = src.indexOf(']]', pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner.trim() || inner.includes('\n') || inner.includes('[[')) return false;
  if (!silent) {
    const tok = state.push('wikilink', '', 0);
    tok.meta = { embed, raw: inner.replace(/\\\|/g, '|') };
  }
  state.pos = end + 2;
  return true;
}

function highlightRule(state, silent) {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;
  const end = src.indexOf('==', start + 2);
  if (end < 0 || end === start + 2) return false;
  if (!silent) {
    state.push('mark_open', 'mark', 1);
    const oldMax = state.posMax;
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = oldMax;
    state.push('mark_close', 'mark', -1);
  }
  state.pos = end + 2;
  return true;
}

const TAG_RE = /^#([\p{L}\p{N}_\-/]+)/u;
function tagRule(state, silent) {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x23) return false;
  if (pos > 0 && !/\s/.test(src[pos - 1])) return false;
  const m = TAG_RE.exec(src.slice(pos));
  if (!m || /^[\d/]+$/.test(m[1])) return false;
  if (!silent) {
    const tok = state.push('obsidian_tag', '', 0);
    tok.content = m[1];
  }
  state.pos = pos + m[0].length;
  return true;
}

function mathInlineRule(state, silent) {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24) return false;
  const display = src.charCodeAt(start + 1) === 0x24;
  const open = display ? 2 : 1;
  if (!display && /\s/.test(src[start + 1] || ' ')) return false;
  let end = start + open;
  for (;;) {
    end = src.indexOf(display ? '$$' : '$', end);
    if (end < 0) return false;
    if (src[end - 1] !== '\\') break;
    end++;
  }
  if (end === start + open) return false;
  if (!display && /\s/.test(src[end - 1])) return false;
  if (!silent) {
    const tok = state.push('math_inline', '', 0);
    tok.content = src.slice(start + open, end);
    tok.meta = { display };
  }
  state.pos = end + open;
  return true;
}

function mathBlockRule(state, startLine, endLine, silent) {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const first = state.src.slice(pos, max);
  if (!first.startsWith('$$')) return false;
  let content;
  let next = startLine;
  if (first.length > 4 && first.trim().endsWith('$$') && first.trim() !== '$$') {
    content = first.trim().slice(2, -2);
  } else {
    const lines = [first.slice(2)];
    let found = false;
    while (++next < endLine) {
      const line = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
      if (line.trim().endsWith('$$')) { lines.push(line.trim().slice(0, -2)); found = true; break; }
      lines.push(line);
    }
    if (!found) return false;
    content = lines.join('\n');
  }
  if (silent) return true;
  const tok = state.push('math_block', 'div', 0);
  tok.content = content.trim();
  tok.map = [startLine, next + 1];
  state.line = next + 1;
  return true;
}

// Callouts: > [!type]+/- Title
function calloutRule(state) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'blockquote_open') continue;
    const para = tokens[i + 1];
    const inline = tokens[i + 2];
    if (!para || para.type !== 'paragraph_open' || !inline || inline.type !== 'inline') continue;
    const firstLine = inline.content.split('\n')[0];
    const m = /^\[!([^\]\s]+)\]([+-]?)[ \t]*(.*)$/.exec(firstLine);
    if (!m) continue;
    const type = m[1].toLowerCase();
    const title = m[3] || (type.charAt(0).toUpperCase() + type.slice(1));
    // Drop the first line from the paragraph.
    const kids = inline.children || [];
    const br = kids.findIndex((k) => k.type === 'softbreak' || k.type === 'hardbreak');
    inline.children = br < 0 ? [] : kids.slice(br + 1);
    inline.content = inline.content.split('\n').slice(1).join('\n');
    if (!inline.children.length) {
      para.hidden = true;
      const close = tokens[i + 3];
      if (close && close.type === 'paragraph_close') close.hidden = true;
    }
    // Matching close.
    let depth = 0;
    for (let j = i; j < tokens.length; j++) {
      if (tokens[j].type === 'blockquote_open') depth++;
      else if (tokens[j].type === 'blockquote_close' && --depth === 0) {
        tokens[j].meta = { callout: true, fold: m[2] };
        break;
      }
    }
    tokens[i].meta = { callout: true, type, fold: m[2], title };
  }
}

// - [ ] / - [x] task lists (any status character, like Obsidian).
function taskListRule(state) {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const m = /^\[(.)\][ \t]/.exec(inline.content);
    if (!m) continue;
    const ch = m[1];
    const item = tokens[i - 2];
    item.attrJoin('class', 'task-list-item' + (ch !== ' ' ? ' is-checked' : ''));
    item.attrSet('data-task', ch);
    const first = inline.children && inline.children[0];
    if (first && first.type === 'text') first.content = first.content.replace(/^\[.\][ \t]/, '');
    const box = new state.Token('html_inline', '', 0);
    box.content = '<input class="task-list-item-checkbox" type="checkbox" disabled' + (ch !== ' ' ? ' checked' : '') + '>';
    inline.children.unshift(box);
    for (let j = i - 3; j >= 0; j--) {
      if ((tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') && tokens[j].level === item.level - 1) {
        tokens[j].attrJoin('class', 'contains-task-list');
        break;
      }
    }
  }
}

function headingIdRule(state) {
  const seen = new Map();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const text = tokens[i + 1] && tokens[i + 1].content;
    let id = slugify(text || '');
    const n = seen.get(id) || 0;
    seen.set(id, n + 1);
    if (n) id += '-' + n;
    tokens[i].attrSet('id', id);
    tokens[i].attrSet('data-heading', text || '');
  }
}

// ── link handling ───────────────────────────────────────────────────────────

function isExternal(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');
}

function resolveForShare(env, target, { wantNote }) {
  const rel = resolveLinkTarget(env.index, target, env.from);
  if (!rel) return null;
  const isMd = rel.toLowerCase().endsWith('.md');
  if (env.scope.inScope(rel)) return { rel, isMd, href: isMd ? env.noteUrl(rel) : env.rawUrl(rel) };
  if (!isMd && !wantNote && env.linked.byVault.has(rel)) return { rel, isMd, href: env.rawUrl(rel) };
  return null;
}

function renderWikilink(meta, env, md) {
  const bar = meta.raw.indexOf('|');
  const target = (bar < 0 ? meta.raw : meta.raw.slice(0, bar)).trim();
  const alias = bar < 0 ? '' : meta.raw.slice(bar + 1).trim();
  const hash = target.indexOf('#');
  const file = hash < 0 ? target : target.slice(0, hash);
  const sub = hash < 0 ? '' : target.slice(hash + 1).replace(/^\^/, '');
  const anchor = sub ? '#' + slugify(sub.split('#').pop()) : '';

  if (!meta.embed) {
    const label = alias || (file ? file : '') + (sub ? (file ? ' > ' : '') + sub.split('#').join(' > ') : '');
    if (!file) return '<a class="internal-link" href="' + escapeHtml(anchor) + '">' + escapeHtml(label) + '</a>';
    const r = resolveForShare(env, file, { wantNote: false });
    if (!r) return '<span class="internal-link is-unresolved">' + escapeHtml(label) + '</span>';
    return '<a class="internal-link" href="' + escapeHtml(r.href + (r.isMd ? anchor : '')) + '">' + escapeHtml(label) + '</a>';
  }

  const r = resolveForShare(env, file, { wantNote: false });
  if (!r) return '<span class="internal-embed is-unresolved">' + escapeHtml(alias || target) + '</span>';
  const e = ext(r.rel);
  if (IMAGE_EXT.has(e)) {
    const size = /^(\d+)(?:x(\d+))?$/.exec(alias);
    const attrs = size ? ' width="' + size[1] + '"' + (size[2] ? ' height="' + size[2] + '"' : '') : '';
    const alt = size ? basenameNoMd(r.rel) : (alias || basenameNoMd(r.rel));
    return '<span class="internal-embed media-embed image-embed"><img src="' + escapeHtml(r.href) + '" alt="' + escapeHtml(alt) + '"' + attrs + ' loading="lazy"></span>';
  }
  if (AUDIO_EXT.has(e)) return '<span class="internal-embed media-embed audio-embed"><audio controls src="' + escapeHtml(r.href) + '"></audio></span>';
  if (VIDEO_EXT.has(e)) return '<span class="internal-embed media-embed video-embed"><video controls src="' + escapeHtml(r.href) + '"></video></span>';
  if (r.isMd) {
    const html = env.embeds.get(r.rel + '#' + sub);
    if (html == null) return '<a class="internal-link" href="' + escapeHtml(r.href + anchor) + '">' + escapeHtml(alias || target) + '</a>';
    return '<div class="internal-embed markdown-embed inline-embed"><div class="markdown-embed-title">' + escapeHtml(alias || basenameNoMd(r.rel)) +
      '</div><div class="markdown-embed-content">' + html + '</div><a class="markdown-embed-link" href="' + escapeHtml(r.href + anchor) + '">Open</a></div>';
  }
  return '<a class="internal-link" href="' + escapeHtml(r.href) + '">' + escapeHtml(alias || r.rel.slice(r.rel.lastIndexOf('/') + 1)) + '</a>';
}

function createMarkdown(breaks) {
  const md = new MarkdownIt({ html: true, linkify: true, breaks, typographer: false });
  md.use(footnote);
  md.inline.ruler.before('link', 'wikilink', wikilinkRule);
  md.inline.ruler.before('emphasis', 'highlight', highlightRule);
  md.inline.ruler.before('emphasis', 'obsidian_tag', tagRule);
  md.inline.ruler.after('escape', 'math_inline', mathInlineRule);
  md.block.ruler.before('fence', 'math_block', mathBlockRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.core.ruler.after('inline', 'callout', calloutRule);
  md.core.ruler.after('inline', 'task_list', taskListRule);
  md.core.ruler.after('inline', 'heading_ids', headingIdRule);

  md.renderer.rules.wikilink = (tokens, idx, opts, env) => renderWikilink(tokens[idx].meta, env, md);
  md.renderer.rules.obsidian_tag = (tokens, idx) => '<a class="tag">#' + escapeHtml(tokens[idx].content) + '</a>';
  md.renderer.rules.math_inline = (tokens, idx) =>
    '<span class="math math-' + (tokens[idx].meta.display ? 'block' : 'inline') + '">' + escapeHtml(tokens[idx].content) + '</span>';
  md.renderer.rules.math_block = (tokens, idx) => '<div class="math math-block">' + escapeHtml(tokens[idx].content) + '</div>\n';

  md.renderer.rules.blockquote_open = (tokens, idx, opts, env, self) => {
    const meta = tokens[idx].meta;
    if (!meta || !meta.callout) return self.renderToken(tokens, idx, opts);
    // Own env without `footnotes`: with the note's, markdown-it-footnote's
    // core rule would append a second footnote list to the title.
    const titleHtml = '<div class="callout-title-inner">' + md.renderInline(meta.title, Object.assign({}, env, { footnotes: undefined })) + '</div>';
    const attrs = ' data-callout="' + escapeHtml(meta.type) + '"' + (meta.fold ? ' data-callout-fold="' + meta.fold + '"' : '');
    if (meta.fold) {
      return '<details class="callout is-collapsible"' + attrs + (meta.fold === '+' ? ' open' : '') + '><summary class="callout-title">' + titleHtml + '</summary><div class="callout-content">\n';
    }
    return '<div class="callout"' + attrs + '><div class="callout-title">' + titleHtml + '</div><div class="callout-content">\n';
  };
  md.renderer.rules.blockquote_close = (tokens, idx, opts, env, self) => {
    const meta = tokens[idx].meta;
    if (!meta || !meta.callout) return self.renderToken(tokens, idx, opts);
    return meta.fold ? '</div></details>\n' : '</div></div>\n';
  };

  const defaultLinkOpen = md.renderer.rules.link_open || ((t, i, o, e, self) => self.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const tok = tokens[idx];
    const href = tok.attrGet('href') || '';
    if (isExternal(href)) {
      if (/^https?:|^mailto:/i.test(href)) {
        tok.attrJoin('class', 'external-link');
        tok.attrSet('target', '_blank');
        tok.attrSet('rel', 'noopener noreferrer nofollow');
      } else {
        tok.attrs = tok.attrs.filter(([k]) => k !== 'href');   // obsidian://, file:, ...
      }
    } else if (href && !href.startsWith('#')) {
      let target = href;
      try { target = decodeURI(href); } catch (_) { /* keep raw */ }
      const hash = target.indexOf('#');
      const file = hash < 0 ? target : target.slice(0, hash);
      const anchor = hash < 0 ? '' : '#' + slugify(target.slice(hash + 1));
      const r = resolveForShare(env, file, { wantNote: false });
      tok.attrJoin('class', 'internal-link');
      if (r) tok.attrSet('href', r.href + (r.isMd ? anchor : ''));
      else {
        tok.attrs = tok.attrs.filter(([k]) => k !== 'href');
        tok.attrJoin('class', 'is-unresolved');
      }
    }
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };

  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const tok = tokens[idx];
    const src = tok.attrGet('src') || '';
    if (!isExternal(src)) {
      let target = src;
      try { target = decodeURI(src); } catch (_) { /* keep raw */ }
      const r = resolveForShare(env, target.split('#')[0], { wantNote: false });
      if (!r || !IMAGE_EXT.has(ext(r.rel))) return '<span class="internal-embed is-unresolved">' + escapeHtml(tok.content || src) + '</span>';
      tok.attrSet('src', r.href);
    }
    tok.attrSet('loading', 'lazy');
    return defaultImage(tokens, idx, opts, env, self);
  };

  return md;
}

const SANITIZE = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img', 'details', 'summary', 'input', 'mark', 'del', 's', 'ins', 'u', 'sup', 'sub', 'kbd',
    'audio', 'video', 'source', 'span', 'div', 'h1', 'h2', 'figure', 'figcaption', 'section', 'font',
  ]),
  allowedAttributes: {
    '*': ['class', 'id', 'title', 'dir', 'lang', 'style', 'align', 'data-callout', 'data-callout-fold', 'data-task', 'data-heading', 'aria-hidden'],
    a: ['href', 'target', 'rel', 'name'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    input: ['type', 'checked', 'disabled'],
    audio: ['src', 'controls'],
    video: ['src', 'controls', 'width', 'height'],
    source: ['src', 'type'],
    details: ['open'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    ol: ['start'],
    font: ['color'],
  },
  allowedStyles: {
    '*': {
      color: [/^[#\w(),.\s%-]+$/],
      'background-color': [/^[#\w(),.\s%-]+$/],
      'text-align': [/^(left|right|center|justify)$/],
      'font-weight': [/^\w+$/],
      'font-style': [/^\w+$/],
      'text-decoration': [/^[\w\s-]+$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  transformTags: {
    input: (tagName, attribs) => (attribs.type === 'checkbox'
      ? { tagName: 'input', attribs: { type: 'checkbox', class: attribs.class || 'task-list-item-checkbox', disabled: 'disabled', ...(attribs.checked != null ? { checked: 'checked' } : {}) } }
      : { tagName: 'span', attribs: {} }),
    a: (tagName, attribs) => {
      if (attribs.target === '_blank') attribs.rel = 'noopener noreferrer nofollow';
      return { tagName, attribs };
    },
  },
};

function sanitize(html) {
  return sanitizeHtml(html, SANITIZE);
}

// Section of a note under heading `sub` (for ![[note#Heading]]).
function extractSection(text, sub) {
  if (!sub) return text;
  const want = slugify(sub.split('#').pop());
  const lines = text.split('\n');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start < 0 && slugify(m[2]) === want) { start = i; level = m[1].length; continue; }
    if (start >= 0 && m[1].length <= level) return lines.slice(start, i).join('\n');
  }
  return start < 0 ? text : lines.slice(start).join('\n');
}

/**
 * Render one note.
 *   ctx = { scope, index, linked (Scope#linked()), noteUrl(rel), rawUrl(rel),
 *           readNote(rel) -> Promise<string>, breaks }   (rel = vault-relative)
 * Returns sanitized HTML.
 */
async function renderNote(markdown, fromRel, ctx, depth = 0, seen = new Set([fromRel])) {
  const text = preprocess(markdown);
  const embeds = new Map();
  if (depth < MAX_EMBED_DEPTH) {
    for (const raw of new Set(rawEmbedTargets(text))) {
      const hash = raw.indexOf('#');
      const file = hash < 0 ? raw : raw.slice(0, hash);
      const sub = hash < 0 ? '' : raw.slice(hash + 1).replace(/^\^/, '');
      const rel = resolveLinkTarget(ctx.index, file, fromRel);
      if (!rel || !rel.toLowerCase().endsWith('.md') || !ctx.scope.inScope(rel) || seen.has(rel)) continue;
      try {
        const body = extractSection(await ctx.readNote(rel), sub);
        const next = new Set(seen); next.add(rel);
        embeds.set(rel + '#' + sub, await renderNote(body, rel, ctx, depth + 1, next));
      } catch (_) { /* unreadable: falls back to a link */ }
    }
  }
  const md = ctx.breaks === false ? MD_STRICT : MD_BREAKS;
  const env = { ...ctx, from: fromRel, embeds };
  return sanitize(md.render(text, env));
}

// ![[target#sub]] including the subpath (extractEmbedTargets drops it).
function rawEmbedTargets(text) {
  const out = [];
  const re = /!\[\[([^\]\n]+?)\]\]/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1].replace(/\\\|/g, '|').split('|')[0].trim());
  return out;
}

const MD_BREAKS = createMarkdown(true);
const MD_STRICT = createMarkdown(false);

module.exports = { renderNote, sanitize, escapeHtml, slugify, encodePath, basenameNoMd, preprocess, extractEmbedTargets, ATTACHMENT_EXT };
