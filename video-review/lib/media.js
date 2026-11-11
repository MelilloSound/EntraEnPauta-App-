'use strict';
/*
 * Optional ffmpeg helpers. The app works without ffmpeg (review, comments,
 * edits, Copy moments, AAF export via the browser); with ffmpeg installed it
 * can also render your edit to MP4, make playable previews of files the
 * browser can't play, and read media details more precisely.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout || 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

const FONT_CANDIDATES = {
  bold: [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  ],
  regular: [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
    'C:/Windows/Fonts/arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  ],
};

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [n, d] = String(r).split('/').map(Number);
  return d ? n / d : n;
}

class Media {
  constructor() {
    this.ffmpeg = null;
    this.ffprobe = null;
    this.version = null;
    this.drawtext = false;
    this.x264 = false;
    this.fonts = { bold: null, regular: null };
  }

  async detect() {
    if (process.env.VIDEO_REVIEW_NO_FFMPEG) return this.status(); // simulate a machine without ffmpeg (tests)
    const pick = async (name, envVar) => {
      const candidates = [process.env[envVar], name, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`].filter(Boolean);
      for (const c of candidates) {
        const r = await run(c, ['-version'], { timeout: 8000 });
        if (r.ok) return { cmd: c, version: r.stdout.split('\n')[0] };
      }
      return null;
    };
    const ff = await pick('ffmpeg', 'FFMPEG_PATH');
    const fp = await pick('ffprobe', 'FFPROBE_PATH');
    this.ffmpeg = ff && ff.cmd;
    this.version = ff && ff.version;
    this.ffprobe = fp && fp.cmd;
    if (this.ffmpeg) {
      const filters = await run(this.ffmpeg, ['-hide_banner', '-filters']);
      this.drawtext = /\bdrawtext\b/.test(filters.stdout);
      const encoders = await run(this.ffmpeg, ['-hide_banner', '-encoders']);
      this.x264 = /\blibx264\b/.test(encoders.stdout);
    }
    for (const k of ['bold', 'regular']) {
      this.fonts[k] = FONT_CANDIDATES[k].find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
    }
    return this.status();
  }

  status() {
    return {
      ffmpeg: !!this.ffmpeg,
      ffprobe: !!this.ffprobe,
      version: this.version,
      textInRenders: this.drawtext && !!(this.fonts.bold || this.fonts.regular),
    };
  }

  /** Media details: duration, size, frame rate, audio channels. */
  async probe(file) {
    if (!this.ffprobe) return null;
    const r = await run(this.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
    if (!r.ok) return { error: (r.stderr || 'Could not read this file').trim().split('\n').pop() };
    const j = JSON.parse(r.stdout || '{}');
    const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    const meta = { duration: parseFloat((j.format && j.format.duration) || (v && v.duration) || (a && a.duration) || 0) || 0 };
    if (v) {
      let w = v.width, h = v.height;
      const rot = Math.abs(parseInt((v.tags && v.tags.rotate) || ((v.side_data_list || []).find((d) => d.rotation != null) || {}).rotation || 0, 10)) % 180;
      if (rot === 90) [w, h] = [h, w];
      Object.assign(meta, {
        hasVideo: true, width: w, height: h,
        fps: Math.round((parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30) * 1000) / 1000,
        vcodec: v.codec_name,
      });
    }
    if (a) Object.assign(meta, { hasAudio: true, channels: a.channels || 2, sampleRate: parseInt(a.sample_rate, 10) || 48000, acodec: a.codec_name });
    else meta.channels = 0;
    return meta;
  }

  /**
   * Raw mono 24-bit PCM (48 kHz) of one channel, aligned to the start of the
   * file. With `piece` only that part, time-stretched to its speed.
   */
  audio(file, channel, piece, sampleRate = 48000) {
    const args = ['-v', 'error', '-nostdin'];
    // Half a second of extra source after a stretched piece, so the copy is never
    // shorter than the clip that uses it (time-stretching isn't sample-exact).
    if (piece) args.push('-ss', piece.in.toFixed(4), '-t', (piece.out - piece.in + 0.5 * piece.speed).toFixed(4));
    args.push('-i', file, '-map', '0:a:0', '-vn');
    const filters = [`aresample=${sampleRate}:async=1:first_pts=0`, `pan=mono|c0=c${channel}`];
    if (piece && Math.abs(piece.speed - 1) > 1e-3) filters.push(...atempoChain(piece.speed));
    args.push('-af', filters.join(','), '-ar', String(sampleRate), '-c:a', 'pcm_s24le', '-f', 's24le', 'pipe:1');
    const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      if (code) child.stdout.destroy(new Error('ffmpeg could not read audio from ' + path.basename(file) + ': ' + err.trim().split('\n').pop()));
    });
    return child.stdout;
  }

  /** Runs ffmpeg reporting progress (0..1) against an expected duration in seconds. */
  render(args, expected, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, ['-hide_banner', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (m && expected > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / expected));
        }
      });
      child.stderr.on('data', (d) => { log += d; if (log.length > 200000) log = log.slice(-100000); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(log);
        else reject(Object.assign(new Error('ffmpeg failed: ' + (log.trim().split('\n').slice(-3).join(' ') || 'exit ' + code)), { log }));
      });
    });
  }
}

/** atempo only accepts 0.5–2.0 per stage, so chain stages for other speeds. */
function atempoChain(speed) {
  const out = [];
  let s = speed;
  while (s > 2.0001) { out.push('atempo=2'); s /= 2; }
  while (s < 0.4999) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-4) out.push('atempo=' + s.toFixed(5));
  return out;
}

module.exports = { Media, atempoChain, parseRate };
