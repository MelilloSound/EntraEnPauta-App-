'use strict';
/*
 * Projects are plain folders. Every folder inside the projects folder is a
 * project, and you can also add ("link") a folder from anywhere else, such as
 * an external drive. Clips are the video files directly inside the folder.
 *
 * The app keeps its own notes in a hidden ".review" folder inside each
 * project (comments, edits, frame stills, caches) and writes exports to an
 * "Exports" folder. It never changes anything else.
 */

const fs = require('fs');
const path = require('path');
const safe = require('./safe-fs');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpg', '.mpeg', '.mts', '.m2ts', '.3gp', '.ogv']);
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.aif', '.aiff', '.flac', '.ogg', '.opus', '.caf', '.wma']);
const DATA_DIR = '.review';
const EXPORTS_DIR = 'Exports';

const kindOf = (name) => {
  const ext = path.extname(name).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
};

const encodeId = (abs) => Buffer.from(abs, 'utf8').toString('base64url');
const decodeId = (id) => Buffer.from(String(id), 'base64url').toString('utf8');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const emptyReview = () => ({ app: 'video-review', version: 1, rev: 0, clips: {} });

class Projects {
  constructor(root) {
    this.root = path.resolve(root);
    this.configPath = path.join(this.root, '.video-review.json');
    this.locks = new Map();
  }

  async init() {
    await safe.ensureDir(this.root);
  }

  async config() {
    const c = await safe.readJson(this.configPath, {});
    c.linked = Array.isArray(c.linked) ? c.linked : [];
    return c;
  }

  dataDir(dir) { return path.join(dir, DATA_DIR); }
  exportsDir(dir) { return path.join(dir, EXPORTS_DIR); }

  /** Turns a project id back into a folder path, refusing anything that is not a known project. */
  async resolve(id) {
    let abs;
    try { abs = path.resolve(decodeId(id)); } catch { throw httpError(404, 'Unknown project'); }
    const parentIsRoot = path.dirname(abs) === this.root && !path.basename(abs).startsWith('.');
    const linked = parentIsRoot ? false : (await this.config()).linked.includes(abs);
    if (!parentIsRoot && !linked) throw httpError(404, 'Unknown project');
    let st;
    try { st = await fs.promises.stat(abs); } catch { throw httpError(404, 'Project folder not found: ' + abs); }
    if (!st.isDirectory()) throw httpError(404, 'Not a folder');
    return { dir: abs, linked, id: encodeId(abs) };
  }

  async mediaFiles(dir) {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const kind = kindOf(name);
      if (!kind) continue;
      try {
        const st = await fs.promises.stat(path.join(dir, name));
        if (!st.isFile()) continue;
        out.push({ name, kind, size: st.size, mtime: st.mtimeMs, created: st.birthtimeMs || st.ctimeMs });
      } catch { /* vanished while listing */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  async summary(dir, linked) {
    const st = await fs.promises.stat(dir);
    const files = await this.mediaFiles(dir);
    const review = await this.readReview(dir).catch(() => emptyReview());
    const videos = files.filter((f) => f.kind === 'video');
    let open = 0, total = 0, edited = 0;
    for (const clip of Object.values(review.clips || {})) {
      for (const c of clip.comments || []) { total++; if (!c.done) open++; }
      if (clip.edited) edited++;
    }
    const created = st.birthtimeMs || st.ctimeMs;
    const newestMedia = files.reduce((m, f) => Math.max(m, f.mtime), 0);
    const posterFile = videos.length ? await this.posterFor(dir, videos[videos.length - 1]) : null;
    return {
      id: encodeId(dir),
      name: path.basename(dir),
      path: dir,
      linked: !!linked,
      created,
      updated: Math.max(created, newestMedia),
      clips: videos.length,
      audio: files.length - videos.length,
      comments: { open, total },
      edited,
      poster: posterFile,
      latestClip: videos.length ? videos.reduce((a, b) => (b.mtime > a.mtime ? b : a)).name : null,
    };
  }

  async posterFor(dir, file) {
    const name = posterName(file);
    try {
      await fs.promises.access(path.join(this.dataDir(dir), 'cache', name));
      return 'cache/' + name;
    } catch { return null; }
  }

  /** All projects, newest first. */
  async list() {
    const out = [];
    let names = [];
    try { names = await fs.promises.readdir(this.root, { withFileTypes: true }); } catch { /* empty */ }
    for (const d of names) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      try { out.push(await this.summary(path.join(this.root, d.name), false)); } catch { /* unreadable */ }
    }
    for (const abs of (await this.config()).linked) {
      try { out.push(await this.summary(abs, true)); } catch {
        out.push({ id: encodeId(abs), name: path.basename(abs), path: abs, linked: true, missing: true, updated: 0, created: 0, clips: 0, audio: 0, comments: { open: 0, total: 0 } });
      }
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async create(name) {
    const dir = await safe.createUniqueDir(this.root, name || 'New project');
    return this.summary(dir, false);
  }

  async link(folder) {
    const abs = path.resolve(String(folder || '').trim().replace(/^~(?=$|\/|\\)/, require('os').homedir()));
    let st;
    try { st = await fs.promises.stat(abs); } catch { throw httpError(400, 'That folder does not exist: ' + abs); }
    if (!st.isDirectory()) throw httpError(400, 'That is a file, not a folder.');
    if (path.dirname(abs) === this.root) return this.summary(abs, false);
    if (abs === path.parse(abs).root || abs === require('os').homedir()) throw httpError(400, 'Pick a specific project folder, not a whole drive or your home folder.');
    await this.withLock('config', async () => {
      const c = await this.config();
      if (!c.linked.includes(abs)) c.linked.push(abs);
      await safe.replaceOwnJson(this.configPath, c, null);
    });
    return this.summary(abs, true);
  }

  /** Takes an added folder off the list. The folder itself is not touched. */
  async forget(id) {
    const abs = path.resolve(decodeId(id));
    await this.withLock('config', async () => {
      const c = await this.config();
      c.linked = c.linked.filter((p) => p !== abs);
      await safe.replaceOwnJson(this.configPath, c, null);
    });
  }

  reviewFile(dir) { return path.join(this.dataDir(dir), 'review.json'); }

  async readReview(dir) {
    const data = await safe.readJson(this.reviewFile(dir), null);
    if (!data || typeof data !== 'object') return emptyReview();
    data.clips = data.clips || {};
    data.rev = data.rev || 0;
    return data;
  }

  /** Saves notes. Refuses (409) if another window saved in between. */
  async saveReview(dir, baseRev, data) {
    return this.withLock(dir, async () => {
      const current = await this.readReview(dir);
      if ((current.rev || 0) !== baseRev) throw Object.assign(httpError(409, 'Changed in another window'), { current });
      const next = Object.assign({}, data, { app: 'video-review', version: 1, rev: (current.rev || 0) + 1, saved: new Date().toISOString() });
      await safe.ensureDir(this.dataDir(dir));
      await safe.replaceOwnJson(this.reviewFile(dir), next, path.join(this.dataDir(dir), 'history'));
      return next;
    });
  }

  async withLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(key, run.catch(() => {}));
    return run;
  }
}

/** Cache file name for a clip's poster frame, tied to the file's size and date. */
function posterName(file) {
  return `poster-${safe.cleanName(file.name)}-${file.size}-${Math.round(file.mtime)}.jpg`;
}

module.exports = { Projects, kindOf, posterName, httpError, encodeId, VIDEO_EXT, AUDIO_EXT, DATA_DIR, EXPORTS_DIR };
