/**
 * Browser shim for Node's `os` module.
 *
 * Obsidian uses os.tmpdir(), os.hostname(), os.version(), os.platform(),
 * os.homedir(), os.EOL.
 */
(function (global) {
  global.__owOs = {
    tmpdir: () => '/tmp',
    hostname: () => 'obsidian-web',
    version: () => 'web',
    release: () => 'web',
    platform: () => 'linux',
    arch: () => 'x64',
    homedir: () => '/home',
    type: () => 'Linux',
    EOL: '\n',
    cpus: () => [],
    totalmem: () => 0,
    freemem: () => 0,
    networkInterfaces: () => ({}),
    userInfo: () => ({ username: 'web', uid: 1000, gid: 1000, shell: '/bin/sh', homedir: '/home' }),
  };
})(window);
