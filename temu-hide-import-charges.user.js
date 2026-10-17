// ==UserScript==
// @name         Temu: ocultar artículos con cargo de importación
// @namespace    https://github.com/JoShMiQueL/violentmonkey-scripts
// @version      1.5
// @downloadURL  https://raw.githubusercontent.com/JoShMiQueL/violentmonkey-scripts/master/temu-hide-import-charges.user.js
// @updateURL    https://raw.githubusercontent.com/JoShMiQueL/violentmonkey-scripts/master/temu-hide-import-charges.user.js
// @description  Elimina de los listados de Temu los artículos con cargo de importación (marcados con "RRP €X.XX"), incluidos los ads de los carruseles. Objetivo: 0 € en importación.
// @match        *://*.temu.com/*
// Páginas transaccionales excluidas: el carrito/checkout se ve siempre intacto
// @exclude      *://*.temu.com/*cart*
// @exclude      *://*.temu.com/*checkout*
// @exclude      *://*.temu.com/*order*
// @exclude      *://*.temu.com/*account*
// @exclude      *://*.temu.com/*payment*
// @exclude      *://*.temu.com/*sign-in*
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const LOG = '[vm-temu-import]';
    // Contenedor de producto, presente en grid y carruseles: data-tooltip="goodContainer-XXXXX"
    const CONTAINER_SEL = '[data-tooltip^="goodContainer-"]';
    // Texto del precio recomendado: "RRP", "RRP €9.00", "RRP 9,00€"
    const RRP_RE = /^RRP\b/i;
    const MAX_CLIMB = 20; // niveles máximos al subir por el DOM

    // Defensa extra: nunca actuar en páginas transaccionales aunque cambie la URL
    // ("cart" sin ancla de '/' porque la URL real es /shopping_cart.html)
    if (/(cart|checkout|order|account|payment|sign-in)/i.test(location.pathname)) {
        return;
    }

    console.log(LOG, 'script cargado en', location.href);

    // Ocultar por atributo + CSS: sobrevive si Temu re-renderiza y limpia el style inline
    const style = document.createElement('style');
    style.textContent = '[data-vm-rrp-hidden]{display:none!important}';
    document.head.appendChild(style);

    // Las clases de Temu son hashes que rotan: la tarjeta se localiza por estructura.
    // Sube desde el texto "RRP" mientras el padre envuelva como mucho un producto;
    // la tarjeta válida siempre contiene un contenedor de producto (la imagen/ficha).
    function cardOf(marker) {
        let node = marker;
        for (let i = 0; i < MAX_CLIMB && node !== document.body && node.parentElement; i++) {
            if (node.parentElement.querySelectorAll(CONTAINER_SEL).length >= 2) break;
            node = node.parentElement;
        }
        if (node === document.body || !node.querySelector(CONTAINER_SEL)) return null;
        return node;
    }

    // Descarta falsos positivos: un candidato válido es una celda de tamaño tarjeta,
    // nunca body/html ni un contenedor tan alto como toda la página.
    function looksLikeCard(el) {
        if (el === document.body || el === document.documentElement) return false;
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.height < innerHeight * 1.5;
    }

    const checked = new WeakSet();

    function scan() {
        let hidden = 0;
        for (const el of document.querySelectorAll('span')) {
            if (checked.has(el)) continue;
            checked.add(el);
            if (!RRP_RE.test(el.textContent.trim())) continue;
            const card = cardOf(el);
            // Tarjeta aún no localizable (lazy render): se reintenta en el próximo escaneo
            if (!card || !looksLikeCard(card)) { checked.delete(el); continue; }
            if (card.dataset.vmRrpHidden) continue;
            card.dataset.vmRrpHidden = '1';
            hidden++;
        }
        return hidden;
    }

    // Los listados cargan por scroll/AJAX: escanear de nuevo ante cada tanda de cambios
    let pending = false;
    let total = 0;
    function scheduleScan() {
        if (pending) return;
        pending = true;
        setTimeout(() => {
            pending = false;
            const n = scan();
            if (n) {
                total += n;
                console.log(LOG, 'artículos ocultos:', total);
            }
        }, 150);
    }

    scheduleScan();
    new MutationObserver(scheduleScan)
        .observe(document.body, { childList: true, subtree: true });
})();
