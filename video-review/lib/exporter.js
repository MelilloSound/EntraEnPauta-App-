'use strict';
/*
 * Export jobs: the AAF hand-off for Pro Tools and MP4 renders of an edit.
 * Each export goes into its own new folder under the project's "Exports"
 * folder, so nothing is ever overwritten.
 */

const fs = require('fs');
const path = require('path');
const T = require('../public/js/timeline.js');
const safe = require('./safe-fs');
const { writeAAF } = require('./aaf');
const { buildRender, prepareRender, ffPath } = require('./render');

const SAMPLE_RATE = 48000;

function parseTimecode(tc, nominal) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(String(tc || '').trim());
  if (!m) return 3600 * nominal; // 01:00:00:00
  const [h, mi, s, f] = m.slice(1).map(Number);
  return ((h * 60 + mi) * 60 + s) * nominal + Math.min(f, nominal - 1);
}

function formatTimecode(frames, nominal) {
  const f = Math.round(frames);
  const p = (n) => String(n).padStart(2, '0');
  const ff = f % nominal, s = Math.floor(f / nominal);
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

/** A file name in `dir` that is not taken yet ("name.ext", "name (2).ext", …). */
async function freePath(dir, name) {
  const clean = safe.cleanName(name);
  const ext = path.extname(clean), base = clean.slice(0, clean.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, i === 1 ? clean : `${base} (${i})${ext}`);
    try { await fs.promises.access(candidate); } catch { return candidate; }
  }
  throw new Error('No free file name in ' + dir);
}

/** Reads a request body made of fixed-size parts, one after another. */
class SequentialReader {
  constructor(stream) {
    this.it = stream[Symbol.asyncIterator]();
    this.pending = null;
  }
  async next() {
    if (this.pending) { const p = this.pending; this.pending = null; return p; }
    const r = await this.it.next();
    return r.done ? null : r.value;
  }
  async readExact(n) {
    const parts = [];
    let got = 0;
    while (got < n) {
      const c = await this.next();
      if (!c) throw new Error('Upload ended early');
      const need = n - got;
      if (c.length > need) { parts.push(c.subarray(0, need)); this.pending = c.subarray(need); got = n; } else { parts.push(c); got += c.length; }
    }
    return Buffer.concat(parts);
  }
  async *take(n) {
    let left = n;
    while (left > 0) {
      const c = await this.next();
      if (!c) throw new Error('Upload ended early');
      if (c.length > left) { yield c.subarray(0, left); this.pending = c.subarray(left); left = 0; } else { yield c; left -= c.length; }
    }
  }
}

function cueSheet({ name, plan, spec, nominal, fpsLabel, tcStart, clipFile, options }) {
  const sr = spec.sampleRate;
  const lines = [];
  lines.push(`${name} — audio hand-off for Pro Tools`);
  lines.push(`Exported ${new Date().toLocaleString()} by Video Review from ${clipFile}`);
  lines.push('');
  lines.push(`Sequence start  ${formatTimecode(tcStart, nominal)} at ${fpsLabel}`);
  lines.push(`Length          ${T.fmt(plan.duration)}`);
  lines.push(`Audio           ${sr / 1000} kHz, 24-bit, embedded in the AAF as mono clips with full handles`);
  lines.push('');
  lines.push('In Pro Tools: File > Import > Session Data…, choose the .aaf, then pick the tracks.');
  if (options.reference) lines.push('The reference video is in this folder too (File > Import > Video…).');
  lines.push('');
  lines.push('TRACKS');
  plan.tracks.forEach((tr, i) => {
    lines.push(`${String(i + 1).padStart(2)}. ${tr.name}`);
    for (const c of tr.clips) {
      const src = plan.sources.find((s) => s.key === c.source);
      const rec = formatTimecode(tcStart + Math.round(c.start * nominal), nominal);
      lines.push(`    ${rec}  ${T.fmt(c.start)}–${T.fmt(c.start + c.length)}  ${src.label}  (file ${T.fmtRange(c.offset, c.offset + c.length)})  gain ${T.db(c.gain)}`);
    }
  });
  if (plan.notes.length) {
    lines.push('');
    lines.push('NOTES');
    for (const n of [...new Set(plan.notes)]) lines.push('  - ' + n);
  }
  lines.push('');
  return lines.join('\n');
}

