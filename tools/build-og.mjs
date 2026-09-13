/**
 * Rasteriza la imagen social y el favicon PNG de respaldo.
 *   node tools/build-og.mjs
 * Ambos se commitean: GitHub Pages sirve archivos, no ejecuta build.
 */
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const navegador = await chromium.launch();

const og = await navegador.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await og.goto(pathToFileURL(resolve(raiz, 'tools/og.html')).href);
await og.waitForTimeout(250);
await og.screenshot({ path: resolve(raiz, 'assets/og-entraenpauta.png') });
console.log('assets/og-entraenpauta.png · 1200×630');

const ico = await navegador.newPage({ viewport: { width: 32, height: 32 }, deviceScaleFactor: 2 });
await ico.goto(pathToFileURL(resolve(raiz, 'assets/favicon.svg')).href);
await ico.waitForTimeout(150);
await ico.screenshot({ path: resolve(raiz, 'assets/favicon-32.png'), omitBackground: true });
console.log('assets/favicon-32.png · 64×64 (respaldo para navegadores sin SVG)');

await navegador.close();
