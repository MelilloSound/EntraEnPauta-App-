'use strict';
/*
 * AAF writer for Pro Tools hand-off. Zero dependencies.
 *
 * An AAF file is a Microsoft "compound file" (a little file system inside one
 * file) holding an object graph:
 *
 *   Header
 *   ├── Dictionary       data / container / operation definitions   ┐ copied from
 *   ├── MetaDictionary   every class and type the file uses         ┘ aaf-template.json
 *   └── ContentStorage
 *       ├── CompositionMob   the sequence: one mono audio track per slot
 *       ├── MasterMob ×N     one per source clip channel ("ad_v2.L")
 *       ├── SourceMob ×N     the media itself (PCM descriptor)
 *       └── EssenceData ×N   the embedded audio samples
 *
 * The layout mirrors what Pro Tools writes when it exports an AAF with
 * embedded audio: mono 24-bit PCM, edit rate = sample rate on every audio
 * slot, a timecode slot for the sequence start, and clip gain as a
 * "Mono Audio Gain" operation (the same way Premiere Pro writes it).
 *
 * Everything that changes per export is written here. The schema parts are
 * produced once by tools/make-aaf-template.py (pyaaf2) and copied verbatim.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEMPLATE = JSON.parse(fs.readFileSync(path.join(__dirname, 'aaf-template.json'), 'utf8'));

// ───────────────────────── identifiers ─────────────────────────

const CLASS = {
  Header: '0d010101-0101-2f00-060e-2b3402060101',
  ContentStorage: '0d010101-0101-1800-060e-2b3402060101',
  Identification: '0d010101-0101-3000-060e-2b3402060101',
  CompositionMob: '0d010101-0101-3500-060e-2b3402060101',
  MasterMob: '0d010101-0101-3600-060e-2b3402060101',
  SourceMob: '0d010101-0101-3700-060e-2b3402060101',
  TimelineMobSlot: '0d010101-0101-3b00-060e-2b3402060101',
  Sequence: '0d010101-0101-0f00-060e-2b3402060101',
  Filler: '0d010101-0101-0900-060e-2b3402060101',
  SourceClip: '0d010101-0101-1100-060e-2b3402060101',
  Timecode: '0d010101-0101-1400-060e-2b3402060101',
  OperationGroup: '0d010101-0101-0a00-060e-2b3402060101',
  ConstantValue: '0d010101-0101-3d00-060e-2b3402060101',
  PCMDescriptor: '0d010101-0101-4800-060e-2b3402060101',
  EssenceData: '0d010101-0101-2300-060e-2b3402060101',
};

const DATADEF_SOUND = '01030202-0200-0000-060e-2b3404010101';
const DATADEF_TIMECODE = '01030201-0100-0000-060e-2b3404010101';
const CONTAINERDEF_AAF = '4313b571-d8ba-11d2-809b-006008143e6f';
const OPDEF_MONO_GAIN = '9d2ea894-0968-11d3-8a38-0050040ef7d2';
const PARAMDEF_AMPLITUDE = 'e4962321-2267-11d3-8a4c-0050040ef7d2';
const TYPEDEF_RATIONAL = '03010100-0000-0000-060e-2b3401040101';
const USAGE_TOPLEVEL = '0d010102-0101-0700-060e-2b3404010101';
const OP_EDIT_PROTOCOL = '0d011201-0100-0000-060e-2b3404010105';
const PRODUCT_ID = '5c1b4f8e-7a2d-4b6e-9c41-3d2a8e6f0b17';

// Weak references point into the Dictionary through a table of property paths.
const PID_HEADER = 0x0002, PID_DICTIONARY = 0x3b04, PID_DEF_ID = 0x1b01;
const PATH_DATADEFS = [PID_HEADER, PID_DICTIONARY, 0x2605];
const PATH_CONTAINERDEFS = [PID_HEADER, PID_DICTIONARY, 0x2608];
const PATH_OPDEFS = [PID_HEADER, PID_DICTIONARY, 0x2603];

// Stored property formats
const SF_DATA = 0x82, SF_DATA_STREAM = 0x42, SF_STRONG = 0x22,
  SF_STRONG_VECTOR = 0x32, SF_STRONG_SET = 0x3a, SF_WEAK = 0x02;

// ───────────────────────── primitive encoders ─────────────────────────

const enc = {
  u8: (v) => { const b = Buffer.alloc(1); b.writeUInt8(v); return b; },
  i16: (v) => { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; },
  u16: (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; },
  u32: (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; },
  i64: (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.round(v))); return b; },
  bool: (v) => Buffer.from([v ? 1 : 0]),
  rational: (num, den) => { const b = Buffer.alloc(8); b.writeInt32LE(num); b.writeInt32LE(den, 4); return b; },
  string: (s) => Buffer.from(String(s) + '\0', 'utf16le'),
  // AUIDs are stored like Microsoft GUIDs: first three groups little-endian.
  auid: (str) => {
    const be = Buffer.from(str.replace(/-/g, ''), 'hex');
    if (be.length !== 16) throw new Error('bad AUID ' + str);
    return Buffer.concat([
      Buffer.from(be.subarray(0, 4)).reverse(),
      Buffer.from(be.subarray(4, 6)).reverse(),
      Buffer.from(be.subarray(6, 8)).reverse(),
      be.subarray(8),
    ]);
  },
  timestamp: (d) => {
    const b = Buffer.alloc(8);
    b.writeInt16LE(d.getFullYear(), 0);
    b.writeUInt8(d.getMonth() + 1, 2);
    b.writeUInt8(d.getDate(), 3);
    b.writeUInt8(d.getHours(), 4);
    b.writeUInt8(d.getMinutes(), 5);
    b.writeUInt8(d.getSeconds(), 6);
    b.writeUInt8(0, 7);
    return b;
  },
  versionType: (major, minor) => Buffer.from([major & 0xff, minor & 0xff]),
  productVersion: (major, minor, tertiary, patch, type) => {
    const b = Buffer.alloc(9);
    b.writeUInt16LE(major, 0); b.writeUInt16LE(minor, 2);
    b.writeUInt16LE(tertiary, 4); b.writeUInt16LE(patch, 6);
    b.writeUInt8(type, 8);
    return b;
  },
  // Indirect values carry their own type: byte order + type AUID + value.
  indirect: (typeAuid, value) => Buffer.concat([Buffer.from([0x4c]), enc.auid(typeAuid), value]),
};

/** A new SMPTE UMID (basic, UUID-based material number), as AAF MobIDs are. */
function newMobId() {
  const label = [0x06, 0x0a, 0x2b, 0x34, 0x01, 0x01, 0x01, 0x05, 0x01, 0x01, 0x0f, 0x20];
  const material = crypto.randomBytes(16);
  material[7] = (material[7] & 0x0f) | 0x40; // uuid4 version nibble (bytes_le order)
  material[8] = (material[8] & 0x3f) | 0x80;
  return Buffer.concat([Buffer.from(label), Buffer.from([0x13, 0, 0, 0]), material]);
}

