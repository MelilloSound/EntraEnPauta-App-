# melillosound.com · paquete de cambios listo para pegar

Escrito el 15/09/2026 a partir del brief de traspaso, en una sesión **sin acceso
al sitio**: la política de egreso de esta sesión bloquea `www.melillosound.com`
y no hay puente con el navegador, así que no se pudo abrir el panel de
Squarespace ni correr el probe.

**Consecuencia honesta:** el código de aquí está escrito contra los selectores y
las medidas documentadas en el brief, y **no está verificado contra el DOM en
vivo**. Lo único verificado localmente es lo que se podía verificar sin el
sitio, que no es poco:

| Verificación | Resultado |
|---|---|
| `custom-css-append.less` compila como LESS (`lessc`) | ✅ compila; los `clamp()` escapados salen como CSS válido |
| `footer-ms4.js` y `probe.js` parsean (`node --check`) | ✅ sin errores |
| Los snippets por página son CSS crudo, sin `~"..."` | ✅ (en Code Injection no hay LESS: escapar ahí rompería la regla) |
| `footer-ms4.js` corrido en **Chromium headless** contra una reproducción de la falla | ✅ ver abajo |

La primera fila es la que más importa: un `calc()` sin escapar deja la hoja
vacía, tumba los estilos del sitio entero y **Squarespace no avisa**.

### La prueba en Chromium

Se armó una página que reproduce las condiciones documentadas —`h2` con
`clamp(38px,7.4vw,118px)`, una rejilla de 24 columnas, un bloque de hero ancho,
celdas angostas de «Conversemos» y «Algunas preguntas frecuentes», un `.ms-num`,
el párrafo de cierre, y `word-break:break-word` para provocar el «Convers /
emos»— y se le inyectó el script a 1440, 768 y 390px:

```
=== 1440px ===
 Sonido que hace sentir la   celda 1438  antes 107px -> 107px  INTACTO
 Algunas preguntas frecuent  celda  538  antes 107px ->  49px
 Conversemos                 celda  418  antes 107px ->  38px
 Conversemos                 celda  538  antes 107px ->  49px
  ms-num: intacto | .ms-closer: 1 | idempotente tras dos resize: SI

=== 768px ===
 Sonido que hace sentir la   celda  766  antes  57px ->  57px  INTACTO
 Algunas preguntas frecuent  celda  286  antes  57px ->  34px
 Conversemos                 celda  222  antes  57px ->  26px
  ms-num: intacto | .ms-closer: 1 | idempotente tras dos resize: SI
```

Es decir: el hero queda **intacto** (sin estilo en línea, la animación de `__ms`
a salvo), los titulares de columna angosta bajan solos a la jerarquía correcta,
los numerales del proceso no se tocan, la línea de cierre se marca, y correrlo
cuatro veces seguidas da siempre el mismo resultado.

**Lo que la prueba encontró y se corrigió:** la red de seguridad se detenía en
el piso de 34px y dejaba el titular desbordado en contenedores muy angostos.
Ahora baja hasta 22px (`PISO`): un titular chico es mejor que uno que se sale de
la pantalla.

**Lo que la prueba no puede decir:** por debajo de ~150px de contenedor ni 22px
alcanzan para una palabra como «frecuentes». En el sitio real los bloques de
móvil son de ~358px, así que no debería ocurrir — pero es exactamente lo que
hay que confirmar corriendo `__P` a 390px. La reproducción no sustituye al
probe: es una red distinta, no la misma.

---

## Qué hay en esta carpeta

| Archivo | Dónde va | Qué resuelve |
|---|---|---|
| `footer-ms4.js` | Code Injection → **Footer**, después de `v3b` | 6.2 completo: titulares dimensionados por su contenedor + marcado de la línea de cierre |
| `custom-css-append.less` | **Custom CSS**, al final (bloques 32–35) | G1 (aire entre secciones), G2 parte 1 (hover de logos), estilo de la línea de cierre, titulares que no parten palabra |
| `page-portafolio.html` | Pages → Portafolio → Advanced → **Page Header Code Injection** | fuera la imagen de stock, tratamiento oscuro, fusión de SEC1+SEC2 |
| `page-nosotros.html` | Pages → Nosotros → Advanced → **Page Header Code Injection** | fuera la foto del piano, tratamiento oscuro |
| `probe.js` | consola de una pestaña en el sitio | `__P` (solapes/desbordes), `__GRID` (volcado de rejilla), `__CONTRAST` |

Los dos snippets por página son además el **primer paso real de la migración a
CSS por página** que pide la sección 7 del brief: todo lo de layout de esas dos
páginas queda aislado y no puede tocar a las demás.

---

## Cómo se pega y se guarda

`CodeMirror.setValue()` **no dispara** el evento que Squarespace escucha para
habilitar el botón de guardar. La secuencia que sí funciona:

```js
var cm = document.querySelectorAll('.CodeMirror')[0].CodeMirror;   // 0 = Custom CSS / Header
cm.setValue(nuevoTexto);
cm.focus();
cm.replaceRange('\n', cm.posFromIndex(cm.getValue().length));      // esto sí dispara el change
await new Promise(r=>setTimeout(r,900));
[].slice.call(document.querySelectorAll('button,[role="button"]'))
  .filter(e=>/^save$/i.test(e.textContent.trim()))[0].click();
await new Promise(r=>setTimeout(r,5000));
```

El panel de Custom CSS tarda **20–35 s** en montar el CodeMirror. Si
`document.querySelectorAll('.CodeMirror').length === 0`, esperar más y
reintentar: no es un error. Para pasar texto con acentos, codificar en base64 y
decodificar con `decodeURIComponent(escape(atob(b64)))`.

