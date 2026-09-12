# EntraEnPauta App

Herramienta web que predice si un guion publicitario **cabe dentro de su pauta comercial**
(1 min, 30s, 20s, 15s o la duración que definas) **antes** de entrar al estudio de grabación.

Pensada para creativos, agencias de publicidad, copywriters e ingenieros de grabación.
Todo se calcula en tiempo real mientras escribes, con un modelo de **sílabas por minuto (SPM)**
y pausas por puntuación calibrado para el **español de Latinoamérica**.

Desarrollada para **Melillo Sound**.

**▶ Probarla en vivo:** https://claude.ai/code/artifact/1789ffbd-a072-4592-9af6-645ecb61ef2d

---

## Cómo usarla

No necesita instalación, servidor ni conexión a internet.

```bash
# Opción 1 — abrir el archivo directamente
open index.html          # macOS
xdg-open index.html      # Linux
start index.html         # Windows

# Opción 2 — servirla en local
npx http-server . -p 8080
```

### Publicarla en GitHub Pages

`Settings → Pages → Source: Deploy from a branch → rama · carpeta /(root)`.
No hay paso de compilación: se publica tal cual.

---

## Cómo cambiar el logotipo

Los SVG incluidos son una **reproducción vectorial** del logotipo: el ícono del teclado
es fiel al original, pero el wordmark está compuesto con una pila de tipografías
geométricas, no con la tipografía licenciada de la marca. Para usar los archivos
oficiales, reemplázalos conservando estos nombres:

| Archivo | Se usa en |
|---|---|
| `assets/melillo-sound.svg` | interfaz **clara** — wordmark oscuro |
| `assets/melillo-sound-dark.svg` | interfaz **oscura** — wordmark claro |

Son dos porque el wordmark de la marca es de un verde casi negro y desaparecería sobre
el tema oscuro. La app intercambia el `src` según el tema efectivo; no hay que editar
`index.html`. Sirve SVG, PNG o WebP (si cambias la extensión, ajusta la línea
`$("logoImg").src = ...` dentro de `aplicarTema()`).

El alto se limita por CSS a 34px, así que conviene una **versión horizontal** del
logotipo: el lockup vertical del manual de marca queda ilegible a esa altura.

---

## El modelo predictivo

### Paso A — Conteo de sílabas

Cada grupo de vocales equivale a una sílaba en español, con ~95 % de precisión:

```js
(texto.match(/[aeiouáéíóúü]+/gi) || []).length
```

### Paso B — Tiempo base

```
Tiempo base (s) = (sílabas / SPM del estilo) × 60
```

> Los SPM son el razonamiento interno del modelo y **no se muestran en la aplicación**:
> el usuario elige un estilo por su nombre, no por su cifra. La tabla está aquí para quien
> mantenga el código o quiera recalibrar.

| Estilo de locución | SPM |
|---|---:|
| Promocional / Alta Energía | 415 |
| Natural / Conversacional | 355 |
| Amigable / Profesional | 335 |
| Institucional / Voz de Marca | 310 |
| Emotivo | 290 |
| Maternal / Paternal | 265 |
| Sensual | 240 |
| Tráiler de Película | 220 |

### Paso C — Penalización por puntuación

Segundos extra por cada pausa para respirar:

| Signo | Pausa |
|---|---:|
| Coma `,` | +0.5 s |
| Punto `.` | +1.0 s |
| Punto y coma `;` o dos puntos `:` | +0.8 s |
| Puntos suspensivos `...` | +1.5 s |
| Cierre de interrogación `?` o exclamación `!` | +1.0 s |

Los puntos suspensivos se consumen **antes** de contar puntos simples: de lo contrario
`...` sumaría 3.0 s en vez de 1.5 s. Los signos de **apertura** `¿` `¡` no suman pausa.

> **Tiempo del bloque = Tiempo base + Tiempo de puntuación**

### Un estilo base, y overrides por sección

El selector de arriba fija el **estilo base** del proyecto. Copy Creativo y Copy Oferta /
Institucional tienen además su propio selector, cuya primera opción — *«Igual que el estilo base»* —
viene marcada por defecto: cambiar el base mueve las secciones que no hayas tocado, y una sección
con estilo propio queda fijada.

Existe porque un comercial real rara vez tiene un solo ritmo: la dramatización del creativo la hacen
actores de doblaje y el cierre de marca lo lee un locutor institucional. Cada sección muestra en su
pie el SPM con el que se está midiendo.

El **VO del AudioLogo** usa siempre el estilo base. El **Copy Legal** no lleva selector de estilo:
usa el base con su multiplicador de velocidad, porque ahí lo que importa es la rapidez.

