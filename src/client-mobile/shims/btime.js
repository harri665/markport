/**
 * Stub for Obsidian's custom `btime` module.
 *
 * btime exposes file birthtime/mtime helpers. Our fs shim already returns
 * these in stats results, so the module's job in the browser is trivial.
 * If Obsidian calls into it, we no-op and let the stat-based timestamps
 * win.
 */
(function (global) {
  global.__owBtime = {
    btime: () => null,
    btimeSync: () => null,
    setBtime: (_p, _t, cb) => cb && cb(null),
    setBtimeSync: () => {},
  };
})(window);
