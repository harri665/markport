'use strict';

/**
 * Markport docx editor: edit a Word document (.docx) in place, in the browser.
 *
 * Loaded by main.js (DocxView, "Edit" mode) through loadVendor, the first
 * time a document is edited: plain CommonJS, no dependencies but the DOM and
 * the JSZip that vendor-docx.js already carries (passed in as opts.JSZip).
 *
 * How edits stay safe. document.xml is parsed into an XML DOM and kept for
 * the whole session. Every paragraph, run and inline wrapper (hyperlink,
 * tracked insertion, content control) the page shows remembers the XML node
 * it came from, by index (data-pid / data-rid / data-wid). On save:
 *
 *   - a paragraph nobody touched is written back as its original node;
 *   - an edited one is rebuilt from what the page shows, each piece of text
 *     taking its run properties (font, size, colour, ...) from the run it
 *     came from, with bold / italic / underline / strike read off the page;
 *   - anything the editor cannot offer as editable text (images, fields,
 *     footnote marks, equations, bookmarks, tracked deletions, page breaks,
 *     elements it does not know) is an "atom": shown, or hidden, as one
 *     uneditable piece and written back verbatim, in place;
 *   - tables keep their structure (rows can be added and removed); only the
 *     paragraphs in their cells are rebuilt.
 *
 * Headers, footers, footnotes, comments, styles, numbering and media live in
 * other parts of the zip and are not touched. Opening and saving a document
 * without edits changes nothing.
 */

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  v: 'urn:schemas-microsoft-com:vml',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  xml: 'http://www.w3.org/XML/1998/namespace',
  pkgRel: 'http://schemas.openxmlformats.org/package/2006/relationships',
};
const W = NS.w;
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

// ── XML helpers ─────────────────────────────────────────────────────────────

function isW(n, name) {
  return !!n && n.nodeType === 1 && n.namespaceURI === W && (name === undefined || n.localName === name);
}
function kids(n, name) {
  const out = [];
  for (let c = n && n.firstChild; c; c = c.nextSibling) if (isW(c, name)) out.push(c);
  return out;
}
function kid(n, name) {
  for (let c = n && n.firstChild; c; c = c.nextSibling) if (isW(c, name)) return c;
  return null;
}
function val(n, attr) {
  if (!n) return null;
  const v = n.getAttributeNS(W, attr || 'val');
  return v === '' && !n.hasAttributeNS(W, attr || 'val') ? null : v;
}
// A toggle property (<w:b/>, <w:b w:val="0"/>): true, false, or undefined when absent.
function onOff(n) {
  if (!n) return undefined;
  const v = val(n);
  return !(v === '0' || v === 'false' || v === 'off');
}
function twipPx(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round((n / 15) * 100) / 100 : null;   // 1440 twips per inch, 96 px per inch
}
function within(el, ns, name) {
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (p.namespaceURI === ns && p.localName === name) return true;
  return false;
}

// Child order the schema requires (Word refuses a file with them out of order).
const PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr',
  'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct',
  'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind',
  'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment',
  'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
const RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline',
  'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern',
  'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em',
  'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange'];

// Replace (or with el null, remove) parent's <w:name> children, keeping schema order.
function setChild(parent, name, order, el) {
  for (const c of kids(parent, name)) parent.removeChild(c);
  if (!el) return;
  const at = order.indexOf(name);
  let before = null;
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (isW(c) && order.indexOf(c.localName) > at) { before = c; break; }
  }
  parent.insertBefore(el, before);
}

function normalizePath(p) {
  const out = [];
  for (const s of p.split('/')) {
    if (s === '..') out.pop();
    else if (s && s !== '.') out.push(s);
  }
  return out.join('/');
}

// ── the package ─────────────────────────────────────────────────────────────

async function openPackage(data, JSZip) {
  const zip = await JSZip.loadAsync(data);
  const readXml = async (p) => {
    const f = zip.file(p);
    if (!f) return null;
    const d = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
    if (d.getElementsByTagName('parsererror').length) throw new Error(p + ' is not valid XML');
    return d;
  };
  let main = 'word/document.xml';
  const rootRels = await readXml('_rels/.rels');
  if (rootRels) {
    for (const rel of rootRels.getElementsByTagNameNS(NS.pkgRel, 'Relationship')) {
      if (/\/officeDocument$/.test(rel.getAttribute('Type') || '')) main = normalizePath(rel.getAttribute('Target') || main);
    }
  }
  const doc = await readXml(main);
  if (!doc || !isW(doc.documentElement, 'document') || !kid(doc.documentElement, 'body')) {
    throw new Error('this file has no Word document inside');
  }
  const dir = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
  const partPath = (t) => (t.startsWith('/') ? normalizePath(t) : normalizePath(dir + t));
  const rels = new Map();
  const relsDoc = await readXml(dir + '_rels/' + main.slice(dir.length) + '.rels');
  if (relsDoc) {
    for (const rel of relsDoc.getElementsByTagNameNS(NS.pkgRel, 'Relationship')) {
      rels.set(rel.getAttribute('Id'), {
        type: (rel.getAttribute('Type') || '').replace(/^.*\//, ''),
        target: rel.getAttribute('Target') || '',
        external: rel.getAttribute('TargetMode') === 'External',
      });
    }
  }
  let styles = null;
  let numbering = null;
  for (const r of rels.values()) {
    if (r.external) continue;
    if (r.type === 'styles') styles = await readXml(partPath(r.target));
    if (r.type === 'numbering') numbering = await readXml(partPath(r.target));
  }
  return { zip, main, doc, rels, partPath, styles, numbering };
}

// ── styles and numbering ────────────────────────────────────────────────────

function readStyles(sdoc) {
  const S = { para: new Map(), char: new Map(), defPara: null, docR: null, docP: null };
  if (!sdoc) return S;
  const root = sdoc.documentElement;
  const dd = kid(root, 'docDefaults');
  S.docR = kid(kid(dd, 'rPrDefault'), 'rPr');
  S.docP = kid(kid(dd, 'pPrDefault'), 'pPr');
  for (const s of kids(root, 'style')) {
    const id = val(s, 'styleId');
    if (!id) continue;
    const e = {
      id,
      name: val(kid(s, 'name')) || id,
      basedOn: val(kid(s, 'basedOn')),
      pPr: kid(s, 'pPr'),
      rPr: kid(s, 'rPr'),
      hidden: !!(kid(s, 'semiHidden') || kid(s, 'hidden')),
      prio: Number(val(kid(s, 'uiPriority')) || 99),
    };
    const type = val(s, 'type');
    if (type === 'paragraph') {
      S.para.set(id, e);
      const d = val(s, 'default');
      if (d !== null && d !== '0' && d !== 'false') S.defPara = id;
    } else if (type === 'character') {
      S.char.set(id, e);
    }
  }
  if (!S.defPara && S.para.has('Normal')) S.defPara = 'Normal';
  return S;
}

// A style and the styles it is based on, base first.
function chain(map, id) {
  const out = [];
  const seen = new Set();
  while (id && map.has(id) && !seen.has(id)) {
    seen.add(id);
    const e = map.get(id);
    out.unshift(e);
    id = e.basedOn;
  }
  return out;
}

function readNumbering(ndoc) {
  const abs = new Map();
  const nums = new Map();
  if (!ndoc) return { abs, nums };
  const lvlInfo = (l) => ({
    start: Number(val(kid(l, 'start')) ?? 1),
    fmt: val(kid(l, 'numFmt')) || 'decimal',
    text: val(kid(l, 'lvlText')) ?? '',
    pPr: kid(l, 'pPr'),
  });
  const root = ndoc.documentElement;
  for (const a of kids(root, 'abstractNum')) {
    const lv = new Map();
    for (const l of kids(a, 'lvl')) lv.set(Number(val(l, 'ilvl')), lvlInfo(l));
    abs.set(val(a, 'abstractNumId'), lv);
  }
  for (const n of kids(root, 'num')) {
    const over = new Map();
    for (const o of kids(n, 'lvlOverride')) {
      const st = val(kid(o, 'startOverride'));
      const l = kid(o, 'lvl');
      over.set(Number(val(o, 'ilvl')), { start: st !== null ? Number(st) : null, lvl: l ? lvlInfo(l) : null });
    }
    nums.set(val(n, 'numId'), { abs: val(kid(n, 'abstractNumId')), over });
  }
  return { abs, nums };
}

function roman(n) {
  if (!(n > 0 && n < 4000)) return String(n);
  const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}
function letters(n) {
  if (!(n > 0)) return String(n);
  const ch = String.fromCharCode(97 + ((n - 1) % 26));
  return ch.repeat(Math.floor((n - 1) / 26) + 1);
}
function formatNumber(n, fmt) {
  switch (fmt) {
    case 'lowerLetter': return letters(n);
    case 'upperLetter': return letters(n).toUpperCase();
    case 'lowerRoman': return roman(n);
    case 'upperRoman': return roman(n).toUpperCase();
    case 'decimalZero': return n < 10 ? '0' + n : String(n);
    case 'none': return '';
    default: return String(n);
  }
}
// Bullets are often Symbol / Wingdings private-use characters.
function bulletChar(text) {
  const c = text || '•';
  const map = { '\uf0b7': '•', '\uf0a7': '▪', '\uf0d8': '➢', '\uf0fc': '✓', '\uf076': '❖', '\uf06e': '■', '\uf0a8': '◆' };
  if (map[c]) return map[c];
  return /[\uf000-\uf0ff]/.test(c) ? '•' : c;
}

// ── Word properties as CSS ──────────────────────────────────────────────────

const HIGHLIGHT = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};
const JC = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' };
const SERIF = /times|cambria|georgia|garamond|book|serif|minion|palatino|baskerville/i;

