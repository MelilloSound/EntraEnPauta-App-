/* ============================================================================
   PROBE DE VERIFICACIÓN · melillosound.com
   ----------------------------------------------------------------------------
   Pegar completo en la consola de una pestaña abierta en
   https://www.melillosound.com  (mismo origen: por eso funciona el iframe).

   POR QUÉ ESTO Y NO CAPTURAS: las capturas de pantalla no son fiables en este
   sitio. Elementos con opacity:1, posición correcta y que responden a
   document.elementFromPoint() salen en blanco o desvaídos. Es una limitación de
   composición (mix-blend-mode + muchas capas), no un problema del sitio.
   Verificar por captura lleva a «arreglar» lo que no está roto.

   Tres utilidades:
     await __P('/agencias', 390)   -> solapes, desbordes, recortes, scroll
     await __GRID('/agencias')     -> volcado de rejilla por sección
     await __CONTRAST('/agencias') -> contraste real de cada etiqueta

   Correr cada página a 390, 768 y 1440. DE A DOS O TRES PÁGINAS POR LLAMADA:
   más provoca timeout del puente CDP.
   ========================================================================== */

/* --- motor común: abre la página en un iframe del ancho pedido y la mide --- */
window.__frame = function (path, w, wait, fn) {
  return new Promise(function (res) {
    var f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-99999px;top:0;border:0;width:' + w + 'px;height:900px';
    f.src = path;
    f.onload = function () {
      setTimeout(function () {
        try {
          var out = fn(f.contentDocument, f.contentWindow);
          f.remove(); res(out);
        } catch (e) { f.remove(); res({ p: path, ERR: e.message }); }
      }, wait || 3200);
    };
    document.body.appendChild(f);
  });
};

/* --- 1 · solapes / desbordes / recortes / scroll horizontal --------------- */
window.__P = function (path, w, wait) {
  return window.__frame(path, w, wait, function (D, W) {
    var CW = D.documentElement.clientWidth;
    var cs = function (e) { return W.getComputedStyle(e); };
    var real = function (e) {
      var r = e.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && cs(e).visibility !== 'hidden' && cs(e).display !== 'none';
    };
    // un bloque «con contenido» tiene media o texto: los paneles de fondo no cuentan
    var con = function (e) {
      return !!(e.querySelector('img,video,iframe,.sqs-video-wrapper,.plyr')
             || (e.innerText || '').trim().length > 1);
    };
    D.documentElement.classList.add('ms-measure');            // congela los reveals
    var bl = [].slice.call(D.querySelectorAll('.fe-block')).filter(real);
    var rc = bl.map(function (b) {
      var r = b.getBoundingClientRect();
      return { e: b, l: r.left, rt: r.right, t: r.top, b: r.bottom, c: con(b) };
    });
    var ov = [];
    for (var i = 0; i < rc.length; i++) for (var j = i + 1; j < rc.length; j++) {
      var a = rc[i], b = rc[j];
      if (a.l < b.rt - 4 && b.l < a.rt - 4 && a.t < b.b - 4 && b.t < a.b - 4 && a.c && b.c)
        ov.push((a.e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 16) + '><' +
                (b.e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 16));
    }
    var of = [], cl = [];
    [].slice.call(D.querySelectorAll('h1,h2,h3,h4,p,a.sqs-block-button-element,a.ms-wa,li,.ms-eyebrow'))
      .forEach(function (e) {
        if (!real(e)) return;
        var r = e.getBoundingClientRect();
        if (r.right > CW + 1 || r.left < -1) of.push(e.tagName + ':' + (e.innerText || '').trim().slice(0, 20));
        if (e.scrollHeight > e.clientHeight + 3) {
          var p = e.closest('.fe-block');
          if (p && r.bottom > p.getBoundingClientRect().bottom + 3)
            cl.push(e.tagName + ':' + (e.innerText || '').trim().slice(0, 20));
        }
      });
    D.documentElement.classList.remove('ms-measure');
    return {
      p: path + '@' + CW, hS: D.documentElement.scrollWidth > CW + 1,
      ov: ov, of: of.slice(0, 5), cl: Array.from(new Set(cl)).slice(0, 5)
    };
  });
};

