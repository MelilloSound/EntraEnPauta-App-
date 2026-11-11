/*
 * Timeline model shared by the browser and the server.
 *
 * An "edit" is what the user builds on a clip's timeline:
 *
 *   video: [{ id, src, in, out, speed, volume, muted, fadeIn, fadeOut }]
 *          Played back to back (no gaps), like CapCut's main track.
 *          in/out are seconds in the source file; speed 2 = twice as fast.
 *   texts: [{ id, text, start, end, x, y, size, color, box, bold }]
 *          start/end are timeline seconds; x/y are the text centre as a
 *          fraction of the frame; size is a fraction of the frame height.
 *   audio: [{ id, src, lane, start, in, out, volume, muted, fadeIn, fadeOut }]
 *          Extra audio (music, voice-over) placed freely on lanes A2, A3…
 *
 * Every function here is pure: it returns new data and never mutates input.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Timeline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-6;
  let idCounter = 0;
  const newId = (p) => p + Date.now().toString(36) + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 5);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function snap(t, fps) {
    if (!fps) return round3(t);
    return round3(Math.round(t * fps) / fps);
  }

  // ───────────── creation & layout ─────────────

  function defaultEdit(file, meta) {
    return {
      video: [{ id: newId('s'), src: file, in: 0, out: round3(meta.duration || 0), speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 }],
      texts: [],
      audio: [],
    };
  }

  function normalize(edit, file, meta) {
    const e = edit && edit.video ? clone(edit) : defaultEdit(file, meta);
    e.texts = e.texts || [];
    e.audio = e.audio || [];
    for (const s of e.video) {
      s.speed = s.speed || 1;
      s.volume = s.volume == null ? 1 : s.volume;
      s.muted = !!s.muted;
      s.fadeIn = s.fadeIn || 0;
      s.fadeOut = s.fadeOut || 0;
    }
    for (const a of e.audio) {
      a.lane = a.lane || 0;
      a.volume = a.volume == null ? 1 : a.volume;
      a.fadeIn = a.fadeIn || 0;
      a.fadeOut = a.fadeOut || 0;
      a.muted = !!a.muted;
    }
    return e;
  }

  const segDuration = (s) => (s.out - s.in) / (s.speed || 1);

  /** Video segments with their timeline start/end, and the total length. */
  function layout(edit) {
    let t = 0;
    const segments = edit.video.map((s, index) => {
      const d = segDuration(s);
      const out = Object.assign({}, s, { index, start: t, end: t + d, duration: d });
      t += d;
      return out;
    });
    return { segments, duration: t };
  }

  function duration(edit) { return layout(edit).duration; }

  function isUntouched(edit, file, meta) {
    if (!edit || !edit.video) return true;
    if (edit.texts && edit.texts.length) return false;
    if (edit.audio && edit.audio.length) return false;
    if (edit.video.length !== 1) return false;
    const s = edit.video[0];
    return s.src === file && Math.abs(s.in) < 0.002 && Math.abs(s.out - (meta.duration || s.out)) < 0.02 &&
      (s.speed || 1) === 1 && (s.volume == null || s.volume === 1) && !s.muted && !s.fadeIn && !s.fadeOut;
  }

  // ───────────── time mapping ─────────────

  /** What source frame plays at timeline time t. */
  function toSource(edit, t) {
    const { segments, duration: total } = layout(edit);
    if (!segments.length) return null;
    const tt = clamp(t, 0, total);
    let seg = segments.find((s) => tt >= s.start - EPS && tt < s.end - EPS);
    if (!seg) seg = segments[segments.length - 1];
    const time = clamp(seg.in + (tt - seg.start) * seg.speed, seg.in, seg.out);
    return { seg, src: seg.src, time };
  }

  /** Where a source moment appears in the timeline (first occurrence), or null if cut out. */
  function fromSource(edit, src, time) {
    const { segments } = layout(edit);
    for (const s of segments) {
      if (s.src === src && time >= s.in - 0.0005 && time <= s.out + 0.0005) {
        return s.start + (clamp(time, s.in, s.out) - s.in) / s.speed;
      }
    }
    return null;
  }

  /**
   * Where a note sits in the edit. Notes about an added text or audio item
   * follow that item; every other note follows the footage it was made on.
   */
  function noteTime(note, edit) {
    const tg = note.target;
    if (tg && tg.offset != null && (tg.kind === 'texts' || tg.kind === 'audio')) {
      const it = (edit[tg.kind] || []).find((x) => x.id === tg.id);
      if (it) {
        const len = tg.kind === 'texts' ? it.end - it.start : it.out - it.in;
        return it.start + clamp(tg.offset, 0, Math.max(0, len));
      }
    }
    return fromSource(edit, note.src, note.at);
  }

  // ───────────── edit operations ─────────────

  function splitAt(edit, t, fps) {
    const e = clone(edit);
    const { segments } = layout(e);
    const minLen = fps ? 1 / fps : 0.04;
    const seg = segments.find((s) => t > s.start + minLen && t < s.end - minLen);
    if (!seg) return { edit: e, changed: false };
    const cut = snap(seg.in + (t - seg.start) * seg.speed, fps);
    if (cut <= seg.in + EPS || cut >= seg.out - EPS) return { edit: e, changed: false };
    const a = e.video[seg.index];
    const b = Object.assign({}, a, { id: newId('s'), in: cut, fadeIn: 0 });
    a.out = cut;
    a.fadeOut = 0;
    e.video.splice(seg.index + 1, 0, b);
    return { edit: e, changed: true, newId: b.id };
  }

  function removeSegment(edit, id) {
    const e = clone(edit);
    if (e.video.length <= 1) return { edit: e, changed: false };
    const i = e.video.findIndex((s) => s.id === id);
    if (i < 0) return { edit: e, changed: false };
    e.video.splice(i, 1);
    return { edit: e, changed: true };
  }

  /** Move a segment's in or out point. srcDuration bounds the source file. */
  function trimSegment(edit, id, side, srcTime, srcDuration, fps) {
    const e = clone(edit);
    const s = e.video.find((x) => x.id === id);
    if (!s) return e;
    const minLen = (fps ? 1 / fps : 0.04) * (s.speed || 1);
    const t = snap(srcTime, fps);
    if (side === 'in') s.in = clamp(t, 0, s.out - minLen);
    else s.out = clamp(t, s.in + minLen, srcDuration || Infinity);
    s.in = round3(s.in); s.out = round3(s.out);
    return e;
  }

  function moveSegment(edit, id, toIndex) {
    const e = clone(edit);
    const i = e.video.findIndex((s) => s.id === id);
    if (i < 0) return e;
    const [s] = e.video.splice(i, 1);
    e.video.splice(clamp(toIndex, 0, e.video.length), 0, s);
    return e;
  }

  function insertSegment(edit, index, seg) {
    const e = clone(edit);
    const s = Object.assign({ id: newId('s'), speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 }, seg);
    e.video.splice(clamp(index, 0, e.video.length), 0, s);
    return { edit: e, id: s.id };
  }

  function update(edit, kind, id, props) {
    const e = clone(edit);
    const item = (e[kind] || []).find((x) => x.id === id);
    if (item) Object.assign(item, props);
    return e;
  }

  function addText(edit, props) {
    const e = clone(edit);
    const t = Object.assign({ id: newId('t'), text: 'Your text', start: 0, end: 3, x: 0.5, y: 0.82, size: 0.07, color: '#ffffff', box: false, bold: true }, props);
    e.texts.push(t);
    return { edit: e, id: t.id };
  }

  function addAudio(edit, props) {
    const e = clone(edit);
    const a = Object.assign({ id: newId('a'), lane: 0, start: 0, in: 0, out: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 }, props);
    e.audio.push(a);
    return { edit: e, id: a.id };
  }

  function removeItem(edit, kind, id) {
    const e = clone(edit);
    e[kind] = (e[kind] || []).filter((x) => x.id !== id);
    return e;
  }

  /** Split a text or audio item at timeline time t. */
  function splitItem(edit, kind, id, t, fps) {
    const e = clone(edit);
    const arr = e[kind];
    const i = arr.findIndex((x) => x.id === id);
    if (i < 0) return { edit: e, changed: false };
    const it = arr[i];
    const end = kind === 'texts' ? it.end : it.start + (it.out - it.in);
    const cut = snap(t, fps);
    if (cut <= it.start + 0.04 || cut >= end - 0.04) return { edit: e, changed: false };
    const b = Object.assign({}, it, { id: newId(kind === 'texts' ? 't' : 'a') });
    if (kind === 'texts') { it.end = cut; b.start = cut; } else {
      const srcCut = it.in + (cut - it.start);
      it.out = round3(srcCut); it.fadeOut = 0;
      b.start = cut; b.in = round3(srcCut); b.fadeIn = 0;
    }
    arr.splice(i + 1, 0, b);
    return { edit: e, changed: true, newId: b.id };
  }

  // ───────────── formatting ─────────────

  function fmt(t) {
    if (t == null || !isFinite(t)) return '--:--';
    const neg = t < 0;
    let s = Math.abs(t);
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    let ss = s.toFixed(2);
    if (ss === '60.00') { ss = '59.99'; }
    const body = (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + ss.padStart(5, '0');
    return (neg ? '-' : '') + body;
  }

  const fmtRange = (a, b) => fmt(a) + '–' + fmt(b);
  const pct = (v) => Math.round(v * 100) + '%';
  function db(v) {
    if (v <= 0) return '-∞ dB';
    const d = 20 * Math.log10(v);
    return (d >= 0 ? '+' : '') + d.toFixed(1) + ' dB';
  }

  function spotWords(x, y) {
    const col = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center';
    const row = y < 1 / 3 ? 'top' : y > 2 / 3 ? 'bottom' : 'middle';
    if (row === 'middle' && col === 'center') return 'center';
    if (row === 'middle') return 'middle ' + col;
    return row + ' ' + col;
  }

  // ───────────── describing an edit (for Claude) ─────────────

  const COLOR_NAMES = { '#ffffff': 'white', '#000000': 'black', '#ffcc00': 'yellow', '#ff4d4d': 'red', '#5b8cff': 'blue', '#3dd68c': 'green' };
  function colorName(hex) {
    const k = String(hex).toLowerCase();
    return COLOR_NAMES[k] ? `${COLOR_NAMES[k]} (${k})` : k;
  }

  function mergeIntervals(list) {
    const s = list.filter((r) => r[1] - r[0] > EPS).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of s) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + 0.001) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    }
    return out;
  }

  /**
   * The pieces that stayed in their original order: the in-order subsequence
   * with the most total duration (a big piece is less likely the one moved).
   */
  function lisIndices(arr, key, weight) {
    const n = arr.length;
    const len = arr.map(weight), prev = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) {
      if (key(arr[j]) <= key(arr[i]) && len[j] + weight(arr[i]) > len[i]) { len[i] = len[j] + weight(arr[i]); prev[i] = j; }
    }
    let best = 0;
    for (let i = 1; i < n; i++) if (len[i] > len[best]) best = i;
    const keep = new Set();
    for (let i = n ? best : -1; i >= 0; i = prev[i]) keep.add(i);
    return keep;
  }

  /**
   * Human-readable list of what changed compared with the original clip.
   * Returns { lines: [...], cutList: [...], duration, originalDuration }.
   */
  function describeEdit(edit, file, meta) {
    const lines = [];
    const minGap = meta.fps ? 0.5 / meta.fps : 0.02;
    const { segments, duration: total } = layout(edit);
    const own = segments.filter((s) => s.src === file);

    const covered = mergeIntervals(own.map((s) => [s.in, s.out]));
    let cursor = 0;
    const removed = [];
    for (const [a, b] of covered) { if (a - cursor > minGap) removed.push([cursor, a]); cursor = Math.max(cursor, b); }
    if ((meta.duration || 0) - cursor > minGap) removed.push([cursor, meta.duration]);
    for (const [a, b] of removed) {
      lines.push(`Cut out ${fmtRange(a, b)} of the original (${(b - a).toFixed(2)} s removed).`);
    }

    // Repeated material
    const events = [];
    for (const s of own) { events.push([s.in, 1], [s.out, -1]); }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let depth = 0, repStart = null;
    const repeated = [];
    for (const [t, d] of events) {
      const before = depth; depth += d;
      if (before < 2 && depth >= 2) repStart = t;
      if (before >= 2 && depth < 2 && repStart != null) { if (t - repStart > minGap) repeated.push([repStart, t]); repStart = null; }
    }
    for (const [a, b] of repeated) lines.push(`Used ${fmtRange(a, b)} of the original more than once.`);

    // Re-ordered material
    const keep = lisIndices(own, (s) => s.in, (s) => s.out - s.in);
    own.forEach((s, i) => {
      if (keep.has(i) || own.length < 2) return;
      const prevSeg = segments[s.index - 1];
      const where = prevSeg ? `right after ${prevSeg.src === file ? 'original ' + fmtRange(prevSeg.in, prevSeg.out) : prevSeg.src}` : 'at the very start';
      lines.push(`Moved original ${fmtRange(s.in, s.out)} so it plays ${where} (at ${fmt(s.start)} in my edit).`);
    });

    for (const s of segments) {
      const label = s.src === file ? `original ${fmtRange(s.in, s.out)}` : `${s.src} ${fmtRange(s.in, s.out)}`;
      if (s.src !== file) lines.push(`Inserted ${s.src} ${fmtRange(s.in, s.out)} at ${fmt(s.start)} in my edit.`);
      if (Math.abs(s.speed - 1) > 1e-3) lines.push(`Speed ${+s.speed.toFixed(2)}× on ${label} (now lasts ${s.duration.toFixed(2)} s).`);
      if (s.muted) lines.push(`Muted the clip's own audio on ${label}.`);
      else if (Math.abs(s.volume - 1) > 1e-3) lines.push(`Clip audio at ${pct(s.volume)} (${db(s.volume)}) on ${label}.`);
      if (s.fadeIn > 0) lines.push(`Fade in ${s.fadeIn.toFixed(2)} s at the start of ${label} (picture and sound).`);
      if (s.fadeOut > 0) lines.push(`Fade out ${s.fadeOut.toFixed(2)} s at the end of ${label} (picture and sound).`);
    }

    for (const t of edit.texts || []) {
      const style = [colorName(t.color || '#ffffff'), `${Math.round((t.size || 0.07) * 100)}% of frame height`, t.bold ? 'bold' : 'regular', t.box ? 'on a dark box' : 'no box'].join(', ');
      lines.push(`Added text "${t.text}" from ${fmt(t.start)} to ${fmt(t.end)} in my edit, ${spotWords(t.x, t.y)} (centre at x ${pct(t.x)}, y ${pct(t.y)}), ${style}.`);
    }

    for (const a of edit.audio || []) {
      const parts = [`Added audio "${a.src}" on track A${(a.lane || 0) + 2} at ${fmt(a.start)} in my edit`, `using ${fmtRange(a.in, a.out)} of the file`];
      parts.push(a.muted ? 'muted' : `${pct(a.volume)} volume (${db(a.volume)})`);
      if (a.fadeIn > 0) parts.push(`fade in ${a.fadeIn.toFixed(2)} s`);
      if (a.fadeOut > 0) parts.push(`fade out ${a.fadeOut.toFixed(2)} s`);
      lines.push(parts.join(', ') + '.');
    }

    const cutList = segments.map((s) => ({
      plays: fmtRange(s.start, s.end),
      from: (s.src === file ? '' : s.src + ' ') + fmtRange(s.in, s.out),
      speed: +s.speed.toFixed(2) + '×',
      audio: s.muted ? 'muted' : pct(s.volume),
    }));

    return { lines, cutList, duration: total, originalDuration: meta.duration || 0 };
  }

  // ───────────── audio plan for AAF export ─────────────

  function fadeWords(x) {
    const w = [];
    if (x.fadeIn > 0) w.push(`fade in ${x.fadeIn.toFixed(2)} s`);
    if (x.fadeOut > 0) w.push(`fade out ${x.fadeOut.toFixed(2)} s`);
    const t = w.join(' and ');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function channelLabel(c, n) {
    if (n === 1) return '';
    if (n === 2) return c === 0 ? 'L' : 'R';
    return String(c + 1);
  }

  /**
   * Turns an edit into tracks of audio clips (seconds), one mono track per
   * channel, the way AAF hands audio to Pro Tools.
   * metas: { [src]: { channels, duration } }
   */
  function audioPlan(edit, metas, name) {
    const { segments, duration: total } = layout(edit);
    const sources = new Map();
    const tracks = [];
    const notes = [];
    const chOf = (src) => Math.min(8, (metas[src] && metas[src].channels) || 0);

    const useSource = (src, piece) => {
      const key = piece ? `${src}|${piece.in}|${piece.out}|${piece.speed}` : src;
      if (!sources.has(key)) {
        const base = src.replace(/\.[^.]+$/, '');
        const label = piece ? `${base} ${+piece.speed.toFixed(2)}x from ${piece.in.toFixed(2)}s` : base;
        sources.set(key, { key, file: src, channels: chOf(src), piece: piece || null, label });
      }
      return sources.get(key);
    };

    const live = segments.filter((s) => !s.muted && s.volume > 0 && chOf(s.src) > 0);
    const v1 = live.reduce((m, s) => Math.max(m, chOf(s.src)), 0);
    if (v1) {
      for (let c = 0; c < v1; c++) tracks.push({ name: ['Clip audio', channelLabel(c, v1)].filter(Boolean).join(' '), clips: [] });
      const base = 0;
      for (const s of live) {
        const n = chOf(s.src);
        const sped = Math.abs(s.speed - 1) > 1e-3;
        const source = useSource(s.src, sped ? { in: s.in, out: s.out, speed: s.speed } : null);
        for (let c = 0; c < v1; c++) {
          tracks[base + c].clips.push({
            source: source.key, channel: Math.min(c, n - 1),
            start: s.start, offset: sped ? 0 : s.in, length: s.duration, gain: s.volume,
          });
        }
        if (sped) notes.push(`${s.src} ${fmtRange(s.in, s.out)} plays at ${+s.speed.toFixed(2)}× — exported as a time-stretched copy.`);
        if (s.fadeIn || s.fadeOut) notes.push(`${fadeWords(s)} on ${s.src} ${fmtRange(s.in, s.out)} (at ${fmt(s.start)} in the edit) — not baked into the AAF, recreate in Pro Tools.`);
      }
    }
    for (const s of segments) if (s.muted) notes.push(`Clip audio muted ${fmtRange(s.start, s.end)} in the edit — left out of the AAF.`);

    const lanes = new Map();
    for (const a of edit.audio || []) {
      if (a.muted || a.volume <= 0 || chOf(a.src) === 0) continue;
      if (!lanes.has(a.lane)) lanes.set(a.lane, []);
      lanes.get(a.lane).push(a);
    }
    for (const lane of [...lanes.keys()].sort((x, y) => x - y)) {
      const items = lanes.get(lane);
      const n = items.reduce((m, a) => Math.max(m, chOf(a.src)), 0);
      const first = tracks.length;
      for (let c = 0; c < n; c++) tracks.push({ name: [`A${lane + 2}`, channelLabel(c, n)].filter(Boolean).join(' '), clips: [] });
      for (const a of items) {
        const source = useSource(a.src, null);
        const len = Math.min(a.out - a.in, total - a.start);
        if (len <= 0) continue;
        for (let c = 0; c < n; c++) {
          tracks[first + c].clips.push({ source: source.key, channel: Math.min(c, chOf(a.src) - 1), start: a.start, offset: a.in, length: len, gain: a.volume });
        }
        if (a.fadeIn || a.fadeOut) notes.push(`${fadeWords(a)} on ${a.src} (at ${fmt(a.start)} in the edit) — not baked into the AAF, recreate in Pro Tools.`);
      }
    }

    return { name, duration: total, sources: [...sources.values()], tracks, notes };
  }

  /** The (source, channel) pairs an audio plan needs, in a stable order. */
  function essenceList(plan) {
    const used = new Map();
    for (const tr of plan.tracks) for (const c of tr.clips) {
      if (!used.has(c.source)) used.set(c.source, new Set());
      used.get(c.source).add(c.channel);
    }
    const out = [];
    for (const src of plan.sources) {
      const chans = [...(used.get(src.key) || [])].sort((a, b) => a - b);
      for (const ch of chans) {
        const suffix = src.channels > 1 ? '.' + (channelLabel(ch, src.channels) || String(ch + 1)) : '';
        out.push({ id: `${src.key}#${ch}`, source: src, channel: ch, name: src.label + suffix });
      }
    }
    return out;
  }

  /** Nominal timecode rate for a measured frame rate. */
  function timecodeRate(fps) {
    const f = fps || 30;
    const ntsc = [[23.976, 24], [29.97, 30], [47.952, 48], [59.94, 60], [119.88, 120]];
    for (const [v, n] of ntsc) if (Math.abs(f - v) < 0.01) return [n * 1000, 1001];
    return [Math.round(f), 1];
  }

  return {
    newId, clamp, snap, clone, defaultEdit, normalize, layout, duration, segDuration, isUntouched,
    toSource, fromSource, noteTime, splitAt, removeSegment, trimSegment, moveSegment, insertSegment, update,
    addText, addAudio, removeItem, splitItem, fmt, fmtRange, pct, db, spotWords, describeEdit,
    audioPlan, essenceList, timecodeRate, channelLabel,
  };
});