// The bold / italic / underline / strike a run's own properties set
// (true / false / undefined when not set), as the page shows them.
function rState(rPr) {
  const uEl = kid(rPr, 'u');
  const sEl = kid(rPr, 'strike') || kid(rPr, 'dstrike');
  return {
    b: onOff(kid(rPr, 'b')),
    i: onOff(kid(rPr, 'i')),
    u: uEl ? val(uEl) !== 'none' : undefined,
    s: sEl ? onOff(sEl) : undefined,
  };
}

function rCss(rPr, css) {
  css = css || {};
  if (!rPr) return css;
  const st = rState(rPr);
  if (st.b !== undefined) css['font-weight'] = st.b ? 'bold' : 'normal';
  if (st.i !== undefined) css['font-style'] = st.i ? 'italic' : 'normal';
  if (st.u !== undefined || st.s !== undefined) {
    const set = new Set(String(css['text-decoration-line'] || '').split(' ').filter((x) => x && x !== 'none'));
    if (st.u !== undefined) { if (st.u) set.add('underline'); else set.delete('underline'); }
    if (st.s !== undefined) { if (st.s) set.add('line-through'); else set.delete('line-through'); }
    css['text-decoration-line'] = set.size ? [...set].join(' ') : 'none';
  }
  const sz = val(kid(rPr, 'sz'));
  if (sz && Number(sz) > 0) css['font-size'] = Number(sz) / 2 + 'pt';
  const col = val(kid(rPr, 'color'));
  if (col && /^[0-9a-f]{6}$/i.test(col)) css.color = '#' + col;
  const f = kid(rPr, 'rFonts');
  const fam = f && (val(f, 'ascii') || val(f, 'hAnsi'));
  if (fam) css['font-family'] = '"' + fam.replace(/["\\;{}]/g, '') + '", ' + (SERIF.test(fam) ? 'serif' : 'sans-serif');
  const hl = val(kid(rPr, 'highlight'));
  const fill = val(kid(rPr, 'shd'), 'fill');
  if (hl && HIGHLIGHT[hl]) css['background-color'] = HIGHLIGHT[hl];
  else if (fill && /^[0-9a-f]{6}$/i.test(fill)) css['background-color'] = '#' + fill;
  const va = val(kid(rPr, 'vertAlign'));
  if (va === 'superscript' || va === 'subscript') {
    css['vertical-align'] = va === 'superscript' ? 'super' : 'sub';
    css['font-size'] = '0.75em';
  }
  if (onOff(kid(rPr, 'caps'))) css['text-transform'] = 'uppercase';
  if (onOff(kid(rPr, 'smallCaps'))) css['font-variant'] = 'small-caps';
  return css;
}

function pCss(pPr, css) {
  css = css || {};
  if (!pPr) return css;
  const jc = val(kid(pPr, 'jc'));
  if (jc) css['text-align'] = JC[jc] || 'left';
  const sp = kid(pPr, 'spacing');
  if (sp) {
    const before = val(sp, 'before');
    const after = val(sp, 'after');
    const line = val(sp, 'line');
    const rule = val(sp, 'lineRule');
    if (before !== null && twipPx(before) !== null) css['padding-top'] = twipPx(before) + 'px';
    if (after !== null && twipPx(after) !== null) css['padding-bottom'] = twipPx(after) + 'px';
    if (line && Number(line) > 0) {
      css['line-height'] = (!rule || rule === 'auto') ? String(Math.round((Number(line) / 240) * 1.15 * 100) / 100) : twipPx(line) + 'px';
    }
  }
  const ind = kid(pPr, 'ind');
  if (ind) {
    const left = val(ind, 'left') ?? val(ind, 'start');
    const right = val(ind, 'right') ?? val(ind, 'end');
    const first = val(ind, 'firstLine');
    const hanging = val(ind, 'hanging');
    if (left !== null) css['padding-left'] = twipPx(left) + 'px';
    if (right !== null) css['padding-right'] = twipPx(right) + 'px';
    if (hanging !== null) css['text-indent'] = -twipPx(hanging) + 'px';
    else if (first !== null) css['text-indent'] = twipPx(first) + 'px';
  }
  const fill = val(kid(pPr, 'shd'), 'fill');
  if (fill && /^[0-9a-f]{6}$/i.test(fill)) css['background-color'] = '#' + fill;
  return css;
}

function decl(css) {
  return Object.keys(css).map((k) => k + ':' + css[k]).join(';');
}

// ── reading formatting off the page ────────────────────────────────────────

// Bold / italic / underline / strike set by an element itself (tags the
// browser's own formatting commands make, or inline style), over its parent's.
function fmtOf(el, f) {
  const o = { b: f.b, i: f.i, u: f.u, s: f.s };
  const t = el.tagName;
  if (t === 'B' || t === 'STRONG') o.b = true;
  if (t === 'I' || t === 'EM') o.i = true;
  if (t === 'U') o.u = true;
  if (t === 'S' || t === 'STRIKE' || t === 'DEL') o.s = true;
  const st = el.style;
  if (!st) return o;
  const fw = st.fontWeight;
  if (fw) o.b = fw === 'bold' || fw === 'bolder' || Number(fw) >= 600;
  const fs = st.fontStyle;
  if (fs) o.i = fs === 'italic' || fs === 'oblique';
  const td = st.textDecorationLine || st.textDecoration;
  if (td) {
    if (/\bnone\b/.test(td)) { o.u = false; o.s = false; } else {
      if (/underline/.test(td)) o.u = true;
      if (/line-through/.test(td)) o.s = true;
    }
  }
  return o;
}
function fmtKey(f) {
  return [f.b, f.i, f.u, f.s].map((x) => (x === undefined ? '-' : x ? '1' : '0')).join('');
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE']);
const TEXTY = new Set(['rPr', 't', 'tab', 'br', 'cr', 'lastRenderedPageBreak', 'noBreakHyphen', 'softHyphen']);
const WRAPPERS = new Set(['hyperlink', 'ins', 'moveTo', 'smartTag', 'customXml', 'fldSimple', 'dir', 'bdo']);
const INVISIBLE = new Set(['bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'permStart', 'permEnd',
  'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd', 'proofErr',
  'customXmlInsRangeStart', 'customXmlInsRangeEnd', 'customXmlDelRangeStart', 'customXmlDelRangeEnd']);
const CONTAINERS = ['dx-body', 'dx-cell', 'dx-sdtc'];

function isContainer(el) {
  return !!(el && el.classList && CONTAINERS.some((c) => el.classList.contains(c)));
}

// ── the editor ─────────────────────────────────────────────────────────────

class DocxEditor {
  constructor(pkg, opts) {
    this.pkg = pkg;
    this.opts = opts || {};
    this.doc = pkg.doc;
    this.prefix = this.doc.documentElement.lookupPrefix(W) || 'w';
    this.styles = readStyles(pkg.styles);
    this.numbering = readNumbering(pkg.numbering);
    // XML nodes the page refers to, by index.
    this.paras = [];
    this.runs = [];
    this.wraps = [];
    this.atoms = [];
    this.tables = [];
    this.cells = [];
    this.sdts = [];
    this.keeps = [];
    this.images = [];
    this.urls = [];
    this.dirty = new WeakSet();
    this.changed = false;
    this.notes = 0;
    this.lastRange = null;
    this.markerTimer = null;
    this.dead = false;
  }

  mk(name, attrs) {
    const e = this.doc.createElementNS(W, this.prefix + ':' + name);
    if (attrs) for (const k of Object.keys(attrs)) e.setAttributeNS(W, this.prefix + ':' + k, attrs[k]);
    return e;
  }

  // ── building the page ──

  render() {
    this.css = this.buildCss();
    const root = document.createElement('div');
    root.className = 'dx-root';
    const style = document.createElement('style');
    style.textContent = this.css.text;
    root.appendChild(style);
    root.appendChild(this.buildToolbar());

    const body = kid(this.doc.documentElement, 'body');
    const page = document.createElement('div');
    page.className = 'dx-page dx-body';
    page.contentEditable = 'true';
    page.spellcheck = true;
    const sect = kid(body, 'sectPr');
    const sz = kid(sect, 'pgSz');
    const mar = kid(sect, 'pgMar');
    const wpx = twipPx(val(sz, 'w')) || 816;
    page.style.width = wpx + 'px';
    const m = (k, d) => (mar && twipPx(val(mar, k)) !== null ? twipPx(val(mar, k)) : d);
    page.style.padding = `${Math.min(m('top', 96), 96)}px min(${m('right', 96)}px, 7%) ${Math.min(m('bottom', 96), 96)}px min(${m('left', 96)}px, 7%)`;
    this.container(body, page);
    root.appendChild(page);
    this.el = root;
    this.page = page;
    this.refreshMarkers();
    this.loadImages();

    this.mo = new MutationObserver((recs) => this.onMutations(recs));
    this.mo.observe(page, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['style', 'class', 'data-style', 'data-jc', 'data-num', 'data-ilvl'],
    });
    this.listen(page, 'keydown', (e) => this.onKey(e));
    this.listen(page, 'paste', (e) => this.onPaste(e));
    this.listen(page, 'drop', (e) => e.preventDefault());
    this.listen(page, 'focusin', () => {
      try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) { /* old browser */ }
    });
    this.listen(page, 'click', (e) => {
      const link = e.target.closest && e.target.closest('.dx-link');
      if (link && (e.ctrlKey || e.metaKey) && link.dataset.href && /^(https?|mailto):/i.test(link.dataset.href)) {
        e.preventDefault();
        window.open(link.dataset.href, '_blank', 'noopener');
      }
    });
    this.listen(document, 'selectionchange', () => this.onSelection());
    return root;
  }

  listen(target, type, fn) {
    target.addEventListener(type, fn);
    (this.unlisten = this.unlisten || []).push(() => target.removeEventListener(type, fn));
  }

  buildCss() {
    const S = this.styles;
    const cls = new Map();
    const rules = [];
    rules.push('.dx-root .dx-page{' + decl(rCss(S.docR)) + '}');
    rules.push('.dx-root .dx-p{' + decl(pCss(S.docP)) + '}');
    let n = 0;
    for (const id of S.para.keys()) {
      const c = 'dx-ps' + n++;
      cls.set('p:' + id, c);
      const css = {};
      for (const e of chain(S.para, id)) { pCss(e.pPr, css); rCss(e.rPr, css); }
      rules.push('.dx-root .dx-p.' + c + '{' + decl(css) + '}');
    }
    for (const id of S.char.keys()) {
      const c = 'dx-cs' + n++;
      cls.set('c:' + id, c);
      const css = {};
      for (const e of chain(S.char, id)) rCss(e.rPr, css);
      rules.push('.dx-root .' + c + '{' + decl(css) + '}');
    }
    return { text: rules.join('\n'), cls };
  }

  // Render the block children of a body, cell or content control into el.
  container(x, el) {
    for (let c = x.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      if (isW(c, 'p')) el.appendChild(this.renderPara(c));
      else if (isW(c, 'tbl')) el.appendChild(this.renderTable(c));
      else if (isW(c, 'sdt') && kid(c, 'sdtContent')) el.appendChild(this.renderSdt(c));
      else if (isW(c) && /Pr$/.test(c.localName)) continue;   // properties: kept where they are
      else el.appendChild(this.keepBlock(c));
    }
  }

  renderPara(xp) {
    const el = document.createElement('p');
    el.className = 'dx-p';
    el.dataset.pid = String(this.paras.push(xp) - 1);
    const pPr = kid(xp, 'pPr');
    el.dataset.style = val(kid(pPr, 'pStyle')) || '';
    el.dataset.jc = val(kid(pPr, 'jc')) || '';
    const np = kid(pPr, 'numPr');
    el.dataset.num = val(kid(np, 'numId')) ?? '';
    el.dataset.ilvl = val(kid(np, 'ilvl')) ?? '';
    if (kid(pPr, 'sectPr')) el.classList.add('dx-sect');
    if (onOff(kid(pPr, 'pageBreakBefore'))) el.classList.add('dx-pbb');
    this.inline(xp, el);
    if (!el.textContent && !el.querySelector('img')) el.appendChild(document.createElement('br'));
    this.decorate(el);
    return el;
  }

  inline(x, el) {
    for (let c = x.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      if (!isW(c)) { el.appendChild(this.atom(c)); continue; }
      const name = c.localName;
      if (name === 'pPr' || name === 'rPr') continue;
      if (name === 'r') { el.appendChild(this.renderRun(c)); continue; }
      if (WRAPPERS.has(name) || (name === 'sdt' && kid(c, 'sdtContent'))) {
        const w = document.createElement('span');
        w.className = 'dx-w dx-' + name;
        w.dataset.wid = String(this.wraps.push(c) - 1);
        if (name === 'hyperlink') {
          w.classList.add('dx-link');
          const rel = this.pkg.rels.get(c.getAttributeNS(NS.r, 'id'));
          const href = rel ? rel.target : (val(c, 'anchor') ? '#' + val(c, 'anchor') : '');
          if (href) { w.dataset.href = href; w.title = href + (/^(https?|mailto):/i.test(href) ? '\nCtrl/Cmd+click to open' : ''); }
        }
        this.inline(name === 'sdt' ? kid(c, 'sdtContent') : c, w);
        el.appendChild(w);
        continue;
      }
      el.appendChild(this.atom(c));
    }
  }

  renderRun(r) {
    const rPr = kid(r, 'rPr');
    let texty = onOff(kid(rPr, 'vanish')) !== true;
    for (let c = r.firstChild; c && texty; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      if (!isW(c) || !TEXTY.has(c.localName)) texty = false;
      else if (c.localName === 'br' && val(c, 'type') && val(c, 'type') !== 'textWrapping') texty = false;
    }
    if (!texty) return this.atom(r);
    const span = document.createElement('span');
    span.className = 'dx-r';
    span.dataset.rid = String(this.runs.push(r) - 1);
    const rs = val(kid(rPr, 'rStyle'));
    if (rs && this.css.cls.has('c:' + rs)) span.classList.add(this.css.cls.get('c:' + rs));
    const css = decl(rCss(rPr));
    if (css) span.style.cssText = css;
    let buf = '';
    const flush = () => { if (buf) span.appendChild(document.createTextNode(buf)); buf = ''; };
    for (let c = r.firstChild; c; c = c.nextSibling) {
      if (!isW(c)) continue;
      switch (c.localName) {
        case 't': buf += c.textContent; break;
        case 'tab': buf += '\t'; break;
        case 'noBreakHyphen': buf += '\u2011'; break;
        case 'softHyphen': buf += '\u00ad'; break;
        case 'br': case 'cr': flush(); span.appendChild(document.createElement('br')); break;
        default: break;
      }
    }
    flush();
    return span;
  }

  // One uneditable piece of a paragraph, written back as it is.
  atom(node) {
    const s = document.createElement('span');
    s.contentEditable = 'false';
    s.className = 'dx-atom';
    s.dataset.atom = String(this.atoms.push(node) - 1);
    const name = node.localName;
    if (isW(node, 'r')) {
      let shown = false;
      for (const kind of ['inline', 'anchor']) {
        for (const d of Array.from(node.getElementsByTagNameNS(NS.wp, kind))) {
          if (within(d, NS.mc, 'Fallback')) continue;
          s.appendChild(this.image(d));
          shown = true;
        }
      }
      if (!shown) {
        for (const im of Array.from(node.getElementsByTagNameNS(NS.v, 'imagedata'))) {
          if (within(im, NS.mc, 'Choice')) continue;
          s.appendChild(this.vmlImage(im));
          shown = true;
        }
      }
      for (const c of kids(node)) {
        const n = c.localName;
        if (n === 'footnoteReference' || n === 'endnoteReference') {
          const sup = document.createElement('span');
          sup.className = 'dx-note';
          sup.textContent = String(++this.notes);
          sup.title = n === 'footnoteReference' ? 'Footnote' : 'Endnote';
          s.appendChild(sup);
          shown = true;
        } else if (n === 'br' && (val(c, 'type') === 'page' || val(c, 'type') === 'column')) {
          s.classList.add('dx-pagebreak');
          s.title = val(c, 'type') === 'page' ? 'Page break' : 'Column break';
          shown = true;
        } else if (n === 'sym') {
          s.appendChild(document.createTextNode('\u25a1'));
          shown = true;
        } else if (n === 't' && onOff(kid(kid(node, 'rPr'), 'vanish')) !== true) {
          s.appendChild(document.createTextNode(c.textContent));
          shown = true;
        } else if (n === 'tab' && onOff(kid(kid(node, 'rPr'), 'vanish')) !== true) {
          s.appendChild(document.createTextNode('\t'));
        }
      }
      if (!shown) s.classList.add('dx-hidden');
      return s;
    }
    if (isW(node) && (name === 'del' || name === 'moveFrom')) {
      s.classList.add('dx-del');
      s.title = 'Tracked deletion';
      let t = '';
      for (const d of Array.from(node.getElementsByTagNameNS(W, 'delText'))) t += d.textContent;
      for (const d of Array.from(node.getElementsByTagNameNS(W, 't'))) t += d.textContent;
      s.textContent = t;
      if (!t) s.classList.add('dx-hidden');
      return s;
    }
    if (isW(node) && INVISIBLE.has(name)) { s.classList.add('dx-hidden'); return s; }
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    if (/oMath/.test(name)) { s.classList.add('dx-math'); s.title = 'Equation (not editable here)'; s.textContent = text || '[equation]'; return s; }
    if (text) { s.classList.add('dx-unknown'); s.title = 'Not editable here'; s.textContent = text; } else s.classList.add('dx-hidden');
    return s;
  }

  image(d) {
    const img = document.createElement('img');
    img.className = 'dx-img';
    img.alt = 'image';
    img.draggable = false;
    const ext = d.getElementsByTagNameNS(NS.wp, 'extent')[0];
    const cx = ext ? Number(ext.getAttribute('cx')) / 9525 : 0;   // EMU per px
    const cy = ext ? Number(ext.getAttribute('cy')) / 9525 : 0;
    if (cx > 0 && cy > 0) { img.style.width = Math.round(cx) + 'px'; img.style.aspectRatio = cx + ' / ' + cy; }
    const blip = d.getElementsByTagNameNS(NS.a, 'blip')[0];
    const rid = blip && (blip.getAttributeNS(NS.r, 'embed') || blip.getAttributeNS(NS.r, 'link'));
    if (rid) this.images.push([img, rid]);
    else { img.alt = 'shape'; img.classList.add('dx-shape'); }
    return img;
  }

  vmlImage(im) {
    const img = document.createElement('img');
    img.className = 'dx-img';
    img.alt = 'image';
    img.draggable = false;
    const shape = im.parentNode;
    const st = (shape && shape.getAttribute && shape.getAttribute('style')) || '';
    const w = /width:\s*([\d.]+)pt/.exec(st);
    const h = /height:\s*([\d.]+)pt/.exec(st);
    if (w && h) { img.style.width = Math.round(Number(w[1]) * 4 / 3) + 'px'; img.style.aspectRatio = w[1] + ' / ' + h[1]; }
    const rid = im.getAttributeNS(NS.r, 'id');
    if (rid) this.images.push([img, rid]);
    return img;
  }

  async loadImages() {
    const cache = new Map();
    const mime = (p) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' })[p.split('.').pop().toLowerCase()] || 'application/octet-stream';
    for (const [img, rid] of this.images.splice(0)) {
      const rel = this.pkg.rels.get(rid);
      if (!rel || rel.external) continue;
      const path = this.pkg.partPath(rel.target);
      try {
        if (!cache.has(path)) {
          const f = this.pkg.zip.file(path);
          cache.set(path, f ? f.async('uint8array').then((b) => {
            if (this.dead) return null;
            const u = URL.createObjectURL(new Blob([b], { type: mime(path) }));
            this.urls.push(u);
            return u;
          }) : Promise.resolve(null));
        }
        const url = await cache.get(path);
        if (url && !this.dead) img.src = url;
      } catch (_) { /* leave the image empty */ }
    }
  }

  renderTable(tbl, tid) {
    const wrap = document.createElement('div');
    wrap.className = 'dx-tbl';
    wrap.contentEditable = 'false';
    if (tid === undefined) tid = this.tables.push(tbl) - 1;
    wrap.dataset.tid = String(tid);
    const table = document.createElement('table');
    const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => twipPx(val(g, 'w')) || 0);
    if (cols.length && cols.every((c) => c > 0)) {
      const cg = document.createElement('colgroup');
      for (const c of cols) { const col = document.createElement('col'); col.style.width = c + 'px'; cg.appendChild(col); }
      table.appendChild(cg);
    }
    // Grid positions, for vertically merged cells (rowspan).
    const rows = kids(tbl, 'tr');
    const layout = rows.map((tr) => {
      let g = Number(val(kid(kid(tr, 'trPr'), 'gridBefore')) || 0);
      return kids(tr, 'tc').map((tc) => {
        const tcPr = kid(tc, 'tcPr');
        const span = Math.max(1, Number(val(kid(tcPr, 'gridSpan')) || 1));
        const vm = kid(tcPr, 'vMerge');
        const info = { tc, g, span, vm: vm ? (val(vm) === 'restart' ? 'restart' : 'cont') : null };
        g += span;
        return info;
      });
    });
    const tbody = document.createElement('tbody');
    layout.forEach((cells, r) => {
      const tr = document.createElement('tr');
      for (const info of cells) {
        if (info.vm === 'cont') continue;
        const td = document.createElement('td');
        if (info.span > 1) td.colSpan = info.span;
        if (info.vm === 'restart') {
          let n = 1;
          for (let rr = r + 1; rr < layout.length; rr++) {
            if (layout[rr].some((x) => x.g === info.g && x.vm === 'cont')) n++; else break;
          }
          if (n > 1) td.rowSpan = n;
        }
        const tcPr = kid(info.tc, 'tcPr');
        const fill = val(kid(tcPr, 'shd'), 'fill');
        if (fill && /^[0-9a-f]{6}$/i.test(fill)) td.style.backgroundColor = '#' + fill;
        const cell = document.createElement('div');
        cell.className = 'dx-cell';
        cell.contentEditable = 'true';
        cell.dataset.cid = String(this.cells.push(info.tc) - 1);
        this.container(info.tc, cell);
        if (!cell.firstChild) cell.appendChild(this.newPara());
        td.appendChild(cell);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  renderSdt(sdt) {
    const wrap = document.createElement('div');
    wrap.className = 'dx-sdt';
    wrap.contentEditable = 'false';
    wrap.dataset.sid = String(this.sdts.push(sdt) - 1);
    const alias = val(kid(kid(sdt, 'sdtPr'), 'alias'));
    if (alias) wrap.title = alias;
    const inner = document.createElement('div');
    inner.className = 'dx-sdtc';
    inner.contentEditable = 'true';
    this.container(kid(sdt, 'sdtContent'), inner);
    if (!inner.firstChild) inner.appendChild(this.newPara());
    wrap.appendChild(inner);
    return wrap;
  }

  keepBlock(node) {
    const d = document.createElement('div');
    d.className = 'dx-keep';
    d.contentEditable = 'false';
    d.dataset.kid = String(this.keeps.push(node) - 1);
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    if (text) { d.textContent = text; d.title = 'Not editable here'; } else d.classList.add('dx-hidden');
    return d;
  }

  newPara() {
    const p = document.createElement('p');
    p.className = 'dx-p';
    p.appendChild(document.createElement('br'));
    this.decorate(p);
    return p;
  }

  // ── paragraph look: style class, numbering, direct properties ──

  styleClass(id) {
    return this.css.cls.get('p:' + (id || this.styles.defPara)) || null;
  }

  effNum(p) {
    let num = p.dataset.num || '';
    let ilvl = p.dataset.ilvl || '';
    if (!num || !ilvl) {
      const st = chain(this.styles.para, p.dataset.style || this.styles.defPara).reverse();
      for (const e of st) {
        const np = kid(e.pPr, 'numPr');
        if (!np) continue;
        if (!num) num = val(kid(np, 'numId')) || '';
        if (!ilvl) ilvl = val(kid(np, 'ilvl')) || '';
        if (num && ilvl) break;
      }
    }
    return { num, ilvl: Math.min(8, Math.max(0, Number(ilvl) || 0)) };
  }

  level(num, ilvl) {
    const n = this.numbering.nums.get(num);
    if (!n) return null;
    const base = (this.numbering.abs.get(n.abs) || new Map()).get(ilvl);
    const o = n.over.get(ilvl);
    const l = (o && o.lvl) || base;
    if (!l) return null;
    return Object.assign({}, l, { start: o && o.start !== null ? o.start : l.start });
  }

  decorate(p) {
    for (const c of Array.from(p.classList)) if (/^dx-ps\d/.test(c)) p.classList.remove(c);
    const c = this.styleClass(p.dataset.style);
    if (c) p.classList.add(c);
    if (!p.classList.contains('dx-p')) p.classList.add('dx-p');
    const css = {};
    const { num, ilvl } = this.effNum(p);
    const lvl = num && num !== '0' ? this.level(num, ilvl) : null;
    if (lvl) pCss(lvl.pPr, css);
    const src = this.paras[Number(p.dataset.pid)];
    if (p.dataset.pid && src) pCss(kid(src, 'pPr'), css);
    delete css['text-align'];
    if (p.dataset.jc) css['text-align'] = JC[p.dataset.jc] || 'left';
    const text = decl(css);
    if (p.style.cssText !== text) p.style.cssText = text;
  }

  refreshMarkers() {
    const counters = new Map();
    for (const p of this.page.querySelectorAll('.dx-p')) {
      const { num, ilvl } = this.effNum(p);
      const lvl = num && num !== '0' ? this.level(num, ilvl) : null;
      if (!lvl) { if (p.hasAttribute('data-marker')) p.removeAttribute('data-marker'); continue; }
      let c = counters.get(num);
      if (!c) { c = new Array(9).fill(null); counters.set(num, c); }
      c[ilvl] = c[ilvl] === null ? lvl.start : c[ilvl] + 1;
      for (let k = ilvl + 1; k < 9; k++) c[k] = null;
      let text;
      if (lvl.fmt === 'bullet') text = bulletChar(lvl.text);
      else {
        text = lvl.text.replace(/%([1-9])/g, (_, d) => {
          const k = Number(d) - 1;
          const L = this.level(num, k);
          return formatNumber(c[k] !== null ? c[k] : (L ? L.start : 1), L ? L.fmt : 'decimal');
        });
      }
      if (p.getAttribute('data-marker') !== text) p.setAttribute('data-marker', text);
    }
  }

  // ── edits ──

  paraOf(n) {
    let e = n && (n.nodeType === 1 ? n : n.parentNode);
    while (e && e !== this.page) {
      if (isContainer(e.parentNode)) return e;
      e = e.parentNode;
    }
    return null;
  }

  onMutations(recs) {
    if (this.dead) return;
    for (const m of recs) {
      if (m.type === 'childList' && isContainer(m.target)) {
        for (const a of m.addedNodes) {
          if (a.nodeType !== 1 || a.dataset.tid || a.dataset.sid || a.dataset.kid) continue;
          this.dirty.add(a);
          if (BLOCK_TAGS.has(a.tagName) && !a.classList.contains('dx-p')) {
            a.classList.add('dx-p');
            this.decorate(a);
          }
        }
        continue;
      }
      const p = this.paraOf(m.target);
      if (p) this.dirty.add(p);
    }
    this.changed = true;
    clearTimeout(this.markerTimer);
    this.markerTimer = setTimeout(() => { if (!this.dead) this.refreshMarkers(); }, 150);
    if (this.opts.onChange) this.opts.onChange();
  }

  range() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (this.page.contains(r.commonAncestorContainer)) return r;
    }
    return null;
  }

  selectedParas() {
    const r = this.range() || this.lastRange;
    if (!r) return [];
    const out = [];
    for (const p of this.page.querySelectorAll('.dx-p')) if (r.intersectsNode(p)) out.push(p);
    if (!out.length) { const p = this.paraOf(r.startContainer); if (p) out.push(p); }
    return out;
  }

  restoreSelection() {
    if (!this.lastRange) return;
    const host = this.lastRange.startContainer.parentElement && this.lastRange.startContainer.parentElement.closest('[contenteditable="true"]');
    if (host) host.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(this.lastRange);
  }

  onSelection() {
    const r = this.range();
    if (!r) return;
    this.lastRange = r.cloneRange();
    const t = this.tools;
    if (!t) return;
    for (const [cmd, btn] of t.toggles) {
      let on = false;
      try { on = document.queryCommandState(cmd); } catch (_) { /* not supported */ }
      btn.classList.toggle('is-on', on);
    }
    const p = this.paraOf(r.startContainer);
    if (p) {
      const id = p.dataset.style || this.styles.defPara || '';
      if (t.style.value !== id) t.style.value = t.style.querySelector(`option[value="${CSS.escape(id)}"]`) ? id : '';
      const jc = JC[p.dataset.jc] || 'left';
      for (const [v, btn] of t.aligns) btn.classList.toggle('is-on', (JC[v] || 'left') === jc);
    }
    const inCell = !!(r.startContainer.parentElement && r.startContainer.parentElement.closest('.dx-cell'));
    t.rowGroup.style.display = inCell ? '' : 'none';
  }

  exec(cmd, value) {
    this.restoreSelection();
    try { document.execCommand(cmd, false, value); } catch (_) { /* unsupported */ }
    this.onSelection();
  }

  setStyle(id) {
    this.restoreSelection();
    for (const p of this.selectedParas()) {
      p.dataset.style = id === this.styles.defPara ? '' : id;
      this.decorate(p);
    }
    this.refreshMarkers();
  }

  setAlign(jc) {
    this.restoreSelection();
    const ps = this.selectedParas();
    const all = ps.length && ps.every((p) => (JC[p.dataset.jc] || 'left') === (JC[jc] || 'left'));
    for (const p of ps) { p.dataset.jc = all || jc === 'left' ? '' : jc; this.decorate(p); }
    this.onSelection();
  }

  onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      const cmd = { b: 'bold', i: 'italic', u: 'underline' }[k];
      if (cmd) { e.preventDefault(); e.stopPropagation(); this.exec(cmd); return; }
      if (k === 's') { e.preventDefault(); e.stopPropagation(); if (this.opts.onSave) this.opts.onSave(); return; }
    }
    const sel = window.getSelection();
    const p = sel && sel.anchorNode ? this.paraOf(sel.anchorNode) : null;
    if (!p) return;
    const listed = (() => { const { num } = this.effNum(p); return num && num !== '0'; })();
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      if (listed) {
        const { ilvl, num } = this.effNum(p);
        const next = Math.min(8, Math.max(0, ilvl + (e.shiftKey ? -1 : 1)));
        if (!p.dataset.num) p.dataset.num = num;
        p.dataset.ilvl = String(next);
        this.decorate(p);
        this.refreshMarkers();
      } else if (!e.shiftKey) {
        document.execCommand('insertText', false, '\t');
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && listed && !p.textContent) {
      // Enter on an empty list item ends the list, as in Word.
      e.preventDefault();
      p.dataset.num = '0';
      p.dataset.ilvl = '';
      this.decorate(p);
      this.refreshMarkers();
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && sel.isCollapsed) {
      // Do not let one keystroke swallow a whole table or content control.
      const back = e.key === 'Backspace';
      const sib = back ? p.previousElementSibling : p.nextElementSibling;
      if (sib && (sib.dataset.tid || sib.dataset.sid || sib.dataset.kid)) {
        const r = document.createRange();
        if (back) { r.setStart(p, 0); r.setEnd(sel.anchorNode, sel.anchorOffset); } else { r.setStart(sel.anchorNode, sel.anchorOffset); r.setEnd(p, p.childNodes.length); }
        if (!r.toString() && !r.cloneContents().querySelector('img')) e.preventDefault();
      }
    }
  }

  onPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, i) => {
      if (i) document.execCommand('insertParagraph');
      if (line) document.execCommand('insertText', false, line);
    });
  }

  // Insert a row above / below the one the caret is in, or delete it.
  rowOp(kind) {
    const r = this.range() || this.lastRange;
    const cell = r && r.startContainer.parentElement && r.startContainer.parentElement.closest('.dx-cell');
    const wrap = cell && cell.closest('.dx-tbl');
    if (!wrap || !this.page.contains(wrap)) return;
    this.onMutations(this.mo.takeRecords());
    const tbl = this.tables[Number(wrap.dataset.tid)];
    const tc = this.cells[Number(cell.dataset.cid)];
    const tr = tc && tc.parentNode;
    if (!tbl || !tr || !isW(tr, 'tr')) return;
    const rowIndex = kids(tbl, 'tr').indexOf(tr);
    const cellIndex = kids(tr, 'tc').indexOf(tc);
    this.emitTable(wrap, this.occurrences());
    if (kind === 'delete') {
      if (kids(tbl, 'tr').length <= 1) { wrap.remove(); return; }
      tr.parentNode.removeChild(tr);
    } else {
      const nr = tr.cloneNode(true);
      for (const el of [nr].concat(Array.from(nr.getElementsByTagName('*')))) {
        for (const a of Array.from(el.attributes)) if (a.localName === 'paraId' || a.localName === 'textId') el.removeAttributeNode(a);
      }
      for (const ntc of kids(nr, 'tc')) {
        const tcPr = kid(ntc, 'tcPr');
        if (tcPr) setChild(tcPr, 'vMerge', [], null);
        const firstP = kid(ntc, 'p');
        const np = this.mk('p');
        const pPr = firstP && kid(firstP, 'pPr');
        if (pPr) {
          const c = pPr.cloneNode(true);
          setChild(c, 'sectPr', PPR_ORDER, null);
          np.appendChild(c);
        }
        for (const c of Array.from(ntc.childNodes)) if (c !== tcPr) ntc.removeChild(c);
        ntc.appendChild(np);
      }
      tr.parentNode.insertBefore(nr, kind === 'above' ? tr : tr.nextSibling);
    }
    const fresh = this.renderTable(tbl, Number(wrap.dataset.tid));
    wrap.replaceWith(fresh);
    this.refreshMarkers();
    // Caret into the new row (or the row that took the deleted one's place).
    const target = kind === 'below' ? rowIndex + 1 : kind === 'delete' ? Math.min(rowIndex, kids(tbl, 'tr').length - 1) : rowIndex;
    const trs = fresh.querySelectorAll(':scope > table > tbody > tr');
    const row = trs[target];
    const cells = row ? row.querySelectorAll(':scope > td > .dx-cell') : [];
    const dest = cells[Math.min(cellIndex, cells.length - 1)];
    if (dest) {
      dest.focus({ preventScroll: true });
      const rr = document.createRange();
      rr.selectNodeContents(dest.querySelector('.dx-p') || dest);
      rr.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(rr);
    }
  }

  // ── the toolbar ──

  buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'dx-bar';
    const t = { toggles: [], aligns: [] };
    const button = (icon, label, fallback, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dx-btn clickable-icon';
      b.setAttribute('aria-label', label);
      b.title = label;
      try { if (this.opts.setIcon) this.opts.setIcon(b, icon); } catch (_) { /* no such icon */ }
      if (!b.querySelector('svg')) b.textContent = fallback;
      // Keep the caret (and the selection) where it is.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
      return b;
    };
    const sep = () => { const s = document.createElement('span'); s.className = 'dx-sep'; return s; };

    const style = document.createElement('select');
    style.className = 'dropdown dx-style';
    style.setAttribute('aria-label', 'Paragraph style');
    const S = this.styles;
    const order = (e) => {
      const n = e.name.toLowerCase();
      if (e.id === S.defPara || n === 'normal') return '0';
      if (n === 'title') return '1';
      if (n === 'subtitle') return '2';
      const h = /^heading (\d)$/.exec(n);
      if (h) return '3' + h[1];
      return '5' + n;
    };
    const list = [...S.para.values()].filter((e) => !e.hidden || /^heading \d$|^title$/i.test(e.name)).sort((a, b) => order(a).localeCompare(order(b)));
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '(other style)';
    blank.hidden = true;
    style.appendChild(blank);
    for (const e of list) {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.name.replace(/^heading (\d)$/i, 'Heading $1').replace(/^(\w)/, (m) => m.toUpperCase());
      style.appendChild(o);
    }
    style.addEventListener('change', () => { if (style.value) this.setStyle(style.value); });
    if (list.length) bar.appendChild(style);
    t.style = style;

    bar.appendChild(sep());
    for (const [cmd, icon, label, fb] of [
      ['bold', 'bold', 'Bold (Ctrl/Cmd+B)', 'B'],
      ['italic', 'italic', 'Italic (Ctrl/Cmd+I)', 'I'],
      ['underline', 'underline', 'Underline (Ctrl/Cmd+U)', 'U'],
      ['strikeThrough', 'strikethrough', 'Strikethrough', 'S'],
    ]) {
      const b = button(icon, label, fb, () => this.exec(cmd));
      t.toggles.push([cmd, b]);
      bar.appendChild(b);
    }
    bar.appendChild(sep());
    for (const [jc, icon, label, fb] of [
      ['left', 'align-left', 'Align left', 'L'],
      ['center', 'align-center', 'Center', 'C'],
      ['right', 'align-right', 'Align right', 'R'],
      ['both', 'align-justify', 'Justify', 'J'],
    ]) {
      const b = button(icon, label, fb, () => this.setAlign(jc));
      t.aligns.push([jc, b]);
      bar.appendChild(b);
    }
    bar.appendChild(sep());
    bar.appendChild(button('undo-2', 'Undo', '↶', () => this.exec('undo')));
    bar.appendChild(button('redo-2', 'Redo', '↷', () => this.exec('redo')));

    const rows = document.createElement('span');
    rows.className = 'dx-group';
    rows.style.display = 'none';
    rows.appendChild(sep());
    rows.appendChild(button('between-horizontal-start', 'Insert row above', '+↑', () => this.rowOp('above')));
    rows.appendChild(button('between-horizontal-end', 'Insert row below', '+↓', () => this.rowOp('below')));
    rows.appendChild(button('trash-2', 'Delete row', '−row', () => this.rowOp('delete')));
    bar.appendChild(rows);
    t.rowGroup = rows;

    const status = document.createElement('span');
    status.className = 'dx-status';
    bar.appendChild(status);
    t.status = status;
    this.tools = t;
    return bar;
  }

  setStatus(text) {
    if (this.tools) this.tools.status.textContent = text || '';
  }

  // ── saving ──

  occurrences() {
    const occ = new Map();
    for (const p of this.page.querySelectorAll('[data-pid]')) {
      const k = p.dataset.pid;
      if (k === '') continue;
      const o = occ.get(k) || { seen: 0, total: 0 };
      o.total++;
      occ.set(k, o);
    }
    return occ;
  }

  // The XML blocks a body / cell / content-control element now holds.
  emit(el, occ) {
    const out = [];
    let loose = null;
    const flushLoose = () => {
      if (loose) out.push(this.regen(loose, null, true, true));
      loose = null;
    };
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 1 && (n.dataset.tid || n.dataset.sid || n.dataset.kid || BLOCK_TAGS.has(n.tagName))) {
        flushLoose();
        if (n.dataset.tid) out.push(this.emitTable(n, occ));
        else if (n.dataset.sid) out.push(this.emitSdt(n, occ));
        else if (n.dataset.kid) out.push(this.keeps[Number(n.dataset.kid)]);
        else out.push(this.emitPara(n, occ));
      } else if (n.nodeType === 1 || (n.nodeType === 3 && n.data)) {
        // Text typed straight into the container (after deleting everything).
        if (!loose) loose = document.createElement('p');
        loose.appendChild(n.cloneNode(true));
      }
    }
    flushLoose();
    return out;
  }

  emitPara(n, occ) {
    const pid = n.dataset.pid || '';
    const src = pid !== '' ? this.paras[Number(pid)] : null;
    const o = src ? occ.get(pid) : null;
    const idx = o ? o.seen++ : 0;
    const first = idx === 0;
    const last = !o || idx === o.total - 1;
    if (src && o.total === 1 && !this.dirty.has(n)) return src;
    const node = this.regen(n, src, first, last);
    n.dataset.pid = String(this.paras.push(node) - 1);
    return node;
  }

  emitTable(wrap, occ) {
    const tbl = this.tables[Number(wrap.dataset.tid)];
    for (const cell of wrap.querySelectorAll('.dx-cell')) {
      if (cell.closest('.dx-tbl') !== wrap) continue;
      this.rebuild(this.cells[Number(cell.dataset.cid)], this.emit(cell, occ), true);
    }
    return tbl;
  }

  emitSdt(wrap, occ) {
    const sdt = this.sdts[Number(wrap.dataset.sid)];
    const inner = wrap.querySelector(':scope > .dx-sdtc');
    if (inner) this.rebuild(kid(sdt, 'sdtContent'), this.emit(inner, occ), false);
    return sdt;
  }

  // Put blocks back into a body / cell / sdtContent, keeping its properties.
  rebuild(x, nodes, needsTrailingPara) {
    const props = [];
    let sect = null;
    for (const c of Array.from(x.childNodes)) {
      if (isW(c, 'sectPr')) sect = c;
      else if (isW(c) && /Pr$/.test(c.localName)) props.push(c);
      x.removeChild(c);
    }
    for (const p of props) x.appendChild(p);
    if (!nodes.length || (needsTrailingPara && isW(nodes[nodes.length - 1], 'tbl'))) nodes.push(this.mk('p'));
    for (const n of nodes) x.appendChild(n);
    if (sect) x.appendChild(sect);
  }

  // Build a <w:p> from a paragraph on the page.
  regen(el, src, first, last) {
    const p = this.mk('p');
    if (src && first) for (const a of Array.from(src.attributes)) p.setAttributeNS(a.namespaceURI, a.name, a.value);
    let pPr = src && kid(src, 'pPr') ? kid(src, 'pPr').cloneNode(true) : null;
    // A section break belongs to the last paragraph of a split one.
    if (pPr && !last) setChild(pPr, 'sectPr', PPR_ORDER, null);
    pPr = this.applyPara(pPr, el);
    if (pPr) p.appendChild(pPr);

    const items = [];
    const walk = (node, ctx) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          if (c.data) items.push({ k: 'text', text: c.data, rid: ctx.rid, wr: ctx.wr, fmt: ctx.fmt });
          continue;
        }
        if (c.nodeType !== 1) continue;
        if (c.dataset.atom) { items.push({ k: 'atom', id: Number(c.dataset.atom), wr: ctx.wr, hidden: c.classList.contains('dx-hidden') }); continue; }
        if (c.tagName === 'BR') { items.push({ k: 'br', rid: ctx.rid, wr: ctx.wr, fmt: ctx.fmt }); continue; }
        if (c.tagName === 'IMG' || c.contentEditable === 'false') continue;
        const next = { rid: ctx.rid, wr: ctx.wr, fmt: fmtOf(c, ctx.fmt) };
        if (c.dataset.rid) next.rid = c.dataset.rid;
        if (c.dataset.wid) next.wr = ctx.wr.concat(c.dataset.wid);
        walk(c, next);
      }
    };
    walk(el, { rid: '', wr: [], fmt: {} });
    // The <br> a browser keeps at the end of a block is not a line break.
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].k === 'atom' && items[i].hidden) continue;
      if (items[i].k === 'br') items.splice(i, 1);
      break;
    }

    const stack = [];
    const top = () => (stack.length ? stack[stack.length - 1].into : p);
    const openTo = (path) => {
      let k = 0;
      while (k < stack.length && k < path.length && stack[k].wid === path[k]) k++;
      stack.length = k;
      for (; k < path.length; k++) {
        const shell = this.shell(path[k]);
        top().appendChild(shell.el);
        stack.push({ wid: path[k], into: shell.into });
      }
    };
    let cur = null;
    let curKey = null;
    for (const it of items) {
      openTo(it.wr);
      if (it.k === 'atom') { top().appendChild(this.atoms[it.id].cloneNode(true)); cur = null; continue; }
      const key = it.rid + '|' + fmtKey(it.fmt);
      if (!cur || key !== curKey || cur.parentNode !== top()) {
        cur = this.makeRun(it.rid !== '' ? this.runs[Number(it.rid)] : null, it.fmt);
        top().appendChild(cur);
        curKey = key;
      }
      if (it.k === 'br') cur.appendChild(this.mk('br'));
      else this.appendText(cur, it.text);
    }
    return p;
  }

  // An empty copy of an inline wrapper (hyperlink, ins, sdt...) to refill.
  shell(wid) {
    const el = this.wraps[Number(wid)].cloneNode(true);
    const into = isW(el, 'sdt') ? kid(el, 'sdtContent') : el;
    for (const c of Array.from(into.childNodes)) if (!(isW(c) && /Pr$/.test(c.localName))) into.removeChild(c);
    return { el, into };
  }

  applyPara(pPr, el) {
    const style = el.dataset.style || '';
    const jc = el.dataset.jc || '';
    const num = el.dataset.num || '';
    const ilvl = el.dataset.ilvl || '';
    if (!pPr && !style && !jc && !num && !ilvl) return null;
    if (!pPr) pPr = this.mk('pPr');
    if ((val(kid(pPr, 'pStyle')) || '') !== style) setChild(pPr, 'pStyle', PPR_ORDER, style ? this.mk('pStyle', { val: style }) : null);
    if ((val(kid(pPr, 'jc')) || '') !== jc) setChild(pPr, 'jc', PPR_ORDER, jc ? this.mk('jc', { val: jc }) : null);
    const np = kid(pPr, 'numPr');
    if ((val(kid(np, 'numId')) || '') !== num || (val(kid(np, 'ilvl')) || '') !== ilvl) {
      let next = null;
      if (num || ilvl) {
        next = this.mk('numPr');
        if (ilvl) next.appendChild(this.mk('ilvl', { val: ilvl }));
        if (num) next.appendChild(this.mk('numId', { val: num }));
      }
      setChild(pPr, 'numPr', PPR_ORDER, next);
    }
    return pPr;
  }

  makeRun(base, f) {
    const r = this.mk('r');
    if (base) for (const a of Array.from(base.attributes)) r.setAttributeNS(a.namespaceURI, a.name, a.value);
    let rPr = base && kid(base, 'rPr') ? kid(base, 'rPr').cloneNode(true) : null;
    const was = rState(rPr);
    const set = (name, v, on, off) => {
      if (!rPr) rPr = this.mk('rPr');
      setChild(rPr, name, RPR_ORDER, v === undefined ? null : this.mk(name, v ? on : off));
    };
    if (f.b !== was.b) set('b', f.b, null, { val: '0' });
    if (f.i !== was.i) set('i', f.i, null, { val: '0' });
    if (f.u !== was.u) set('u', f.u, { val: 'single' }, { val: 'none' });
    if (f.s !== was.s) {
      if (rPr) setChild(rPr, 'dstrike', RPR_ORDER, null);
      set('strike', f.s, null, { val: '0' });
    }
    if (rPr) r.appendChild(rPr);
    return r;
  }

  appendText(r, text) {
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
    const parts = clean.split(/(\t|\n)/);
    for (const part of parts) {
      if (part === '\t') r.appendChild(this.mk('tab'));
      else if (part === '\n') r.appendChild(this.mk('br'));
      else if (part) {
        const t = this.mk('t');
        if (/^\s|\s$|\s\s/.test(part)) t.setAttributeNS(NS.xml, 'xml:space', 'preserve');
        t.textContent = part;
        r.appendChild(t);
      }
    }
  }

  isDirty() { return this.changed; }

  // The edited document, as the bytes of a .docx.
  async save() {
    this.onMutations(this.mo.takeRecords());
    const body = kid(this.doc.documentElement, 'body');
    let xml;
    try {
      this.rebuild(body, this.emit(this.page, this.occurrences()), true);
      this.dirty = new WeakSet();
      this.changed = false;
      xml = new XMLSerializer().serializeToString(this.doc);
    } catch (e) {
      this.changed = true;
      throw e;
    }
    if (!/^<\?xml/.test(xml)) xml = XML_DECL + xml;
    this.pkg.zip.file(this.pkg.main, xml);
    try {
      return await this.pkg.zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    } catch (e) {
      this.changed = true;
      throw e;
    }
  }

  focus() {
    const first = this.page.querySelector('.dx-p');
    this.page.focus({ preventScroll: true });
    if (first) {
      const r = document.createRange();
      r.selectNodeContents(first);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.markerTimer);
    if (this.mo) this.mo.disconnect();
    for (const off of this.unlisten || []) off();
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    if (this.el) this.el.remove();
  }
}

async function open(data, opts) {
  if (!opts || !opts.JSZip) throw new Error('docx-editor: opts.JSZip is required');
  const pkg = await openPackage(data, opts.JSZip);
  const ed = new DocxEditor(pkg, opts);
  ed.render();
  return ed;
}

module.exports = { open, DocxEditor, _test: { rCss, pCss, fmtOf, formatNumber, bulletChar, normalizePath } };