// ───────────────────────── object model ─────────────────────────

/** Property-name mangling used for storage and stream names (≤ 31 UTF-16 chars). */
function squeeze(name, size) {
  if (name.length <= size) return name;
  const half = Math.floor(size / 2);
  let out = '';
  for (let i = 0; i < size; i++) {
    if (i < half) out += name[i];
    else if (i === half) out += '-';
    else out += name[name.length - (size - i)];
  }
  return out;
}
function mangle(name, pid, size) {
  const p = pid.toString(16);
  return squeeze(name, size - p.length - 2) + '-' + p;
}

class AAFObject {
  constructor(classAuid) {
    this.classAuid = classAuid;
    this.props = []; // { pid, fmt, data, kind?, ... }
  }
  data(pid, buf) { this.props.push({ pid, fmt: SF_DATA, data: buf }); return this; }
  strong(pid, name, obj) { this.props.push({ pid, fmt: SF_STRONG, kind: 'strong', name, obj }); return this; }
  vector(pid, name, objs) { this.props.push({ pid, fmt: SF_STRONG_VECTOR, kind: 'vector', name, objs }); return this; }
  set(pid, name, objs, keyPid, keyOf) {
    this.props.push({ pid, fmt: SF_STRONG_SET, kind: 'set', name, objs, keyPid, keyOf });
    return this;
  }
  weak(pid, tableIndex, keyPid, key) {
    const data = Buffer.concat([enc.u16(tableIndex), enc.u16(keyPid), enc.u8(key.length), key]);
    this.props.push({ pid, fmt: SF_WEAK, data });
    return this;
  }
  stream(pid, name, extent) { this.props.push({ pid, fmt: SF_DATA_STREAM, kind: 'stream', name, extent }); return this; }