/* --- 2 · volcado de rejilla ----------------------------------------------
   Lo que revela los errores de maquetado invisibles: dos tarjetas que deberían
   ser gemelas y no lo son (H1, A3, M2), un botón indentado respecto de su
   texto, un titular en una celda más corta que su propio alto.               */
window.__GRID = function (path, w, wait) {
  return window.__frame(path, w || 1440, wait, function (D, W) {
    return [].slice.call(D.querySelectorAll('section.page-section')).map(function (s, si) {
      return {
        sec: 'SEC' + (si + 1),
        h: Math.round(s.getBoundingClientRect().height),
        blocks: [].slice.call(s.querySelectorAll('.fe-block')).map(function (b) {
          var r = b.getBoundingClientRect(), g = W.getComputedStyle(b);
          return {
            gr: g.gridRowStart + '/' + g.gridRowEnd,
            gc: g.gridColumnStart + '/' + g.gridColumnEnd,
            w: Math.round(r.width), ht: Math.round(r.height), l: Math.round(r.left),
            txt: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 34)
          };
        })
      };
    });
  });
};

/* --- 3 · contraste real ---------------------------------------------------
   data-section-theme MIENTE en las secciones cuyo fondo reescribimos (el hero
   del home declara light y es negro). Por eso se mide el color efectivo de
   .section-background, no el atributo.                                       */
window.__CONTRAST = function (path, w, wait) {
  return window.__frame(path, w || 1440, wait, function (D, W) {
    var lum = function (c) {
      var m = c.match(/[\d.]+/g); if (!m) return null;
      var v = m.slice(0, 3).map(function (x) {
        x = x / 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4);
      });
      return .2126 * v[0] + .7152 * v[1] + .0722 * v[2];
    };
    var opaque = function (el) {                      // sube hasta hallar fondo no transparente
      for (var e = el; e && e !== D.documentElement; e = e.parentElement) {
        var bg = W.getComputedStyle(e).backgroundColor;
        if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
        var sb = e.querySelector && e.querySelector('.section-background');
        if (sb) {
          var b2 = W.getComputedStyle(sb).backgroundColor;
          if (b2 && !/rgba\(0, 0, 0, 0\)|transparent/.test(b2)) return b2;
        }
      }
      return 'rgb(255,255,255)';
    };
    var out = [];
    [].slice.call(D.querySelectorAll('.ms-eyebrow,h1,h2,h3,h4,p,a.sqs-block-button-element,nav a'))
      .forEach(function (e) {
        var r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        var lf = lum(W.getComputedStyle(e).color), lb = lum(opaque(e));
        if (lf === null || lb === null) return;
        var ratio = (Math.max(lf, lb) + .05) / (Math.min(lf, lb) + .05);
        if (ratio < 4.5) out.push({
          txt: (e.innerText || '').trim().slice(0, 28),
          ratio: Math.round(ratio * 100) / 100
        });
      });
    return { p: path, bajoDe45: out.slice(0, 12) };
  });
};

/* --- 4 · las ocho páginas, un ancho por llamada --------------------------- */
window.__PAGINAS = ['/', '/agencias', '/marcas', '/nosotros',
                    '/contacto', '/portafolio', '/casos-de-estudio', '/blog'];

/* Uso, de a dos o tres:
     await __P('/', 1440); await __P('/agencias', 1440); await __P('/marcas', 1440);
   Y después de cada cambio, en la pestaña del sitio ya cargada:
     getComputedStyle(document.documentElement).getPropertyValue('--ms-accent')  // canario del LESS
     window.__ms.steps; window.__ms3.steps; window.__ms4.steps
*/
