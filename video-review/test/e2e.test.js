'use strict';
/*
 * Full flow in a real browser: pin notes on the picture, edit, Copy moments,
 * export AAF and MP4. Needs Playwright (with Chromium) and ffmpeg; skipped otherwise.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { readCfb } = require('./cfb-reader');

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

let child, base, root, browser, page, projectDir;
const pageErrors = [];

async function startServer() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-e2e-'));
  projectDir = path.join(root, 'Summer Promo');
  fs.mkdirSync(projectDir);
  const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=12',
    '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', path.join(projectDir, 'ad_v1.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=20', '-ac', '2', path.join(projectDir, 'music.mp3')]);
  const port = 20000 + Math.floor(Math.random() * 20000);
  await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), root], {
      env: Object.assign({}, process.env, { PORT: String(port), NO_OPEN: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = /localhost:(\d+)/.exec(out); if (m) { base = `http://localhost:${m[1]}`; resolve(); } });
    child.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
}

const review = () => JSON.parse(fs.readFileSync(path.join(projectDir, '.review', 'review.json'), 'utf8'));

module.exports = {
  async 'opens the project from the homepage'() {
    if (!playwright) skip('Playwright not installed (npm i -D playwright)');
    if (!hasFfmpeg) skip('ffmpeg not installed (needed to make test videos)');
    await startServer();
    browser = await playwright.chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(base + '/');
    await page.click('.card:has-text("Summer Promo")');
    await page.waitForSelector('.item.seg');
    await page.waitForTimeout(800);
  },

  async 'pins notes on the picture and on the timeline'() {
    if (!page) skip('no browser');
    const ruler = await page.locator('.tl-row.ruler').boundingBox();
    const pps = await page.evaluate(() => document.querySelector('.item.seg').offsetWidth / 12);
    const at = (t) => page.mouse.click(ruler.x + 14 + t * pps, ruler.y + 10);
    const st = await page.locator('#stage').boundingBox();
    await at(2);
    await page.mouse.click(st.x + st.width * 0.2, st.y + st.height * 0.25);
    await page.fill('#composerText', 'The logo is cut off');
    await page.keyboard.press('Enter');
    await at(5);
    await page.mouse.move(st.x + st.width * 0.6, st.y + st.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(st.x + st.width * 0.8, st.y + st.height * 0.85, { steps: 4 });
    await page.mouse.up();
    await page.fill('#composerText', 'Too busy in this corner');
    await page.click('text=Save note');
    await page.waitForFunction(() => document.querySelectorAll('.note-card').length === 2);
    await page.waitForTimeout(1500);
    const notes = review().clips['ad_v1.mp4'].comments;
    assert.equal(notes.length, 2);
    assert.deepEqual(notes[0].spot, { x: 0.2, y: 0.25 });
    assert.equal(notes[1].spot.w, 0.2);
    for (const n of notes) assert.ok(fs.existsSync(path.join(projectDir, '.review', n.still)), 'still saved for ' + n.text);
  },

  async 'splits, removes a piece, adds text and music'() {
    if (!page) skip('no browser');
    const ruler = await page.locator('.tl-row.ruler').boundingBox();
    const pps = await page.evaluate(() => document.querySelector('.item.seg').offsetWidth / 12);
    const at = (t) => page.mouse.click(ruler.x + 14 + t * pps, ruler.y + 10);
    await at(3); await page.keyboard.press('s');
    await at(6); await page.keyboard.press('s');
    await page.locator('.item.seg').nth(1).click({ position: { x: 20, y: 30 } });
    await page.keyboard.press('Delete');
    assert.equal(await page.locator('.item.seg').count(), 2);
    await at(1);
    await page.keyboard.press('t');
    await page.fill('#inspector textarea', 'Summer sale');
    await page.click('#audioBtn');
    await page.click('.popover button:has-text("music.mp3")');
    await page.waitForTimeout(1200);
    const edit = review().clips['ad_v1.mp4'].edit;
    assert.deepEqual(edit.video.map((s) => [s.in, s.out]), [[0, 3], [6, 12]]);
    assert.equal(edit.texts[0].text, 'Summer sale');
    assert.equal(edit.audio[0].src, 'music.mp3');
  },

  async 'Copy moments puts one complete prompt on the clipboard'() {
    if (!page) skip('no browser');
    await page.click('#copyBtn');
    await page.waitForSelector('pre.prompt');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(text, /video project "Summer Promo"/);
    assert.match(text, /At 00:02\.00 — the top left of the frame/);
    assert.match(text, /At 00:05\.00 \(in a part I cut from my edit\)/);
    assert.match(text, /Still: .*\.review.frames.*\.jpg/);
    assert.match(text, /Cut out 00:03\.00–00:06\.00/);
    assert.match(text, /Added text "Summer sale"/);
    assert.match(text, /Added audio "music\.mp3"/);
    await page.keyboard.press('Escape');
  },

  async 'exports an AAF for Pro Tools with a cue sheet and reference video'() {
    if (!page) skip('no browser');
    await page.click('#exportBtn');
    await page.click('.popover button:has-text("AAF")');
    await page.click('.modal button:has-text("Export AAF")');
    await page.waitForSelector('.modal h2:has-text("AAF ready")', { timeout: 120000 });
    const files = await page.locator('.file-list li').allTextContents();
    const aaf = files.find((f) => f.endsWith('.aaf'));
    assert.ok(aaf && files.some((f) => f.endsWith('cue sheet.txt')) && files.some((f) => f.endsWith('reference.mp4')));
    const cfb = readCfb(fs.readFileSync(aaf));
    assert.deepEqual(cfb.problems, []);
    const cue = fs.readFileSync(files.find((f) => f.endsWith('cue sheet.txt')), 'utf8');
    assert.match(cue, /Clip audio L/);
    assert.match(cue, /A2 L/);
  },

  async 'renders the edit to MP4 with the right length'() {
    if (!page) skip('no browser');
    await page.keyboard.press('Escape');
    await page.click('#exportBtn');
    await page.click('.popover button:has-text("MP4")');
    await page.waitForSelector('.modal h2:has-text("rendered")', { timeout: 120000 });
    const mp4 = (await page.locator('.file-list li').allTextContents()).find((f) => f.endsWith('.mp4'));
    const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString());
    assert.ok(Math.abs(dur - 9) < 0.15, 'duration ' + dur);
    assert.ok(fs.existsSync(path.join(projectDir, 'ad_v1.mp4')), 'original untouched');
    await browser.close();
    assert.deepEqual(pageErrors, [], 'no JavaScript errors in the page');
    child.kill();
  },
};
