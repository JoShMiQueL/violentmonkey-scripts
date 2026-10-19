# Violentmonkey Scripts

Colección de userscripts para Violentmonkey / Tampermonkey.

## Instalación

1. Instala [Violentmonkey](https://violentmonkey.github.io/) en Chrome/Firefox.
2. Abre la URL raw del `.user.js` deseado en GitHub — Violentmonkey ofrecerá instalarlo.
3. Las actualizaciones llegan solas: cada script lleva `@updateURL`/`@downloadURL` apuntando a este repo.

## Scripts incluidos

| Script | Qué hace | Sitio |
|--------|----------|-------|
| `murciaeduca-enhancer.user.js` | Enhancer del aula virtual: badge ✓/✗ de entrega por tarea, resumen flotante en el curso, y en "Mis cursos" totales por curso + profesor + próxima entrega | `aulavirtual.murciaeduca.es` |
| `temu-hide-import-charges.user.js` | Switch ON/OFF (píldora flotante + menú VM). Cuando está activo marca cada artículo enviado desde fuera de la UE con un triángulo rojo abajo-derecha de la tarjeta (en carrito/minicart, sobre la miniatura para no tapar botones), precio inline `precio +3,63€ → total`, y línea `Import fees +3,63€ ?` con el icono nativo de ayuda de Temu (en la línea del RRP si existe; si no, línea propia). El carrito añade una fila nativa `Import fees (n): +X` antes del Total + nota de cobertura (50% en pedidos >20€, máx 10€); el mini-carrito muestra filas alineadas de fees y total. Detecta el origen por el CDN de la imagen (`img-eu.kwcdn.com`/`local-goods-img` = almacén local, sin cargo) y decodifica el subtotal ofuscado del sidebar. Nunca oculta ni elimina nada | `*.temu.com` |
| `youtube-real-time-helper.user.js` | Extiende el timer del reproductor de YouTube con el tiempo real que queda hasta el final a la velocidad actual (`Done in`), lo que ahorras (o añades) frente a 1x con su porcentaje y la hora estimada de fin en formato 24h (`HOUR_24`). Lee la velocidad del `<video>`, así que también refleja los cambios hechos por otras extensiones de velocidad. Va dentro de la propia barra de tiempo de YouTube, se adapta al ancho disponible (descarta segmentos en lugar de recortarlos), se oculta durante anuncios y directos, y su tooltip queda congelado mientras el ratón está encima para que no parpadee | `youtube.com` |

## Añadir un script nuevo

1. Crea el archivo `nombre.user.js` con el bloque de metadatos `// ==UserScript==` … `// ==/UserScript==`.
2. `@match` define en qué URLs corre; añade `@updateURL`/`@downloadURL` al raw del repo.
3. Prueba en la consola del navegador antes de instalar.

## Notas

- Los scripts usan `fetch` same-origin con `credentials: 'include'` — funcionan solo tras login.
- Caché en `localStorage` para no saturar el servidor (TTL configurable en cada script).