  /** Serialises this object into a compound-file storage node. */
  toNode(storageName) {
    const node = { name: storageName, type: 'storage', clsid: enc.auid(this.classAuid), children: [] };
    const entries = [];
    for (const p of this.props) {
      let data = p.data;
      if (p.kind === 'strong') {
        const child = mangle(p.name, p.pid, 32);
        data = enc.string(child);
        node.children.push(p.obj.toNode(child));
      } else if (p.kind === 'vector' || p.kind === 'set') {
        const indexName = mangle(p.name, p.pid, 22);
        data = enc.string(indexName);
        const n = p.objs.length;
        const parts = [enc.u32(n), enc.u32(n), enc.u32(0xffffffff)];
        if (p.kind === 'set') {
          const keySize = p.keyOf(p.objs[0] || null)?.length || 16;
          parts.push(enc.u16(p.keyPid), enc.u8(keySize));
        }
        p.objs.forEach((obj, i) => {
          parts.push(enc.u32(i));
          if (p.kind === 'set') parts.push(enc.u32(1), p.keyOf(obj));
          node.children.push(obj.toNode(`${indexName}{${i.toString(16)}}`));
        });
        node.children.push({ name: indexName + ' index', type: 'stream', data: Buffer.concat(parts) });
      } else if (p.kind === 'stream') {
        const streamName = mangle(p.name, p.pid, 32);
        data = Buffer.concat([Buffer.from([0x55]), enc.string(streamName)]);
        node.children.push({ name: streamName, type: 'stream', extent: p.extent });
      }
      if (data.length > 0xffff) throw new Error('AAF property too large');
      entries.push({ pid: p.pid, fmt: p.fmt, data });
    }
    const head = Buffer.alloc(4 + entries.length * 6);
    head.writeUInt8(0x4c, 0);
    head.writeUInt8(32, 1); // property version
    head.writeUInt16LE(entries.length, 2);
    entries.forEach((e, i) => {
      head.writeUInt16LE(e.pid, 4 + i * 6);
      head.writeUInt16LE(e.fmt, 6 + i * 6);
      head.writeUInt16LE(e.data.length, 8 + i * 6);
    });
    node.children.push({ name: 'properties', type: 'stream', data: Buffer.concat([head, ...entries.map((e) => e.data)]) });
    return node;
  }
}

/** Turns the template's JSON tree back into storage nodes. */
function templateNode(t, rename) {
  if (t.children) {
    return {
      name: rename || t.name, type: 'storage', clsid: enc.auid(t.clsid),
      children: t.children.map((c) => templateNode(c)),
    };
  }
  return { name: t.name, type: 'stream', data: Buffer.from(t.data, 'base64') };
}

// ───────────────────────── compound file writer ─────────────────────────

const SECTOR = 4096, MINI_SECTOR = 64, MINI_CUTOFF = 4096;
const FREESECT = 0xffffffff, ENDOFCHAIN = 0xfffffffe, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;

const sectorOffset = (n) => (n + 1) * SECTOR; // sector 0 follows the 4 KB header sector

function compareNames(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  const A = a.toUpperCase(), B = b.toUpperCase();
  for (let i = 0; i < A.length; i++) {
    const d = A.charCodeAt(i) - B.charCodeAt(i);
    if (d) return d;
  }
  return 0;
}

