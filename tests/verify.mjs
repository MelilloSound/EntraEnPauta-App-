/**
 * Pruebas de verificación de EntraEnPauta.
 * Uso:  node tests/verify.mjs [--shots]
 * Requiere Playwright + Chromium. No forma parte de lo que se despliega.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url  = 'file://' + resolve(raiz, 'index.html');
const conCapturas = process.argv.includes('--shots');

let ok = 0, fallos = 0;
const cerca = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;

function check(nombre, condicion, detalle = '') {
  if (condicion) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ' → ' + detalle : ''}`); }
}

const navegador = await chromium.launch();
const page = await navegador.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => { fallos++; console.log('  ✗ error en página:', e.message); });
await page.goto(url);

// ── 1. Motor de cálculo ───────────────────────────────────────────────
console.log('\n1. Motor de cálculo');

const silabas = await page.evaluate(() => EEP.contarSilabas('Hola, bienvenido a la nueva era.'));
check('"Hola, bienvenido a la nueva era." = 12 sílabas', silabas === 12, `dio ${silabas}`);

const ref = await page.evaluate(() => EEP.tiempoBloque('Hola, bienvenido a la nueva era.', 355));
check('base = 12/355*60 ≈ 2.028s', cerca(ref.base, 12 / 355 * 60), `dio ${ref.base}`);
check('pausas = coma 0.5 + punto 1.0 = 1.5s', cerca(ref.pausas, 1.5), `dio ${ref.pausas}`);
check('total ≈ 3.528s', cerca(ref.total, 12 / 355 * 60 + 1.5), `dio ${ref.total}`);

const elip = await page.evaluate(() => EEP.tiempoPuntuacion('Espera... llegó.'));
check('"..." cuenta 1.5s y no 3.0s → total 2.5s', cerca(elip, 2.5), `dio ${elip}`);

const uni = await page.evaluate(() => EEP.tiempoPuntuacion('Espera… llegó.'));
check('el carácter único "…" equivale a "..."', cerca(uni, 2.5), `dio ${uni}`);

const signos = await page.evaluate(() => EEP.tiempoPuntuacion('¿Lo quieres? ¡Ya!'));
check('? y ! suman 1.0s cada uno; ¿ y ¡ no suman → 2.0s', cerca(signos, 2.0), `dio ${signos}`);

const mixto = await page.evaluate(() => EEP.tiempoPuntuacion('Uno, dos; tres: cuatro.'));
check('coma + ; + : + punto = 0.5+0.8+0.8+1.0 = 3.1s', cerca(mixto, 3.1), `dio ${mixto}`);

const vacio = await page.evaluate(() => EEP.tiempoBloque('', 355));
check('texto vacío → 0 sílabas y 0s', vacio.silabas === 0 && vacio.total === 0);

// ── 2. Velocidad del legal ────────────────────────────────────────────
console.log('\n2. Velocidad del Copy Legal');

const vel = await page.evaluate(() => {
  const t = 'Aplican términos y condiciones, consulta vigencia.';
  return { n: EEP.tiempoBloque(t, 355, 1).total, mr: EEP.tiempoBloque(t, 355, 1.5).total };
});
check('Muy Rápido = Normal / 1.5 exacto', cerca(vel.mr, vel.n / 1.5), `${vel.mr} vs ${vel.n / 1.5}`);
check('el legal acelerado dura menos', vel.mr < vel.n);

// ── 3. Detección de cifras ────────────────────────────────────────────
console.log('\n3. Alerta de cifras');

const cifras = await page.evaluate(() => ({
  num:    EEP.tieneCifras('Llama al 1999 ya'),
  porDos: EEP.tieneCifras('Llévate 2 X 1 hoy'),
  suelta: EEP.tieneCifras('El combo X viene completo'),
  exito:  EEP.tieneCifras('Un éxito rotundo en el examen'),
  limpio: EEP.tieneCifras('Bienvenido a la nueva era'),
}));
check('detecta dígitos', cifras.num);
check('detecta "2 X 1"', cifras.porDos);
check('detecta X suelta', cifras.suelta);
check('NO marca "éxito" ni "examen"', !cifras.exito);
check('NO marca texto limpio', !cifras.limpio);

// ── 4. Veredictos ─────────────────────────────────────────────────────
console.log('\n4. Diagnóstico global');

const v = await page.evaluate(() => ({
  cero:  EEP.veredicto(0, 30).clase,
  bajo:  EEP.veredicto(10, 30).clase,   // 33 %
  en50:  EEP.veredicto(15, 30).clase,   // 50 % exacto → verde
  buena: EEP.veredicto(21, 30).clase,   // 70 %
  en80:  EEP.veredicto(24, 30).clase,   // 80 % exacto → verde
  justa: EEP.veredicto(27, 30).clase,   // 90 %
  en100: EEP.veredicto(30, 30).clase,   // 100 % exacto → naranja
  sobra: EEP.veredicto(35, 30),         // 117 %
}));
check('0s → neutro', v.cero === '');
check('33 % → amarillo', v.bajo === 'amarillo');
check('50 % exacto → verde', v.en50 === 'verde');
check('70 % → verde', v.buena === 'verde');
check('80 % exacto → verde', v.en80 === 'verde');
check('90 % → naranja', v.justa === 'naranja');
check('100 % exacto → naranja', v.en100 === 'naranja');
check('117 % → rojo', v.sobra.clase === 'rojo');
check('el mensaje rojo indica los segundos sobrantes',
  v.sobra.txt.includes('Sobran 5.0 segundos'), v.sobra.txt);

// ── 5. Interfaz en vivo ───────────────────────────────────────────────
console.log('\n5. Interfaz reactiva');

await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload();

await page.selectOption('#estilo', 'natural');
await page.click('.chip[data-seg="30"]');
await page.fill('#txCreativo', 'Hola, bienvenido a la nueva era.');
await page.waitForTimeout(60);

const tCreativo = await page.textContent('#tCreativo');
check('el contador del módulo muestra 3.5s', tCreativo === '3.5s', `dio ${tCreativo}`);
const pCreativo = await page.textContent('#pCreativo');
check('el contador de pausas muestra 1.5s', pCreativo === '1.5s', `dio ${pCreativo}`);

// AudioLogo por defecto: 3s al final. 3.0 + 3.5 = 6.5s de 30s = 22 % → amarillo
let diag = await page.getAttribute('#diag', 'class');
check('con poco texto el diagnóstico es amarillo', diag.includes('amarillo'), diag);

// Texto largo que desborda una pauta de 15s
await page.click('.chip[data-seg="15"]');
await page.fill('#txCreativo',
  'Llegó la temporada más esperada del año, con descuentos en toda la tienda, ' +
  'envíos gratis a todo el país, y una garantía extendida que te acompaña siempre. ' +
  'No esperes más, corre, porque las unidades son limitadas y se agotan rápido.');
await page.waitForTimeout(60);

diag = await page.getAttribute('#diag', 'class');
check('con texto largo en 15s el diagnóstico es rojo', diag.includes('rojo'), diag);
const diagTxt = await page.textContent('#diagTxt');
check('el mensaje avisa que excede la pauta', diagTxt.includes('EXCEDE LA PAUTA'), diagTxt);
// La densidad del módulo (>20s) es independiente de la pauta global (15s):
// este texto dura ~17.5s, así que desborda la pauta pero NO el límite del módulo.
check('a 17.5s el módulo aún no marca densidad (límite 20s)',
  !(await page.getAttribute('#mod-creativo', 'class')).includes('densidad'));

await page.fill('#txCreativo',
  'Llegó la temporada más esperada del año, con descuentos en toda la tienda, ' +
  'envíos gratis a todo el país, y una garantía extendida que te acompaña siempre. ' +
  'No esperes más, corre, porque las unidades son limitadas y se agotan rápido. ' +
  'Visita cualquiera de nuestras sucursales, pregunta por las promociones vigentes ' +
  'y descubre por qué somos la marca preferida de las familias de toda la región.');
await page.waitForTimeout(60);
check('pasando los 20s el módulo sí marca densidad',
  (await page.getAttribute('#mod-creativo', 'class')).includes('densidad'));
check('la métrica del módulo se pinta en rojo',
  (await page.getAttribute('#met-creativo', 'class')).includes('alerta'));
check('aparece la alerta roja de densidad',
  (await page.$$('#alertas-creativo .alerta.roja')).length === 1);

const anchos = await page.$$eval('#barra .seg',
  els => els.map(e => parseFloat(e.style.width)).reduce((a, b) => a + b, 0));
check('los segmentos de la barra suman 100 %', cerca(anchos, 100, 0.6), `dio ${anchos}`);
check('hay un segmento de excedente en rojo', (await page.$$('#barra .seg.excedente')).length > 0);
check('la marca de la pauta es visible',
  await page.evaluate(() => getComputedStyle(document.getElementById('marca')).display === 'block'));

// Alerta de cifras
await page.fill('#txOferta', 'Llévate 2 X 1 este fin de semana.');
await page.waitForTimeout(60);
check('aparece la alerta ámbar de cifras', (await page.$$('#alertas-oferta .alerta.ambar')).length === 1);

// Alerta del VO del AudioLogo
await page.fill('#alVo', 'Melillo Sound, el sonido que conecta a las marcas con su gente.');
await page.waitForTimeout(60);
check('alerta cuando el VO no cabe en la música del AudioLogo',
  (await page.$$('#alertas-audiologo .alerta.roja')).length === 1);

// Toggle: apagar un módulo lo saca del total
const antes = await page.textContent('#dTotal');
await page.click('#tgl-creativo');
await page.waitForTimeout(60);
const despues = await page.textContent('#dTotal');
check('apagar el Copy Creativo reduce el total', parseFloat(despues) < parseFloat(antes),
  `${antes} → ${despues}`);
await page.click('#tgl-creativo');

// ── 6. Guion final ────────────────────────────────────────────────────
console.log('\n6. Guion final');

await page.click('#tgl-legal');
await page.selectOption('#legalVel', 'muyrapido');
await page.fill('#txLegal', 'Aplican términos y condiciones.');
await page.click('#generarBtn');
await page.waitForTimeout(120);

const guion = await page.inputValue('#guionTxt');
check('el modal se abre', await page.evaluate(() => document.getElementById('modal').open));
check('la hoja se renderiza', await page.isVisible('#hoja'));
check('incluye el RESUMEN TÉCNICO', guion.includes('RESUMEN TÉCNICO'));
check('el legal declara lo que pasa en post', guion.includes('Muy Rápido (Muy acelerado en Audio Post)'));
check('incluye el total', /TOTAL: \d+\.\d+s de 15\.0s/.test(guion));
check('el texto copiado no lleva SPM ni sílabas',
  !/SPM|sílabas/.test(guion), guion.split('\n').find(l => /SPM|sílabas/.test(l)));
check('el AudioLogo ya no dice "musicales"', !guion.includes('musicales'));

const cuerpo = guion.split('RESUMEN TÉCNICO')[0];
const iVo = cuerpo.indexOf('Melillo Sound, el sonido');
const iCr = cuerpo.indexOf('Llegó la temporada');
const iLg = cuerpo.indexOf('Aplican términos');
check('AudioLogo al final → su VO va después del creativo', iVo > iCr);
check('el legal va antes del AudioLogo final', iLg > iCr && iLg < iVo);

// Cambiar el AudioLogo al principio reordena el guion
await page.click('#cerrarBtn');
await page.selectOption('#alPos', 'inicio');
await page.click('#generarBtn');
await page.waitForTimeout(120);
const guion2 = (await page.inputValue('#guionTxt')).split('RESUMEN TÉCNICO')[0];
check('AudioLogo al principio → su VO va primero',
  guion2.indexOf('Melillo Sound, el sonido') < guion2.indexOf('Llegó la temporada'));
await page.click('#cerrarBtn');

// ── 7. Diseño responsivo ──────────────────────────────────────────────
console.log('\n7. Responsivo');

for (const [nombre, ancho] of [['escritorio', 1440], ['tablet', 768], ['móvil', 390]]) {
  await page.setViewportSize({ width: ancho, height: 900 });
  await page.waitForTimeout(80);
  const desborda = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check(`sin scroll horizontal en ${nombre} (${ancho}px)`, !desborda);

  // El dock es fijo y de alto variable: el body debe reservarle sitio real.
  const hueco = await page.evaluate(() => {
    const d = document.querySelector('.dock');
    return { dock: d.offsetHeight, pad: parseFloat(getComputedStyle(document.body).paddingBottom) };
  });
  check(`el hueco al pie cubre el dock en ${nombre} (${hueco.pad}px ≥ ${hueco.dock}px)`,
    hueco.pad >= hueco.dock);

  // Con la página al final, el último texto debe quedar por encima del dock.
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(80);
  const tapado = await page.evaluate(() => {
    const fin = document.querySelector('.creditos').getBoundingClientRect().bottom;
    const dock = document.querySelector('.dock').getBoundingClientRect().top;
    return fin > dock + 1;
  });
  check(`el footer no queda tapado por el dock en ${nombre}`, !tapado);
  await page.evaluate(() => scrollTo(0, 0));
}

// ── 8. Logotipo por tema ──────────────────────────────────────────────
console.log('\n8. Logotipo');

await page.setViewportSize({ width: 1440, height: 900 });
const logoPorTema = await page.evaluate(async () => {
  const img = document.getElementById('logoImg');
  const btn = document.getElementById('temaBtn');
  const raiz = document.documentElement;
  const leer = () => img.getAttribute('src');
  while (raiz.getAttribute('data-tema') !== 'light') btn.click();
  const claro = leer();
  btn.click();
  const oscuro = leer();
  return { claro, oscuro, tema: raiz.getAttribute('data-tema') };
});
check('tema claro → variante oscura del wordmark',
  logoPorTema.claro === 'assets/melillo-sound.svg', logoPorTema.claro);
check('tema oscuro → variante clara del wordmark',
  logoPorTema.oscuro === 'assets/melillo-sound-dark.svg', logoPorTema.oscuro);

for (const archivo of ['melillo-sound.svg', 'melillo-sound-dark.svg']) {
  const cargado = await page.evaluate(async (f) => {
    const i = new Image();
    i.src = 'assets/' + f;
    try { await i.decode(); return i.naturalWidth > 0; } catch (e) { return false; }
  }, archivo);
  check(`assets/${archivo} carga correctamente`, cargado);
}

// ── 9. Estilo por sección ───────────────────────────────────
console.log('\n9. Estilo de locución por sección');

await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload();
await page.setViewportSize({ width: 1440, height: 900 });

check('Creativo y Oferta arrancan heredando el estilo base',
  (await page.inputValue('#estiloCreativo')) === 'base' &&
  (await page.inputValue('#estiloOferta')) === 'base');

const etiquetaHeredar = await page.$eval('#estiloCreativo option', o => o.textContent);
check('la opción heredada nombra el estilo base vigente',
  etiquetaHeredar === 'Igual que el estilo base (Natural / Conversacional)', etiquetaHeredar);

await page.selectOption('#estilo', 'trailer');   // 220 SPM
await page.waitForTimeout(60);
const etiquetaTrailer = await page.$eval('#estiloCreativo option', o => o.textContent);
check('la etiqueta heredada se reescribe al cambiar el base',
  etiquetaTrailer === 'Igual que el estilo base (Tráiler de Película)', etiquetaTrailer);

// Mismo texto en ambas secciones: heredando, deben medir igual.
const frase = 'Bienvenido a la nueva era de nuestra marca.';
await page.selectOption('#estilo', 'natural');
await page.fill('#txCreativo', frase);
await page.fill('#txOferta', frase);
await page.waitForTimeout(60);
check('heredando el base, Creativo y Oferta miden igual',
  (await page.textContent('#tCreativo')) === (await page.textContent('#tOferta')));
check('el pie de Creativo no expone el SPM', (await page.$('#spmCreativo')) === null);

// Fijar Oferta en Institucional (310 SPM) la separa del base.
await page.selectOption('#estiloOferta', 'institucional');
await page.waitForTimeout(60);


const esperado = await page.evaluate(f => EEP.tiempoBloque(f, 310).total, frase);
check('Oferta se calcula con 310 SPM',
  Math.abs(parseFloat(await page.textContent('#tOferta')) - Math.round(esperado * 10) / 10) < 0.051,
  `UI ${await page.textContent('#tOferta')} vs motor ${esperado.toFixed(2)}s`);
check('Creativo y Oferta ya no miden igual',
  (await page.textContent('#tCreativo')) !== (await page.textContent('#tOferta')));

// Mover el base arrastra a quien hereda, no a quien está fijado.
const ofertaAntes = await page.textContent('#tOferta');
const creativoAntes = await page.textContent('#tCreativo');
await page.selectOption('#estilo', 'promocional');   // 415 SPM
await page.waitForTimeout(60);
check('cambiar el base mueve la sección que hereda',
  (await page.textContent('#tCreativo')) !== creativoAntes);
check('cambiar el base NO mueve la sección fijada a mano',
  (await page.textContent('#tOferta')) === ofertaAntes);


// Persistencia y saneamiento de lo guardado.
await page.reload();
await page.waitForTimeout(80);
check('el estilo fijado sobrevive al recargar',
  (await page.inputValue('#estiloOferta')) === 'institucional');

await page.evaluate(() => {
  const g = JSON.parse(localStorage.getItem('entraenpauta.v1'));
  g.oferta.estilo = 'estilo-que-no-existe';
  localStorage.setItem('entraenpauta.v1', JSON.stringify(g));
});
await page.reload();
await page.waitForTimeout(80);
check('un estilo inválido guardado vuelve a heredar el base',
  (await page.inputValue('#estiloOferta')) === 'base');

// El resumen técnico debe decir a qué ritmo se midió cada sección.
await page.selectOption('#estiloOferta', 'institucional');
await page.fill('#txCreativo', frase);
await page.fill('#txOferta', frase);
await page.click('#generarBtn');
await page.waitForTimeout(120);
const resumen = await page.inputValue('#guionTxt');
await page.click('#cerrarBtn');
check('el resumen nombra el estilo de cada sección',
  /Creativo: .+ · Oferta: Institucional \/ Voz de Marca/.test(resumen),
  resumen.split('\n').find(l => l.startsWith('Creativo:')));
check('el resumen lista los tramos con sus segundos',
  /Copy Creativo — \d+\.\d+s/.test(resumen));
check('el resumen no lleva SPM ni sílabas', !/SPM|sílabas/.test(resumen));

// ── 10. Textos de la interfaz ──────────────────────────────
console.log('\n10. Textos de la interfaz');

const textos = await page.evaluate(() => ({
  dur:      document.querySelector('label[for="alDur"]').textContent,
  vo:       document.getElementById('alVo').placeholder,
  creativo: document.getElementById('txCreativo').placeholder,
  oferta:   document.getElementById('txOferta').placeholder,
  labOferta:document.querySelector('label[for="txOferta"]').textContent,
  titulo:   document.querySelector('#mod-oferta h2').textContent,
  cta:      document.querySelector('.cta p:last-of-type').textContent,
  base:     document.querySelector('label[for="estilo"]').textContent,
}));
check('label de duración del AudioLogo', textos.dur === 'Duración del AudioLogo (segundos)', textos.dur);
check('placeholder del VO', textos.vo === 'Ej: Toyota. Vayamos juntos', textos.vo);
check('placeholder del Copy Creativo', textos.creativo.startsWith('Pega aquí únicamente los diálogos'));
check('placeholder del Copy Oferta', textos.oferta.startsWith('Pega aquí el cierre de marca'));
check('label del Copy Oferta', textos.labOferta === 'Cierre de marca, CTA o promoción', textos.labOferta);
check('título renombrado', textos.titulo === 'Copy Oferta / Institucional', textos.titulo);
check('CTA del footer actualizado', textos.cta.includes('branding sonoro, música original'), textos.cta);
check('selector de arriba es el estilo base', textos.base === 'Estilo de locución base', textos.base);

// El placeholder largo de Oferta no puede quedar cortado.
const alturaOferta = await page.evaluate(() => {
  const t = document.getElementById('txOferta');
  const previo = t.value; t.value = '';
  const cabe = t.scrollHeight <= t.clientHeight;
  t.value = previo;
  return cabe;
});
check('el placeholder de Oferta no queda cortado', alturaOferta);

// Encabezado del AudioLogo según el toggle.
const lim = async () => (await page.textContent('#lim-audiologo')).trim();
check('AudioLogo encendido → "Mi pauta tiene un audiologo"', (await lim()) === 'Mi pauta tiene un audiologo', await lim());
await page.click('#tgl-audiologo');
await page.waitForTimeout(60);
check('AudioLogo apagado → "Mi pauta no tiene audiologo"', (await lim()) === 'Mi pauta no tiene audiologo', await lim());
check('el encabezado sigue visible con el módulo apagado',
  await page.isVisible('#lim-audiologo'));
await page.click('#tgl-audiologo');
await page.waitForTimeout(60);
check('vuelve al encender', (await lim()) === 'Mi pauta tiene un audiologo');

// Los dos campos del AudioLogo deben alinear sus inputs pese a etiquetas de
// distinto alto, y apilarse en pantallas angostas en vez de estrujarse.
for (const [nombre, ancho, apilados] of [['escritorio', 1440, false], ['móvil', 390, true]]) {
  await page.setViewportSize({ width: ancho, height: 900 });
  await page.waitForTimeout(80);
  const campos = await page.evaluate(() => {
    const r = n => document.getElementById(n).getBoundingClientRect();
    return { dur: r('alDur'), pos: r('alPos') };
  });
  const mismaFila = Math.abs(campos.dur.top - campos.pos.top) < 2;
  check(`los campos del AudioLogo ${apilados ? 'se apilan' : 'alinean sus inputs'} en ${nombre}`,
    apilados ? !mismaFila : mismaFila,
    `input ${campos.dur.top} vs select ${campos.pos.top}`);
  if (!apilados) check('input y select tienen la misma altura',
    Math.abs(campos.dur.height - campos.pos.height) < 1,
    `${campos.dur.height} vs ${campos.pos.height}`);
}
await page.setViewportSize({ width: 1440, height: 900 });

// ── 11. Ficha del proyecto y hoja A4 ──────────────────────
console.log('\n11. Ficha del proyecto y hoja A4');

await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload();
await page.setViewportSize({ width: 1440, height: 1000 });

// Sin ficha: la hoja cae en el texto de reserva y omite los campos opcionales.
await page.fill('#txCreativo', 'Llegó la temporada más esperada del año.');
await page.click('#generarBtn');
await page.waitForTimeout(150);
check('sin título, la hoja usa el texto de reserva',
  (await page.textContent('#hTitulo')) === 'Guion sin título');
check('Agencia vacía no aparece en la hoja',
  !(await page.textContent('#hMeta')).includes('Agencia'));
check('Dirección creativa vacía queda oculta', await page.isHidden('#hDir'));
check('Marca y Versión aparecen aunque estén vacías',
  /Marca/.test(await page.textContent('#hMeta')) && /Versión/.test(await page.textContent('#hMeta')));
await page.click('#cerrarBtn');

// Con ficha completa.
await page.fill('#fTitulo', 'Día de las Madres 2026');
await page.fill('#fMarca', 'Toyota');
await page.fill('#fVersion', 'Comercial TV 20s V1');
await page.fill('#fAgencia', 'Agencia Ejemplo');
await page.fill('#fDireccion', 'Tono cálido, cercano. Evitar la sobreactuación.');
await page.click('#generarBtn');
await page.waitForTimeout(150);

check('el título encabeza la hoja', (await page.textContent('#hTitulo')) === 'Día de las Madres 2026');
const meta = await page.textContent('#hMeta');
check('la hoja lleva marca, versión y agencia',
  /Toyota/.test(meta) && /Comercial TV 20s V1/.test(meta) && /Agencia Ejemplo/.test(meta), meta);
check('la dirección creativa aparece cuando hay contenido',
  await page.isVisible('#hDir') && (await page.textContent('#hDir')).includes('Tono cálido'));
check('el guion va en párrafos, sin rótulos de sección',
  (await page.$$('#hGuion p')).length >= 1 &&
  !(await page.textContent('#hGuion')).includes('Copy Creativo'));

// La ficha persiste.
await page.click('#cerrarBtn');
await page.reload();
await page.waitForTimeout(100);
check('la ficha sobrevive al recargar', (await page.inputValue('#fMarca')) === 'Toyota');

// ── Línea del tiempo ──────────────────────────────────────
await page.click('.chip[data-seg="30"]');
await page.fill('#txCreativo', 'Llegó la temporada más esperada del año, con descuentos.');
await page.fill('#txOferta', 'Visita tu concesionario.');
await page.click('#generarBtn');
await page.waitForTimeout(150);

const lt = await page.evaluate(() => {
  const celdas = [...document.querySelectorAll('#hLinea .lt-celda')];
  return celdas.map(c => ({
    nombre: c.querySelector('.lt-nombre').textContent,
    seg: c.querySelector('.lt-seg').textContent,
    grow: parseFloat(c.style.flexGrow),
  }));
});
check('hay un tramo por bloque activo con duración', lt.length === 3, JSON.stringify(lt.map(c => c.nombre)));
check('el orden cronológico pone el AudioLogo al final',
  lt[lt.length - 1].nombre === 'AudioLogo', lt.map(c => c.nombre).join(' → '));
check('cada tramo muestra sus segundos debajo del nombre',
  lt.every(c => /^\d+\.\d+s$/.test(c.seg)), JSON.stringify(lt.map(c => c.seg)));
check('el ancho de cada tramo es su duración',
  lt.every(c => Math.abs(c.grow - parseFloat(c.seg)) < 0.051), JSON.stringify(lt.map(c => [c.grow, c.seg])));
check('la línea del tiempo no usa color, solo tinta',
  await page.evaluate(() => [...document.querySelectorAll('#hLinea .lt-tramo')]
    .every(t => getComputedStyle(t).backgroundColor === 'rgba(0, 0, 0, 0)')));
check('sin exceso no hay marcador de pauta', (await page.$('#hLinea .lt-marca')) === null);

const total = await page.textContent('#hTotal');
check('el TOTAL usa el formato pedido', /^TOTAL: \d+\.\d+s de 30\.0s \(\d+\.\d+ %\)$/.test(total), total);

// Con exceso aparece el marcador, y dentro de los límites de la barra.
await page.click('#cerrarBtn');
await page.fill('#objSeg', '8');   // el guion ronda los 10s: con 8s de pauta se pasa
await page.waitForTimeout(60);
await page.click('#generarBtn');
await page.waitForTimeout(150);
const marca = await page.evaluate(() => {
  const m = document.querySelector('#hLinea .lt-marca');
  if (!m) return null;
  const lt = document.getElementById('hLinea');
  return { left: m.offsetLeft, ancho: lt.offsetWidth, texto: m.textContent.trim() };
});
check('al exceder aparece el marcador de pauta', marca !== null);
check('el marcador cae dentro de la barra',
  marca && marca.left > 0 && marca.left < marca.ancho, JSON.stringify(marca));
check('el marcador etiqueta el límite', marca && marca.texto === 'PAUTA 8.0s', marca && marca.texto);
check('el TOTAL avisa del exceso', /excede por \d+\.\d+s/.test(await page.textContent('#hTotal')));

// ── Impresión real a A4 ───────────────────────────────────
const pdf = await page.pdf({ format: 'A4', printBackground: true });
const paginas = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
check('la impresión genera un PDF', pdf.length > 1000, `${pdf.length} bytes`);
check('el CSS de impresión deja una sola página, no la app entera',
  paginas === 1, `${paginas} páginas`);
if (conCapturas) {
  mkdirSync(resolve(raiz, 'tests/output'), { recursive: true });
  writeFileSync(resolve(raiz, 'tests/output/guion-final.pdf'), pdf);
}
await page.click('#cerrarBtn');

// ── 12. Nada de razonamiento interno a la vista ───────────
console.log('\n12. Razonamiento interno oculto');

const visible = await page.evaluate(() => document.body.innerText);
check('la app no muestra "SPM" en ninguna parte', !/SPM/.test(visible),
  visible.split('\n').find(l => /SPM/.test(l)));
check('la app no muestra "sílabas / minuto"', !/sílabas\s*\/\s*minuto/.test(visible));

// La única aparición permitida es la alerta de cifras, donde la palabra explica
// por qué el aviso existe.
await page.fill('#txOferta', 'Llévate 2 X 1 hoy.');
await page.waitForTimeout(80);
const conAlerta = await page.evaluate(() => document.body.innerText);
const lineasSilabas = conAlerta.split('\n').filter(l => /sílabas/.test(l));
check('"sílabas" solo aparece en la alerta de cifras',
  lineasSilabas.length === 1 && lineasSilabas[0].includes('1999'), JSON.stringify(lineasSilabas));

const opciones = await page.$$eval('#estilo option, #estiloCreativo option, #estiloOferta option',
  os => os.map(o => o.textContent));
check('ningún selector de estilo nombra el SPM', !opciones.some(o => /SPM/.test(o)),
  opciones.find(o => /SPM/.test(o)));

const velocidades = await page.$$eval('#legalVel option', os => os.map(o => o.textContent));
check('el legal declara la aceleración en post',
  velocidades[1].includes('(Acelerado en Audio Post)') &&
  velocidades[2].includes('(Muy acelerado en Audio Post)'), JSON.stringify(velocidades));

// ── Capturas opcionales ───────────────────────────────────────────────
if (conCapturas) {
  const dir = resolve(raiz, 'tests/output');
  mkdirSync(dir, { recursive: true });
  for (const [tema, etiqueta] of [['dark', 'oscuro'], ['light', 'claro']]) {
    // Usamos el toggle real de la app: fijar data-tema a mano se saltaría
    // aplicarTema() y la captura saldría con la variante equivocada del logo.
    await page.evaluate(t => {
      const btn = document.getElementById('temaBtn');
      let giros = 0;
      while (document.documentElement.getAttribute('data-tema') !== t && giros++ < 4) btn.click();
    }, tema);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${dir}/escritorio-${etiqueta}.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${dir}/movil-${etiqueta}.png`, fullPage: true });
  }
  console.log(`\n  📸 Capturas en tests/output/`);
}

await navegador.close();
console.log(`\n${'─'.repeat(46)}\n  ${ok} pruebas OK · ${fallos} fallos\n`);
process.exit(fallos ? 1 : 0);
