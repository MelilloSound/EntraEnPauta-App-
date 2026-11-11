'use strict';
/*
 * A small, independent compound-file (CFB) reader used only by the tests to
 * check what lib/aaf.js writes: header, FAT chains, directory tree, streams.
 */

const ENDOFCHAIN = 0xfffffffe, FREESECT = 0xffffffff, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc, NOSTREAM = 0xffffffff;

function readCfb(buf) {
  const problems = [];
  if (buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) throw new Error('not a compound file');
  const major = buf.readUInt16LE(26);
  const SS = 1 << buf.readUInt16LE(30);
  const MS = 1 << buf.readUInt16LE(32);
  const numFat = buf.readUInt32LE(44);
  const firstDir = buf.readUInt32LE(48);
  const cutoff = buf.readUInt32LE(56);
  const firstMiniFat = buf.readUInt32LE(60);
  const firstDifat = buf.readUInt32LE(68);
  const numDifat = buf.readUInt32LE(72);
  const off = (n) => (n + 1) * SS;

  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) fatSectors.push(buf.readUInt32LE(76 + i * 4));
  let d = firstDifat;
  for (let k = 0; k < numDifat; k++) {
    for (let i = 0; i < SS / 4 - 1 && fatSectors.length < numFat; i++) fatSectors.push(buf.readUInt32LE(off(d) + i * 4));
    d = buf.readUInt32LE(off(d) + SS - 4);
  }
  const fat = [];
  for (const s of fatSectors) for (let i = 0; i < SS / 4; i++) fat.push(buf.readUInt32LE(off(s) + i * 4));
  for (const s of fatSectors) if (fat[s] !== FATSECT) problems.push(`FAT sector ${s} not marked FATSECT`);

  const used = new Map();
  function chain(start, label) {
    const out = [];
    let s = start;
    while (s !== ENDOFCHAIN) {
      if (s >= fat.length || s === FREESECT || s === FATSECT || s === DIFSECT) { problems.push(`bad chain in ${label} at ${s}`); break; }
      if (used.has(s)) { problems.push(`sector ${s} used by ${used.get(s)} and ${label}`); break; }
      used.set(s, label);
      out.push(s);
      s = fat[s];
    }
    return out;
  }
  const readChain = (start, size, label) => {
    const parts = chain(start, label).map((s) => buf.subarray(off(s), off(s) + SS));
    return Buffer.concat(parts).subarray(0, size);
  };

  const dirBuf = Buffer.concat(chain(firstDir, 'directory').map((s) => buf.subarray(off(s), off(s) + SS)));
  const entries = [];
  for (let i = 0; i * 128 < dirBuf.length; i++) {
    const e = dirBuf.subarray(i * 128, i * 128 + 128);
    const nameLen = e.readUInt16LE(64);
    entries.push({
      id: i,
      name: e.subarray(0, Math.max(0, nameLen - 2)).toString('utf16le'),
      type: e[66], color: e[67],
      left: e.readUInt32LE(68), right: e.readUInt32LE(72), child: e.readUInt32LE(76),
      clsid: e.subarray(80, 96),
      start: e.readUInt32LE(116),
      size: major === 3 ? e.readUInt32LE(120) : Number(e.readBigUInt64LE(120)),
    });
  }
  const root = entries[0];
  const mini = root.size ? readChain(root.start, root.size, 'ministream') : Buffer.alloc(0);
  const miniFat = [];
  if (firstMiniFat !== ENDOFCHAIN) {
    const mf = readChain(firstMiniFat, Infinity, 'minifat');
    for (let i = 0; i < mf.length / 4; i++) miniFat.push(mf.readUInt32LE(i * 4));
  }

  function read(e) {
    if (e.size === 0) return Buffer.alloc(0);
    if (e.size < cutoff) {
      const parts = [];
      let s = e.start, guard = 0;
      while (s !== ENDOFCHAIN && guard++ < 1e7) { parts.push(mini.subarray(s * MS, s * MS + MS)); s = miniFat[s]; }
      return Buffer.concat(parts).subarray(0, e.size);
    }
    return readChain(e.start, e.size, e.name);
  }

  const cmp = (a, b) => (a.length !== b.length ? a.length - b.length : (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0));
  function children(e) {
    const out = [];
    const walk = (id, lo, hi, depth) => {
      if (id === NOSTREAM) return 0;
      const n = entries[id];
      if (lo && cmp(n.name, lo) <= 0) problems.push(`sibling order broken at ${n.name}`);
      if (hi && cmp(n.name, hi) >= 0) problems.push(`sibling order broken at ${n.name}`);
      const l = n.left !== NOSTREAM ? entries[n.left] : null, r = n.right !== NOSTREAM ? entries[n.right] : null;
      if (n.color === 0 && ((l && l.color === 0) || (r && r.color === 0))) problems.push(`red-red at ${n.name}`);
      const bl = walk(n.left, lo, n.name, depth + 1);
      out.push(n);
      const br = walk(n.right, n.name, hi, depth + 1);
      if (bl !== br) problems.push(`black height differs at ${n.name}`);
      return bl + (n.color === 1 ? 1 : 0);
    };
    if (e.child !== NOSTREAM && entries[e.child].color !== 1) problems.push(`red tree root under ${e.name}`);
    walk(e.child, null, null, 0);
    return out;
  }
  function find(p) {
    let cur = root;
    for (const part of p.split('/').filter(Boolean)) {
      cur = children(cur).find((c) => c.name === part);
      if (!cur) return null;
    }
    return cur;
  }
  return { major, sectorSize: SS, entries, root, read, children, find, problems };
}

/** Parses an AAF "properties" stream into { pid: Buffer }. */
function readProps(buf) {
  const n = buf.readUInt16LE(2);
  const out = {};
  let o = 4 + n * 6;
  for (let i = 0; i < n; i++) {
    const pid = buf.readUInt16LE(4 + i * 6), size = buf.readUInt16LE(8 + i * 6);
    out[pid] = buf.subarray(o, o + size);
    o += size;
  }
  return out;
}

const utf16z = (b) => b.toString('utf16le').replace(/\0+$/, '');

module.exports = { readCfb, readProps, utf16z };
