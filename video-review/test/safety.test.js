'use strict';
/* The app must never delete, move or overwrite your files. */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const safe = require('../lib/safe-fs');

const ROOT = path.join(__dirname, '..');
const sources = [
  'server.js',
  ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f),
  ...fs.readdirSync(path.join(ROOT, 'public/js')).map((f) => 'public/js/' + f),
];
const code = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

module.exports = {
  'no delete calls anywhere in the app'() {
    for (const f of sources) {
      const hit = code(f).match(/\b(unlink|unlinkSync|rmdir|rmdirSync|rmSync|rimraf)\b|\bfs(\.promises)?\.rm\(|promises\.rm\(/);
      assert.equal(hit, null, `${f} contains "${hit && hit[0]}"`);
    }
  },

  'files are only renamed in the two places that need it'() {
    const renames = sources.filter((f) => /\brename\(/.test(code(f)));
    // safe-fs: the app's own notes file (written to a temp file first, then swapped in)
    // exporter: "name.aaf.part" becomes "name.aaf" once complete
    assert.deepEqual(renames.sort(), ['lib/exporter.js', 'lib/safe-fs.js']);
  },

  'every ffmpeg output refuses to overwrite (-n)'() {
    const ex = code('lib/exporter.js') + code('server.js');
    assert.ok(!/['"]-y['"]/.test(ex), 'no -y flag');
    assert.ok((ex.match(/'-n'/g) || []).length >= 2, 'renders and playable copies pass -n');
  },

  async 'new files never replace existing ones'() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-safe-'));
    fs.writeFileSync(path.join(dir, 'clip.mp4'), 'ORIGINAL');
    const a = await safe.writeNewFile(dir, 'clip.mp4', 'new one');
    const b = await safe.writeNewFile(dir, 'clip.mp4', 'newer one');
    assert.equal(a.name, 'clip (2).mp4');
    assert.equal(b.name, 'clip (3).mp4');
    assert.equal(fs.readFileSync(path.join(dir, 'clip.mp4'), 'utf8'), 'ORIGINAL');
    const d1 = await safe.createUniqueDir(dir, 'Exports');
    const d2 = await safe.createUniqueDir(dir, 'Exports');
    assert.notEqual(d1, d2);
  },

  async 'only the app\'s own notes file can be replaced, and the old one is kept'() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-safe-'));
    await assert.rejects(safe.replaceOwnJson(path.join(dir, 'clip.mp4'), {}), /Refusing/);
    const file = path.join(dir, 'review.json');
    const hist = path.join(dir, 'history');
    await safe.replaceOwnJson(file, { v: 1 }, hist, 0);
    await safe.replaceOwnJson(file, { v: 2 }, hist, 0);
    assert.equal(JSON.parse(fs.readFileSync(file)).v, 2);
    const saved = fs.readdirSync(hist);
    assert.equal(saved.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(hist, saved[0]))).v, 1);
  },

  'file names are cleaned of path tricks'() {
    assert.equal(safe.cleanName('../../etc/passwd'), 'etc passwd');
    assert.equal(safe.cleanName('a:b*c?.mp4'), 'a b c .mp4');
    assert.equal(safe.cleanName('   '), 'untitled');
  },
};
