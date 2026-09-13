# Publicar EntraEnPauta

Guía de un solo camino, en orden. Cada paso dice qué esperar y cómo saber que salió bien.

**Resultado final**

| URL | Qué es | Dónde vive |
|---|---|---|
| `entraenpauta.melillosound.com` | La herramienta | GitHub Pages (este repo) |
| `melillosound.com/entraenpauta-app` | Página de aterrizaje con el formulario | Squarespace |

**Dónde se toca cada cosa:** el dominio está registrado en **Porkbun** (ahí va el DNS) y la web
está alojada en **Squarespace** (ahí va la página de aterrizaje). Son dos paneles distintos.

## Por qué no va directo en Squarespace

Squarespace no puede servir un archivo HTML propio en una ruta: no hay FTP ni acceso a la raíz.
Solo permite bloques de código dentro de páginas, y los iframes exigen plan Core o superior.
Por eso la herramienta se sirve aparte, en su propio subdominio, y Squarespace se queda con lo
que hace bien: la página de venta y el formulario.

Un subdominio propio además es **mejor técnicamente** que incrustarla: dentro de un iframe, el
navegador trata el almacenamiento como de terceros y el autoguardado puede no persistir.

---

## 1 · Mezclar el pull request

Abre el PR **«Publicar EntraEnPauta 1.0.0-beta.1»**, revísalo y dale a *Merge*.

Después, en **Settings → General → Default branch**, cambia la predeterminada a `main`.
Hoy lo es la rama de desarrollo, porque fue el primer push del repo.

## 2 · Activar GitHub Pages

**Settings → Pages**

- *Source*: **Deploy from a branch**
- *Branch*: **`main`**, carpeta **`/ (root)`** → **Save**

En un minuto aparece arriba «Your site is live at …». Ábrelo: debe verse la app.
Si ves el README en vez de la app, la carpeta elegida no es la raíz.

## 3 · Conectar el subdominio

Sigue en **Settings → Pages → Custom domain**: escribe `entraenpauta.melillosound.com` y **Save**.
GitHub avisará de que el DNS todavía no responde. Es lo normal: falta el paso 4.

> El archivo `CNAME` del repo ya lleva ese dominio, así que el campo puede rellenarse solo.

## 4 · Crear el registro DNS en Porkbun

El dominio está registrado en **Porkbun**, no en Squarespace: el registro va ahí. Squarespace
solo aloja la web; el DNS lo gobierna quien tiene los nameservers.

**porkbun.com → Account → Domain Management → melillosound.com → DNS Records**

| Campo | Valor |
|---|---|
| Type | `CNAME` |
| Host | `entraenpauta` |
| Answer | `melillosound.github.io` |
| TTL | `600` |

En **Host** va solo la etiqueta del subdominio, `entraenpauta`, no el dominio completo: Porkbun
le añade `melillosound.com` por su cuenta. En **Answer** va el destino sin `https://` y sin barra
final. Pulsa **Add**.

La propagación tarda de unos minutos a unas horas.

**Si Porkbun rechaza el registro** con «A CNAME or ALIAS record with that host already exists», es
que ya hay algo en ese host: bórralo primero. Un registro duplicado es también la causa más común
de que el certificado de GitHub no llegue a emitirse.

> **Cómo confirmar que Porkbun es el sitio correcto:** en su panel deberías ver los registros que
> hoy apuntan `melillosound.com` a Squarespace (direcciones que empiezan por `198.185.159.` o
> `198.49.23.`). Si los ves, estás donde toca. Si el panel está vacío o dice que los nameservers
> son de otro proveedor, el DNS se gestiona allí y el registro va en ese otro panel.

Referencias: [añadir registros DNS en Porkbun](https://kb.porkbun.com/article/231-how-to-add-dns-records-on-porkbun)
y [conectar un dominio de Porkbun a GitHub Pages](https://kb.porkbun.com/article/64-how-to-connect-your-domain-to-github-pages).

## 5 · Esperar el certificado y forzar HTTPS

Vuelve a **Settings → Pages**. Cuando el DNS propague verás *DNS check successful* y, poco
después, se activará la casilla **Enforce HTTPS**. Márcala.

**No compartas el enlace hasta que el candado aparezca en el navegador.** Antes de eso, quien lo
abra verá un aviso de sitio no seguro.

¿Sigue sin emitir pasada una hora? Quita el dominio del campo *Custom domain*, guarda, vuelve a
escribirlo y guarda otra vez. Eso reintenta la emisión.

## 6 · La página de aterrizaje en Squarespace

Crea una página con la URL `/entraenpauta-app`. El texto listo para pegar está en
[`docs/landing-squarespace.md`](docs/landing-squarespace.md).

Lo esencial: un bloque de formulario con **nombre, correo y empresa**, y que al enviarlo lleve a
`https://entraenpauta.melillosound.com`.

> **No te saltes esto:** el formulario nativo guarda los envíos dentro de Squarespace, pero hay
> que **conectarlo** a Mailchimp o Google Sheets en *Storage* para que los leads lleguen a tu
> lista de correo. Sin conectar, quedan atrapados en el panel.

---

## Beta cerrada

La app se publica con **`<meta name="robots" content="noindex">`** en el `<head>` de `index.html`.
Google no la indexa: el enlace solo llega a quien tú se lo des.

Mientras dure la beta, en el pie aparece la versión y un enlace **«¿algo no cuadra? Cuéntanos»**
que abre un correo prellenado con la versión y el navegador de quien reporta. Así sabrás siempre
de qué build habla cada mensaje.

## Lista de lanzamiento público

Cuando termines la ronda con tus allegados:

- [ ] **Quitar el `noindex`** de `index.html`. Está marcado con un comentario `⚠ BETA CERRADA`.
      También hay que quitar su aserción en `tests/verify.mjs` («la beta lleva noindex»).
- [ ] Decidir si el enlace de feedback y la etiqueta de versión siguen o se van.
- [ ] Comprobar la tarjeta al compartir pegando el enlace en un chat: debe salir la imagen.
      Si la cambiaste, regenérala con `node tools/build-og.mjs` y vuelve a subirla.
- [ ] Subir la versión en la constante `VERSION` de `index.html`.
- [ ] Enviar la página al buscador en Squarespace, si quieres que indexe la de aterrizaje.

## Actualizar la app después

GitHub Pages sirve archivos, no compila nada: cualquier cambio que llegue a `main` está en línea
en un minuto.

```bash
node tests/verify.mjs     # 141 aserciones; que estén en verde antes de publicar
git push origin main
```
