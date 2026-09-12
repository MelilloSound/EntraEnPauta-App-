# EntraEnPauta App

Herramienta web que predice si un guion publicitario **cabe dentro de su pauta comercial**
(1 min, 30s, 20s, 15s o la duración que definas) **antes** de entrar al estudio de grabación.

Pensada para creativos, agencias de publicidad, copywriters e ingenieros de grabación.
Todo se calcula en tiempo real mientras escribes, con un modelo de **sílabas por minuto (SPM)**
y pausas por puntuación calibrado para el **español de Latinoamérica**.

Desarrollada para **Melillo Sound**.

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

Reemplaza **`assets/melillo-sound.svg`** conservando ese nombre. El header lo toma
automáticamente y no hay que editar `index.html`. Sirve SVG, PNG o WebP (si cambias
la extensión, ajusta el `src` en el único `<img class="logo">` del archivo).
El alto se limita por CSS a 34px, así que cualquier proporción razonable funciona.

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
  Copy Oferta > 8s, Copy Legal > 6s, o el VO no cabe en el AudioLogo.
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

## Guion final

El botón **Generar Guion Final** arma un documento limpio con solo los textos a locutar,
en orden cronológico real (el AudioLogo al principio o al final, según se configure),
sin contadores ni datos de la interfaz. Bajo una línea `---` añade un **Resumen Técnico**
para el ingeniero de mezcla con los tiempos de cada sección y el estilo elegido.

---

## Pruebas

`tests/verify.mjs` cubre el motor de cálculo, las alertas, los veredictos, el render de
la barra, el guion final y el diseño responsivo (59 aserciones).

```bash
npm install -D playwright   # si aún no está disponible
node tests/verify.mjs       # añade --shots para generar capturas en tests/output/
```

---

## Detalles técnicos

- Un solo archivo, cero dependencias, cero peticiones externas: funciona sin conexión.
- Tema claro y oscuro; sigue al sistema y se puede forzar desde el header.
- El trabajo se autoguarda en `localStorage` y se recupera al volver.
- Accesible: etiquetas reales, `aria-live` en el diagnóstico y foco visible.

---

© Melillo Sound. Las duraciones son una estimación: la interpretación final del locutor puede variar.
