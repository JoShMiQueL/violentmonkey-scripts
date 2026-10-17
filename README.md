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
| `temu-hide-import-charges.user.js` | Switch ON/OFF (píldora flotante + menú VM). Cuando está activo marca con borde rojo + badge del importe todo artículo enviado desde fuera de la UE (cargo de importación ~3€/ítem + IVA, política oficial de Temu) — en listados, mini-carrito, carrito y checkout. Detecta el origen por el CDN de la imagen (`img-eu.kwcdn.com`/`local-goods-img` = almacén local, sin cargo). Nunca oculta ni elimina nada | `*.temu.com` |

## Añadir un script nuevo

1. Crea el archivo `nombre.user.js` con el bloque de metadatos `// ==UserScript==` … `// ==/UserScript==`.
2. `@match` define en qué URLs corre; añade `@updateURL`/`@downloadURL` al raw del repo.
3. Prueba en la consola del navegador antes de instalar.

## Notas

- Los scripts usan `fetch` same-origin con `credentials: 'include'` — funcionan solo tras login.
- Caché en `localStorage` para no saturar el servidor (TTL configurable en cada script).
