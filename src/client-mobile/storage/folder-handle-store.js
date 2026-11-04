/**
 * folder-handle-store.js — IndexedDB persistence for `folder` vaults'
 * `FileSystemDirectoryHandle` (picked via `showDirectoryPicker`, File System
 * Access API). Structured-clone lets a directory handle survive a reload
 * when stashed in IndexedDB — localStorage can't hold it (not
 * structured-cloneable to a string).
 *
 * Browser-only (indexedDB + FileSystemDirectoryHandle aren't available
 * under node:test/bun test) — plain IIFE, attaches to
 * window.__owFolderHandles. Must load before boot.js and in new-local.html
 * (see docs/plans/folder-vault.md §3ב/§3ד) so both are defined when needed.
 *
 * DB 'ow-folder-vaults', object store 'handles', key = vault id (same id
 * space as __owLocalVaults).
 */
(function () {
  'use strict';

  var DB_NAME = 'ow-folder-vaults';
  var STORE_NAME = 'handles';
  var DB_VERSION = 1;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function saveHandle(id, dirHandle) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(dirHandle, id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function loadHandle(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readonly');
        var req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  window.__owFolderHandles = { saveHandle: saveHandle, loadHandle: loadHandle };
})();
