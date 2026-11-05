/**
 * Markport Clipper - drag an image, drop it on a folder.
 *
 * A content script on every page (after find-image.js and menu.js). It does
 * nothing until a drag starts on an image; then the folder menu (menu.js)
 * opens beside the pointer. Dropping the image on a folder saves it there.
 * Dropping anywhere else (or Esc) does whatever the page or the drop target
 * would normally do - the drag itself is never changed.
 *
 * Off in Markport/Obsidian itself (dragging is how you move files there),
 * and when "Folder menu when dragging" is unchecked in Options.
 */
(() => {
  'use strict';

  if (self.__markportDrag || window.top !== window) return;
  self.__markportDrag = true;

  const { candidateForDrag } = self.__markportShared;
  const { DEFAULT_ORIGINS, normalizeOrigin } = self.MarkportLib;
  const menu = self.__markportMenu;

  let enabled = true;
  let skipOrigin = false;

  function applySettings(s) {
    enabled = s.dragPopup !== false;
    const origins = (Array.isArray(s.origins) ? s.origins : DEFAULT_ORIGINS).map(normalizeOrigin);
    skipOrigin = origins.includes(location.origin);
  }
  const load = () => chrome.storage.sync.get({ dragPopup: true, origins: DEFAULT_ORIGINS }).then(applySettings).catch(() => {});
  load();
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'sync') load(); });

  // Obsidian's own window (Markport on an address not in Options).
  function isObsidian() {
    return !!document.querySelector('body > .app-container .workspace');
  }

  let dragging = false;
  let hideTimer = null;

  window.addEventListener('dragstart', (e) => {
    if (!enabled || skipOrigin || menu.isNaming()) return;
    if (menu.contains(e)) return;
    if (window.__markportPicker && window.__markportPicker.active()) return;
    if (isObsidian()) return;
    const c = candidateForDrag(e, menu.element());
    if (!c) return;
    clearTimeout(hideTimer);
    dragging = true;
    const size = c.w && c.h ? c.w + ' × ' + c.h + ' · ' : '';
    menu.open({
      x: e.clientX,
      y: e.clientY,
      mode: 'drop',
      title: 'Save Image',
      sub: size + 'Drop on a folder',
      onPick: (vault, folder) => menu.save(vault, folder, c),
    });
  }, true);

  window.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging = false;
    // Let a drop handler run first; keep the menu if it asked for a name.
    hideTimer = setTimeout(() => { if (!menu.isNaming()) menu.close(); }, 60);
  }, true);
})();
