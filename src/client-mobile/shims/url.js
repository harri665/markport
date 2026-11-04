/**
 * Browser shim for Node's `url` module.
 *
 * Obsidian uses pathToFileURL and fileURLToPath. We back them with the
 * standard URL constructor.
 */
(function (global) {
  global.__owUrl = {
    pathToFileURL(p) {
      return new URL('file://' + (p.startsWith('/') ? p : '/' + p));
    },
    fileURLToPath(u) {
      const url = typeof u === 'string' ? new URL(u) : u;
      if (url.protocol !== 'file:') throw new TypeError('not a file: URL');
      return decodeURIComponent(url.pathname);
    },
    URL,
    URLSearchParams,
    parse: (s) => {
      try {
        const u = new URL(s, 'http://x');
        return {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port,
          pathname: u.pathname,
          search: u.search,
          hash: u.hash,
          href: u.href,
        };
      } catch (_) {
        return { href: s };
      }
    },
    format: (o) => o.href || '',
  };
})(window);
