# Violentmonkey Scripts

Colección de userscripts para Violentmonkey / Tampermonkey.

## Instalación

1. Instala [Violentmonkey](https://violentmonkey.github.io/) en Chrome/Firefox.
2. Abre el archivo `.user.js` deseado desde el explorador (o arrástralo al navegador).
3. Violentmonkey detectará el script y ofrecerá instalarlo.

## Scripts incluidos

| Script | Qué hace | Sitio |
|--------|----------|-------|
| `moodle-assign-status.user.js` | Muestra si cada tarea está entregada (badge ✓/✗), resumen flotante en el curso, y en "Mis cursos" totales por curso + profesor + próxima entrega | `aulavirtual.murciaeduca.es` |

## Añadir un script nuevo

1. Crea el archivo `nombre.user.js` con el bloque de metadatos `// ==UserScript==` … `// ==/UserScript==`.
2. `@match` define en qué URLs corre.
3. Prueba en la consola del navegador antes de instalar.

## Notas

- Los scripts usan `fetch` same-origin con `credentials: 'include'` — funcionan solo tras login.
- Caché en `localStorage` para no saturar el servidor (TTL configurable en cada script).