/**
 * Siblings are stored as a red-black tree. A midpoint-built tree has every
 * level full except the deepest, so painting the deepest level red (when the
 * tree has more than one level) gives a valid red-black tree.
 */
function buildSiblingTree(children) {
  const sorted = children.slice().sort((x, y) => compareNames(x.name, y.name));
  let maxDepth = 0;
  const rec = (lo, hi, depth) => {
    if (lo > hi) return NOSTREAM;
    const mid = (lo + hi) >> 1;
    const n = sorted[mid];
    n.depth = depth;
    maxDepth = Math.max(maxDepth, depth);
    n.left = rec(lo, mid - 1, depth + 1);
    n.right = rec(mid + 1, hi, depth + 1);
    return n.id;
  };
  const root = rec(0, sorted.length - 1, 0);
  for (const n of sorted) n.color = (maxDepth > 0 && n.depth === maxDepth) ? 0 : 1;
  return root;
}

function dirEntry(n) {
  const b = Buffer.alloc(128);
  b.writeUInt32LE(NOSTREAM, 68); b.writeUInt32LE(NOSTREAM, 72); b.writeUInt32LE(NOSTREAM, 76);
  if (!n) return b;
  if (n.name.length > 31) throw new Error('compound file name too long: ' + n.name);
  b.write(n.name, 0, 'utf16le');
  b.writeUInt16LE((n.name.length + 1) * 2, 64);
  b.writeUInt8(n.type === 'root' ? 5 : n.type === 'storage' ? 1 : 2, 66);
  b.writeUInt8(n.color ?? 1, 67);
  b.writeUInt32LE(n.left ?? NOSTREAM, 68);
  b.writeUInt32LE(n.right ?? NOSTREAM, 72);
  b.writeUInt32LE(n.child ?? NOSTREAM, 76);
  if (n.clsid) n.clsid.copy(b, 80);
  if (n.type !== 'storage') {
    b.writeUInt32LE(n.start ?? ENDOFCHAIN, 116);
    b.writeBigUInt64LE(BigInt(n.size || 0), 120);
  }
  return b;
}

/**
 * Writes everything except the pre-written essence streams, then the header.
 * `next` is the first free sector after the essences.
 */
