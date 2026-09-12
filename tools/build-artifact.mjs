/**
 * Genera la versión para publicar como Artifact a partir de index.html.
 *
 * El anfitrión de Artifacts envuelve el archivo en su propio <!doctype>/<head>/<body>,
 * así que aquí se extraen el <title>, el <style> y el contenido del <body>. Se genera
 * en vez de mantenerse a mano para que index.html siga siendo la única fuente de verdad.
 *
 *   node tools/build-artifact.mjs   →   dist/entraenpauta.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(raiz, 'index.html'), 'utf8');

const saca = (re, nombre) => {
  const m = src.match(re);
  if (!m) throw new Error(`No se encontró ${nombre} en index.html`);
  return m[1];
};

const estilo  = saca(/<style>([\s\S]*?)<\/style>/, 'el <style>');
const cuerpo  = saca(/<body>([\s\S]*)<\/body>/, 'el contenido del <body>');

// El nombre en la galería es solo el producto; la explicación va en el `description`.
const salida = `<title>EntraEnPauta</title>\n<style>${estilo}</style>\n${cuerpo.trim()}\n`;

mkdirSync(resolve(raiz, 'dist'), { recursive: true });
const destino = resolve(raiz, 'dist/entraenpauta.html');
writeFileSync(destino, salida);
console.log(`dist/entraenpauta.html · ${(salida.length / 1024).toFixed(1)} KB`);
