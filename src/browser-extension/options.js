'use strict';

const { DEFAULT_ORIGINS, normalizeOrigin, normalizeKey } = self.MarkportLib;
const originsBox = document.getElementById('origins');
const keysBox = document.getElementById('keys');
const dragBox = document.getElementById('dragPopup');
const status = document.getElementById('status');
const found = document.getElementById('found');

function lines(box) {
  return box.value.split('\n').map((s) => s.trim()).filter(Boolean);
}

function say(text, isError) {
  status.className = isError ? 'err' : '';
  status.textContent = text;
  if (!isError) setTimeout(() => { if (status.textContent === text) status.textContent = ''; }, 2500);
}

Promise.all([
  chrome.storage.sync.get({ origins: DEFAULT_ORIGINS, dragPopup: true }),
  chrome.storage.local.get({ desktopKeys: [] }),
]).then(([{ origins, dragPopup }, { desktopKeys }]) => {
  originsBox.value = origins.join('\n');
  keysBox.value = desktopKeys.join('\n');
  dragBox.checked = dragPopup !== false;
});

document.getElementById('save').addEventListener('click', async () => {
  const badOrigins = lines(originsBox).filter((s) => !normalizeOrigin(s));
  if (badOrigins.length) return say('Not a web address: ' + badOrigins.join(', '), true);
  const badKeys = lines(keysBox).filter((s) => !normalizeKey(s));
  if (badKeys.length) return say('A pairing key is 48 characters, 0-9 and a-f: ' + badKeys.map((k) => k.slice(0, 12) + '...').join(', '), true);

  const origins = [...new Set(lines(originsBox).map(normalizeOrigin))];
  const keys = [...new Set(lines(keysBox).map(normalizeKey))];
  const finalOrigins = origins.length ? origins : DEFAULT_ORIGINS;
  await chrome.storage.sync.set({ origins: finalOrigins, dragPopup: dragBox.checked });
  // Keys stay on this device: storage.local, not synced.
  await chrome.storage.local.set({ desktopKeys: keys });
  originsBox.value = finalOrigins.join('\n');
  keysBox.value = keys.join('\n');
  say('Saved');
});

function item(cls, text, detail) {
  const li = document.createElement('li');
  li.className = cls;
  li.append(text);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'detail';
    d.textContent = ' - ' + detail;
    li.append(d);
  }
  return li;
}

document.getElementById('check').addEventListener('click', async () => {
  found.textContent = '';
  found.append(item('', 'Looking\u2026 Waking a sleeping Markport tab takes a few seconds.'));
  let r;
  try {
    // The background worker bounds every lookup, but don't trust that alone.
    r = await Promise.race([
      chrome.runtime.sendMessage({ type: 'targets' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('The extension did not answer within 45 s. Reload it on the extensions page and try again.')), 45000)),
    ]);
    if (!r) throw new Error('The extension did not answer.');
    if (!r.ok) throw new Error(r.error);
  } catch (e) {
    found.textContent = '';
    found.append(item('err', String((e && e.message) || e)));
    return;
  }
  const { vaults, selected, checks, message } = r.value;
  found.textContent = '';
  if (vaults.length) {
    found.append(item('head', 'Vaults you can save to'));
    for (const v of vaults) {
      found.append(item('ok', v.label, 'saving to ' + (v.target || '/') + (v.id === selected ? ' (selected)' : '')));
    }
  } else {
    found.append(item('err', message));
  }
  found.append(item('head', 'What was checked'));
  for (const c of checks || []) found.append(item(c.ok ? 'ok' : 'bad', c.where, c.detail));
});