async function finishCompoundFile(fh, root, next, chains) {
  const entries = [];
  const walk = (n) => { n.id = entries.length; entries.push(n); (n.children || []).forEach(walk); };
  walk(root);
  for (const n of entries) if (n.children) n.child = n.children.length ? buildSiblingTree(n.children) : NOSTREAM;
  root.color = 1; root.left = NOSTREAM; root.right = NOSTREAM;

  // Small streams live in the mini stream (64-byte mini sectors).
  const miniFat = [];
  const miniParts = [];
  const regular = [];
  for (const n of entries) {
    if (n.type !== 'stream' || n.extent) continue;
    const size = n.data.length;
    n.size = size;
    if (size === 0) { n.start = ENDOFCHAIN; continue; }
    if (size >= MINI_CUTOFF) { regular.push(n); continue; }
    const count = Math.ceil(size / MINI_SECTOR);
    n.start = miniFat.length;
    for (let i = 0; i < count; i++) miniFat.push(i < count - 1 ? n.start + i + 1 : ENDOFCHAIN);
    miniParts.push(n.data, Buffer.alloc(count * MINI_SECTOR - size));
  }
  for (const n of entries) if (n.extent) { n.start = n.extent.sector; n.size = n.extent.size; }

  const writeSectors = async (buf) => {
    const start = next;
    const count = Math.ceil(buf.length / SECTOR);
    const padded = buf.length === count * SECTOR ? buf : Buffer.concat([buf, Buffer.alloc(count * SECTOR - buf.length)]);
    await fh.write(padded, 0, padded.length, sectorOffset(start));
    chains.push({ start, count });
    next += count;
    return { start, count };
  };

  for (const n of regular) n.start = (await writeSectors(n.data)).start;

  if (miniParts.length) {
    const mini = Buffer.concat(miniParts);
    root.start = (await writeSectors(mini)).start;
    root.size = mini.length;
  } else {
    root.start = ENDOFCHAIN; root.size = 0;
  }

  const perDirSector = SECTOR / 128;
  const dirSlots = Math.ceil(entries.length / perDirSector) * perDirSector;
  const dirBuf = Buffer.concat(Array.from({ length: dirSlots }, (_, i) => dirEntry(entries[i])));
  const dir = await writeSectors(dirBuf);

  let miniFatInfo = { start: ENDOFCHAIN, count: 0 };
  if (miniFat.length) {
    const words = Math.ceil(miniFat.length / (SECTOR / 4)) * (SECTOR / 4);
    const mf = Buffer.alloc(words * 4, 0xff);
    miniFat.forEach((v, i) => mf.writeUInt32LE(v, i * 4));
    miniFatInfo = await writeSectors(mf);
  }

  // FAT sectors cover every sector including themselves and the DIFAT.
  let fatCount = 1, difatCount = 0;
  for (;;) {
    difatCount = fatCount > 109 ? Math.ceil((fatCount - 109) / 1023) : 0;
    if (fatCount * 1024 >= next + fatCount + difatCount) break;
    fatCount++;
  }
  const fatStart = next;
  const difatStart = next + fatCount;
  const fat = new Uint32Array(fatCount * 1024).fill(FREESECT);
  for (const c of chains) {
    for (let i = 0; i < c.count; i++) fat[c.start + i] = i < c.count - 1 ? c.start + i + 1 : ENDOFCHAIN;
  }
  for (let i = 0; i < fatCount; i++) fat[fatStart + i] = FATSECT;
  for (let i = 0; i < difatCount; i++) fat[difatStart + i] = DIFSECT;
  const fatBuf = Buffer.from(fat.buffer);
  await fh.write(fatBuf, 0, fatBuf.length, sectorOffset(fatStart));

  const fatSectors = Array.from({ length: fatCount }, (_, i) => fatStart + i);
  for (let d = 0; d < difatCount; d++) {
    const b = Buffer.alloc(SECTOR, 0xff);
    const slice = fatSectors.slice(109 + d * 1023, 109 + (d + 1) * 1023);
    slice.forEach((s, i) => b.writeUInt32LE(s, i * 4));
    b.writeUInt32LE(d < difatCount - 1 ? difatStart + d + 1 : ENDOFCHAIN, 1023 * 4);
    await fh.write(b, 0, SECTOR, sectorOffset(difatStart + d));
  }

  const h = Buffer.alloc(SECTOR);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(h, 0);
  h.writeUInt16LE(0x003e, 24);
  h.writeUInt16LE(0x0004, 26);
  h.writeUInt16LE(0xfffe, 28);
  h.writeUInt16LE(12, 30); // 4096-byte sectors
  h.writeUInt16LE(6, 32);  // 64-byte mini sectors
  h.writeUInt32LE(dir.count, 40);
  h.writeUInt32LE(fatCount, 44);
  h.writeUInt32LE(dir.start, 48);
  h.writeUInt32LE(0, 52);
  h.writeUInt32LE(MINI_CUTOFF, 56);
  h.writeUInt32LE(miniFatInfo.start, 60);
  h.writeUInt32LE(miniFatInfo.count, 64);
  h.writeUInt32LE(difatCount ? difatStart : ENDOFCHAIN, 68);
  h.writeUInt32LE(difatCount, 72);
  for (let i = 0; i < 109; i++) h.writeUInt32LE(i < fatCount ? fatSectors[i] : FREESECT, 76 + i * 4);
  await fh.write(h, 0, SECTOR, 0);
  return sectorOffset(next + fatCount + difatCount);
}

// ───────────────────────── AAF building ─────────────────────────

function component(classAuid, dataDefIndex, dataDef, length) {
  return new AAFObject(classAuid)
    .weak(0x0201, dataDefIndex, PID_DEF_ID, enc.auid(dataDef))
    .data(0x0202, enc.i64(length));
}

