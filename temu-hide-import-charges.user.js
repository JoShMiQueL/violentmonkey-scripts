// ==UserScript==
// @name         Temu: mark items with import charges
// @namespace    https://github.com/JoShMiQueL/violentmonkey-scripts
// @version      2.1
// @downloadURL  https://raw.githubusercontent.com/JoShMiQueL/violentmonkey-scripts/master/temu-hide-import-charges.user.js
// @updateURL    https://raw.githubusercontent.com/JoShMiQueL/violentmonkey-scripts/master/temu-hide-import-charges.user.js
// @description  On/off switch. When ON, marks every item that ships from outside the EU (import charge ~3€/item + VAT, per Temu's policy) with a red border + fee badge — listings, mini-cart, cart and checkout. Nothing is hidden or removed.
// @match        *://*.temu.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    const LOG = '[vm-temu-import]';
    // Product card container, present in grids and carousels: data-tooltip="goodContainer-XXXXX"
    const CONTAINER_SEL = '[data-tooltip^="goodContainer-"]';
    // EU-fulfilled items serve images from the EU CDN / local-goods path.
    // Everything else ships internationally -> import charge at checkout.
    const LOCAL_IMG_RE = /img-eu\.kwcdn\.com|local-goods-img/i;
    const PRODUCT_IMG_RE = /img(?:-eu)?\.kwcdn\.com\/product\//i;
    // Real charge text shown in the checkout accordion: "This 1 item has one import charge:3,63€"
    const CHARGE_TEXT_RE = /has one import charge/i;
    const AMOUNT_RE = /(\d+[.,]\d+)\s*€/;
    const DEFAULT_AMOUNT = '~3,63€';
    const ENABLED_KEY = 'temuIcEnabled';
    const MAX_CLIMB = 20;

    let enabled = GM_getValue(ENABLED_KEY, true);

    const style = document.createElement('style');
    style.textContent = `
        [data-vm-ic="charged"]{box-shadow:0 2px 0 0 #e02424!important}
        [data-vm-ic-badge]{position:absolute;top:4px;left:4px;z-index:9999;pointer-events:none;
            background:#e02424;color:#fff;font:600 11px/1.4 system-ui,sans-serif;
            padding:2px 6px;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.35)}
        #vmIcToggle{position:fixed;right:14px;bottom:14px;z-index:999999;cursor:pointer;
            border:0;border-radius:20px;padding:8px 14px;font:600 13px system-ui,sans-serif;
            color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.35)}
        #vmIcToggle[data-on="1"]{background:#e02424}
        #vmIcToggle[data-on="0"]{background:#666}
    `;
    document.head.appendChild(style);

    // ---- classification -----------------------------------------------------

    function imgUrls(el) {
        const urls = [];
        for (const img of el.querySelectorAll('img, source')) {
            for (const a of ['src', 'currentSrc', 'data-src', 'srcset', 'data-srcset']) {
                const v = a === 'currentSrc' ? img.currentSrc : img.getAttribute(a);
                if (v) urls.push(v);
            }
            const bg = img.style?.backgroundImage;
            if (bg) urls.push(bg);
        }
        return urls;
    }

    // 'local' = EU warehouse (no fee) | 'charged' = ships internationally | 'unknown' = not rendered yet
    function classify(el) {
        let local = false, product = false;
        for (const u of imgUrls(el)) {
            if (LOCAL_IMG_RE.test(u)) local = true;
            else if (PRODUCT_IMG_RE.test(u)) product = true;
        }
        return local ? 'local' : product ? 'charged' : 'unknown';
    }

    // ---- container detection ------------------------------------------------

    // Listing cards: climb from the product container while the parent wraps
    // a single product (same structural rule as before).
    function cardOf(container) {
        let node = container;
        for (let i = 0; i < MAX_CLIMB && node !== document.body && node.parentElement; i++) {
            if (node.parentElement.querySelectorAll(CONTAINER_SEL).length >= 2) break;
            node = node.parentElement;
        }
        if (node === document.body || !node.querySelector(CONTAINER_SEL)) return null;
        const r = node.getBoundingClientRect();
        if (r.height === 0 || r.height >= innerHeight * 1.5) return null;
        return node;
    }

    // Cart / mini-cart / checkout rows: climb from a product image until the
    // parent would wrap more than one product or become oversized.
    function itemBoxOf(img) {
        let node = img.parentElement;
        let last = null;
        for (let i = 0; i < MAX_CLIMB && node && node !== document.body; i++) {
            const r = node.getBoundingClientRect();
            if (r.height > 400 || r.width > 1400) break;
            if (node.querySelectorAll('img').length > 4) break;
            if (r.height >= 50 && r.width >= 140) last = node;
            node = node.parentElement;
        }
        if (!last || !AMOUNT_RE.test(last.textContent)) return null;
        return last;
    }

    // ---- marking ------------------------------------------------------------

    function amountOf(el) {
        const m = el.textContent.replace(/\s+/g, ' ').match(/import charge\D*(\d+[.,]\d+)\s*€/i);
        return m ? m[1] + '€' : DEFAULT_AMOUNT;
    }

    function mark(el) {
        if (el.dataset.vmIc === 'charged' && el.querySelector('[data-vm-ic-badge]')) return;
        el.dataset.vmIc = 'charged';
        // Badge is absolutely positioned: only set relative when the element is
        // static — never override absolute/fixed positioning or the layout breaks.
        if (getComputedStyle(el).position === 'static') {
            el.dataset.vmIcRel = '1';
            el.style.position = 'relative';
        }
        const badge = document.createElement('span');
        badge.dataset.vmIcBadge = '1';
        badge.textContent = 'Import fee ' + amountOf(el);
        badge.title = 'Ships from outside the EU — import charge applies at checkout';
        el.appendChild(badge);
    }

    function unmarkAll() {
        for (const el of document.querySelectorAll('[data-vm-ic]')) {
            delete el.dataset.vmIc;
            if (el.dataset.vmIcRel) { el.style.position = ''; delete el.dataset.vmIcRel; }
        }
        for (const b of document.querySelectorAll('[data-vm-ic-badge]')) b.remove();
    }

    // ---- scanning -----------------------------------------------------------

    function scan() {
        let marked = 0;
        // 1) listing cards (grid + carousels)
        for (const c of document.querySelectorAll(CONTAINER_SEL)) {
            const card = cardOf(c);
            if (!card || card.dataset.vmIc === 'charged') continue;
            if (classify(card) === 'charged') { mark(card); marked++; }
        }
        // 2) any product image outside a listing card (cart, mini-cart, checkout, PDP)
        for (const img of document.querySelectorAll('img')) {
            if (img.closest('[data-vm-ic]') || img.closest(CONTAINER_SEL)) continue;
            const u = img.currentSrc || img.src || img.getAttribute('data-src') || '';
            if (!PRODUCT_IMG_RE.test(u) || LOCAL_IMG_RE.test(u)) continue;
            const box = itemBoxOf(img);
            if (box && classify(box) === 'charged') { mark(box); marked++; }
        }
        // 3) checkout accordion rows (explicit fee text, authoritative amounts)
        for (const el of document.querySelectorAll('div, li, span')) {
            if (el.children.length === 0 && CHARGE_TEXT_RE.test(el.textContent)) {
                const box = itemBoxOf(el) || el.parentElement;
                if (box && box.dataset.vmIc !== 'charged') { mark(box); marked++; }
            }
        }
        return marked;
    }

    let pending = false;
    function scheduleScan() {
        if (pending || !enabled) return;
        pending = true;
        setTimeout(() => {
            pending = false;
            if (!enabled) return;
            const n = scan();
            if (n) console.log(LOG, 'items marked:', n);
        }, 150);
    }

    // ---- switch -------------------------------------------------------------

    const toggle = document.createElement('button');
    toggle.id = 'vmIcToggle';
    function renderToggle() {
        toggle.dataset.on = enabled ? '1' : '0';
        toggle.textContent = enabled ? 'Import fees: ON' : 'Import fees: OFF';
        toggle.title = 'Toggle import-charge markers (Violentmonkey script)';
    }
    function setEnabled(v) {
        enabled = v;
        GM_setValue(ENABLED_KEY, v);
        renderToggle();
        if (v) scheduleScan();
        else unmarkAll();
    }
    toggle.addEventListener('click', () => setEnabled(!enabled));
    document.body.appendChild(toggle);
    renderToggle();
    GM_registerMenuCommand(enabled ? 'Disable import-fee markers' : 'Enable import-fee markers',
        () => setEnabled(!enabled));

    // Lazy-loaded images set src later: observe attribute changes too
    scheduleScan();
    new MutationObserver(scheduleScan).observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['src', 'data-src', 'srcset', 'data-srcset']
    });
})();
