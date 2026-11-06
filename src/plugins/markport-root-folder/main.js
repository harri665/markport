'use strict';

/**
 * Markport - Root Folder.
 *
 * Right-click a folder -> "Set as root folder": the file explorer shows that
 * folder's contents as its top level, with a bar above the tree that names
 * the folder and has "up one level" and "show whole vault" buttons. This only
 * changes the view. The vault, search, links and the quick switcher still
 * cover everything.
 *
 * "Temporary" means sessionStorage: the choice survives a reload of the same
 * tab and is gone when the tab closes. Each vault keeps its own value.
 *
 * How it works, without touching app.js: FileExplorerView.sort() builds the
 * top level of the tree from `this.getSortedFolderItems(vault.getRoot())`,
 * and each folder item's own sort() calls the same method with its folder.
 * We shadow that method on the view instance:
 *   - root           -> the chosen folder's children (they become top level)
 *   - chosen folder  -> [] (its item is hidden, so its children aren't owned twice)
 *   - anything else  -> unchanged
 * The methods are looked up by name, which is the plugin-facing surface of the
 * explorer, not the minified code. If a future Obsidian renames them, the
 * plugin does nothing rather than breaking the explorer.
 *
 * While a root folder is set, a new note or folder that would have gone to
 * the vault root (explorer buttons, empty-area right-click, "default location
 * for new notes" = vault root) goes into the chosen folder instead.
 */

const obsidian = require('obsidian');

const KEY_PREFIX = 'obsidian-web:markport-root-folder:';

