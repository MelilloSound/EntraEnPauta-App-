#!/usr/bin/env node
'use strict';
/*
 * Video Review — review and edit your videos, then hand the notes to Claude.
 *
 *   node server.js                 projects live in ~/Video Review
 *   node server.js "/path/to/dir"  use another projects folder
 *   PORT=5000 node server.js       use another port
 *
 * The server only listens on this computer (127.0.0.1) and never deletes,
 * moves or overwrites your files. See README.md.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const safe = require('./lib/safe-fs');
const { Projects, kindOf, httpError, posterName } = require('./lib/projects');
const { Media } = require('./lib/media');
const { Exporter, SequentialReader } = require('./lib/exporter');
const T = require('./public/js/timeline.js');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const ROOT = path.resolve(args.find((a) => !a.startsWith('--')) || process.env.VIDEO_REVIEW_DIR || path.join(os.homedir(), 'Video Review'));
const START_PORT = parseInt(process.env.PORT || '4747', 10);
const PUBLIC = path.join(__dirname, 'public');

const projects = new Projects(ROOT);
const media = new Media();
const exporter = new Exporter(projects, media);
let PORT = START_PORT;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ogv': 'video/ogg', '.3gp': 'video/3gpp',
  '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.caf': 'audio/x-caf',
};

// ───────────────────────── helpers ─────────────────────────

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, headers));
  res.end(data);
}

async function readBody(req, limit = 50 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'Request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'Invalid JSON'); }
}

/** A plain file name that exists directly in the project folder. */
async function projectFile(dir, name, kinds = ['video', 'audio']) {
  if (!name || path.basename(name) !== name || name.startsWith('.')) throw httpError(400, 'Bad file name');
  if (!kinds.includes(kindOf(name))) throw httpError(400, 'Not a media file');
  const full = path.join(dir, name);
  try {
    const st = await fs.promises.stat(full);
    if (!st.isFile()) throw new Error();
    return { full, st };
  } catch { throw httpError(404, 'File not found: ' + name); }
}

async function serveFile(req, res, full, extraHeaders = {}) {
  let st;
  try { st = await fs.promises.stat(full); } catch { return send(res, 404, 'Not found'); }
  if (!st.isFile()) return send(res, 404, 'Not found');
  const type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
  const headers = Object.assign({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }, extraHeaders);
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = m && m[1] !== '' ? parseInt(m[1], 10) : NaN;
    let end = m && m[2] !== '' ? parseInt(m[2], 10) : NaN;
    if (m && isNaN(start) && !isNaN(end)) { start = Math.max(0, st.size - end); end = st.size - 1; }
    if (isNaN(end) || end >= st.size) end = st.size - 1;
    if (!m || isNaN(start) || start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, Object.assign(headers, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 }));
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(full, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, Object.assign(headers, { 'Content-Length': st.size }));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
}

function openInOS(target) {
  const cmd = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
      : ['xdg-open', [target]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no opener */ }
}

/** Protects against other websites talking to this local server. */
function allowed(req) {
  const host = String(req.headers.host || '');
  const okHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];
  if (!okHosts.includes(host)) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !okHosts.map((h) => 'http://' + h).includes(origin)) return false;
    if (req.headers['x-video-review'] !== '1') return false;
  }
  return true;
}

// ───────────────────────── API ─────────────────────────

