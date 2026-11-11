'use strict';
/*
 * Every write the app makes goes through this file.
 *
 * The promise: the app never deletes, moves or overwrites your files.
 *   - New files are created with the exclusive flag ("wx"): if a file with that
 *     name exists, the OS refuses and we pick "name (2).ext" instead.
 *   - The only file ever replaced is the app's own notes file
 *     (.review/review.json, .video-review.json), and the previous version is
 *     first copied into .review/history/.
 *   - There is no delete call anywhere in this app (test/safety.test.js checks
 *     the source code for one).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OWN_JSON = new Set(['review.json', '.video-review.json']);

function splitName(name) {
  const ext = path.extname(name);
  return { base: name.slice(0, name.length - ext.length), ext };
}

/** Make a file name safe for any OS (no separators, no control characters). */
function cleanName(name, fallback = 'untitled') {
  const cleaned = String(name || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

/** Creates a brand-new file, never touching an existing one. Returns { fh, path, name }. */
async function createUniqueFile(dir, name) {
  const { base, ext } = splitName(cleanName(name));
  for (let i = 1; i < 10000; i++) {
    const candidate = i === 1 ? base + ext : `${base} (${i})${ext}`;
    const full = path.join(dir, candidate);
    try {
      const fh = await fs.promises.open(full, 'wx');
      return { fh, path: full, name: candidate };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not find a free file name in ' + dir);
}

/** Creates a brand-new folder ("name", "name (2)", …). Returns its path. */
async function createUniqueDir(parent, name) {
  const clean = cleanName(name);
  for (let i = 1; i < 10000; i++) {
    const candidate = i === 1 ? clean : `${clean} (${i})`;
    const full = path.join(parent, candidate);
    try {
      await fs.promises.mkdir(full);
      return full;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not find a free folder name in ' + parent);
}

async function writeNewFile(dir, name, data) {
  const { fh, path: full, name: finalName } = await createUniqueFile(dir, name);
  try { await fh.writeFile(data); } finally { await fh.close(); }
  return { path: full, name: finalName };
}

/** Pipes a readable stream into a brand-new file. */
async function streamToNewFile(dir, name, readable, limitBytes = Infinity) {
  const { fh, path: full, name: finalName } = await createUniqueFile(dir, name);
  let bytes = 0;
  try {
    for await (const chunk of readable) {
      bytes += chunk.length;
      if (bytes > limitBytes) throw new Error('File is larger than allowed');
      await fh.write(chunk);
    }
  } finally {
    await fh.close();
  }
  return { path: full, name: finalName, bytes };
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Replaces one of the app's own JSON files atomically. The old version is
 * copied into historyDir first (at most once every `historyEveryMs`).
 */
const lastSnapshot = new Map();
async function replaceOwnJson(file, data, historyDir, historyEveryMs = 120000) {
  if (!OWN_JSON.has(path.basename(file))) throw new Error('Refusing to replace ' + file);
  if (historyDir) {
    const last = lastSnapshot.get(file) || 0;
    if (Date.now() - last > historyEveryMs) {
      try {
        const previous = await fs.promises.readFile(file);
        await ensureDir(historyDir);
        await writeNewFile(historyDir, `${path.basename(file, '.json')} ${stamp()}.json`, previous);
        lastSnapshot.set(file, Date.now());
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), { flag: 'wx' });
  await fs.promises.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** True if `child` is inside `parent` (after resolving). */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = {
  cleanName, createUniqueFile, createUniqueDir, writeNewFile, streamToNewFile,
  ensureDir, replaceOwnJson, readJson, isInside, stamp,
};