En Code Injection el índice **0** es el Header y el **1** es el Footer.

---

## Orden de aplicación, y qué mirar después de cada paso

Aplicar **de a uno**, no todo junto: si algo se rompe hay que saber qué fue.

**1 · `footer-ms4.js`** — el de mayor retorno: resuelve cuatro quejas en cinco
páginas. Pegar al final del Footer (índice 1), conservando los tres scripts que
ya están.
Después: `window.__ms4.steps` debe traer un `{step:'fit', n:…}` con `n` mayor que
cero, y un `{step:'closer', n:2}` en `/agencias` y `/marcas`.

**2 · `custom-css-append.less`** — pegar **al final** del Custom CSS actual, sin
tocar los 31 bloques que ya están.
Después, y antes que nada:
```js
getComputedStyle(document.documentElement).getPropertyValue('--ms-accent')
```
Si vuelve **vacío**, la hoja no compiló: revertir el bloque de inmediato.
Luego el probe completo, porque el paso 2 **baja el padding y sube la
densidad**, y en el Fluid Engine eso puede reactivar solapes:

```js
await __P('/',1440); await __P('/agencias',1440); await __P('/marcas',1440);
```
…y así las ocho páginas a **390, 768 y 1440**. Se busca `ov:[]`, `of:[]`,
`cl:[]`, `hS:false` en las 24 combinaciones.

**3 · `page-portafolio.html` y `page-nosotros.html`** — una página, verificar,
después la otra.

---

## Cómo está pensado `footer-ms4.js`

La causa de 6.2 es que `h2{font-size:clamp(38px,7.4vw,118px)}` dimensiona según
el **ancho de la ventana**, no según el ancho de la columna donde vive el
titular: a 1440px un h2 en un bloque de 448px sigue saliendo a 112px.

El script mide el ancho disponible de cada titular y le fija el tamaño en
píxeles, con una regla de seguridad que conviene entender antes de tocarlo:

- **Solo encoge.** Si el tamaño calculado es mayor o igual al que ya tiene, no
  toca el elemento ni le pone estilo en línea. Por eso el titular del hero del
  home (bloque de 1211px → calcula ~114px, ya tiene 112px) queda **intacto**, y
  el partido en líneas que hace `__ms` tras `document.fonts.ready` no se ve
  afectado. Era el riesgo de integración más serio de este cambio y así se evita
  en vez de gestionarse.
- **Mide y aplica en bloque** (limpia todos → mide todos → aplica todos) para no
  provocar una relayout por elemento.
- **Es idempotente**: limpia el estilo en línea antes de medir, así que correrlo
  en `DOMContentLoaded`, en `fonts.ready`, en `load` y en cada `resize` da
  siempre el mismo resultado.
- **Red de seguridad contra la palabra partida**: el bloque 33 del CSS impide
  que un titular se parta («Convers / emos») y lo obliga a desbordar; entonces
  el script detecta el desborde con `scrollWidth` y baja de a 2px hasta que la
  palabra quepa. Las dos piezas se necesitan: sin el bloque 33 el titular se
  parte en silencio y el script no puede verlo.
- **Deja fuera** los numerales `.ms-num` del proceso, y todo lo que viva en
  `header`, `footer` o `nav`.

La línea de cierre del proceso se marca **por coincidencia de texto**
(`/mientras antes entremos/i`), no por índice de sección — igual que las
etiquetas mono del sistema actual, y por la misma razón: sobrevive si se agrega
o se mueve una sección. Si Stefano cambia esa frase, hay que cambiar la regex.

---

## Lo que NO está aquí, y por qué

Estos puntos del brief necesitan **medir el DOM en vivo** antes de escribir una
línea. Escribirlos a ciegas habría sido inventar selectores:

| Punto | Qué falta medir |
|---|---|
| **H1 / A3 / M2** · igualar las tarjetas de «Cómo se contrata» | La conversión a flex exige **agrupar** texto + botón en una tarjeta, y los bloques del Fluid Engine son hermanos sueltos. Hay que ver con `__GRID` qué bloques caen en cada mitad antes de decidir si se agrupa por JS o se corrigen las columnas una por una. |
| **A2 / M3** · titular a todo el ancho y formulario más abajo | Cambio de `grid-row`/`grid-column` en secciones concretas: hacen falta los índices `nth-of-type` reales de cada página. |
| **G2 parte 2** · los 22 logos a PNG con transparencia | Requiere descargar los JPEG de `static1.squarespace.com`, procesarlos y **subirlos por el editor**. La subida es la parte lenta y frágil; conviene una pasada dedicada, no mezclada con CSS. |
| **Blog y casos de estudio** | Son *items de colección*, no páginas con Fluid Engine: el CSS de rejilla no los alcanza. Necesitan su propio bloque (medida ~68ch, titular con filete, etiqueta mono, pie con botones). Y antes hay que resolver lo de BNC. |
| **Migración completa a CSS por página** (sección 7) | Los dos snippets de aquí son el primer paso. El resto, de a una página y verificando cada vez. |

---

## Bloqueo de contenido que hay que decidir antes de seguir

`/casos-de-estudio` publica hoy **«Caso de Estudio: BNC — Banco Nacional de
Crédito» con nombre completo**, y el Contexto Maestro dice que los casos de BNC
**no están confirmados como publicables**. Está en vivo desde antes de esta
intervención.

Hay que decidir —dejarlo, anonimizarlo o bajarlo— **antes** de darle tratamiento
de diseño, porque el tratamiento lo vuelve más visible. Es la única decisión del
brief que no es técnica y que bloquea trabajo posterior.
