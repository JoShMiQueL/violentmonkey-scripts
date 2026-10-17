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
| `temu-hide-import-charges.user.js` | Switch ON/OFF (píldora flotante + menú VM). Cuando está activo marca cada artículo enviado desde fuera de la UE con un triángulo rojo en la esquina y modifica la línea de precio inline: `precio +3,63 → total` (cargo de importación ~3€/ítem + IVA, política oficial de Temu). En el carrito y el mini-carrito lateral añade `+cargos → total` en la línea Subtotal/Total (solo ítems seleccionados) y una nota sobre la cobertura del 50% de Temu en pedidos >20€ (máx 10€, si aplica). En el checkout marca las filas del acordeón con el cargo real. Detecta el origen por el CDN de la imagen (`img-eu.kwcdn.com`/`local-goods-img` = almacén local, sin cargo) y decodifica el subtotal ofuscado del sidebar (rodillos de dígitos). Nunca oculta ni elimina nada | `*.temu.com` |

## Añadir un script nuevo

1. Crea el archivo `nombre.user.js` con el bloque de metadatos `// ==UserScript==` … `// ==/UserScript==`.
2. `@match` define en qué URLs corre; añade `@updateURL`/`@downloadURL` al raw del repo.
3. Prueba en la consola del navegador antes de instalar.

## Notas

- Los scripts usan `fetch` same-origin con `credentials: 'include'` — funcionan solo tras login.
- Caché en `localStorage` para no saturar el servidor (TTL configurable en cada script).
