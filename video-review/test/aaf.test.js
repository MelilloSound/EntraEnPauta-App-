'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { execFileSync } = require('child_process');
const { writeAAF } = require('../lib/aaf');
const { readCfb, readProps, utf16z } = require('./cfb-reader');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-aaf-'));

/** Deterministic 24-bit samples so the round trip can be checked byte for byte. */
function pcm(samples, seed) {
  const b = Buffer.alloc(samples * 3);
  for (let i = 0; i < samples; i++) b.writeIntLE(Math.round(Math.sin((i + seed) / 20) * 4000000), i * 3, 3);
  return b;
}
const streamOf = (buf) => () => Readable.from([buf.subarray(0, 7777), buf.subarray(7777)]);

async function sample(file, extra = {}) {
  const a = pcm(96000, 1), b = pcm(96000, 99), m = pcm(240000, 7);
  const spec = Object.assign({
    name: 'Test', sampleRate: 48000, fps: [30000, 1001], tcStart: 108000, duration: 48000 * 4,
    essences: [
      { id: 'a', name: 'clip.L', open: streamOf(a) },
      { id: 'b', name: 'clip.R', open: streamOf(b) },
      { id: 'm', name: 'music', open: streamOf(m) },
    ],
    tracks: [
      { name: 'Clip L', clips: [{ essence: 'a', start: 0, offset: 0, length: 48000 }, { essence: 'a', start: 96000, offset: 48000, length: 48000, gain: 0.5 }] },
      { name: 'Clip R', clips: [{ essence: 'b', start: 0, offset: 0, length: 48000 }] },
      { name: 'Music', clips: [{ essence: 'm', start: 24000, offset: 0, length: 240000, gain: 0.25 }] },
    ],
  }, extra);
  const r = await writeAAF(file, spec);
  return { r, a, b, m };
}

module.exports = {
  async 'writes a valid compound file with the AAF object tree'() {
    const file = path.join(tmp, 'one.aaf');
    const { r, a } = await sample(file);
    const buf = fs.readFileSync(file);
    assert.equal(buf.length, r.bytes);
    const cfb = readCfb(buf);
    assert.equal(cfb.major, 4);
    assert.equal(cfb.sectorSize, 4096);
    const top = cfb.children(cfb.root).map((e) => e.name).sort();
    assert.deepEqual(top, ['Header-2', 'MetaDictionary-1', 'properties', 'referenced properties']);
    const header = readProps(cfb.read(cfb.find('Header-2/properties')));
    assert.equal(utf16z(header[0x3b03]), 'Content-3b03');
    assert.equal(utf16z(header[0x3b04]), 'Dictionary-3b04');
    const index = cfb.read(cfb.find('Header-2/Content-3b03/Mobs-1901 index'));
    assert.equal(index.readUInt32LE(0), 1 + 3 * 2, 'one composition + master/source per essence');
    assert.equal(index.readUInt16LE(12), 0x4401, 'mobs keyed by MobID');
    // Embedded audio is byte-identical to what went in.
    const ess = cfb.children(cfb.find('Header-2/Content-3b03')).filter((e) => /^EssenceData-1902\{/.test(e.name));
    assert.equal(ess.length, 3);
    const first = cfb.read(cfb.children(ess[0]).find((e) => e.name === 'Data-2702'));
    assert.ok(first.subarray(0, a.length).equals(a));
    assert.deepEqual(cfb.problems, []);
  },

  async 'the composition references master clips that exist'() {
    const file = path.join(tmp, 'refs.aaf');
    await sample(file);
    const cfb = readCfb(fs.readFileSync(file));
    const content = cfb.find('Header-2/Content-3b03');
    const mobs = cfb.children(content).filter((e) => /^Mobs-1901\{/.test(e.name));
    const ids = new Set(mobs.map((m) => readProps(cfb.read(cfb.children(m).find((c) => c.name === 'properties')))[0x4401].toString('hex')));
    // Walk every SourceClip in the composition (the mob with a UsageCode).
    const comp = mobs.find((m) => readProps(cfb.read(cfb.children(m).find((c) => c.name === 'properties')))[0x4408]);
    assert.ok(comp, 'composition mob found');
    let clips = 0;
    const walk = (storage) => {
      for (const c of cfb.children(storage)) {
        if (c.type === 1) walk(c);
        else if (c.name === 'properties') {
          const p = readProps(cfb.read(c));
          if (p[0x1101] && p[0x1201] !== undefined) { clips++; assert.ok(ids.has(p[0x1101].toString('hex')), 'SourceID resolves'); }
        }
      }
    };
    walk(comp);
    assert.equal(clips, 4);
  },

  async 'never overwrites an existing file'() {
    const file = path.join(tmp, 'exists.aaf');
    fs.writeFileSync(file, 'keep me');
    await assert.rejects(sample(file), /EEXIST/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep me');
  },

  async 'large essences use DIFAT sectors correctly'() {
    if (!process.env.VR_BIG_TEST) skip('writes a ~465 MB file; run with VR_BIG_TEST=1');
    const file = path.join(tmp, 'big.aaf');
    const samples = 155e6; // ~465 MB, needs more than 109 FAT sectors
    let left = samples * 3;
    const chunk = Buffer.alloc(1 << 20, 3);
    const open = () => new Readable({ read() { if (left <= 0) return this.push(null); const n = Math.min(left, chunk.length); left -= n; this.push(chunk.subarray(0, n)); } });
    await writeAAF(file, {
      name: 'Big', sampleRate: 48000, fps: [25, 1], tcStart: 90000, duration: samples,
      essences: [{ id: 'x', name: 'long', open }],
      tracks: [{ name: 'A1', clips: [{ essence: 'x', start: 0, offset: 0, length: samples }] }],
    });
    const buf = fs.readFileSync(file);
    assert.ok(buf.readUInt32LE(72) >= 1, 'has DIFAT sectors');
    const cfb = readCfb(buf);
    assert.deepEqual(cfb.problems, []);
    // the big file is test output we created in a temp folder
    fs.writeFileSync(file, '');
  },

  async 'pyaaf2 + olefile read it (when installed)'() {
    const py = ['python3', 'python'].find((p) => { try { execFileSync(p, ['-c', 'import aaf2, olefile'], { stdio: 'ignore' }); return true; } catch { return false; } });
    if (!py) skip('python3 with pyaaf2 and olefile not installed');
    const file = path.join(tmp, 'py.aaf');
    await sample(file);
    const out = execFileSync(py, ['-c', `
import sys, olefile, aaf2
olefile.OleFileIO(sys.argv[1], raise_defects=olefile.DEFECT_INCORRECT)
with aaf2.open(sys.argv[1], 'r') as f:
    n = 0
    for obj, _ in f.header.walk_references():
        obj.validate(); n += 1
    comp = [m for m in f.content.mobs if m.classdef.class_name == 'CompositionMob'][0]
    for slot in comp.slots:
        seg = slot.segment
        if seg.classdef.class_name != 'Sequence': continue
        for c in seg.components:
            clip = c['InputSegments'][0] if c.classdef.class_name == 'OperationGroup' else c
            if clip.classdef.class_name == 'SourceClip':
                assert clip.mob.slots[0].segment.mob.essence is not None
    print(n)
`, file]).toString().trim();
    assert.ok(Number(out) > 50, 'validated objects: ' + out);
  },
};
