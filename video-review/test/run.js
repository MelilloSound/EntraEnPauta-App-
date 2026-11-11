#!/usr/bin/env node
'use strict';
/*
 * Tiny test runner (no dependencies). Runs every test/*.test.js file.
 *   npm test                 all tests
 *   node test/run.js aaf     only files whose name contains "aaf"
 * Tests that need ffmpeg, Python+pyaaf2 or Playwright skip themselves when
 * those tools aren't installed.
 */
const fs = require('fs');
const path = require('path');

const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f.includes(filter)).sort();

let passed = 0, failed = 0, skipped = 0;
const SKIP = Symbol('skip');
global.skip = (why) => { const e = new Error(why); e[SKIP] = true; throw e; };

(async () => {
  for (const file of files) {
    const tests = require(path.join(__dirname, file));
    console.log(`\n${file}`);
    for (const [name, fn] of Object.entries(tests)) {
      const t0 = Date.now();
      try {
        await fn();
        passed++;
        console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
      } catch (err) {
        if (err && err[SKIP]) { skipped++; console.log(`  - ${name} (skipped: ${err.message})`); continue; }
        failed++;
        console.log(`  ✗ ${name}\n    ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n    ')}`);
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
})();