async function projectDetail(p) {
  const files = await projects.mediaFiles(p.dir);
  const review = await projects.readReview(p.dir);
  const summary = await projects.summary(p.dir, p.linked);
  const posters = {};
  for (const f of files) posters[f.name] = posterName(f);
  return { project: summary, files, posters, review, dataPath: projects.dataDir(p.dir), exportsPath: projects.exportsDir(p.dir) };
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]
  const method = req.method;
  const q = url.searchParams;

  if (parts[1] === 'system' && method === 'GET') {
    return send(res, 200, Object.assign(media.status(), { root: ROOT, platform: process.platform, home: os.homedir() }));
  }

  if (parts[1] === 'jobs' && parts[2] && method === 'GET') {
    const j = exporter.publicJob(parts[2]);
    return j ? send(res, 200, j) : send(res, 404, { error: 'Unknown job' });
  }

  if (parts[1] === 'reveal-root' && method === 'POST') { openInOS(ROOT); return send(res, 200, { ok: true }); }

  if (parts[1] !== 'projects') return send(res, 404, { error: 'Not found' });

  if (parts.length === 2) {
    if (method === 'GET') return send(res, 200, { root: ROOT, projects: await projects.list() });
    if (method === 'POST') {
      const body = await readJsonBody(req);
      return send(res, 201, await projects.create(body.name));
    }
  }
  if (parts[2] === 'link' && parts.length === 3 && method === 'POST') {
    const body = await readJsonBody(req);
    return send(res, 201, await projects.link(body.path));
  }

  const p = await projects.resolve(parts[2]);
  const action = parts[3] || '';

  if (!action && method === 'GET') return send(res, 200, await projectDetail(p));

  if (action === 'files' && method === 'GET') return send(res, 200, { files: await projects.mediaFiles(p.dir) });

  if (action === 'forget' && method === 'POST') {
    if (!p.linked) throw httpError(400, 'Only added folders can be removed from the list.');
    await projects.forget(p.id);
    return send(res, 200, { ok: true });
  }

  if (action === 'review' && method === 'PUT') {
    const body = await readJsonBody(req);
    try {
      const saved = await projects.saveReview(p.dir, Number(body.baseRev) || 0, body.data || {});
      return send(res, 200, { rev: saved.rev, saved: saved.saved });
    } catch (err) {
      if (err.status === 409) return send(res, 409, { error: err.message, current: err.current });
      throw err;
    }
  }

  if (action === 'upload' && method === 'PUT') {
    const name = safe.cleanName(q.get('name'));
    if (!kindOf(name)) throw httpError(400, 'Only video and audio files can be added.');
    const saved = await safe.streamToNewFile(p.dir, name, req);
    return send(res, 201, { name: saved.name, bytes: saved.bytes });
  }

  if (action === 'still' && method === 'POST') {
    const dir = await safe.ensureDir(path.join(projects.dataDir(p.dir), 'frames'));
    const buf = await readBody(req, 20 * 1024 * 1024);
    const saved = await safe.writeNewFile(dir, safe.cleanName(q.get('name') || 'still') + '.jpg', buf);
    return send(res, 201, { rel: 'frames/' + saved.name, path: saved.path });
  }

  if (action === 'cache' && method === 'POST') {
    const name = safe.cleanName(q.get('name'));
    if (!/^[\w .()+-]+\.(jpg|json)$/i.test(name)) throw httpError(400, 'Bad cache name');
    const dir = await safe.ensureDir(path.join(projects.dataDir(p.dir), 'cache'));
    const full = path.join(dir, name);
    const buf = await readBody(req, 50 * 1024 * 1024);
    try { await fs.promises.writeFile(full, buf, { flag: 'wx' }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    return send(res, 201, { rel: 'cache/' + name });
  }

  if (action === 'probe' && method === 'GET') {
    const { full } = await projectFile(p.dir, q.get('file'));
    const meta = await media.probe(full);
    return meta ? send(res, 200, meta) : send(res, 404, { error: 'ffprobe not available' });
  }

  if (action === 'reveal' && method === 'POST') {
    const body = await readJsonBody(req);
    let target = p.dir;
    if (body.what === 'exports') target = await safe.ensureDir(projects.exportsDir(p.dir));
    if (body.what === 'folder' && body.path && safe.isInside(p.dir, body.path)) target = body.path;
    openInOS(target);
    return send(res, 200, { ok: true });
  }

  if (action === 'proxy' && method === 'POST') {
    if (!media.ffmpeg) throw httpError(400, 'Making a playable copy needs ffmpeg.');
    const body = await readJsonBody(req);
    const { full } = await projectFile(p.dir, body.file, ['video']);
    const dir = await safe.ensureDir(path.join(projects.dataDir(p.dir), 'proxies'));
    const out = path.join(dir, body.file + '.mp4');
    const job = exporter.start('proxy', async (j) => {
      try { await fs.promises.access(out); j.files.push(out); return; } catch { /* make it */ }
      j.step = 'Making a playable copy';
      const meta = await media.probe(full);
      const video = media.x264 ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'] : ['-c:v', 'mpeg4', '-q:v', '3'];
      await media.render(['-n', '-i', full, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale=-2:'min(1080,ih)'", ...video, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out],
        (meta && meta.duration) || 0, (x) => { j.progress = x; });
      j.files.push(out);
    });
    return send(res, 202, { job: job.id });
  }

  if (action === 'render' && method === 'POST') {
    const body = await readJsonBody(req);
    const edit = T.normalize(body.edit, body.clip, {});
    const job = exporter.start('render', (j) => exporter.render(j, { dir: p.dir, clip: body.clip, edit, clientMetas: body.metas }));
    return send(res, 202, { job: job.id });
  }

  if (action === 'aaf' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!media.ffmpeg) return send(res, 409, { error: 'NEEDS_BROWSER_AUDIO' });
    const edit = T.normalize(body.edit, body.clip, {});
    const job = exporter.start('aaf', (j) => exporter.aaf(j, { dir: p.dir, clip: body.clip, edit, clientMetas: body.metas, options: body.options || {} }));
    return send(res, 202, { job: job.id });
  }

  // AAF with audio decoded by the browser (when ffmpeg is not installed).
  // Body: [4-byte JSON length][JSON manifest][raw 24-bit mono PCM per essence].
  if (action === 'aaf-upload' && method === 'POST') {
    const reader = new SequentialReader(req);
    const len = (await reader.readExact(4)).readUInt32LE(0);
    if (len > 50 * 1024 * 1024) throw httpError(400, 'Bad upload');
    const manifest = JSON.parse((await reader.readExact(len)).toString('utf8'));
    const edit = T.normalize(manifest.edit, manifest.clip, {});
    const job = exporter.job('aaf');
    try {
      await exporter.aaf(job, { dir: p.dir, clip: manifest.clip, edit, options: manifest.options || {}, upload: { manifest, reader } });
      job.status = 'done'; job.progress = 1; job.step = 'Done';
    } catch (err) {
      job.status = 'error'; job.error = err.message; job.step = 'Failed';
    }
    return send(res, 200, exporter.publicJob(job.id));
  }

  return send(res, 404, { error: 'Not found' });
}

// ───────────────────────── routing ─────────────────────────

async function handle(req, res) {
  if (!allowed(req)) return send(res, 403, 'Forbidden');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) return api(req, res, url);

  if (pathname.startsWith('/media/')) {
    const [, , id, ...rest] = url.pathname.split('/');
    const p = await projects.resolve(decodeURIComponent(id));
    const name = decodeURIComponent(rest.join('/'));
    if (url.searchParams.get('proxy') === '1') {
      await projectFile(p.dir, name, ['video']);
      return serveFile(req, res, path.join(projects.dataDir(p.dir), 'proxies', name + '.mp4'));
    }
    const { full } = await projectFile(p.dir, name);
    return serveFile(req, res, full);
  }

  if (pathname.startsWith('/data/')) {
    const [, , id, ...rest] = url.pathname.split('/');
    const p = await projects.resolve(decodeURIComponent(id));
    const rel = decodeURIComponent(rest.join('/'));
    const base = projects.dataDir(p.dir);
    const full = path.resolve(base, rel);
    if (!/^(frames|cache)\//.test(rel) || !safe.isInside(base, full)) return send(res, 404, 'Not found');
    return serveFile(req, res, full);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let file = pathname === '/' ? 'index.html' : pathname === '/project' ? 'project.html' : pathname.slice(1);
  const full = path.resolve(PUBLIC, file);
  if (!safe.isInside(PUBLIC, full)) return send(res, 404, 'Not found');
  return serveFile(req, res, full);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message });
    else res.destroy();
  });
});
server.requestTimeout = 0; // large uploads and exports can take a while

function listen(port, attempts = 20) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && attempts > 0) resolve(listen(port + 1, attempts - 1));
      else reject(err);
    };
    const onListening = () => { server.off('error', onError); resolve(port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function main() {
  await projects.init();
  const status = await media.detect();
  PORT = await listen(START_PORT);
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  Video Review is running');
  console.log(`  ➜  ${url}`);
  console.log(`  Projects folder: ${ROOT}`);
  console.log(status.ffmpeg ? `  ffmpeg: found (${status.version})` : '  ffmpeg: not found — renders are off; everything else works (see README)');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  if (!flag('--no-open') && !process.env.NO_OPEN) openInOS(url);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { server, main, listen, projects, media };
