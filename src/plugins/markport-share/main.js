'use strict';

/**
 * Markport - Share.
 *
 * Adds "Share link…" to the file menu of notes and folders (and a command for the
 * current note). A share is a link, /s/<id>, that shows the note or folder as
 * a static page; with "Can edit" the page also offers "Open in editor", a full
 * Obsidian editor that can reach only that note or folder. Links can have a
 * password and an expiry date, and can be revoked at any time.
 *
 * The server does the enforcing (src/runtime-server/server/shares/); this
 * plugin is only the owner's UI for /api/shares. It runs only in server
 * vaults - browser-storage and local-folder vaults live in one browser, so
 * there is nothing another person could open.
 */

const obsidian = require('obsidian');

function isServerVault() {
  return typeof window.__owPlatform !== 'undefined' && window.__owVaultType === 'server' && !!window.__owVaultId;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
  return json;
}

function shareUrl(share) {
  return window.location.origin + share.url;
}

// Obsidian's mobile app adds its own "Share" (the phone's share sheet) to
// file menus. In a browser there is nothing behind it - clicking it does
// nothing - and next to "Share link…" it reads like the broken version of it.
// Found by section + icon, not by its title, which is translated.
function removeNativeShare(menu) {
  const items = (menu && menu.items) || [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const svg = it.iconEl && it.iconEl.querySelector && it.iconEl.querySelector('svg');
    if (it.section === 'system' && svg && svg.classList.contains('lucide-arrow-up-right')) {
      items.splice(i, 1);
      if (it.dom) it.dom.remove();
    }
  }
}

function sharePath(file) {
  return !file.path || file.path === '/' ? '' : file.path;
}

function describe(share) {
  const bits = [share.permission === 'edit' ? 'Can edit' : 'View only'];
  if (share.hasPassword) bits.push('password');
  if (share.expiresAt) bits.push((share.expired ? 'expired ' : 'expires ') + new Date(share.expiresAt).toLocaleDateString());
  if (share.missing) bits.push('item missing');
  return bits.join(' · ');
}

