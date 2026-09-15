# Prueba de `footer-ms4.js` en Chromium

Reproduce las condiciones documentadas en el brief (h2 con
`clamp(38px,7.4vw,118px)`, rejilla de 24 columnas, celdas angostas,
`word-break:break-word`) e inyecta el script a 1440, 768 y 390px.

No sustituye al probe contra el sitio en vivo: es una red distinta.

```bash
npm install playwright   # en la raíz del repo (node_modules está en .gitignore)
node test/run.mjs      # usa el Chromium del entorno vía executablePath
```
