/**
 * Markport Clipper - shared by picker.js (capture mode), menu.js and drag.js (the folder
 * menu when dragging an image). Loaded as a content script on every page,
 * and injected again before picker.js; the guard makes the second load a
 * no-op. Both scripts run in the extension's isolated world, so they see
 * self.__markportShared but the page does not.
 */
(() => {
  'use strict';

  if (self.__markportShared) return;

  const MIN_SIZE = 24;

  // -- talking to background.js ---------------------------------------------

  async function send(msg) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      if (!r) throw new Error('No answer from the extension');
      if (!r.ok) throw new Error(r.error);
      return r.value;
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/context invalidated|Receiving end does not exist/i.test(m)) {
        throw new Error('The extension was reloaded - reload this page to keep clipping.');
      }
      throw e instanceof Error ? e : new Error(m);
    }
  }

  // -- finding an image ------------------------------------------------------

  function abs(url) {
    try { return new URL(url, document.baseURI).href; } catch (_) { return null; }
  }

  function largestFromSrcset(srcset) {
    let best = null;
    let bestScore = -1;
    for (const part of srcset.split(/,\s+/)) {
      const [url, descriptor] = part.trim().split(/\s+/);
      if (!url) continue;
      const m = /^([\d.]+)([wx])$/.exec(descriptor || '1x');
      const score = m ? parseFloat(m[1]) * (m[2] === 'x' ? 1000 : 1) : 1000;
      if (score > bestScore) { best = url; bestScore = score; }
    }
    return best;
  }

  function imgSource(img) {
    let src = img.currentSrc || img.src;
    if (img.srcset) {
      const big = largestFromSrcset(img.srcset);
      if (big) src = big;
    }
    // Lazy loaders put a tiny placeholder in src and the real one in data-*.
    if (!src || (/^data:/i.test(src) && src.length < 400)) {
      src = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src') || src;
    }
    return src ? abs(src) : null;
  }

  function bigEnough(el) {
    const r = el.getBoundingClientRect();
    return r.width >= MIN_SIZE && r.height >= MIN_SIZE;
  }

  function svgToBase64(svg) {
    const clone = svg.cloneNode(true);
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const r = svg.getBoundingClientRect();
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.round(r.width)));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.round(r.height)));
    const text = new XMLSerializer().serializeToString(clone);
    return btoa(unescape(encodeURIComponent(text)));
  }

  // The image an element shows, or null. Result:
  //   { el, src, alt, w, h, makeInline? }   makeInline() -> { data, mime } for
  //   images that have no URL to fetch (inline <svg>, <canvas>).
  function candidateFor(el) {
    if (el instanceof HTMLImageElement) {
      if (!bigEnough(el)) return null;
      const src = imgSource(el);
      return src ? { el, src, alt: el.alt || el.title || '', w: el.naturalWidth, h: el.naturalHeight } : null;
    }
    if (el instanceof SVGElement) {
      let svg = el instanceof SVGSVGElement ? el : el.ownerSVGElement;
      while (svg && svg.ownerSVGElement) svg = svg.ownerSVGElement;
      if (!svg || !bigEnough(svg)) return null;
      const r = svg.getBoundingClientRect();
      const label = svg.getAttribute('aria-label') || (svg.querySelector('title') || {}).textContent || '';
      return { el: svg, src: 'inline-svg', alt: label, w: Math.round(r.width), h: Math.round(r.height), makeInline: () => ({ data: svgToBase64(svg), mime: 'image/svg+xml' }) };
    }
    if (el instanceof HTMLCanvasElement) {
      if (!bigEnough(el)) return null;
      return { el, src: 'canvas', alt: '', w: el.width, h: el.height, makeInline: () => {
        let url;
        try { url = el.toDataURL('image/png'); } catch (_) { throw new Error('This canvas is protected by the page and cannot be saved.'); }
        return { data: url.slice(url.indexOf(',') + 1), mime: 'image/png' };
      } };
    }
    if (el instanceof HTMLVideoElement && el.poster && bigEnough(el)) {
      return { el, src: abs(el.poster), alt: el.title || '', w: el.videoWidth, h: el.videoHeight };
    }
    if (!(el instanceof Element) || el === document.documentElement || el === document.body) return null;
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none' && bigEnough(el)) {
      const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(bg);
      const r = el.getBoundingClientRect();
      // Small SVG data-URL backgrounds are almost always UI icons.
      if (m && m[2] && (!/^data:image\/svg/i.test(m[2]) || r.width >= 64)) {
        const src = abs(m[2]);
        if (src) return { el, src, alt: el.getAttribute('aria-label') || el.title || '', w: Math.round(r.width), h: Math.round(r.height), isBackground: true };
      }
    }
    return null;
  }

  // Everything under the point, top first, so images under transparent
  // overlays still count. `skip`: our own UI host element.
  function candidateAt(x, y, skip) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === skip) continue;
      const c = candidateFor(el);
      if (c) return c;
    }
    return null;
  }

  // The image being dragged, from a dragstart event. The browser starts a
  // drag on an <img> (target is the image), on a link wrapping one (target
  // is the <a>), or on something draggable placed over it.
  function candidateForDrag(e, skip) {
    const t = e.target;
    if (t instanceof Element) {
      const direct = candidateFor(t);
      if (direct) return direct;
      if (t.closest('a')) {
        const img = t.closest('a').querySelector('img');
        const c = img && candidateFor(img);
        if (c) return c;
      }
    }
    if (typeof e.clientX === 'number' && (e.clientX || e.clientY)) return candidateAt(e.clientX, e.clientY, skip);
    return null;
  }

  self.__markportShared = { send, candidateFor, candidateAt, candidateForDrag };
})();
