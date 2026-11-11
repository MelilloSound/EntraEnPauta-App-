'use strict';
/* Starts the real server on a temporary projects folder and talks to it over HTTP. */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let child, base, root, port;
const H = { 'X-Video-Review': '1', 'Content-Type': 'application/json' };

function start(env = {}) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-server-'));
  port = 20000 + Math.floor(Math.random() * 20000);
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), root], {
      env: Object.assign({}, process.env, { PORT: String(port), NO_OPEN: '1', VIDEO_REVIEW_NO_FFMPEG: '1' }, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /localhost:(\d+)/.exec(out);
      if (m) { port = +m[1]; base = `http://localhost:${port}`; resolve(); }
    });
    child.on('exit', (code) => reject(new Error('server exited ' + code + out)));
  });
}

/** Raw request so we can send any Host header. */
function raw(pathname, headers = {}) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => { res.resume(); resolve(res.statusCode); });
  });
}

module.exports = {
  async 'starts and lists an empty projects folder'() {
    await start();
    const r = await (await fetch(base + '/api/projects')).json();
    assert.deepEqual(r.projects, []);
    assert.equal(r.root, root);
  },

  async 'refuses other websites (Host check, CSRF header)'() {
    assert.equal(await raw('/api/projects', { Host: 'evil.example' }), 403);
    const r = await fetch(base + '/api/projects', { method: 'POST', body: '{}' });
    assert.equal(r.status, 403, 'POST without the app header is refused');
    const r2 = await fetch(base + '/api/projects', { method: 'POST', headers: Object.assign({ Origin: 'https://evil.example' }, H), body: '{}' });
    assert.equal(r2.status, 403);
  },

  async 'creates projects and copies files in without overwriting'() {
    const p = await (await fetch(base + '/api/projects', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Promo' }) })).json();
    assert.equal(p.name, 'Promo');
    const up = (body) => fetch(`${base}/api/projects/${p.id}/upload?name=spot.mp4`, { method: 'PUT', headers: { 'X-Video-Review': '1' }, body });
    assert.equal((await (await up('first')).json()).name, 'spot.mp4');
    assert.equal((await (await up('second')).json()).name, 'spot (2).mp4');
    assert.equal(fs.readFileSync(path.join(root, 'Promo', 'spot.mp4'), 'utf8'), 'first');
    const bad = await fetch(`${base}/api/projects/${p.id}/upload?name=evil.sh`, { method: 'PUT', headers: { 'X-Video-Review': '1' }, body: 'x' });
    assert.equal(bad.status, 400);
  },

  async 'serves media with byte ranges and blocks path traversal'() {
    const { projects } = await (await fetch(base + '/api/projects')).json();
    const id = projects[0].id;
    const r = await fetch(`${base}/media/${id}/spot.mp4`, { headers: { Range: 'bytes=1-3' } });
    assert.equal(r.status, 206);
    assert.equal(await r.text(), 'irs');
    const t = await fetch(`${base}/media/${id}/..%2F..%2Fetc%2Fpasswd`);
    assert.ok([400, 404].includes(t.status));
    const unknown = Buffer.from('/etc').toString('base64url');
    assert.equal((await fetch(`${base}/media/${unknown}/passwd`)).status, 404);
  },

  async 'saves notes with conflict detection and history'() {
    const { projects } = await (await fetch(base + '/api/projects')).json();
    const id = projects[0].id;
    const put = (baseRev, data) => fetch(`${base}/api/projects/${id}/review`, { method: 'PUT', headers: H, body: JSON.stringify({ baseRev, data }) });
    const a = await put(0, { clips: { 'spot.mp4': { comments: [{ id: 'n1', text: 'hi' }] } } });
    assert.equal((await a.json()).rev, 1);
    const stale = await put(0, { clips: {} });
    assert.equal(stale.status, 409, 'a second window cannot silently overwrite');
    const detail = await (await fetch(`${base}/api/projects/${id}`)).json();
    assert.equal(detail.review.clips['spot.mp4'].comments[0].text, 'hi');
    assert.equal(detail.project.comments.open, 1);
  },

  async 'links an outside folder and removes it from the list without touching it'() {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-outside-'));
    fs.writeFileSync(path.join(outside, 'take1.mov'), 'x');
    const p = await (await fetch(base + '/api/projects/link', { method: 'POST', headers: H, body: JSON.stringify({ path: outside }) })).json();
    assert.equal(p.linked, true);
    assert.equal(p.clips, 1);
    await fetch(`${base}/api/projects/${p.id}/forget`, { method: 'POST', headers: H });
    const { projects } = await (await fetch(base + '/api/projects')).json();
    assert.ok(!projects.some((x) => x.path === outside));
    assert.ok(fs.existsSync(path.join(outside, 'take1.mov')));
  },

  async 'lists newest projects first'() {
    fs.mkdirSync(path.join(root, 'Older'));
    fs.writeFileSync(path.join(root, 'Older', 'a.mp4'), 'x');
    const old = new Date(Date.now() - 86400000 * 30);
    fs.utimesSync(path.join(root, 'Older', 'a.mp4'), old, old);
    fs.mkdirSync(path.join(root, 'Newest'));
    const { projects } = await (await fetch(base + '/api/projects')).json();
    assert.equal(projects[0].name, 'Newest');
    child.kill();
  },
};