function timelineSlot(slotId, name, editRate, segment, trackNumber) {
  const o = new AAFObject(CLASS.TimelineMobSlot)
    .data(0x4801, enc.u32(slotId))
    .data(0x4802, enc.string(name))
    .data(0x4b02, enc.i64(0))
    .data(0x4b01, enc.rational(editRate[0], editRate[1]))
    .strong(0x4803, 'Segment', segment);
  if (trackNumber) o.data(0x4804, enc.u32(trackNumber));
  return o;
}

function mob(classAuid, mobId, name, now, slots) {
  return new AAFObject(classAuid)
    .data(0x4401, mobId)
    .data(0x4402, enc.string(name))
    .data(0x4405, enc.timestamp(now))
    .data(0x4404, enc.timestamp(now))
    .vector(0x4403, 'Slots', slots);
}

async function writeAt(fh, buf, pos) {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, pos + off);
    off += bytesWritten;
  }
}

/**
 * Writes an AAF file with embedded mono 24-bit PCM audio.
 *
 * spec = {
 *   name:        sequence name shown in Pro Tools
 *   sampleRate:  e.g. 48000
 *   fps:         [num, den] timecode frame rate, e.g. [30000, 1001]
 *   tcStart:     timecode start in frames (01:00:00:00 at 30 fps = 108000)
 *   dropFrame:   boolean
 *   duration:    sequence length in samples
 *   essences:    [{ id, name, open() -> Readable of raw s24le mono samples }]
 *   tracks:      [{ name, clips: [{ essence, start, offset, length, gain }] }]  (all in samples)
 * }
 *
 * The output path must not exist: the file is created exclusively, so an
 * export can never overwrite anything.
 */
