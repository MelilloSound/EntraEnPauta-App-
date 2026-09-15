/* ============================================================================
   __ms4 — Titulares dimensionados por su contenedor + línea de cierre
   melillosound.com · Code Injection → FOOTER · pegar DESPUÉS de v3b
   ----------------------------------------------------------------------------
   Resuelve, de un solo pase, cuatro quejas en cinco páginas:
     · «Algunas preguntas frecuentes» tapando el acordeón (home)
     · «Conversemos» tapando el formulario (home, /agencias, /marcas, /contacto)
     · «Convers / emos» (palabra partida) en /agencias y /marcas
     · titulares de columna angosta compitiendo con el titular del home

   CAUSA: h2{font-size:clamp(38px,7.4vw,118px)} dimensiona según el ANCHO DE LA
   VENTANA, no según el ancho de la columna donde vive el titular. A 1440px un
   h2 en un bloque de 448px sigue renderizando a 112px.

   PRINCIPIO DE SEGURIDAD: este script SOLO ENCOGE. Si el tamaño calculado es
   mayor o igual al que ya tiene el titular, no toca el elemento (ni le pone
   estilo en línea). Por eso el titular del hero del home queda intacto y la
   animación de __ms —que lo parte en líneas— no se ve afectada.

   Marcadores: window.__ms4.steps
   ========================================================================== */
(function () {
  var S = (window.__ms4 = window.__ms4 || { steps: [] });
  function mark(step, n) { S.steps.push({ step: step, n: n, t: Date.now() }); }

  var FACTOR = 0.094;   // 1211px de contenedor -> ~114px ; 555px -> ~52px
  var MIN = 34, MAX = 118;
  var PISO = 22;   // suelo duro de la red de seguridad: un titular chico es
                   // mejor que un titular que se sale de la pantalla

  /* --- 1 · titulares candidatos ------------------------------------------ */
  function heads() {
    var sel = '.sqs-html-content h1, .sqs-html-content h2, article h1, article h2';
    var seen = [], out = [];
    [].slice.call(document.querySelectorAll(sel)).forEach(function (h) {
      if (seen.indexOf(h) > -1) return;
      seen.push(h);
      if (h.classList.contains('ms-num')) return;              // numerales del proceso
      if (h.closest('header, footer, nav')) return;            // header y pie quedan fuera
      var r = h.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;                 // invisible
      out.push(h);
    });
    return out;
  }

  /* --- 2 · el pase ------------------------------------------------------- */
  function fit() {
    var hs = heads();
    if (!hs.length) { mark('fit:none', 0); return; }

    // (a) limpiar en bloque: medir contra el tamaño del CSS, no contra el ya reducido
    hs.forEach(function (h) { h.style.fontSize = ''; });

    // (b) medir en bloque (una sola relayout)
    var plan = [];
    hs.forEach(function (h) {
      var cs = getComputedStyle(h);
      var avail = h.clientWidth
                - (parseFloat(cs.paddingLeft) || 0)
                - (parseFloat(cs.paddingRight) || 0);
      var cur = parseFloat(cs.fontSize) || 0;
      if (!avail || !cur) return;
      var want = Math.max(MIN, Math.min(MAX, avail * FACTOR));
      if (want < cur - 1) plan.push({ h: h, size: want });     // SOLO ENCOGE
    });

    // (c) aplicar
    plan.forEach(function (p) {
      p.h.style.fontSize = (Math.round(p.size * 10) / 10) + 'px';
      // que ninguna palabra se parta: «Convers / emos» era esto
      p.h.style.overflowWrap = 'normal';
      p.h.style.wordBreak = 'normal';
      p.h.style.hyphens = 'manual';
      p.h.style.webkitHyphens = 'manual';
    });

    // (d) red de seguridad: si una palabra larga sigue sin caber, bajar de a 2px.
    //     Baja por debajo de MIN hasta PISO: en una columna muy angosta el piso
    //     de 34px dejaba el titular desbordado (visto en prueba a 390px).
    var forced = 0;
    plan.forEach(function (p) {
      var s = p.size, guard = 0;
      while (p.h.scrollWidth > p.h.clientWidth + 1 && s > PISO && guard++ < 60) {
        s -= 2;
        p.h.style.fontSize = s + 'px';
      }
      if (guard) forced++;
    });

    mark('fit', plan.length);
    if (forced) mark('fit:forzados', forced);
  }

  /* --- 3 · línea de cierre del proceso (/agencias y /marcas) -------------- */
  /* Se marca por texto, no por índice de sección: sobrevive si se mueve o se
     agrega una sección. El estilo vive en el bloque 35 del Custom CSS.        */
  var CLOSER = /mientras\s+antes\s+entremos/i;
  function tagClosers() {
    var n = 0;
    [].slice.call(document.querySelectorAll('.sqs-html-content p')).forEach(function (p) {
      if (!CLOSER.test(p.textContent || '')) return;
      p.classList.add('ms-closer');
      var b = p.closest('.fe-block');
      if (b) b.classList.add('ms-closer-block');
      n++;
    });
    mark('closer', n);
  }

  /* --- 4 · calendario ----------------------------------------------------- */
  function run(why) {
    try { fit(); } catch (e) { mark('err:' + why, 0); S.err = e.message; }
  }
  function boot() {
    run('dom');
    try { tagClosers(); } catch (e) { S.errCloser = e.message; }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { setTimeout(function () { run('fonts'); }, 0); });
  }
  window.addEventListener('load', function () {
    setTimeout(function () { run('load'); try { tagClosers(); } catch (e) {} }, 120);
  });

  var t;
  window.addEventListener('resize', function () {
    clearTimeout(t);
    t = setTimeout(function () { run('resize'); }, 150);
  });
  window.addEventListener('orientationchange', function () {
    setTimeout(function () { run('orient'); }, 250);
  });
})();