class RootFolderPlugin extends obsidian.Plugin {
  async onload() {
    this.rootPath = null;     // path of the folder shown as root, or null
    this.patched = new Map(); // FileExplorerView -> { bar, restore }

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof obsidian.TFolder)) return;
      if (!file.isRoot() && file.path !== this.rootPath) {
        menu.addItem((item) => item
          .setTitle('Set as root folder')
          .setIcon('folder-input')
          .setSection('view')
          .onClick(() => this.setRoot(file.path)));
      }
      if (this.rootPath) {
        menu.addItem((item) => item
          .setTitle('Show whole vault')
          .setIcon('folder-tree')
          .setSection('view')
          .onClick(() => this.setRoot(null)));
      }
    }));

    this.addCommand({
      id: 'set-root-to-active-folder',
      name: "Set root folder to the current note's folder",
      checkCallback: (checking) => {
        const parent = this.app.workspace.getActiveFile()?.parent;
        if (!parent || parent.isRoot()) return false;
        if (!checking) this.setRoot(parent.path);
        return true;
      },
    });
    this.addCommand({
      id: 'clear-root-folder',
      name: 'Show whole vault in the file explorer',
      checkCallback: (checking) => {
        if (!this.rootPath) return false;
        if (!checking) this.setRoot(null);
        return true;
      },
    });

    // Keep the choice valid when its folder moves or disappears.
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!this.rootPath || !(file instanceof obsidian.TFolder)) return;
      if (oldPath === this.rootPath || this.rootPath.startsWith(oldPath + '/')) {
        this.setRoot(file.path + this.rootPath.slice(oldPath.length));
      }
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (!this.rootPath || !(file instanceof obsidian.TFolder)) return;
      if (file.path === this.rootPath || this.rootPath.startsWith(file.path + '/')) this.setRoot(null);
    }));

    // New notes: "vault root" means the chosen folder for this session.
    const fm = this.app.fileManager;
    if (typeof fm.getNewFileParent === 'function') {
      const orig = fm.getNewFileParent;
      const plugin = this;
      fm.getNewFileParent = function (...args) {
        const parent = orig.apply(this, args);
        return parent && parent.isRoot && parent.isRoot() ? (plugin.getRootFolder() || parent) : parent;
      };
      this.register(() => { if (fm.getNewFileParent !== orig) fm.getNewFileParent = orig; });
    }

    this.app.workspace.onLayoutReady(() => {
      const saved = sessionStorage.getItem(this.storageKey());
      this.rootPath = saved && this.app.vault.getAbstractFileByPath(saved) instanceof obsidian.TFolder ? saved : null;
      if (!this.rootPath) sessionStorage.removeItem(this.storageKey());
      this.syncViews();
      // A file explorer opened later (or re-created by a layout change).
      this.registerEvent(this.app.workspace.on('layout-change', () => this.syncViews()));
    });
  }

  onunload() {
    for (const view of [...this.patched.keys()]) this.unpatch(view);
  }

  storageKey() {
    return KEY_PREFIX + this.app.vault.getName();
  }

  getRootFolder() {
    if (!this.rootPath) return null;
    const f = this.app.vault.getAbstractFileByPath(this.rootPath);
    return f instanceof obsidian.TFolder ? f : null;
  }

  setRoot(path) {
    this.rootPath = path || null;
    if (this.rootPath) sessionStorage.setItem(this.storageKey(), this.rootPath);
    else sessionStorage.removeItem(this.storageKey());
    this.syncViews();
  }

  explorerViews() {
    return this.app.workspace.getLeavesOfType('file-explorer')
      .map((leaf) => leaf.view)
      .filter((v) => v && typeof v.getSortedFolderItems === 'function' && typeof v.sort === 'function');
  }

  // Patch every open explorer while a root is set, unpatch otherwise, and resort.
  syncViews() {
    const views = this.explorerViews();
    for (const view of [...this.patched.keys()]) {
      if (!views.includes(view)) this.unpatch(view);
    }
    for (const view of views) {
      if (this.rootPath) {
        if (!this.patched.has(view)) this.patch(view);
        this.renderBar(view);
      } else if (this.patched.has(view)) {
        this.unpatch(view);
      }
      this.resort(view);
    }
  }

  resort(view) {
    // sort() rebuilds the tree from getSortedFolderItems, as long as the view is ready.
    if (view.ready === false) return;
    try { view.sort(); } catch (e) { console.error('[markport-root-folder] resort failed', e); }
  }

  patch(view) {
    const plugin = this;
    const shadowed = [];
    const shadow = (name, wrap) => {
      if (typeof view[name] !== 'function') return;
      const own = Object.prototype.hasOwnProperty.call(view, name);
      const orig = view[name];
      view[name] = wrap(orig);
      shadowed.push(() => { if (own) view[name] = orig; else delete view[name]; });
    };

    shadow('getSortedFolderItems', (orig) => function (folder, ...rest) {
      const root = plugin.getRootFolder();
      if (root && folder) {
        if (folder.isRoot && folder.isRoot()) return orig.call(this, root, ...rest);
        if (folder === root) return [];
      }
      return orig.call(this, folder, ...rest);
    });

    // Right-click on the empty part of the tree targets the vault root; show the
    // menu for the chosen folder, so "New note" etc. land inside it.
    shadow('onFileContextMenu', (orig) => function (evt, file, ...rest) {
      const root = plugin.getRootFolder();
      if (root && file && file.isRoot && file.isRoot()) file = root;
      return orig.call(this, evt, file, ...rest);
    });

    // The "New folder" button passes no parent and nothing is focused -> vault root.
    shadow('createAbstractFile', (orig) => function (type, parent, ...rest) {
      const root = plugin.getRootFolder();
      if (root && (parent == null || (parent.isRoot && parent.isRoot())) && !this.tree?.focusedItem) parent = root;
      return orig.call(this, type, parent, ...rest);
    });

    const bar = createDiv({ cls: 'markport-root-folder-bar' });
    const container = view.navFileContainerEl;
    if (container && container.parentElement) container.parentElement.insertBefore(bar, container);

    this.patched.set(view, {
      bar,
      restore: () => { for (const undo of shadowed) undo(); bar.remove(); },
    });
  }

  unpatch(view) {
    const entry = this.patched.get(view);
    if (!entry) return;
    entry.restore();
    this.patched.delete(view);
    this.resort(view);
  }

  renderBar(view) {
    const entry = this.patched.get(view);
    if (!entry) return;
    const bar = entry.bar;
    bar.empty();
    const root = this.getRootFolder();
    if (!root) return;

    const up = bar.createDiv({ cls: 'clickable-icon markport-root-folder-btn', attr: { 'aria-label': 'Up one level' } });
    obsidian.setIcon(up, 'arrow-up');
    up.addEventListener('click', () => {
      const parent = root.parent;
      this.setRoot(parent && !parent.isRoot() ? parent.path : null);
    });

    const label = bar.createDiv({ cls: 'markport-root-folder-label', attr: { 'aria-label': root.path } });
    obsidian.setIcon(label.createSpan({ cls: 'markport-root-folder-icon' }), 'folder-open');
    label.createSpan({ cls: 'markport-root-folder-name', text: root.name });
    // Right-click the bar for the folder's own menu (rename, new note, ...).
    label.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      if (typeof view.onFileContextMenu === 'function') {
        view.onFileContextMenu(evt, root);
        return;
      }
      const menu = new obsidian.Menu();
      this.app.workspace.trigger('file-menu', menu, root, 'file-explorer-context-menu', view.leaf);
      menu.showAtMouseEvent(evt);
    });

    const close = bar.createDiv({ cls: 'clickable-icon markport-root-folder-btn', attr: { 'aria-label': 'Show whole vault' } });
    obsidian.setIcon(close, 'x');
    close.addEventListener('click', () => this.setRoot(null));
  }
}

module.exports = RootFolderPlugin;