### Reglas específicas por bloque

- **AudioLogo** — aporta a la pauta su **duración musical fija**, no el tiempo del VO.
  El VoiceOver va *superpuesto* sobre la música, por eso la alerta roja salta cuando el
  VO dura más que el AudioLogo: no cabe encima.
- **Copy Legal** — el selector de velocidad multiplica el ritmo (Normal `1×`,
  Rápido `1.25×`, Muy Rápido `1.5×`) y **comprime sílabas y pausas por igual**, porque
  un legal acelerado también acorta las respiraciones.

### Recalibrar el modelo

Todas las constantes viven juntas al inicio del `<script>` de `index.html`:
`CONTACTO`, `ESTILOS`, `PAUSAS`, `VELOCIDAD_LEGAL` y `LIMITES`. Para ceñirte a la
fórmula sin `?` ni `!`, pon `PAUSAS.cierre` en `0`.

---

## Alertas

- 🔴 **Densidad** — un módulo supera lo recomendado: Copy Creativo > 20s,
  Copy Oferta / Institucional > 8s, Copy Legal > 6s, o el VO no cabe en el AudioLogo.
- 🟠 **Cifras** — el texto contiene números o una «X» usada como «por» (2 X 1).
  La fórmula los subestima: `1999` es una palabra pero ocho sílabas.

## Diagnóstico global

| Ocupación | Veredicto |
|---|---|
| < 50 % | 🟡 Podría sobrar espacio dentro de esta pauta |
| 50 – 80 % | 🟢 Tu texto funciona dentro de la pauta |
| > 80 – 100 % | 🟠 Tu texto está justo y podría estar apretado |
| > 100 % | 🔴 Tu texto excede la pauta · indica los segundos sobrantes |

---

## Ficha del proyecto

Sobre la estructura del comercial se rellenan **Título**, **Marca** y **Versión**, más
**Agencia** y **Dirección creativa**, opcionales. Encabezan la hoja del guion final; las dos
opcionales simplemente no aparecen si se dejan vacías. Todo se autoguarda con el resto del trabajo.

## Guion final: una hoja A4

El botón **Generar Guion Final** arma una hoja lista para imprimir o copiar:

1. **Cabecera** con la ficha del proyecto.
2. **GUION FINAL** — solo los textos a locutar, en orden cronológico real (el AudioLogo al
   principio o al final, según se configure), sin rótulos ni indicaciones. Los saltos de línea
   se conservan tal como se escribieron.
3. **RESUMEN TÉCNICO** — una línea del tiempo donde el ancho de cada tramo **es** su duración,
   dibujada solo con tinta, con el nombre de cada estructura y sus segundos debajo. Si el guion
   excede la pauta, una línea punteada marca el límite. Debajo, el estilo de cada sección y el
   total.

**Imprimir / Guardar PDF** saca la hoja sola en A4, sin la interfaz detrás. **Copiar texto** pone
en el portapapeles el equivalente en texto plano — misma cabecera, guion corrido y los tramos como
lista — que es lo que pega limpio en WhatsApp, correo o un prompter.

La hoja se pinta siempre con colores de papel en los dos temas: es la vista previa honesta de lo
que sale por la impresora.

---

## Pruebas

`tests/verify.mjs` cubre el motor de cálculo, las alertas, los veredictos, el render de
la barra, el guion final los estilos por sección, la hoja A4 del guion final —incluida una impresión real a PDF—
y el diseño responsivo (120 aserciones).

```bash
npm install -D playwright   # si aún no está disponible
node tests/verify.mjs       # añade --shots para generar capturas en tests/output/
```

---

## Publicar como Artifact

`index.html` es la única fuente de verdad. Para generar la variante que consume el
anfitrión de Artifacts (que aporta su propio `<!doctype>`, `<head>` y `<body>`):

```bash
node tools/build-artifact.mjs   # → dist/entraenpauta.html
```

La app respeta el tema del anfitrión: si el contenedor estampa `data-theme` en `<html>`,
lo sigue mientras el usuario no elija tema desde el header.

---

## Detalles técnicos

- Un solo archivo, cero dependencias, cero peticiones externas: funciona sin conexión.
- Tema claro y oscuro; sigue al sistema y se puede forzar desde el header.
- El trabajo se autoguarda en `localStorage` y se recupera al volver.
- Accesible: etiquetas reales, `aria-live` en el diagnóstico y foco visible.

---

© Melillo Sound. Las duraciones son una estimación: la interpretación final del locutor puede variar.