class Exporter {
  constructor(projects, media) {
    this.projects = projects;
    this.media = media;
    this.jobs = new Map();
    this.seq = 0;
  }

  job(kind) {
    const id = 'j' + (++this.seq) + Date.now().toString(36);
    const job = { id, kind, status: 'running', progress: 0, step: 'Starting', files: [], warnings: [], started: Date.now() };
    this.jobs.set(id, job);
    return job;
  }

  publicJob(id) {
    const j = this.jobs.get(id);
    if (!j) return null;
    const { log, ...rest } = j;
    return rest;
  }

  async newExportFolder(dir, label) {
    const root = await safe.ensureDir(this.projects.exportsDir(dir));
    return safe.createUniqueDir(root, `${label} ${safe.stamp().slice(0, 15)}`);
  }

  filesFor(dir, edit, extra = []) {
    const names = new Set([...edit.video.map((s) => s.src), ...(edit.audio || []).map((a) => a.src), ...extra]);
    const files = {};
    for (const n of names) {
      if (path.basename(n) !== n) throw new Error('Bad file name: ' + n);
      files[n] = path.join(dir, n);
    }
    return files;
  }

  async metasFor(files, fromClient) {
    const metas = {};
    for (const [name, file] of Object.entries(files)) {
      const probed = this.media.ffprobe ? await this.media.probe(file) : null;
      metas[name] = Object.assign({}, (fromClient || {})[name] || {}, probed && !probed.error ? probed : {});
    }
    return metas;
  }

  /** MP4 render of the edit. */
  async render(job, { dir, clip, edit, clientMetas, options = {} }) {
    if (!this.media.ffmpeg) throw new Error('Rendering needs ffmpeg. Install it (see README) and restart the app.');
    const files = this.filesFor(dir, edit, [clip]);
    const metas = await this.metasFor(files, clientMetas);
    const folder = options.folder || await this.newExportFolder(dir, path.parse(clip).name + ' edit');
    const out = path.join(folder, options.fileName || `${path.parse(clip).name} edit.mp4`);
    const plan = buildRender({ edit, files, metas, main: clip, fonts: this.media.fonts, drawtext: this.media.drawtext, x264: this.media.x264, outPath: out });
    if (options.burnTimecode && this.media.drawtext && (this.media.fonts.regular || this.media.fonts.bold)) {
      const font = this.media.fonts.regular || this.media.fonts.bold;
      const size = Math.round(plan.size[1] * 0.045);
      const tc = options.burnTimecode.start.replace(/:/g, '\\:');
      const label = plan.args[plan.args.indexOf('-map') + 1].slice(1, -1);
      plan.filter += `;\n[${label}]drawtext=fontfile=${ffPath(font)}:timecode='${tc}':rate=${options.burnTimecode.rate}:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=${Math.round(size * 0.25)}:x=(w-tw)/2:y=h-th-${Math.round(size * 0.8)}[vtc]`;
      plan.args[plan.args.indexOf('-map') + 1] = '[vtc]';
    }
    job.warnings.push(...plan.warnings);
    plan.args[plan.args.length - 1] = await freePath(folder, path.basename(out));
    const args = await prepareRender(plan);
    job.step = options.stepLabel || 'Rendering video';
    // -n: ffmpeg refuses to overwrite an existing file.
    await this.media.render(['-n', ...args], plan.duration, (p) => { job.progress = (options.progressBase || 0) + p * (options.progressSpan || 1); });
    job.files.push(plan.args[plan.args.length - 1]);
    job.folder = folder;
    return folder;
  }