// Copy text, returning whether it worked. navigator.clipboard only exists on
// https:// and localhost (not on http://<LAN address>), and can hang or
// refuse without focus, so fall back to the old execCommand route.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
      ]);
      return true;
    } catch (_) { /* fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}

async function copyLink(share) {
  const ok = await copyText(shareUrl(share));
  new obsidian.Notice(ok ? 'Link copied' : 'Could not copy automatically - copy the link from the dialog.');
  return ok;
}

// The link itself, visible and selectable - never only on the clipboard.
function renderLinkBox(containerEl, share) {
  const box = containerEl.createDiv({ cls: 'markport-share-linkbox' });
  const input = box.createEl('input', { type: 'text', cls: 'markport-share-url' });
  input.value = shareUrl(share);
  input.readOnly = true;
  input.addEventListener('focus', () => input.select());
  const copy = box.createEl('button', { text: 'Copy' });
  copy.addEventListener('click', async () => { input.select(); await copyLink(share); });
  return input;
}

// One row per share, with Copy / Open / Revoke.
function renderShareList(containerEl, shares, { showPath, onChange }) {
  containerEl.empty();
  if (!shares.length) {
    containerEl.createEl('p', { cls: 'markport-share-empty', text: 'No links yet.' });
    return;
  }
  for (const share of shares) {
    const setting = new obsidian.Setting(containerEl)
      .setName(showPath ? (share.path || '(whole vault)') : describe(share))
      .setDesc(showPath ? describe(share) : 'Created ' + new Date(share.createdAt).toLocaleString());
    setting.descEl.createDiv({ cls: 'markport-share-rowurl', text: shareUrl(share) });
    if (share.expired || share.missing) setting.settingEl.addClass('markport-share-inactive');
    setting.addExtraButton((b) => b.setIcon('copy').setTooltip('Copy link').onClick(() => copyLink(share)));
    setting.addExtraButton((b) => b.setIcon('external-link').setTooltip('Open').onClick(() => window.open(shareUrl(share), '_blank', 'noopener')));
    setting.addExtraButton((b) => b.setIcon('pencil').setTooltip('Change custom link').onClick(() => {
      new CustomLinkModal(window.app, share, onChange).open();
    }));
    setting.addExtraButton((b) => b.setIcon('trash-2').setTooltip('Revoke').onClick(async () => {
      try {
        await api('DELETE', '/api/shares/' + encodeURIComponent(share.id));
        new obsidian.Notice('Link revoked');
        onChange();
      } catch (err) {
        new obsidian.Notice('Could not revoke: ' + err.message);
      }
    }));
  }
}

// What the server will make of a typed custom link (it normalises the same
// way), for the live preview. Validation itself stays on the server.
function previewSlug(input) {
  return String(input || '').trim().toLowerCase().replace(/\s+/g, '-');
}

const SLUG_HINT = 'Letters, digits, "-" and "_". Easy to guess, unlike the random link - add a password for anything private.';

// Adds a "Custom link" text setting; onChange gets the raw text.
function addCustomLinkSetting(containerEl, value, onChange) {
  const setting = new obsidian.Setting(containerEl).setName('Custom link');
  const preview = () => {
    const slug = previewSlug(text.getValue());
    setting.setDesc(slug ? window.location.origin + '/s/' + slug : 'Optional. Without one the link uses a random id.');
  };
  let text;
  setting.addText((t) => {
    text = t;
    t.setPlaceholder('e.g. project-alpha').setValue(value || '').onChange((v) => { onChange(v); preview(); });
  });
  preview();
  setting.descEl.parentElement.createDiv({ cls: 'setting-item-description markport-share-slughint', text: SLUG_HINT });
  return setting;
}

class CustomLinkModal extends obsidian.Modal {
  constructor(app, share, onSaved) {
    super(app);
    this.share = share;
    this.onSaved = onSaved;
    this.slug = share.slug || '';
  }

  onOpen() {
    this.titleEl.setText('Custom link');
    this.contentEl.createEl('p', { cls: 'markport-share-hint', text: 'Changing or removing it stops the old custom link working. The random link always keeps working.' });
    addCustomLinkSetting(this.contentEl, this.slug, (v) => { this.slug = v; });
    new obsidian.Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Remove custom link').setDisabled(!this.share.slug).onClick(() => this.save(null)))
      .addButton((b) => b.setButtonText('Save').setCta().onClick(() => this.save(this.slug)));
  }

  async save(slug) {
    try {
      const res = await api('PATCH', '/api/shares/' + encodeURIComponent(this.share.id), { slug: slug ? slug : null });
      new obsidian.Notice(res.share.slug ? 'Custom link saved' : 'Custom link removed');
      this.close();
      this.onSaved();
    } catch (err) {
      new obsidian.Notice('Could not save: ' + err.message);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

function authWarning(containerEl) {
  const el = containerEl.createDiv({ cls: 'markport-share-warning' });
  el.setText('This server has no owner password (MARKPORT_PASSWORD), so anyone who can open the site can already open every vault. ' +
    'Share links are still limited to what you share, but set a password before sending links outside your network.');
}

class ShareModal extends obsidian.Modal {
  constructor(app, file) {
    super(app);
    this.file = file;
    this.isFolder = file instanceof obsidian.TFolder;
    this.permission = 'view';
    this.password = '';
    this.expires = '';
    this.slug = '';
  }

  async onOpen() {
    const name = sharePath(this.file) ? this.file.name.replace(/\.md$/i, '') : this.app.vault.getName();
    this.titleEl.setText('Share ' + (this.isFolder ? 'folder' : 'note') + ' "' + name + '"');
    this.contentEl.addClass('markport-share-modal');
    this.warningEl = this.contentEl.createDiv();
    this.contentEl.createEl('p', {
      cls: 'markport-share-hint',
      text: this.isFolder
        ? 'People with the link can see this folder and everything in it, and nothing else in your vault.'
        : 'People with the link can see this note, and the images and files it embeds, and nothing else in your vault.',
    });

    this.contentEl.createEl('h4', { text: 'New link' });
    new obsidian.Setting(this.contentEl)
      .setName('Access')
      .setDesc(this.isFolder ? '"Can edit" lets them create, edit, rename and delete notes inside this folder.' : '"Can edit" lets them edit this note.')
      .addDropdown((d) => d.addOption('view', 'View only').addOption('edit', 'Can edit').setValue(this.permission).onChange((v) => { this.permission = v; }));
    new obsidian.Setting(this.contentEl)
      .setName('Password')
      .setDesc('Optional. Recipients enter it once per browser.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.inputEl.autocomplete = 'new-password';
        t.setPlaceholder('No password').onChange((v) => { this.password = v; });
      });
    new obsidian.Setting(this.contentEl)
      .setName('Expires')
      .setDesc('Optional. The link stops working at the end of this day.')
      .addText((t) => {
        t.inputEl.type = 'date';
        const tomorrow = new Date(Date.now() + 86400000);
        t.inputEl.min = tomorrow.toISOString().slice(0, 10);
        t.onChange((v) => { this.expires = v; });
      });
    addCustomLinkSetting(this.contentEl, '', (v) => { this.slug = v; });
    new obsidian.Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Create link and copy').setCta().onClick(() => this.create(b)));
    this.createdEl = this.contentEl.createDiv();

    this.contentEl.createEl('h4', { text: 'Links to this ' + (this.isFolder ? 'folder' : 'note') });
    this.listEl = this.contentEl.createDiv({ cls: 'markport-share-list' });
    await this.refresh();
  }

  async refresh() {
    try {
      const res = await api('GET', '/api/shares?vault=' + encodeURIComponent(window.__owVaultId));
      this.warningEl.empty();
      if (!res.authEnabled) authWarning(this.warningEl);
      const mine = res.shares.filter((s) => s.path === sharePath(this.file));
      renderShareList(this.listEl, mine, { showPath: false, onChange: () => this.refresh() });
    } catch (err) {
      this.listEl.setText('Could not load links: ' + err.message);
    }
  }

  async create(button) {
    let expiresAt = null;
    if (this.expires) {
      const [y, m, d] = this.expires.split('-').map(Number);
      expiresAt = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
      if (!(expiresAt > Date.now())) { new obsidian.Notice('Pick a date in the future'); return; }
    }
    button.setDisabled(true);
    try {
      const res = await api('POST', '/api/shares', {
        vault: window.__owVaultId,
        path: sharePath(this.file),
        permission: this.permission,
        password: this.password || null,
        expiresAt,
        slug: this.slug.trim() || null,
      });
      this.createdEl.empty();
      this.createdEl.createEl('p', { cls: 'markport-share-hint', text: 'New link - send this to the people you want to share with:' });
      const input = renderLinkBox(this.createdEl, res.share);
      input.focus();
      input.select();
      await copyLink(res.share);
      await this.refresh();
    } catch (err) {
      new obsidian.Notice('Could not create link: ' + err.message);
    } finally {
      button.setDisabled(false);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class AllSharesModal extends obsidian.Modal {
  async onOpen() {
    this.titleEl.setText('Shared links in this vault');
    this.warningEl = this.contentEl.createDiv();
    this.listEl = this.contentEl.createDiv({ cls: 'markport-share-list' });
    await this.refresh();
  }

  async refresh() {
    try {
      const res = await api('GET', '/api/shares?vault=' + encodeURIComponent(window.__owVaultId));
      this.warningEl.empty();
      if (!res.authEnabled) authWarning(this.warningEl);
      renderShareList(this.listEl, res.shares, { showPath: true, onChange: () => this.refresh() });
    } catch (err) {
      this.listEl.setText('Could not load links: ' + err.message);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ShareSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const el = this.containerEl;
    el.empty();
    el.createEl('p', { text: 'Right-click a note or folder and choose "Share link…" to create a link.' });
    const warningEl = el.createDiv();
    el.createEl('h3', { text: 'Links in this vault' });
    const listEl = el.createDiv({ cls: 'markport-share-list' });
    const refresh = async () => {
      try {
        const res = await api('GET', '/api/shares?vault=' + encodeURIComponent(window.__owVaultId));
        warningEl.empty();
        if (!res.authEnabled) authWarning(warningEl);
        renderShareList(listEl, res.shares, { showPath: true, onChange: refresh });
      } catch (err) {
        listEl.setText('Could not load links: ' + err.message);
      }
    };
    await refresh();
    const status = await api('GET', '/api/auth/status').catch(() => null);
    if (status && status.authEnabled) {
      new obsidian.Setting(el)
        .setName('Log out')
        .setDesc('End your owner session in this browser.')
        .addButton((b) => b.setButtonText('Log out').onClick(() => { window.location.href = '/logout'; }));
    }
  }
}

module.exports = class MarkportSharePlugin extends obsidian.Plugin {
  onload() {
    if (!isServerVault()) return;

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      removeNativeShare(menu);
      const shareable = file instanceof obsidian.TFolder || (file instanceof obsidian.TFile && file.extension === 'md');
      if (!shareable) return;
      menu.addItem((item) => item
        .setTitle('Share link…')
        .setIcon('link')
        .setSection('action')
        .onClick(() => new ShareModal(this.app, file).open()));
    }));

    this.addCommand({
      id: 'share-current-note',
      name: 'Share current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) new ShareModal(this.app, file).open();
        return true;
      },
    });

    this.addCommand({
      id: 'share-current-folder',
      name: 'Share folder of current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !file.parent) return false;
        if (!checking) new ShareModal(this.app, file.parent).open();
        return true;
      },
    });

    this.addCommand({
      id: 'manage-shared-links',
      name: 'Manage shared links',
      callback: () => new AllSharesModal(this.app).open(),
    });

    this.addSettingTab(new ShareSettingTab(this.app, this));
  }
};
