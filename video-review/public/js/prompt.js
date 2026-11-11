/*
 * Builds the "Copy moments" prompt: every note, pinned to its exact moment
 * and spot, plus a precise description of the edits you made yourself, so
 * Claude can reproduce them in the source project.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./timeline.js'));
  else root.Prompt = factory(root.Timeline);
})(typeof self !== 'undefined' ? self : this, function (T) {
  'use strict';

  const { fmt, fmtRange, pct, spotWords } = T;

  function joinPath(base, rel, sep) {
    return base.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
  }

  /** Where a note sits, in words, for the current edit. */
  function noteWhen(note, clipFile, edit) {
    const tg = note.target;
    if (edit && tg && tg.offset != null && (edit[tg.kind] || []).some((x) => x.id === tg.id)) {
      // About something that only exists in my edit (added text or audio).
      const t = T.noteTime(note, edit);
      return note.len > 0.05 ? `From ${fmt(t)} to ${fmt(t + note.len)} in my edit` : `At ${fmt(t)} in my edit`;
    }
    const inOwnFile = note.src === clipFile;
    const fileLabel = inOwnFile ? '' : ` of ${note.src}`;
    let when = note.end != null && note.end > note.at
      ? `From ${fmt(note.at)} to ${fmt(note.end)}${fileLabel}`
      : `At ${fmt(note.at)}${fileLabel}`;
    if (!note.end && note.len > 0.05) when = `From ${fmt(note.at)}${fileLabel}, for ${note.len.toFixed(2)} s`;
    let extra = '';
    if (edit) {
      const t = T.fromSource(edit, note.src, note.at);
      if (t == null) extra = ' (in a part I cut from my edit)';
      else if (!inOwnFile || Math.abs(t - note.at) > 0.02) extra = ` (${fmt(t)} in my edit)`;
    }
    return when + extra;
  }

  function targetLabel(note, edit) {
    const tg = note.target;
    if (!tg) return '';
    if (edit && tg.kind === 'texts') {
      const it = (edit.texts || []).find((x) => x.id === tg.id);
      if (it) return `my added text "${it.text}"`;
    }
    if (edit && tg.kind === 'audio') {
      const it = (edit.audio || []).find((x) => x.id === tg.id);
      if (it) return `the audio "${it.src}" on track A${(it.lane || 0) + 2}`;
    }
    return tg.label || '';
  }

  function spotLabel(spot) {
    if (!spot) return '';
    const cx = spot.w ? spot.x + spot.w / 2 : spot.x;
    const cy = spot.h ? spot.y + spot.h / 2 : spot.y;
    const where = spotWords(cx, cy);
    if (spot.w && spot.h) {
      return `the area at the ${where} of the frame (box from x ${pct(spot.x)}, y ${pct(spot.y)}, ${pct(spot.w)} wide, ${pct(spot.h)} tall)`;
    }
    return `the ${where} of the frame (x ${pct(spot.x)}, y ${pct(spot.y)})`;
  }

  function compactEdit(edit, clip, meta) {
    const strip = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = typeof o[k] === 'number' ? Math.round(o[k] * 1000) / 1000 : o[k]; return r; };
    const lines = [];
    lines.push('{');
    lines.push(`  "clip": ${JSON.stringify(clip)},`);
    lines.push(`  "originalDuration": ${Math.round((meta.duration || 0) * 1000) / 1000},`);
    lines.push(`  "editDuration": ${Math.round(T.duration(edit) * 1000) / 1000},`);
    const arr = (name, items, keys, last) => {
      if (!items.length) { lines.push(`  "${name}": []${last ? '' : ','}`); return; }
      lines.push(`  "${name}": [`);
      items.forEach((it, i) => lines.push('    ' + JSON.stringify(strip(it, keys)) + (i < items.length - 1 ? ',' : '')));
      lines.push(`  ]${last ? '' : ','}`);
    };
    arr('video', edit.video, ['src', 'in', 'out', 'speed', 'volume', 'muted', 'fadeIn', 'fadeOut']);
    arr('texts', edit.texts || [], ['text', 'start', 'end', 'x', 'y', 'size', 'color', 'bold', 'box']);
    arr('audio', edit.audio || [], ['src', 'lane', 'start', 'in', 'out', 'volume', 'muted', 'fadeIn', 'fadeOut'], true);
    lines.push('}');
    return lines.join('\n');
  }

  /**
   * opts = {
   *   project: { name, path }, dataPath, sep,
   *   clips: [{ file, meta, edit, comments }],
   *   includeDone, includeJson
   * }
   */
  function build(opts) {
    const sep = opts.sep || (/^[A-Za-z]:\\/.test(opts.project.path) ? '\\' : '/');
    const out = [];
    let noteCount = 0, editedCount = 0;
    const sections = [];

    for (const c of opts.clips) {
      const meta = c.meta || {};
      const edit = c.edit && !T.isUntouched(c.edit, c.file, meta) ? c.edit : null;
      const notes = (c.comments || [])
        .filter((n) => opts.includeDone || !n.done)
        .slice()
        .sort((a, b) => {
          const ta = edit ? T.noteTime(a, edit) : a.at;
          const tb = edit ? T.noteTime(b, edit) : b.at;
          return (ta == null ? 1e9 + a.at : ta) - (tb == null ? 1e9 + b.at : tb);
        });
      if (!notes.length && !edit) continue;
      const s = [];
      const facts = [fmt(meta.duration || 0)];
      if (meta.width && meta.height) facts.push(`${meta.width}×${meta.height}`);
      if (meta.fps) facts.push(`${+meta.fps.toFixed(3)} fps`);
      s.push(`━━ ${c.file} ━━  (${facts.join(' · ')})`);
      s.push(`File: ${joinPath(opts.project.path, c.file, sep)}`);
      s.push('');

      if (notes.length) {
        s.push(`Notes (${notes.length}):`);
        notes.forEach((n, i) => {
          noteCount++;
          const bits = [noteWhen(n, c.file, edit)];
          const spot = spotLabel(n.spot);
          if (spot) bits.push(spot);
          const tg = targetLabel(n, edit);
          if (tg) bits.push('about ' + tg);
          s.push(`${i + 1}. ${n.done ? '[done] ' : ''}${bits.join(' — ')}`);
          const text = String(n.text || '').trim() || '(no text — see the still)';
          for (const line of text.split('\n')) s.push('   ' + line);
          if (n.still && opts.dataPath) s.push(`   Still: ${joinPath(opts.dataPath, n.still, sep)}`);
        });
        s.push('');
      }

      if (edit) {
        editedCount++;
        const d = T.describeEdit(edit, c.file, meta);
        s.push('Edits I made myself — please apply the same changes to the source project:');
        s.push(`My version runs ${fmt(d.duration)} (the original is ${fmt(d.originalDuration)}).`);
        for (const l of d.lines) s.push('- ' + l);
        s.push('');
        s.push('My cut, piece by piece (times in the original unless another file is named):');
        d.cutList.forEach((r, i) => s.push(`  ${i + 1}. ${r.plays} in my edit ← ${r.from} · ${r.speed} · audio ${r.audio}`));
        if (opts.includeJson !== false) {
          s.push('');
          s.push('Exact timeline data (seconds; in/out are times in the source file, start/end are times in my edit, x/y are fractions of the frame):');
          s.push('```json');
          s.push(compactEdit(edit, c.file, meta));
          s.push('```');
        }
        s.push('');
      }
      sections.push(s.join('\n'));
    }

    if (!sections.length) return { text: '', notes: 0, edited: 0 };

    out.push(`Here are my review notes for the video project "${opts.project.name}".`);
    out.push('');
    out.push(`Project folder: ${opts.project.path}`);
    out.push('How to read this: times are minutes:seconds.hundredths from the start of each file. Where I re-cut a clip, "in my edit" gives the time in my version too. Each note has a still of that exact frame — please open it: an orange circle or box marks the spot I clicked.');
    out.push('');
    out.push(sections.join('\n'));
    const asks = [];
    if (noteCount) asks.push(`address every note above (${noteCount})`);
    if (editedCount) asks.push('include the edits I made myself');
    out.push(`Please make a revision that will ${asks.join(' and ')}. Save it as a new file next to the original (don't overwrite anything). If a note is unclear, ask me before guessing.`);
    return { text: out.join('\n'), notes: noteCount, edited: editedCount };
  }

  return { build, noteWhen, spotLabel, targetLabel };
});
