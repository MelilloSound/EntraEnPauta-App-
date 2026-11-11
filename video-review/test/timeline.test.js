'use strict';
const assert = require('assert/strict');
const T = require('../public/js/timeline.js');
const Prompt = require('../public/js/prompt.js');

const meta = { duration: 12, fps: 30, width: 1920, height: 1080 };
const fresh = () => T.defaultEdit('ad.mp4', meta);

module.exports = {
  'a new edit is the untouched clip'() {
    const e = fresh();
    assert.equal(T.duration(e), 12);
    assert.ok(T.isUntouched(e, 'ad.mp4', meta));
  },

  'split, remove and ripple'() {
    let e = fresh();
    e = T.splitAt(e, 3, 30).edit;
    e = T.splitAt(e, 6, 30).edit;
    assert.equal(e.video.length, 3);
    e = T.removeSegment(e, e.video[1].id).edit;
    assert.equal(T.duration(e), 9);
    assert.deepEqual(e.video.map((s) => [s.in, s.out]), [[0, 3], [6, 12]]);
    assert.ok(!T.isUntouched(e, 'ad.mp4', meta));
  },

  'splits snap to frames and refuse edges'() {
    const e = fresh();
    const r = T.splitAt(e, 3.01234, 30);
    assert.equal(r.edit.video[0].out, 3);
    assert.equal(T.splitAt(e, 0.01, 30).changed, false);
  },

  'time mapping through cuts and speed'() {
    let e = fresh();
    e = T.splitAt(e, 4, 30).edit;
    e = T.update(e, 'video', e.video[1].id, { speed: 2 }); // 4–12 plays in 4 s
    assert.equal(T.duration(e), 8);
    const at = T.toSource(e, 6); // 2 s into the fast piece
    assert.equal(at.time, 8);
    assert.equal(T.fromSource(e, 'ad.mp4', 8), 6);
    e = T.removeSegment(e, e.video[0].id).edit;
    assert.equal(T.fromSource(e, 'ad.mp4', 2), null, 'cut material has no position');
  },

  'trim never goes past the file or below one frame'() {
    const e = fresh();
    const id = e.video[0].id;
    assert.equal(T.trimSegment(e, id, 'out', 20, 12, 30).video[0].out, 12);
    const t = T.trimSegment(e, id, 'in', 11.999, 12, 30).video[0];
    assert.ok(t.out - t.in >= 1 / 30 - 0.001, 'at least one frame (to the millisecond)');
  },

  'notes about added text follow the text'() {
    let e = fresh();
    const r = T.addText(e, { start: 1, end: 4, text: 'Sale' });
    e = r.edit;
    const note = { src: 'ad.mp4', at: 2, target: { kind: 'texts', id: r.id, offset: 1 } };
    assert.equal(T.noteTime(note, e), 2);
    e = T.update(e, 'texts', r.id, { start: 5, end: 8 });
    assert.equal(T.noteTime(note, e), 6);
  },

  'describes edits precisely for Claude'() {
    let e = fresh();
    e = T.splitAt(e, 3, 30).edit;
    e = T.splitAt(e, 6, 30).edit;
    e = T.removeSegment(e, e.video[1].id).edit;
    e = T.moveSegment(e, e.video[1].id, 0);
    e = T.update(e, 'video', e.video[0].id, { volume: 0.5 });
    e = T.addText(e, { text: 'Summer sale', start: 1, end: 3, color: '#ffcc00' }).edit;
    e = T.addAudio(e, { src: 'music.mp3', start: 0, in: 2, out: 9, volume: 0.25, fadeOut: 1 }).edit;
    const d = T.describeEdit(e, 'ad.mp4', meta);
    const text = d.lines.join('\n');
    assert.match(text, /Cut out 00:03\.00–00:06\.00 of the original \(3\.00 s removed\)/);
    assert.match(text, /Moved original 00:00\.00–00:03\.00 so it plays right after original 00:06\.00–00:12\.00/);
    assert.match(text, /Clip audio at 50% \(-6\.0 dB\)/);
    assert.match(text, /Added text "Summer sale" from 00:01\.00 to 00:03\.00 .*yellow/);
    assert.match(text, /Added audio "music\.mp3" on track A2 .*25% volume \(-12\.0 dB\), fade out 1\.00 s/);
    assert.equal(d.cutList.length, 2);
  },

  'audio plan: one mono track per channel, stretched copies for speed changes'() {
    let e = fresh();
    e = T.splitAt(e, 4, 30).edit;
    e = T.update(e, 'video', e.video[1].id, { speed: 1.5 });
    e = T.addAudio(e, { src: 'vo.wav', start: 1, in: 0, out: 3 }).edit;
    const plan = T.audioPlan(e, { 'ad.mp4': { channels: 2 }, 'vo.wav': { channels: 1 } }, 'ad');
    assert.deepEqual(plan.tracks.map((t) => t.name), ['Clip audio L', 'Clip audio R', 'A2']);
    assert.equal(plan.sources.length, 3);
    assert.ok(plan.sources.some((s) => s.piece && s.piece.speed === 1.5));
    const list = T.essenceList(plan);
    assert.deepEqual(list.map((x) => x.name), ['ad.L', 'ad.R', 'ad 1.5x from 4.00s.L', 'ad 1.5x from 4.00s.R', 'vo']);
  },

  'timecode rates for drop-frame family'() {
    assert.deepEqual(T.timecodeRate(29.97), [30000, 1001]);
    assert.deepEqual(T.timecodeRate(23.976), [24000, 1001]);
    assert.deepEqual(T.timecodeRate(25), [25, 1]);
  },

  'Copy moments prompt has every note, its spot, still path and the edits'() {
    let e = fresh();
    e = T.splitAt(e, 6, 30).edit;
    e = T.removeSegment(e, e.video[1].id).edit; // keep 0–6
    const r = Prompt.build({
      project: { name: 'Promo', path: '/Users/me/Video Review/Promo' },
      dataPath: '/Users/me/Video Review/Promo/.review',
      clips: [{
        file: 'ad.mp4', meta, edit: e,
        comments: [
          { id: 'a', src: 'ad.mp4', at: 2, spot: { x: 0.1, y: 0.1 }, text: 'Logo cut off', still: 'frames/a.jpg' },
          { id: 'b', src: 'ad.mp4', at: 8, spot: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 }, text: 'Busy corner' },
          { id: 'c', src: 'ad.mp4', at: 1, text: 'Already fixed', done: true },
        ],
      }],
    });
    assert.equal(r.notes, 2);
    assert.match(r.text, /Project folder: \/Users\/me\/Video Review\/Promo/);
    assert.match(r.text, /1\. At 00:02\.00 — the top left of the frame \(x 10%, y 10%\)\n {3}Logo cut off\n {3}Still: \/Users\/me\/Video Review\/Promo\/\.review\/frames\/a\.jpg/);
    assert.match(r.text, /At 00:08\.00 \(in a part I cut from my edit\) — the area at the bottom right/);
    assert.doesNotMatch(r.text, /Already fixed/);
    assert.match(r.text, /Cut out 00:06\.00–00:12\.00/);
    assert.match(r.text, /```json\n\{\n {2}"clip": "ad\.mp4"/);
    assert.match(r.text, /don't overwrite anything/);
  },

  'prompt is empty when there is nothing to say'() {
    const r = Prompt.build({ project: { name: 'P', path: '/p' }, clips: [{ file: 'ad.mp4', meta, edit: fresh(), comments: [] }] });
    assert.equal(r.text, '');
  },
};
