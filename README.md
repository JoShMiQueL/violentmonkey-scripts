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
| `temu-hide-import-charges.user.js` | Elimina de los listados los artículos con cargo de importación (fila "RRP €X.XX"), incluidos los carruseles/ads. Nunca actúa en carrito ni checkout | `*.temu.com` |

## Añadir un script nuevo

1. Crea el archivo `nombre.user.js` con el bloque de metadatos `// ==UserScript==` … `// ==/UserScript==`.
2. `@match` define en qué URLs corre; añade `@updateURL`/`@downloadURL` al raw del repo.
3. Prueba en la consola del navegador antes de instalar.

## Notas

- Los scripts usan `fetch` same-origin con `credentials: 'include'` — funcionan solo tras login.
- Caché en `localStorage` para no saturar el servidor (TTL configurable en cada script).
