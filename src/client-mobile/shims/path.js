/**
 * Browser implementation of Node's `path` module (POSIX flavour).
 *
 * Obsidian expects join, resolve, basename, dirname, extname, relative,
 * normalize, isAbsolute, sep, parse. We implement the subset it actually
 * uses; everything else throws so we discover gaps loudly.
 */
(function (global) {
  function normalizeArray(parts, allowAboveRoot) {
    const res = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || p === '.') continue;
      if (p === '..') {
        if (res.length && res[res.length - 1] !== '..') res.pop();
        else if (allowAboveRoot) res.push('..');
      } else {
        res.push(p);
      }
    }
    return res;
  }

  function normalize(p) {
    if (typeof p !== 'string') throw new TypeError('path must be a string');
    const isAbsolute = p.charCodeAt(0) === 47; // '/'
    const trailingSlash = p.charCodeAt(p.length - 1) === 47;
    let parts = normalizeArray(p.split('/'), !isAbsolute);
    let result = parts.join('/');
    if (!result && !isAbsolute) result = '.';
    if (result && trailingSlash) result += '/';
    return (isAbsolute ? '/' : '') + result;
  }

  function join() {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) {
      const seg = arguments[i];
      if (typeof seg !== 'string') throw new TypeError('path.join: arguments must be strings');
      if (seg) parts.push(seg);
    }
    return normalize(parts.join('/'));
  }

  function resolve() {
    let resolvedPath = '';
    let resolvedAbsolute = false;
    for (let i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
      const p = i >= 0 ? arguments[i] : '/';
      if (typeof p !== 'string') throw new TypeError('path.resolve: arguments must be strings');
      if (!p) continue;
      resolvedPath = p + '/' + resolvedPath;
      resolvedAbsolute = p.charCodeAt(0) === 47;
    }
    resolvedPath = normalizeArray(resolvedPath.split('/'), !resolvedAbsolute).join('/');
    return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
  }

  function basename(p, ext) {
    if (typeof p !== 'string') throw new TypeError('path must be a string');
    const idx = p.lastIndexOf('/');
    let base = idx === -1 ? p : p.slice(idx + 1);
    if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
    return base;
  }

  function dirname(p) {
    if (typeof p !== 'string') throw new TypeError('path must be a string');
    if (!p) return '.';
    const idx = p.lastIndexOf('/');
    if (idx === -1) return '.';
    if (idx === 0) return '/';
    return p.slice(0, idx);
  }

  function extname(p) {
    if (typeof p !== 'string') throw new TypeError('path must be a string');
    const idx = p.lastIndexOf('.');
    const slash = p.lastIndexOf('/');
    if (idx <= slash + 1) return '';
    return p.slice(idx);
  }

  function relative(from, to) {
    from = resolve(from);
    to = resolve(to);
    if (from === to) return '';
    const fromParts = from.slice(1).split('/');
    const toParts = to.slice(1).split('/');
    let i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
    const up = fromParts.slice(i).map(() => '..');
    return up.concat(toParts.slice(i)).join('/');
  }

  function isAbsolute(p) {
    return typeof p === 'string' && p.charCodeAt(0) === 47;
  }

  function parse(p) {
    if (typeof p !== 'string') throw new TypeError('path must be a string');
    const root = isAbsolute(p) ? '/' : '';
    const dir = dirname(p);
    const base = basename(p);
    const ext = extname(base);
    const name = ext ? base.slice(0, -ext.length) : base;
    return { root, dir, base, name, ext };
  }

  const posix = {
    sep: '/',
    delimiter: ':',
    normalize, join, resolve, basename, dirname, extname,
    relative, isAbsolute, parse,
  };
  posix.posix = posix;
  posix.win32 = posix; // we don't support windows-style paths in the browser

  global.__owPath = posix;
})(window);
