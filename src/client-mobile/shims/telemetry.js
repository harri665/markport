/**
 * Sync-call telemetry.
 *
 * Records every synchronous XHR made by the shims so we can see exactly
 * which calls happen, when, and how long they take.  Useful for planning
 * the pre-load/bootstrap cache (Phase 2).
 *
 * Usage (from DevTools console):
 *
 *   __owTelemetry.summary()   // grouped counts + total time
 *   __owTelemetry.dump()      // full call log as JSON string
 *   __owTelemetry.save()      // write to localStorage 'obsidian-web:telemetry'
 *   __owTelemetry.load()      // read back from localStorage
 *   __owTelemetry.clear()     // wipe in-memory log
 *   __owTelemetry.table()     // console.table of all calls (pretty)
 */
(function (global) {
  const T0 = performance.now();   // page-load baseline
  const calls = [];               // in-memory ring buffer (unbounded for now)

  /**
   * Record one sync call.  Called by sync-http.js.
   *
   * @param {string} method   HTTP verb
   * @param {string} url      full URL passed to XHR
   * @param {number} duration milliseconds the call blocked
   * @param {number} status   HTTP status code
   * @param {number} size     response byte length
   */
  function record(method, url, duration, status, size) {
    // Extract semantic label from URL path.
    // e.g. /api/fs/read?vault=…&path=.obsidian/app.json  → { api:'fs', op:'read', arg:'.obsidian/app.json' }
    let label = url;
    let arg = '';
    try {
      const u = new URL(url, location.href);
      const parts = u.pathname.replace(/^\//, '').split('/');
      // /api/fs/read  → "fs.read"
      // /api/electron/vault → "electron.vault"
      if (parts[0] === 'api' && parts.length >= 3) {
        label = parts[1] + '.' + parts[2];
      } else {
        label = parts.join('.');
      }
      // Most useful arg: path for fs calls, channel for electron calls.
      arg = u.searchParams.get('path') || '';
      // For electron calls the meaningful info is already in the label,
      // but vault param helps distinguish which vault was queried.
      if (!arg && parts[1] === 'electron') {
        arg = u.searchParams.get('vault') ? '(vault=' + u.searchParams.get('vault').slice(0, 8) + '…)' : '';
      }
    } catch (_) { /* keep raw url */ }

    calls.push({
      seq:      calls.length + 1,
      ms:       Math.round(performance.now() - T0),  // ms since page load
      label,
      method,
      url,
      arg,
      duration: Math.round(duration * 100) / 100,    // 2 decimal places
      status,
      size,
    });
  }

  function summary() {
    const groups = {};
    for (const c of calls) {
      const k = c.label;
      if (!groups[k]) groups[k] = { count: 0, totalMs: 0, paths: new Set() };
      groups[k].count++;
      groups[k].totalMs += c.duration;
      if (c.arg) groups[k].paths.add(c.arg);
    }

    const rows = Object.entries(groups)
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .map(([label, g]) => ({
        label,
        count:     g.count,
        totalMs:   Math.round(g.totalMs * 10) / 10,
        avgMs:     Math.round(g.totalMs / g.count * 10) / 10,
        uniquePaths: g.paths.size,
      }));

    const grand = calls.reduce((s, c) => s + c.duration, 0);
    console.group('[obsidian-web] Sync call summary — ' + calls.length + ' calls, ' + Math.round(grand) + 'ms total blocked');
    console.table(rows);
    console.groupEnd();
    return rows;
  }

  function table() {
    console.table(calls.map(c => ({
      '#':    c.seq,
      't+ms': c.ms,
      label:  c.label,
      arg:    c.arg.slice(0, 60),
      dur:    c.duration,
      status: c.status,
      bytes:  c.size,
    })));
  }

  function dump() {
    return JSON.stringify(calls, null, 2);
  }

  function save() {
    try {
      localStorage.setItem('obsidian-web:telemetry', dump());
      console.log('[obsidian-web] telemetry saved to localStorage (' + calls.length + ' calls)');
    } catch (e) {
      console.error('[obsidian-web] telemetry save failed:', e.message);
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem('obsidian-web:telemetry');
      if (!raw) { console.warn('[obsidian-web] no telemetry in localStorage'); return null; }
      return JSON.parse(raw);
    } catch (e) {
      console.error('[obsidian-web] telemetry load failed:', e.message);
      return null;
    }
  }

  function clear() {
    calls.length = 0;
    console.log('[obsidian-web] telemetry cleared');
  }

  global.__owTelemetry = { record, summary, table, dump, save, load, clear };
})(window);
