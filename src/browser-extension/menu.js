/**
 * Markport Clipper - the folder menu: "save this where?".
 *
 * One menu, two ways to use it, in the style of a macOS context menu
 * (frosted glass, follows the system light/dark setting):
 *
 *   mode 'drop'   drag.js, while an image is being dragged: every folder is a
 *                 drop target, and holding the image over a closed vault's
 *                 name opens it.
 *   mode 'click'  picker.js, after a screenshot or a click on an image: a
 *                 normal menu. A click outside it or Esc dismisses it.
 *
 * It opens beside the point it is given (the pointer), on whichever side
 * has room, and never under the pointer itself, so a drag does not land on
 * a folder by accident. Toasts ("Saved to ...") live here too.
 *
 * Loaded as a content script after find-image.js, and injected again
 * before picker.js; the guard makes the second load a no-op.
 */
(() => {
  'use strict';

  if (self.__markportMenu) return;

  const { send } = self.__markportShared;
  const { folderGrid, favoriteFolders, folderTree } = self.MarkportLib;

  // Two rows of three folders. Every other folder is a hover away, in the
  // submenus that open beside the "Vault root" bar at the bottom.
  const WIDTH = 300;
  const GRID_MAX = 6;
  // Submenus: how wide, and how long the pointer (or the dragged image) has
  // to rest on a folder before its subfolders open.
  const SUB_WIDTH = 220;
  const SUB_MS = 220;

  const CSS = `
    :host {
      all: initial;
      --glass: rgba(246, 246, 248, .72);
      --glass-strong: rgba(250, 250, 252, .86);
      --fg: #1d1d1f;
      --sub: rgba(60, 60, 67, .62);
      --sep: rgba(60, 60, 67, .16);
      --edge: rgba(255, 255, 255, .6);
      --ring: rgba(0, 0, 0, .10);
      --accent: #007aff;
      --warn: #b25000;
      --input: rgba(255, 255, 255, .7);
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --glass: rgba(38, 38, 42, .62);
        --glass-strong: rgba(44, 44, 48, .84);
        --fg: #f5f5f7;
        --sub: rgba(235, 235, 245, .56);
        --sep: rgba(255, 255, 255, .11);
        --edge: rgba(255, 255, 255, .13);
        --ring: rgba(0, 0, 0, .5);
        --accent: #0a84ff;
        --warn: #ffb35c;
        --input: rgba(255, 255, 255, .08);
      }
    }
    * {
      box-sizing: border-box;
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .glass {
      color: var(--fg);
      background: var(--glass);
      -webkit-backdrop-filter: blur(28px) saturate(180%);
      backdrop-filter: blur(28px) saturate(180%);
      border: .5px solid var(--edge);
      box-shadow: 0 0 0 .5px var(--ring), 0 14px 44px rgba(0, 0, 0, .24), 0 2px 8px rgba(0, 0, 0, .10);
    }
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
      .glass { background: var(--glass-strong); }
    }

    .menu {
      position: fixed; z-index: 2147483647; width: ${WIDTH}px;
      display: flex; flex-direction: column; overflow: hidden;
      border-radius: 12px; padding: 5px 0;
      animation: pop .17s cubic-bezier(.2, .9, .3, 1.15);
      user-select: none;
    }
    @keyframes pop { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: none; } }
    .head { padding: 6px 14px 7px; }
    .title { font-weight: 600; }
    .sub { color: var(--sub); font-size: 11.5px; margin-top: 1px; }
    .list { overflow-y: auto; flex: 1; min-height: 40px; scrollbar-width: thin; }
    .sep { height: .5px; background: var(--sep); margin: 5px 12px; }
    .sec { color: var(--sub); font-size: 11px; font-weight: 600; padding: 6px 14px 2px; }
    .row {
      display: flex; align-items: center; gap: 8px; margin: 0 5px; padding: 4px 9px;
      min-height: 26px; border-radius: 6px; white-space: nowrap; cursor: default;
    }
    .row svg { flex: none; width: 15px; height: 15px; color: var(--sub); }
    .row .name { overflow: hidden; text-overflow: ellipsis; }
    .row .tag { margin-left: auto; color: var(--sub); font-size: 11px; flex: none; }
    .row.vault { font-weight: 600; }
    .row.vault svg { width: 12px; height: 12px; }
    .click .row:hover, .row.over { background: var(--accent); color: #fff; }
    .click .row:hover svg, .click .row:hover .tag, .row.over svg, .row.over .tag { color: #fff; }

    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; padding: 4px 8px 6px; }
    .tile {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
      min-height: 66px; padding: 7px 4px 6px; border-radius: 8px; text-align: center; cursor: default;
    }
    .tile svg { flex: none; width: 24px; height: 24px; color: var(--accent); margin-bottom: 1px; }
    .tile .name, .tile .hint { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tile .name { font-size: 12px; }
    .tile .hint { font-size: 10.5px; color: var(--sub); }
    .tile.last { background: color-mix(in srgb, var(--accent) 13%, transparent); }
    .tile.new { color: var(--accent); }
    .tile.fav svg { color: #E8A33D; }
    .glabel { padding: 6px 12px 0; font-size: 10.5px; color: var(--sub); text-transform: uppercase; letter-spacing: .06em; }

    .foot { flex: none; display: flex; flex-direction: column; padding-top: 4px; border-top: .5px solid var(--sep); margin-top: 3px; }
    .foot:empty { display: none; }
    .row.bar { font-weight: 600; }
    .row .more { margin-left: auto; flex: none; display: flex; align-items: center; color: var(--sub); }
    .row .more svg { width: 11px; height: 11px; }
    .row.open:not(.over):not(:hover) { background: color-mix(in srgb, var(--fg) 11%, transparent); }
    .row.new, .row.new svg { color: var(--accent); }
    .click .row:hover .more, .row.over .more { color: #fff; }
    .menu.sub { width: ${SUB_WIDTH}px; animation: none; }
    .menu.sub .list { min-height: 0; }
    .click .tile:hover, .tile.over { background: var(--accent); color: #fff; }
    .click .tile:hover svg, .click .tile:hover .hint, .tile.over svg, .tile.over .hint { color: #fff; }
    .msg { padding: 8px 14px 10px; color: var(--warn); line-height: 1.4; white-space: normal; }
    .wait { padding: 8px 14px 10px; color: var(--sub); }
    .name-box { padding: 4px 12px 8px; display: flex; flex-direction: column; gap: 8px; }
    .name-box input {
      background: var(--input); color: var(--fg); border: .5px solid var(--sep); border-radius: 6px;
      padding: 6px 8px; outline: none; box-shadow: 0 0 0 3px transparent; transition: box-shadow .15s;
    }
    .name-box input:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 45%, transparent); border-color: var(--accent); }
    .btns { display: flex; gap: 8px; justify-content: flex-end; }
    button {
      background: var(--input); color: var(--fg); border: .5px solid var(--sep); border-radius: 6px;
      padding: 4px 12px; cursor: default;
    }
    button.primary { background: var(--accent); border-color: transparent; color: #fff; }

    .toasts {
      position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483647;
      display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none;
    }
    .toast {
      border-radius: 999px; padding: 8px 16px; max-width: min(520px, calc(100vw - 32px));
      overflow-wrap: anywhere; text-align: center; font-weight: 500;
      animation: rise .2s cubic-bezier(.2, .9, .3, 1.1); transition: opacity .2s, transform .2s;
    }
    .toast.ok::before { content: "\\2713  "; color: #34c759; font-weight: 700; }
    .toast.err { border-radius: 14px; }
    .toast.err::before { content: "\\26A0  "; color: #ff453a; }
    .toast.out { opacity: 0; transform: translateY(6px); }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  `;

  // -- small DOM helpers ----------------------------------------------------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Built with createElementNS, not innerHTML: some pages enforce Trusted Types.
  function icon(d, opts) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    if (opts && opts.fill) {
      p.setAttribute('fill', 'currentColor');
      p.setAttribute('fill-rule', 'evenodd');
    } else {
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', (opts && opts.width) || '1.7');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
    }
    s.appendChild(p);
    return s;
  }

  const ICONS = {
    folder: 'M3.5 7.2c0-.9.7-1.7 1.7-1.7h4.1l1.9 2h7.6c.9 0 1.7.8 1.7 1.7v7.9c0 .9-.8 1.7-1.7 1.7H5.2c-1 0-1.7-.8-1.7-1.7z',
    root: 'M4 11.2 12 4.5l8 6.7M6.3 9.5v9h11.4v-9',
    star: 'M12 4.3l2.35 4.77 5.27.77-3.81 3.71.9 5.24L12 16.32l-4.71 2.47.9-5.24-3.81-3.71 5.27-.77z',
    recent: 'M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 1 0 0-16.4zM12 7.6V12l2.9 1.8',
    plus: 'M12 5.5v13M5.5 12h13',
    right: 'M9 5.5 15.5 12 9 18.5',
    down: 'M5.5 9 12 15.5 18.5 9',
  };

  // -- host -----------------------------------------------------------------

  let host, root, toastBox;

  function ensureHost() {
    if (!host) {
      host = document.createElement('markport-clipper-menu');
      root = host.attachShadow({ mode: 'open' });
      const style = el('style');
      style.textContent = CSS;
      toastBox = el('div', 'toasts');
      root.append(style, toastBox);
      // Keep the page's keyboard shortcuts away from the folder-name input.
      for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, (e) => e.stopPropagation());
    }
    // Last child of <html>, so it paints above picker.js's dimmed overlay
    // (same z-index; later in the document wins).
    if (document.documentElement.lastElementChild !== host) document.documentElement.appendChild(host);
  }

  function toast(text, kind, ms) {
    ensureHost();
    const t = el('div', 'toast glass ' + (kind || ''), text);
    toastBox.appendChild(t);
    while (toastBox.children.length > 3) toastBox.firstChild.remove();
    if (ms !== 0) {
      setTimeout(() => {
        t.classList.add('out');
        setTimeout(() => t.remove(), 220);
      }, ms || 3200);
    }
    return t;
  }

  // -- the menu -------------------------------------------------------------

  let menu = null;
  let list = null;
  let cur = null;        // the open() options: { x, y, mode, title, sub, onPick, onDismiss }
  let data = null;       // the 'targets' reply
  let expanded = null;   // vault id shown open (kept between menus)
  let naming = null;     // vault a new folder is being named in
  let springTimer = null;
  let scrollTimer = null;
  let foot = null;       // "Vault root" and "New Folder…" at the bottom
  let panels = [];       // open submenus, outermost first: { el, row, left }
  let subTimer = null;
  let subOwner = null;   // the row subTimer is for

  function open(opts) {
    ensureHost();
    teardown();
    cur = opts;
    data = null;
    naming = null;
    menu = el('div', 'menu glass ' + (opts.mode === 'drop' ? 'drop' : 'click'));
    const head = el('div', 'head');
    head.append(el('div', 'title', opts.title || 'Save to'));
    if (opts.sub) head.append(el('div', 'sub', opts.sub));
    list = el('div', 'list');
    if (opts.mode === 'drop') scrollsWhileDragging(list);
    foot = el('div', 'foot');
    menu.append(head, el('div', 'sep'), list, foot);
    root.insertBefore(menu, toastBox);
    place();
    render();
    load(opts);
  }

  // Beside the pointer: to the right and below it when there is room,
  // otherwise to the left and/or above. The edge nearest the pointer is the
  // one pinned, so the menu does not jump when the folder list arrives.
  function place() {
    const pad = 8;
    const gap = 14;
    const { x, y } = cur;
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;

    const right = x + gap + WIDTH <= vw - pad;
    const left = right ? x + gap : Math.max(pad, x - gap - WIDTH);
    menu.style.left = left + 'px';

    const below = vh - (y + gap) - pad;
    const above = y - gap - pad;
    if (below >= 280 || below >= above) {
      menu.style.top = (y + gap) + 'px';
      menu.style.bottom = 'auto';
      menu.style.maxHeight = Math.max(120, below) + 'px';
      menu.style.transformOrigin = (right ? 'left' : 'right') + ' top';
    } else {
      menu.style.top = 'auto';
      menu.style.bottom = (vh - (y - gap)) + 'px';
      menu.style.maxHeight = Math.max(120, above) + 'px';
      menu.style.transformOrigin = (right ? 'left' : 'right') + ' bottom';
    }
  }

  async function load(opts) {
    try {
      // The last lookup first, so the menu fills in at once (a drag does not
      // wait), then a fresh one, which may take a few seconds.
      const quick = await send({ type: 'targets', cached: true });
      if (cur !== opts) return;
      data = quick;
      if (!naming) render();
      const fresh = await send({ type: 'targets' });
      if (cur !== opts) return;
      data = fresh;
      if (!naming) render();
    } catch (e) {
      if (cur !== opts) return;
      data = { vaults: [], message: e.message };
      if (!naming) render();
    }
  }

  // Close without telling anyone (the caller is the one closing it).
  function teardown() {
    clearTimeout(springTimer);
    clearTimeout(subTimer);
    clearInterval(scrollTimer);
    closePanels(0);
    if (menu) menu.remove();
    menu = null;
    list = null;
    foot = null;
    cur = null;
    naming = null;
  }

  function pick(vault, folder) {
    const o = cur;
    teardown();
    if (o && o.onPick) o.onPick(vault, folder);
  }

  function dismiss() {
    const o = cur;
    teardown();
    if (o && o.onDismiss) o.onDismiss();
  }

  // A row that does `act` when chosen: dropped on (drop mode) or clicked.
  function actionable(node, act, onHover) {
    if (cur.mode !== 'drop') {
      node.addEventListener('click', (e) => { e.preventDefault(); if (act) act(); });
      if (onHover) {
        node.addEventListener('mouseenter', () => onHover(true));
        node.addEventListener('mouseleave', () => onHover(false));
      }
      return;
    }
    node.addEventListener('dragenter', (e) => {
      e.preventDefault();
      node.classList.add('over');
      if (onHover) onHover(true);
    });
    node.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = act ? 'copy' : 'none';
    });
    node.addEventListener('dragleave', (e) => {
      if (node.contains(e.relatedTarget)) return;
      node.classList.remove('over');
      if (onHover) onHover(false);
    });
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      node.classList.remove('over');
      if (act) act();
    });
  }

  function row(iconName, label, tag, cls) {
    const r = el('div', 'row' + (cls ? ' ' + cls : ''));
    r.append(icon(ICONS[iconName]), el('span', 'name', label));
    if (tag) r.append(el('span', 'tag', tag));
    return r;
  }

  function tile(iconName, label, hint, cls) {
    const t = el('div', 'tile' + (cls ? ' ' + cls : ''));
    t.append(icon(ICONS[iconName], iconName === 'folder' ? { width: '1.5' } : null), el('span', 'name', label));
    if (hint) t.append(el('span', 'hint', hint));
    return t;
  }

  function folderLabel(folder) { return folder || 'Vault root'; }

  function render() {
    if (!menu) return;
    list.textContent = '';
    foot.textContent = '';
    closePanels(0);
    clearTimeout(subTimer);
    if (naming) return renderNaming();
    if (!data) {
      list.append(el('div', 'wait', 'Looking for vaults…'));
      return;
    }
    if (!data.vaults.length) {
      list.append(el('div', 'msg', data.message || 'No vault found.'));
      return;
    }
    if (!expanded || !data.vaults.some((v) => v.id === expanded)) expanded = data.selected || data.vaults[0].id;
    const ordered = data.vaults.slice().sort((a, b) => (a.id === data.selected ? -1 : b.id === data.selected ? 1 : 0));

    ordered.forEach((v, i) => {
      const isOpen = v.id === expanded;
      if (i > 0) list.append(el('div', 'sep'));
      const head = row(isOpen ? 'down' : 'right', v.label, null, 'vault');
      head.title = isOpen ? '' : (cur.mode === 'drop' ? 'Hold the image here to open' : 'Show folders');
      head.addEventListener('click', () => { expanded = v.id; render(); });
      if (cur.mode === 'drop') {
        // Hold the dragged image over a closed vault to open it.
        actionable(head, null, (over) => {
          clearTimeout(springTimer);
          if (over && !isOpen) springTimer = setTimeout(() => { expanded = v.id; render(); }, 450);
        });
      }
      list.append(head);
      if (!isOpen) return;

      // The image library's favorite folders first, then a grid of
      // folders, the one used last at the top left.
      const favs = favoriteFolders(v.favorites, v.folders);
      if (favs.length) {
        list.append(el('div', 'glabel', 'Favorites'));
        const fg = el('div', 'grid');
        favs.slice(0, 9).forEach((f) => {
          const hint = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : (f === v.target ? 'Default' : '');
          const t = tile('star', f ? f.split('/').pop() : 'Vault root', hint, 'fav');
          t.title = (f || '/') + ' in ' + v.label;
          actionable(t, () => pick(v, f), hover(() => closePanels(0)));
          fg.append(t);
        });
        list.append(fg);
        list.append(el('div', 'glabel', 'Recent'));
      }
      const recent = (v.recent || []);
      const grid = el('div', 'grid');
      folderGrid(v.target, recent, v.folders, favs).slice(0, GRID_MAX).forEach((f, n) => {
        const isLast = n === 0 && recent.length > 0 && recent[0] === f;
        const hint = isLast ? 'Last used'
          : f === v.target ? 'Default'
          : f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
        const t = tile(f ? 'folder' : 'root', f ? f.split('/').pop() : 'Vault root', hint, isLast ? 'last' : '');
        t.title = (f || '/') + ' in ' + v.label;
        actionable(t, () => pick(v, f), hover(() => closePanels(0)));
        grid.append(t);
      });
      list.append(grid);
    });

    const shown = data.vaults.find((v) => v.id === expanded);
    if (shown) renderFoot(shown);
  }

  // -- "Vault root" at the bottom, and its submenus -----------------------------
  //
  // The bar at the bottom is the vault root. Resting on it (with the pointer,
  // or with a dragged image) opens a menu beside the popup with the root's
  // folders; resting on a folder there opens the next menu with that
  // folder's subfolders, and so on, like a desktop context menu. Dropping on
  // (or clicking) the bar or any folder saves there.

  // onHover for actionable(): run `act` once the pointer has rested on the
  // row a moment. The browser sends dragenter to the next row before
  // dragleave to the last one, so leaving only cancels this row's own timer.
  function hover(act) {
    const me = {};
    return (over) => {
      if (over) {
        clearTimeout(subTimer);
        subOwner = me;
        subTimer = setTimeout(() => { subOwner = null; act(); }, SUB_MS);
      } else if (subOwner === me) {
        clearTimeout(subTimer);
        subOwner = null;
      }
    };
  }

  // Close the submenus from number `level` on (0: all of them).
  function closePanels(level) {
    while (panels.length > level) {
      const p = panels.pop();
      p.el.remove();
      p.row.classList.remove('open');
    }
  }

  function more() {
    const m = el('span', 'more');
    m.append(icon(ICONS.right, { width: '2' }));
    return m;
  }

  function renderFoot(v) {
    const kids = folderTree(v.folders);
    const bar = row('root', 'Vault root', null, 'bar');
    bar.title = '/ in ' + v.label;
    if ((kids.get('') || []).length) bar.append(more());
    actionable(bar, () => pick(v, ''), hover(() => openPanel(0, bar, v, kids, '')));
    const add = row('plus', 'New Folder…', null, 'new');
    actionable(add, () => { naming = v; render(); }, hover(() => closePanels(0)));
    foot.append(bar, add);
  }

  // Submenu number `level` (0 is the first): the subfolders of `parent`,
  // beside `anchor`, the row it opens from.
  function openPanel(level, anchor, v, kids, parent) {
    if (!menu) return;
    if (panels[level] && panels[level].row === anchor) return closePanels(level + 1);
    closePanels(level);
    const children = kids.get(parent) || [];
    if (!children.length) return;

    const p = el('div', 'menu glass sub ' + (cur.mode === 'drop' ? 'drop' : 'click'));
    const box = el('div', 'list');
    for (const f of children) {
      const r = row('folder', f.slice(f.lastIndexOf('/') + 1), null, 'node');
      r.title = f + ' in ' + v.label;
      const sub = kids.has(f);
      if (sub) r.append(more());
      actionable(r, () => pick(v, f), hover(() => (sub ? openPanel(level + 1, r, v, kids, f) : closePanels(level + 1))));
      box.append(r);
    }
    if (cur.mode === 'drop') scrollsWhileDragging(box);
    // A deeper menu would no longer be beside its row.
    box.addEventListener('scroll', () => closePanels(level + 1));
    p.append(box);
    root.insertBefore(p, toastBox);
    anchor.classList.add('open');
    panels.push({ el: p, row: anchor, left: false });
    placePanel(level);
  }

  // Beside the menu it opens from, its first folder level with the row it
  // opens from. Submenus go right, then keep going the way the last one
  // went. The first goes left instead when the right has room for fewer
  // than two and the left has more, so the menus never turn back over the
  // popup.
  function placePanel(level) {
    const { el: p, row: anchor } = panels[level];
    const pad = 8;
    const gap = 2;
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;
    // Layout box, not getBoundingClientRect(): the popup may still be in its
    // pop-in animation, scaled down.
    const prev = level ? panels[level - 1].el : menu;
    const from = { left: prev.offsetLeft, right: prev.offsetLeft + prev.offsetWidth };
    const right = from.right + gap;
    const left = from.left - gap - SUB_WIDTH;
    const roomRight = vw - pad - right;
    const roomLeft = from.left - gap - pad;
    const goLeft = level > 0 ? panels[level - 1].left
      : roomRight < 2 * SUB_WIDTH + gap && roomLeft > roomRight;
    let x = !goLeft && right + SUB_WIDTH <= vw - pad ? right : left;
    if (x < pad) x = Math.max(pad, Math.min(right, vw - pad - SUB_WIDTH));   // no room either side
    panels[level].left = x < from.left;
    p.style.left = x + 'px';
    p.style.maxHeight = (vh - 2 * pad) + 'px';
    const a = anchor.getBoundingClientRect();
    p.style.top = Math.max(pad, Math.min(a.top - 5, vh - pad - p.offsetHeight)) + 'px';
    p.style.bottom = 'auto';
  }

  function renderNaming() {
    const vault = naming;
    const box = el('div', 'name-box');
    box.append(el('div', 'sub', 'New folder in ' + vault.label));
    const input = el('input');
    input.placeholder = 'e.g. Inspiration/Logos';
    input.value = vault.target ? vault.target + '/' : '';
    const btns = el('div', 'btns');
    const cancel = el('button', null, 'Cancel');
    const ok = el('button', 'primary', 'Save');
    btns.append(cancel, ok);
    box.append(input, btns);
    list.append(box);
    const go = () => {
      const folder = input.value.trim().replace(/^\/+|\/+$/g, '');
      if (folder) pick(vault, folder);
      else dismiss();
    };
    ok.addEventListener('click', go);
    cancel.addEventListener('click', dismiss);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
      if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
    });
    setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
  }

  // While an image is dragged near the top or bottom edge of `box`, scroll it.
  function scrollsWhileDragging(box) {
    box.addEventListener('dragover', (e) => {
      const r = box.getBoundingClientRect();
      const edge = 28;
      const dy = e.clientY < r.top + edge ? -8 : e.clientY > r.bottom - edge ? 8 : 0;
      clearInterval(scrollTimer);
      if (dy && box.scrollHeight > box.clientHeight) scrollTimer = setInterval(() => { box.scrollTop += dy; }, 16);
    });
    box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) clearInterval(scrollTimer); });
  }

  // Click mode: a click anywhere else, or Esc, dismisses the menu.
  window.addEventListener('pointerdown', (e) => {
    if (!menu || cur.mode === 'drop' || naming) return;
    const path = e.composedPath();
    if (path.includes(menu) || panels.some((p) => path.includes(p.el))) return;
    dismiss();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu && (cur.mode !== 'drop' || naming)) dismiss();
  }, true);

  // -- saving ---------------------------------------------------------------

  // c: a find-image.js candidate, or { inline: { data, mime }, alt }.
  // Resolves to true when saved; errors are shown, not thrown.
  async function save(vault, folder, c) {
    const pending = toast('Saving to ' + folderLabel(folder) + '…', '', 0);
    try {
      const msg = { type: 'save', vault: vault.id, folder, src: c.src || '', alt: c.alt || '' };
      if (c.inline) msg.inline = c.inline;
      else if (c.makeInline) { msg.inline = c.makeInline(); msg.src = ''; }
      const r = await send(msg);
      pending.remove();
      toast('Saved to ' + r.label + ': ' + r.path, 'ok');
      return true;
    } catch (e) {
      pending.remove();
      toast(e.message, 'err', 7000);
      return false;
    }
  }

  self.__markportMenu = {
    open,
    close: teardown,
    isOpen: () => !!menu,
    isNaming: () => !!naming,
    contains: (e) => !!host && e.composedPath().includes(host),
    element: () => host,
    toast,
    save,
    icon,
  };
})();
