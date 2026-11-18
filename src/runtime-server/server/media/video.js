'use strict';

/**
 * Re-encoding of uploaded videos with ffmpeg (media/index.js, /upload/finish
 * with `reencode`): H.264 video and AAC audio in the file's own container,
 * which every browser and Obsidian itself can play.
 *
 * Only an upload that asks for it is re-encoded, and only before it reaches
 * the vault: a file already in a vault is never rewritten.
 *
 *   MARKPORT_FFMPEG          path of the ffmpeg binary, or "false" to turn
 *                            re-encoding off (default: "ffmpeg" on the PATH)
 *   MARKPORT_VIDEO_CRF       quality, 18 (large) to 32 (small); default 26
 *   MARKPORT_VIDEO_PRESET    x264 preset, slower = smaller; default "medium"
 */

const { spawn, spawnSync } = require('child_process');

// Extension -> ffmpeg muxer. Only containers that hold H.264 + AAC, so the
// file keeps its name. (WebM would need VP9/Opus; AVI and others are left
// as they are.)
const CONTAINERS = { mp4: 'mp4', m4v: 'mp4', mov: 'mov', mkv: 'matroska' };

let ffmpegCmd;
function ffmpeg() {
  if (ffmpegCmd !== undefined) return ffmpegCmd;
  ffmpegCmd = null;
  if (process.env.MARKPORT_FFMPEG === 'false') return null;
  const cmd = process.env.MARKPORT_FFMPEG || 'ffmpeg';
  try {
    const r = spawnSync(cmd, ['-hide_banner', '-encoders'], { timeout: 10000, encoding: 'utf8' });
    if (r.status === 0 && /libx264/.test(r.stdout || '')) ffmpegCmd = cmd;
  } catch (_) { /* not there */ }
  return ffmpegCmd;
}

function extOf(rel) {
  const m = /\.([^./\\]+)$/.exec(String(rel || ''));
  return m ? m[1].toLowerCase() : '';
}

// The extensions this server re-encodes, or [] without ffmpeg.
function extensions() {
  return ffmpeg() ? Object.keys(CONTAINERS) : [];
}

function canReencode(rel) {
  return !!ffmpeg() && Object.prototype.hasOwnProperty.call(CONTAINERS, extOf(rel));
}

function settings(opts = {}) {
  const crf = parseInt(opts.crf != null ? opts.crf : process.env.MARKPORT_VIDEO_CRF, 10);
  const preset = String(opts.preset || process.env.MARKPORT_VIDEO_PRESET || 'medium');
  return {
    crf: crf >= 0 && crf <= 51 ? crf : 26,
    preset: /^[a-z]+$/.test(preset) ? preset : 'medium',
  };
}

/**
 * Re-encode `input` into `output`. `ext` picks the container (the input's
 * own). Rejects when ffmpeg fails; the caller then keeps the original.
 * opts.onProcess(child) receives the ffmpeg process, to stop it early.
 */
function reencode(input, output, ext, opts = {}) {
  const cmd = ffmpeg();
  const format = CONTAINERS[ext];
  if (!cmd || !format) return Promise.reject(new Error('cannot re-encode .' + ext));
  const s = settings(opts);
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-i', input,
    // The first video stream and every audio track; attached pictures,
    // data and subtitle streams a target container may refuse are left out.
    '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0',
    '-c:v', 'libx264', '-preset', s.preset, '-crf', String(s.crf), '-pix_fmt', 'yuv420p',
    // yuv420p needs even dimensions.
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:a', 'aac', '-b:a', '128k',
  ];
  if (format !== 'matroska') args.push('-movflags', '+faststart');
  args.push('-f', format, output);
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    if (opts.onProcess) opts.onProcess(p);
    let err = '';
    p.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
    p.on('error', reject);
    p.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg ' + (signal ? 'was stopped (' + signal + ')' : 'failed') + (err ? ': ' + err.trim().split('\n').pop() : '')));
    });
  });
}

module.exports = { ffmpeg, extensions, canReencode, reencode, extOf };