  /** AAF + cue sheet (+ reference video when ffmpeg is available). */
  async aaf(job, { dir, clip, edit, clientMetas, options = {}, upload }) {
    const files = this.filesFor(dir, edit, [clip]);
    let metas = await this.metasFor(files, upload ? upload.manifest.metas : clientMetas);
    const name = options.name || path.parse(clip).name;
    const plan = T.audioPlan(edit, metas, name);
    if (!plan.tracks.length) throw new Error('There is no audio on this timeline to export.');
    const list = T.essenceList(plan);
    if (!upload && !this.media.ffmpeg) throw new Error('NEEDS_BROWSER_AUDIO');

    const folder = await this.newExportFolder(dir, name + ' AAF');
    job.folder = folder;
    const fpsPair = T.timecodeRate(metas[clip] && metas[clip].fps);
    const nominal = Math.round(fpsPair[0] / fpsPair[1]);
    const tcStart = parseTimecode(options.timecode || '01:00:00:00', nominal);

    let essences;
    if (upload) {
      const sizes = new Map(upload.manifest.essences.map((e) => [e.id, e.bytes]));
      for (const e of list) if (!sizes.has(e.id)) throw new Error('Missing audio for ' + e.name);
      const order = upload.manifest.essences.map((e) => e.id);
      essences = order.filter((id) => list.some((e) => e.id === id)).map((id) => {
        const e = list.find((x) => x.id === id);
        return { id, name: e.name, open: () => upload.reader.take(sizes.get(id)) };
      });
    } else {
      essences = list.map((e) => ({ id: e.id, name: e.name, open: () => this.media.audio(files[e.source.file], e.channel, e.source.piece, SAMPLE_RATE) }));
    }

    const spec = {
      name, sampleRate: SAMPLE_RATE, fps: fpsPair, tcStart, dropFrame: false,
      duration: Math.round(plan.duration * SAMPLE_RATE),
      essences,
      tracks: plan.tracks.map((tr) => ({
        name: tr.name,
        clips: tr.clips.map((c) => ({
          essence: `${c.source}#${c.channel}`,
          start: c.start * SAMPLE_RATE, offset: c.offset * SAMPLE_RATE, length: c.length * SAMPLE_RATE, gain: c.gain,
        })),
      })),
    };

    const withReference = options.reference !== false && !!this.media.ffmpeg;
    const span = withReference ? 0.5 : 1;
    job.step = 'Writing AAF';
    // Written as ".part" (opened exclusively, never overwriting) and given its
    // real name only once complete, so a failed export is obvious.
    const partPath = await freePath(folder, name + '.aaf.part');
    await writeAAF(partPath, spec, (p) => {
      if (p.step === 'audio') { job.step = `Embedding audio ${p.index + 1}/${p.total}: ${p.name}`; job.progress = span * (p.index / p.total) * 0.95; }
      if (p.step === 'finish') job.progress = span * 0.97;
    });
    const aafPath = await freePath(folder, name + '.aaf');
    await fs.promises.rename(partPath, aafPath);
    job.files.push(aafPath);

    const fpsLabel = `${+(fpsPair[0] / fpsPair[1]).toFixed(3)} fps`;
    const sheet = cueSheet({ name, plan, spec, nominal, fpsLabel, tcStart, clipFile: clip, options: { reference: withReference } });
    const cue = await safe.writeNewFile(folder, `${name} cue sheet.txt`, sheet);
    job.files.push(cue.path);
    job.progress = span;

    if (withReference) {
      try {
        await this.render(job, {
          dir, clip, edit, clientMetas: metas,
          options: {
            folder, fileName: `${name} reference.mp4`, stepLabel: 'Rendering reference video',
            progressBase: 0.5, progressSpan: 0.5,
            burnTimecode: { start: formatTimecode(tcStart, nominal), rate: `${fpsPair[0]}/${fpsPair[1]}` },
          },
        });
      } catch (err) {
        job.warnings.push('The reference video could not be rendered: ' + err.message);
      }
    }
    return folder;
  }

  start(kind, fn) {
    const job = this.job(kind);
    Promise.resolve().then(() => fn(job)).then(() => {
      job.status = 'done'; job.progress = 1; job.step = 'Done';
    }).catch((err) => {
      job.status = 'error'; job.error = err.message; job.step = 'Failed';
    });
    return job;
  }
}

module.exports = { Exporter, SequentialReader, parseTimecode, formatTimecode, cueSheet };
