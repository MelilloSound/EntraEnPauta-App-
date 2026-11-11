'use strict';
/*
 * Builds the ffmpeg command that renders an edit to MP4, so what you export
 * matches what you saw in the player: segments back to back with their speed,
 * volume and fades, text overlays, and extra audio mixed in.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const T = require('../public/js/timeline.js');
const { atempoChain } = require('./media');

/** Quotes a file path for an ffmpeg filter graph (handles spaces and drive letters). */
function ffPath(p) {
  return "'" + p.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:') + "'";
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const num = (v) => (Math.round(v * 10000) / 10000).toString();

/**
 * edit:   the timeline (see public/js/timeline.js)
 * files:  { [name]: absolute path }
 * metas:  { [name]: { duration, width, height, fps, hasAudio, channels } }
 * main:   the clip this timeline belongs to (sets size and frame rate)
 */
function buildRender({ edit, files, metas, main, fonts, drawtext, x264, outPath }) {
  const warnings = [];
  const mainMeta = metas[main] || {};
  const W = even(mainMeta.width || 1920);
  const H = even(mainMeta.height || 1080);
  const fps = mainMeta.fps || 30;
  const { segments, duration } = T.layout(edit);
  if (!segments.length || duration <= 0) throw new Error('The timeline is empty.');

  const inputs = [];
  const inputIndex = new Map();
  const input = (name) => {
    if (!inputIndex.has(name)) { inputIndex.set(name, inputs.length); inputs.push(files[name]); }
    return inputIndex.get(name);
  };

  const graph = [];
  const pairs = [];
  segments.forEach((s, i) => {
    const k = input(s.src);
    const m = metas[s.src] || {};
    const d = s.duration;
    const vf = [
      `trim=start=${num(s.in)}:end=${num(s.out)}`,
      `setpts=(PTS-STARTPTS)/${num(s.speed)}`,
      `fps=${num(fps)}`,
      `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
      'format=yuv420p',
    ];
    if (s.fadeIn > 0) vf.push(`fade=t=in:st=0:d=${num(Math.min(s.fadeIn, d))}`);
    if (s.fadeOut > 0) vf.push(`fade=t=out:st=${num(Math.max(0, d - s.fadeOut))}:d=${num(Math.min(s.fadeOut, d))}`);
    graph.push(`[${k}:v:0]${vf.join(',')}[v${i}]`);

    if (m.hasAudio && !s.muted && s.volume > 0) {
      const af = [
        `atrim=start=${num(s.in)}:end=${num(s.out)}`,
        'asetpts=PTS-STARTPTS',
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
        ...atempoChain(s.speed),
        `volume=${num(s.volume)}`,
      ];
      if (s.fadeIn > 0) af.push(`afade=t=in:st=0:d=${num(Math.min(s.fadeIn, d))}`);
      if (s.fadeOut > 0) af.push(`afade=t=out:st=${num(Math.max(0, d - s.fadeOut))}:d=${num(Math.min(s.fadeOut, d))}`);
      af.push(`apad=whole_dur=${num(d)}`, `atrim=duration=${num(d)}`);
      graph.push(`[${k}:a:0]${af.join(',')}[a${i}]`);
    } else {
      graph.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${num(d)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
    pairs.push(`[v${i}][a${i}]`);
  });
  graph.push(`${pairs.join('')}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);

  // Text overlays
  const textFiles = [];
  let vLabel = 'vcat';
  const texts = (edit.texts || []).filter((t) => t.text && t.end > t.start && t.start < duration);
  if (texts.length && !(drawtext && (fonts.bold || fonts.regular))) {
    warnings.push('Text overlays were left out: this ffmpeg has no text support (drawtext) or no font was found.');
  } else if (texts.length) {
    const draws = texts.map((t, i) => {
      const font = (t.bold ? fonts.bold : fonts.regular) || fonts.bold || fonts.regular;
      const name = `text-${i + 1}.txt`;
      textFiles.push({ name, content: t.text });
      const size = Math.max(8, Math.round((t.size || 0.07) * H));
      const style = t.box
        ? `box=1:boxcolor=black@0.55:boxborderw=${Math.round(size * 0.3)}`
        : 'shadowcolor=black@0.6:shadowx=2:shadowy=2';
      const color = /^#[0-9a-f]{6}$/i.test(t.color || '') ? '0x' + t.color.slice(1) : 'white';
      return `drawtext=fontfile=${ffPath(font)}:textfile=${ffPath('{{DIR}}/' + name)}:expansion=none:fontsize=${size}:fontcolor=${color}:line_spacing=${Math.round(size * 0.2)}:${style}:x=(w*${num(t.x)})-text_w/2:y=(h*${num(t.y)})-text_h/2:enable='between(t,${num(t.start)},${num(Math.min(t.end, duration))})'`;
    });
    graph.push(`[vcat]${draws.join(',')}[vtxt]`);
    vLabel = 'vtxt';
  }

  // Extra audio lanes
  const mix = ['[acat]'];
  (edit.audio || []).forEach((a, i) => {
    const m = metas[a.src] || {};
    if (a.muted || a.volume <= 0 || !m.hasAudio || a.start >= duration) return;
    const k = input(a.src);
    const len = Math.min(a.out - a.in, duration - a.start);
    const af = [
      `atrim=start=${num(a.in)}:end=${num(a.in + len)}`,
      'asetpts=PTS-STARTPTS',
      'aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `volume=${num(a.volume)}`,
    ];
    if (a.fadeIn > 0) af.push(`afade=t=in:st=0:d=${num(Math.min(a.fadeIn, len))}`);
    if (a.fadeOut > 0) af.push(`afade=t=out:st=${num(Math.max(0, len - a.fadeOut))}:d=${num(Math.min(a.fadeOut, len))}`);
    const ms = Math.round(a.start * 1000);
    if (ms > 0) af.push(`adelay=${ms}|${ms}`);
    graph.push(`[${k}:a:0]${af.join(',')}[x${i}]`);
    mix.push(`[x${i}]`);
  });
  if (mix.length > 1) graph.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:normalize=0[aout]`);
  else graph.push('[acat]anull[aout]');

  const video = x264
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p'];
  const args = [];
  for (const f of inputs) args.push('-i', f);
  args.push('-filter_complex_script', '{{SCRIPT}}', '-map', `[${vLabel}]`, '-map', '[aout]',
    ...video, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-r', num(fps), '-t', num(duration),
    '-movflags', '+faststart', outPath);

  return { args, filter: graph.join(';\n'), textFiles, duration, warnings, size: [W, H], fps };
}

/** Writes the filter script and text files to a temp folder and returns runnable args. */
async function prepareRender(plan) {
  const dir = path.join(os.tmpdir(), 'video-review', crypto.randomBytes(6).toString('hex'));
  await fs.promises.mkdir(dir, { recursive: true });
  for (const t of plan.textFiles) await fs.promises.writeFile(path.join(dir, t.name), t.content, { flag: 'wx' });
  const script = path.join(dir, 'filter.txt');
  const escapedDir = ffPath(dir).slice(1, -1); // already inside quotes in the graph
  await fs.promises.writeFile(script, plan.filter.split('{{DIR}}').join(escapedDir), { flag: 'wx' });
  return plan.args.map((a) => (a === '{{SCRIPT}}' ? script : a));
}

module.exports = { buildRender, prepareRender, ffPath };