async function writeAAF(outPath, spec, onProgress = () => {}) {
  const now = new Date();
  const rate = spec.sampleRate;
  const audioRate = [rate, 1];
  const weakTable = TEMPLATE.weakRefTable.map((p) => p.slice());
  const weakIndex = (p) => {
    let i = weakTable.findIndex((q) => q.length === p.length && q.every((v, k) => v === p[k]));
    if (i < 0) { weakTable.push(p.slice()); i = weakTable.length - 1; }
    return i;
  };
  const DD = weakIndex(PATH_DATADEFS);

  const fh = await fs.promises.open(outPath, 'wx');
  try {
    // 1. Stream every essence straight into the file, right after the header.
    const chains = [];
    let next = 0;
    const essenceInfo = new Map();
    for (let e = 0; e < spec.essences.length; e++) {
      const ess = spec.essences[e];
      onProgress({ step: 'audio', index: e, total: spec.essences.length, name: ess.name });
      const start = next;
      let pos = sectorOffset(start);
      let size = 0;
      for await (const chunk of ess.open()) {
        await writeAt(fh, chunk, pos);
        pos += chunk.length;
        size += chunk.length;
      }
      const samples = Math.floor(size / 3);
      size = samples * 3;
      if (size < MINI_CUTOFF) { // keep essences out of the mini stream
        await writeAt(fh, Buffer.alloc(MINI_CUTOFF - size), sectorOffset(start) + size);
        size = MINI_CUTOFF;
      }
      const count = Math.max(1, Math.ceil(size / SECTOR));
      chains.push({ start, count });
      next += count;
      essenceInfo.set(ess.id, { samples, extent: { sector: start, size } });
    }
    onProgress({ step: 'structure' });

    // 2. Media objects: one SourceMob + MasterMob + EssenceData per mono essence.
    const mobs = [];
    const essenceData = [];
    const masterIds = new Map();
    const CF = weakIndex(PATH_CONTAINERDEFS);
    for (const ess of spec.essences) {
      const info = essenceInfo.get(ess.id);
      const sourceId = newMobId();
      const masterId = newMobId();
      masterIds.set(ess.id, masterId);

      const descriptor = new AAFObject(CLASS.PCMDescriptor)
        .data(0x3001, enc.rational(rate, 1))
        .data(0x3002, enc.i64(info.samples))
        .weak(0x3004, CF, PID_DEF_ID, enc.auid(CONTAINERDEF_AAF))
        .data(0x3d03, enc.rational(rate, 1))
        .data(0x3d07, enc.u32(1))
        .data(0x3d01, enc.u32(24))
        .data(0x3d0a, enc.u16(3))
        .data(0x3d09, enc.u32(rate * 3));

      const endOfChain = component(CLASS.SourceClip, DD, DATADEF_SOUND, info.samples)
        .data(0x1201, enc.i64(0))
        .data(0x1101, Buffer.alloc(32))
        .data(0x1102, enc.u32(0));
      const sourceMob = mob(CLASS.SourceMob, sourceId, ess.name, now, [
        timelineSlot(1, '', audioRate, endOfChain, 1),
      ]).strong(0x4701, 'EssenceDescription', descriptor);

      const toSource = component(CLASS.SourceClip, DD, DATADEF_SOUND, info.samples)
        .data(0x1201, enc.i64(0))
        .data(0x1101, sourceId)
        .data(0x1102, enc.u32(1));
      const masterMob = mob(CLASS.MasterMob, masterId, ess.name, now, [
        timelineSlot(1, ess.name, audioRate, toSource, 1),
      ]);

      mobs.push(masterMob, sourceMob);
      essenceData.push(new AAFObject(CLASS.EssenceData)
        .data(0x2701, sourceId)
        .stream(0x2702, 'Data', info.extent));
    }

    // 3. The sequence.
    const OP = weakIndex(PATH_OPDEFS);
    const duration = Math.max(1, Math.round(spec.duration));
    const slots = [];
    spec.tracks.forEach((track, t) => {
      const components = [];
      let cursor = 0;
      const clips = track.clips
        .map((c) => ({ ...c, start: Math.round(c.start), offset: Math.round(c.offset), length: Math.round(c.length) }))
        .sort((a, b) => a.start - b.start);
      for (const c of clips) {
        const info = essenceInfo.get(c.essence);
        if (!info) continue;
        const start = Math.max(c.start, cursor); // no overlaps inside one track
        const offset = Math.min(Math.max(0, c.offset + (start - c.start)), info.samples);
        const length = Math.min(c.length - (start - c.start), info.samples - offset, duration - start);
        if (length <= 0) continue;
        if (start > cursor) components.push(component(CLASS.Filler, DD, DATADEF_SOUND, start - cursor));
        let seg = component(CLASS.SourceClip, DD, DATADEF_SOUND, length)
          .data(0x1201, enc.i64(offset))
          .data(0x1101, masterIds.get(c.essence))
          .data(0x1102, enc.u32(1));
        const gain = c.gain ?? 1;
        if (Math.abs(gain - 1) > 1e-4) {
          const den = 1 << 24;
          const num = Math.max(0, Math.min(0x7fffffff, Math.round(gain * den)));
          const amplitude = new AAFObject(CLASS.ConstantValue)
            .data(0x4c01, enc.auid(PARAMDEF_AMPLITUDE))
            .data(0x4d01, enc.indirect(TYPEDEF_RATIONAL, enc.rational(num, den)));
          seg = component(CLASS.OperationGroup, DD, DATADEF_SOUND, length)
            .weak(0x0b01, OP, PID_DEF_ID, enc.auid(OPDEF_MONO_GAIN))
            .vector(0x0b02, 'InputSegments', [seg])
            .set(0x0b03, 'Parameters', [amplitude], 0x4c01, () => enc.auid(PARAMDEF_AMPLITUDE));
        }
        components.push(seg);
        cursor = start + length;
      }
      if (cursor < duration) components.push(component(CLASS.Filler, DD, DATADEF_SOUND, duration - cursor));
      const seq = component(CLASS.Sequence, DD, DATADEF_SOUND, duration)
        .vector(0x1001, 'Components', components);
      slots.push(timelineSlot(t + 1, track.name, audioRate, seq, t + 1));
    });

    const [fpsNum, fpsDen] = spec.fps;
    const fpsRounded = Math.round(fpsNum / fpsDen);
    const tcLength = Math.max(1, Math.ceil((duration / rate) * fpsNum / fpsDen));
    const tc = component(CLASS.Timecode, DD, DATADEF_TIMECODE, tcLength)
      .data(0x1501, enc.i64(spec.tcStart || 0))
      .data(0x1502, enc.u16(fpsRounded))
      .data(0x1503, enc.bool(!!spec.dropFrame));
    slots.push(timelineSlot(spec.tracks.length + 1, 'TC1', [fpsNum, fpsDen], tc, 1));

    const composition = mob(CLASS.CompositionMob, newMobId(), spec.name, now, slots)
      .data(0x4408, enc.auid(USAGE_TOPLEVEL));
    mobs.unshift(composition);

    // 4. Header.
    const ident = new AAFObject(CLASS.Identification)
      .data(0x3c01, enc.string('Melillo Sound'))
      .data(0x3c02, enc.string('Video Review'))
      .data(0x3c03, enc.productVersion(1, 0, 0, 0, 1))
      .data(0x3c04, enc.string('1.0.0'))
      .data(0x3c05, enc.auid(PRODUCT_ID))
      .data(0x3c06, enc.timestamp(now))
      .data(0x3c08, enc.string(process.platform))
      .data(0x3c09, enc.auid(crypto.randomUUID()));

    const content = new AAFObject(CLASS.ContentStorage)
      .set(0x1901, 'Mobs', mobs, 0x4401, (m) => m.props.find((p) => p.pid === 0x4401).data)
      .set(0x1902, 'EssenceData', essenceData, 0x2701, (e) => e.props.find((p) => p.pid === 0x2701).data);

    const header = new AAFObject(CLASS.Header)
      .data(0x3b01, enc.i16(0x4949))
      .data(0x3b02, enc.timestamp(now))
      .strong(0x3b03, 'Content', content)
      .data(0x3b05, enc.versionType(1, 2))
      .vector(0x3b06, 'IdentificationList', [ident])
      .data(0x3b07, enc.u32(1))
      .data(0x3b09, enc.auid(OP_EDIT_PROTOCOL));
    // The Dictionary comes from the template; only its reference is written here.
    header.props.push({ pid: PID_DICTIONARY, fmt: SF_STRONG, data: enc.string('Dictionary-3b04') });

    const headerNode = header.toNode('Header-2');
    headerNode.children.push(templateNode(TEMPLATE.dictionary, 'Dictionary-3b04'));

    // Root object: MetaDictionary + Header, plus the weak-reference path table.
    const rootProps = new AAFObject(TEMPLATE.rootClsid);
    rootProps.props.push({ pid: 0x0001, fmt: SF_STRONG, data: enc.string('MetaDictionary-1') });
    rootProps.props.push({ pid: 0x0002, fmt: SF_STRONG, data: enc.string('Header-2') });
    const rootPropsNode = rootProps.toNode('x').children.find((c) => c.name === 'properties');

    let pidCount = 0;
    for (const p of weakTable) pidCount += p.length + 1;
    const refs = Buffer.alloc(7 + pidCount * 2);
    refs.writeUInt8(0x4c, 0);
    refs.writeUInt16LE(weakTable.length, 1);
    refs.writeUInt32LE(pidCount, 3);
    let o = 7;
    for (const p of weakTable) {
      for (const pid of p) { refs.writeUInt16LE(pid, o); o += 2; }
      refs.writeUInt16LE(0, o); o += 2;
    }

    const root = {
      name: 'Root Entry', type: 'root', clsid: enc.auid(TEMPLATE.rootClsid),
      children: [
        templateNode(TEMPLATE.metaDictionary, 'MetaDictionary-1'),
        headerNode,
        rootPropsNode,
        { name: 'referenced properties', type: 'stream', data: refs },
      ],
    };

    onProgress({ step: 'finish' });
    const bytes = await finishCompoundFile(fh, root, next, chains);
    await fh.truncate(bytes);
    return { bytes, essences: [...essenceInfo.entries()].map(([id, v]) => ({ id, samples: v.samples })) };
  } finally {
    await fh.close();
  }
}

module.exports = { writeAAF, _internal: { mangle, squeeze, enc, compareNames } };
