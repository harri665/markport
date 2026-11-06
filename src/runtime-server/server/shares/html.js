/**
 * Page shells for share pages, the share password prompt and the owner login.
 * No JavaScript anywhere: these pages are served with `script-src 'none'`.
 */

'use strict';

const { escapeHtml } = require('./render');
const { ShareStore } = require('./store');

const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: https: http:",
  "media-src 'self'",
  "font-src 'self' data: https:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function pageHeaders(res) {
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': PAGE_CSP,
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  });
}

function shell({ title, bodyClass = 'theme-dark', bodyStyle = '', head = '', body }) {
  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<link rel="stylesheet" href="/obsidian-mobile/app.css">' +
    head +
    '<link rel="stylesheet" href="/s/-/share.css">' +
    '</head><body class="' + escapeHtml(bodyClass) + '"' + (bodyStyle ? ' style="' + escapeHtml(bodyStyle) + '"' : '') + '>' +
    body + '</body></html>';
}

function messagePage(title, message, { form = '' } = {}) {
  return shell({
    title,
    bodyClass: 'theme-dark mp-share-page',
    body: '<div class="mp-card"><h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(message) + '</p>' + form + '</div>',
  });
}

function unlockPage(share, next, error) {
  const form = '<form method="post" action="' + escapeHtml(ShareStore.basePath(share)) + '/unlock" class="mp-form">' +
    '<input type="hidden" name="next" value="' + escapeHtml(next) + '">' +
    '<label>Password<input type="password" name="password" autocomplete="current-password" autofocus required></label>' +
    (error ? '<p class="mp-error">' + escapeHtml(error) + '</p>' : '') +
    '<button type="submit" class="mod-cta">Open</button></form>';
  return messagePage('Password required', 'This shared link is protected. Enter the password you were given.', { form });
}

function loginPage(next, error) {
  const form = '<form method="post" action="/login" class="mp-form">' +
    '<input type="hidden" name="next" value="' + escapeHtml(next || '/') + '">' +
    '<label>Password<input type="password" name="password" autocomplete="current-password" autofocus required></label>' +
    (error ? '<p class="mp-error">' + escapeHtml(error) + '</p>' : '') +
    '<button type="submit" class="mod-cta">Log in</button></form>';
  return messagePage('Markport', 'Log in to open your vaults.', { form });
}

module.exports = { shell, messagePage, unlockPage, loginPage, pageHeaders, PAGE_CSP };
