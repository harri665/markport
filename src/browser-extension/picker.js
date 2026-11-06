/**
 * Markport Clipper - capture mode, injected into the page by background.js
 * when the toolbar button (or Alt+Shift+S) is pressed. Pressing it again
 * turns it off.
 *
 * The page dims. Then:
 *
 *   drag      draw a rectangle: that part of the page is captured as a PNG,
 *             and the folder menu (menu.js) opens at the pointer to save it
 *   click     on an image: the folder menu opens to save that image
 *   gear      (top middle) default folder, the drag menu switch, Options
 *   Esc / X   (top right) cancel
 *
 * One save per activation, like a screenshot tool. Clicking outside the
 * menu dismisses it and you can draw again.
 */
(() => {
  'use strict';

  if (window.__markportPicker) {
    window.__markportPicker.toggle();
    return;
  }

  // find-image.js and menu.js are injected just before this file.
  const { send } = self.__markportShared;
  const menu = self.__markportMenu;

  const DRAG_THRESHOLD = 4;   // px of movement before a press becomes a selection
  const MIN_SHOT = 8;         // smaller rectangles are treated as a click

  const CSS = `
    :host { all: initial; }
    * {
      box-sizing: border-box;
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .layer { --glass: rgba(246, 246, 248, .72); --fg: #1d1d1f; --sub: rgba(60, 60, 67, .62);
      --sep: rgba(60, 60, 67, .16); --edge: rgba(255, 255, 255, .6); --ring: rgba(0, 0, 0, .10);
      --accent: #007aff; --input: rgba(255, 255, 255, .7); }
    @media (prefers-color-scheme: dark) {
      .layer { --glass: rgba(38, 38, 42, .62); --fg: #f5f5f7; --sub: rgba(235, 235, 245, .56);
        --sep: rgba(255, 255, 255, .11); --edge: rgba(255, 255, 255, .13); --ring: rgba(0, 0, 0, .5);
        --accent: #0a84ff; --input: rgba(255, 255, 255, .08); }
    }
    .glass {
      color: var(--fg); background: var(--glass);
      -webkit-backdrop-filter: blur(28px) saturate(180%); backdrop-filter: blur(28px) saturate(180%);
      border: .5px solid var(--edge);
      box-shadow: 0 0 0 .5px var(--ring), 0 10px 34px rgba(0, 0, 0, .22), 0 1px 4px rgba(0, 0, 0, .08);
    }

    .dim {
      position: fixed; inset: 0; z-index: 2147483646;
      background: rgba(0, 0, 0, .34); cursor: crosshair; touch-action: none;
      animation: fade .18s ease-out;
    }
    .dim.on-image { cursor: pointer; }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    /* While a rectangle is drawn (or frozen behind the menu), the dimming is
       the selection's huge shadow, so the selected part stays clear. */
    .layer.selecting .dim, .layer.frozen .dim { background: transparent; }
    .sel {
      position: fixed; z-index: 2147483646; display: none; pointer-events: none;
      border: 1px solid rgba(255, 255, 255, .92); border-radius: 2px;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, .25), 0 0 0 200vmax rgba(0, 0, 0, .34);
    }
    .layer.selecting .sel, .layer.frozen .sel { display: block; }
    .size {
      position: absolute; left: 50%; top: calc(100% + 8px); transform: translateX(-50%);
      padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 500;
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    .sel.near-bottom .size { top: auto; bottom: calc(100% + 8px); }
    .layer.frozen .size { display: none; }

    .box {
      position: fixed; z-index: 2147483646; display: none; pointer-events: none;
      border: 2px solid var(--accent); border-radius: 6px;
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      box-shadow: 0 0 0 200vmax rgba(0, 0, 0, .12);
      transition: left .08s, top .08s, width .08s, height .08s;
    }
    .box .label {
      position: absolute; left: -2px; top: -30px; padding: 3px 9px; border-radius: 999px;
      font-size: 11.5px; font-weight: 500; white-space: nowrap;
    }
    .box.below .label { top: auto; bottom: -30px; }

    .gear, .close {
      position: fixed; top: 14px; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      border-radius: 999px; cursor: default; padding: 0;
      transition: transform .12s, background .12s;
    }
    .gear { left: 50%; transform: translateX(-50%); width: 34px; height: 34px; }
    .gear:hover, .gear.open { background: color-mix(in srgb, var(--glass) 60%, var(--accent) 18%); }
    .gear:active { transform: translateX(-50%) scale(.94); }
    .gear svg { width: 18px; height: 18px; color: var(--fg); transition: transform .3s; }
    .gear.open svg { transform: rotate(60deg); }
    .close { right: 14px; width: 30px; height: 30px; }
    .close:hover { background: color-mix(in srgb, var(--glass) 60%, #ff3b30 22%); }
    .close:active { transform: scale(.94); }
    .close svg { width: 14px; height: 14px; color: var(--fg); }

    .hint {
      position: fixed; top: 58px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
      padding: 5px 12px; border-radius: 999px; font-size: 12px; color: var(--sub);
      white-space: nowrap; pointer-events: none; transition: opacity .4s;
    }
    .hint.gone { opacity: 0; }

    .pop {
      position: fixed; top: 56px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
      width: 300px; padding: 12px 14px 12px; border-radius: 12px; display: none;
      animation: drop .16s cubic-bezier(.2, .9, .3, 1.15); transform-origin: top center;
    }
    .pop.open { display: block; }
    @keyframes drop { from { opacity: 0; transform: translateX(-50%) scale(.95); } to { opacity: 1; transform: translateX(-50%); } }
    .pop .title { font-weight: 600; margin-bottom: 10px; }
    .pop label.field { display: block; color: var(--sub); font-size: 11px; font-weight: 600; margin: 0 0 4px; }
    .pop select {
      width: 100%; background: var(--input); color: var(--fg); border: .5px solid var(--sep);
      border-radius: 6px; padding: 5px 6px; outline: none;
    }
    .pop select:focus { border-color: var(--accent); }
    .pop .msg { color: var(--sub); line-height: 1.4; }
    .pop .check { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    .pop .check input { accent-color: var(--accent); margin: 0; }
    .pop .sep { height: .5px; background: var(--sep); margin: 12px -14px 8px; }
    .pop .link { color: var(--accent); cursor: default; background: none; border: 0; padding: 0; }
    .pop .link:hover { text-decoration: underline; }
  `;

  // -- building the UI ------------------------------------------------------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // An 8-tooth gear with a hole, as one even-odd path.
  function gearPath() {
    const teeth = 8;
    const ro = 10.2;
    const ri = 7.4;
    const step = (2 * Math.PI) / teeth;
    const pts = [];
    for (let i = 0; i < teeth; i++) {
      const a = i * step - Math.PI / 2;
      for (const [r, da] of [[ri, -0.36], [ro, -0.2], [ro, 0.2], [ri, 0.36]]) {
        pts.push((12 + r * Math.cos(a + da)).toFixed(2) + ' ' + (12 + r * Math.sin(a + da)).toFixed(2));
      }
    }
    return 'M' + pts.join('L') + 'Z M15.1 12a3.1 3.1 0 1 0-6.2 0 3.1 3.1 0 1 0 6.2 0Z';
  }

  let host, root, layer, dim, sel, sizeEl, box, boxLabel, gear, pop, closeBtn, hint;

  function buildUi() {
    host = document.createElement('markport-clipper-capture');
    root = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = CSS;
    layer = el('div', 'layer');
    root.append(style, layer);

    dim = el('div', 'dim');
    sel = el('div', 'sel');
    sizeEl = el('div', 'size glass');
    sel.appendChild(sizeEl);
    box = el('div', 'box');
    boxLabel = el('div', 'label glass');
    box.appendChild(boxLabel);

    gear = el('button', 'gear glass');
    gear.title = 'Clipper settings';
    gear.setAttribute('aria-label', 'Clipper settings');
    gear.appendChild(menu.icon(gearPath(), { fill: true }));

    closeBtn = el('button', 'close glass');
    closeBtn.title = 'Cancel (Esc)';
    closeBtn.setAttribute('aria-label', 'Cancel');
    closeBtn.appendChild(menu.icon('M6.5 6.5l11 11M17.5 6.5l-11 11', { width: '2.2' }));

    hint = el('div', 'hint glass', 'Drag to capture · Click an image to save it · Esc to cancel');
    pop = el('div', 'pop glass');

    layer.append(dim, sel, box, gear, closeBtn, hint, pop);

    dim.addEventListener('pointerdown', onDown);
    dim.addEventListener('pointermove', onMove);
    dim.addEventListener('pointerup', onUp);
    dim.addEventListener('pointercancel', resetToIdle);
    dim.addEventListener('contextmenu', (e) => e.preventDefault());
    gear.addEventListener('click', () => togglePop());
    closeBtn.addEventListener('click', stop);
    // Keep the page's keyboard shortcuts away from the settings controls.
    for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  }

  // -- state ----------------------------------------------------------------

  let active = false;
  let phase = 'idle';      // idle | pressing | selecting | capturing | menu | saving
  let start = null;        // pointerdown point
  let rect = null;         // the selection, CSS px, viewport coordinates
  let hoverRaf = 0;
  let hintTimer = null;

  function setPhase(p) {
    phase = p;
    layer.classList.toggle('selecting', p === 'selecting');
    layer.classList.toggle('frozen', (p === 'menu' || p === 'saving') && !!rect);
  }

  function resetToIdle() {
    rect = null;
    start = null;
    box.style.display = 'none';
    setPhase('idle');
  }

  // -- selecting ------------------------------------------------------------

  function onDown(e) {
    if (e.button !== 0 || phase !== 'idle') return;
    closePop();
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY };
    try { dim.setPointerCapture(e.pointerId); } catch (_) { /* fine without */ }
    setPhase('pressing');
  }

  function onMove(e) {
    if (phase === 'idle') return scheduleHover(e.clientX, e.clientY);
    if (phase !== 'pressing' && phase !== 'selecting') return;
    if (phase === 'pressing') {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
      box.style.display = 'none';
      dim.classList.remove('on-image');
      setPhase('selecting');
    }
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const x2 = Math.max(0, Math.min(vw, e.clientX));
    const y2 = Math.max(0, Math.min(vh, e.clientY));
    rect = {
      x: Math.min(start.x, x2), y: Math.min(start.y, y2),
      w: Math.abs(x2 - start.x), h: Math.abs(y2 - start.y),
    };
    sel.style.left = rect.x + 'px';
    sel.style.top = rect.y + 'px';
    sel.style.width = rect.w + 'px';
    sel.style.height = rect.h + 'px';
    sel.classList.toggle('near-bottom', rect.y + rect.h > vh - 40);
    sizeEl.textContent = Math.round(rect.w * devicePixelRatio) + ' × ' + Math.round(rect.h * devicePixelRatio);
  }

  function onUp(e) {
    try { dim.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
    const at = { x: e.clientX, y: e.clientY };
    if (phase === 'selecting' && rect && rect.w >= MIN_SHOT && rect.h >= MIN_SHOT) {
      capture(rect, at);
      return;
    }
    if (phase === 'pressing' || phase === 'selecting') {
      rect = null;
      const c = candidateAt(at.x, at.y);
      if (c) return chooseImage(c, at);
    }
    resetToIdle();
  }

  // -- clicking an image ----------------------------------------------------

  function candidateAt(x, y) {
    return self.__markportShared.candidateAt(x, y, host);
  }

  function scheduleHover(x, y) {
    cancelAnimationFrame(hoverRaf);
    hoverRaf = requestAnimationFrame(() => {
      if (phase !== 'idle') return;
      const c = candidateAt(x, y);
      dim.classList.toggle('on-image', !!c);
      if (!c) { box.style.display = 'none'; return; }
      outline(c, 'Click to save');
    });
  }

  function outline(c, text) {
    const r = c.el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    box.classList.toggle('below', r.top < 90);
    boxLabel.textContent = text + (c.w && c.h ? ' · ' + c.w + ' × ' + c.h : '');
  }

  function chooseImage(c, at) {
    outline(c, 'Image');
    setPhase('menu');
    menu.open({
      x: at.x,
      y: at.y,
      mode: 'click',
      title: 'Save Image',
      sub: (c.alt || '').slice(0, 60) || (c.w && c.h ? c.w + ' × ' + c.h : ''),
      onPick: (vault, folder) => finish(menu.save(vault, folder, c)),
      onDismiss: resetToIdle,
    });
  }

  // -- the screenshot -------------------------------------------------------

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  function shotName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return 'Screenshot ' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' at ' + p(d.getHours()) + '.' + p(d.getMinutes()) + '.' + p(d.getSeconds());
  }

  async function capture(r, at) {
    setPhase('capturing');
    closePop();
    // Our own overlay must not be in the picture: hide it (and any toast),
    // let the browser paint a clean frame, then capture.
    host.style.visibility = 'hidden';
    const menuHost = menu.element();
    if (menuHost) menuHost.style.visibility = 'hidden';
    await nextFrame();
    await nextFrame();
    let shot;
    try {
      shot = await send({
        type: 'capture',
        rect: r,
        viewport: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
      });
    } catch (e) {
      host.style.visibility = '';
      if (menuHost) menuHost.style.visibility = '';
      menu.toast(e.message, 'err', 7000);
      resetToIdle();
      return;
    }
    host.style.visibility = '';
    if (menuHost) menuHost.style.visibility = '';
    if (!active) return;
    setPhase('menu');
    const name = shotName();
    menu.open({
      x: at.x,
      y: at.y,
      mode: 'click',
      title: 'Save Screenshot',
      sub: shot.w + ' × ' + shot.h,
      onPick: (vault, folder) => finish(menu.save(vault, folder, { inline: { data: shot.data, mime: shot.mime }, alt: name })),
      onDismiss: resetToIdle,
    });
  }

  async function finish(saving) {
    setPhase('saving');
    const ok = await saving;
    if (ok) stop();
    else resetToIdle();
  }

  // -- settings (the gear) --------------------------------------------------

  function closePop() {
    pop.classList.remove('open');
    gear.classList.remove('open');
  }

  function togglePop() {
    if (pop.classList.contains('open')) return closePop();
    if (menu.isOpen()) menu.close();
    resetToIdle();
    hint.classList.add('gone');
    pop.classList.add('open');
    gear.classList.add('open');
    renderPop(null);
    Promise.all([
      send({ type: 'targets' }),
      chrome.storage.sync.get({ dragPopup: true }),
    ]).then(([t, s]) => renderPop(t, s), (e) => renderPop({ vaults: [], message: e.message }, null));
  }

  function renderPop(t, s) {
    pop.textContent = '';
    pop.append(el('div', 'title', 'Markport Clipper'));
    if (!t) {
      pop.append(el('div', 'msg', 'Looking for vaults…'));
    } else if (!t.vaults.length) {
      pop.append(el('div', 'msg', t.message || 'No vault found.'));
    } else {
      const label = el('label', 'field', 'Default folder');
      const select = el('select');
      for (const v of t.vaults) {
        const group = el('optgroup');
        group.label = v.label;
        // Favorites (starred in the image library) first, marked with a star.
        const favs = (v.favorites || []).filter((f) => v.folders.includes(f));
        const rest = v.folders.includes(v.target) ? v.folders : v.folders.concat([v.target]);
        const folders = favs.concat(rest.filter((f) => !favs.includes(f)));
        for (const f of folders) {
          const o = el('option', null, (favs.includes(f) ? '★ ' : '') + (f || 'Vault root'));
          o.value = JSON.stringify([v.id, f]);
          if (v.id === t.selected && f === v.target) o.selected = true;
          group.appendChild(o);
        }
        select.appendChild(group);
      }
      select.addEventListener('change', async () => {
        let pair;
        try { pair = JSON.parse(select.value); } catch (_) { return; }
        try {
          const r = await send({ type: 'setTarget', vault: pair[0], folder: pair[1] });
          menu.toast('Default folder: ' + r.label + ' › ' + (r.target || 'Vault root'), 'ok', 2200);
        } catch (e) {
          menu.toast(e.message, 'err', 6000);
        }
      });
      pop.append(label, select);
    }

    if (s) {
      const check = el('label', 'check');
      const box2 = el('input');
      box2.type = 'checkbox';
      box2.checked = s.dragPopup !== false;
      box2.addEventListener('change', () => chrome.storage.sync.set({ dragPopup: box2.checked }).catch(() => {}));
      check.append(box2, el('span', null, 'Folder menu when dragging images'));
      pop.append(check);
    }

    pop.append(el('div', 'sep'));
    const more = el('button', 'link', 'All settings…');
    more.addEventListener('click', () => send({ type: 'openOptions' }).catch(() => {}));
    pop.append(more);
  }

  // -- on / off -------------------------------------------------------------

  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  }

  function onViewportChange() {
    // The selection is in viewport coordinates; once the page moves under
    // it, it no longer marks what was meant. The outline follows the image.
    if (phase === 'selecting' || phase === 'pressing') resetToIdle();
    if (phase === 'idle') box.style.display = 'none';
  }

  function start_() {
    if (active) return;
    if (!host) buildUi();
    active = true;
    resetToIdle();
    closePop();
    hint.classList.remove('gone');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.add('gone'), 3500);
    document.documentElement.appendChild(host);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
  }

  function stop() {
    if (!active) return;
    active = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
    if (menu.isOpen()) menu.close();
    closePop();
    resetToIdle();
    host.remove();
  }

  window.__markportPicker = {
    toggle: () => (active ? stop() : start_()),
    active: () => active,
  };
  start_();
})();
