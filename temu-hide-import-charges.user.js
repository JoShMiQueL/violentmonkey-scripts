// ==UserScript==
// @name         Temu: mark items with import charges
// @namespace    https://github.com/JoShMiQueL/violentmonkey-scripts
// @version      2.5
// @downloadURL  https://raw.githubusercontent.com/JoShMiQueL/violentmonkey-scripts/master/temu-hide-import-charges.user.js
// @updateURL    https://raw.githubusercontent.com/JoShMiQueL/violentmonkey-scripts/master/temu-hide-import-charges.user.js
// @description  On/off switch. When ON, items that ship from outside the EU get a corner warning triangle and their price line shows "price +3,63 → real total" (~3€/item + VAT, per Temu's policy). Cart/mini-cart totals include the fees and Temu's 50% coverage note. Nothing is hidden or removed.
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
    const PRICE_RE = /€\s*(\d+[.,]\d+)|(\d+[.,]\d+)\s*€/;
    const FEE = 3.63;            // 3 EUR per different item + VAT (orders <= 150 EUR)
    const COVER_MIN_ORDER = 20;  // Temu covers 50% of fees on orders over 20 EUR...
    const COVER_MAX = 10;        // ...up to 10 EUR (first eligible orders)
    const ENABLED_KEY = 'temuIcEnabled';
    const MAX_CLIMB = 20;

    let enabled = GM_getValue(ENABLED_KEY, true);

    const style = document.createElement('style');
    style.textContent = `
        [data-vm-ic-corner]{position:absolute;top:0;right:0;width:0;height:0;
            border-top:26px solid #e02424;border-left:26px solid transparent;pointer-events:none}
        [data-vm-ic-glyph]{position:absolute;top:2px;right:3px;color:#fff;
            font:700 12px/1 system-ui,sans-serif;pointer-events:none}
        [data-vm-ic-fee]{color:#e02424;font-weight:600;white-space:nowrap}
        [data-vm-ic-note]{color:#e02424;font:600 12px/1.4 system-ui,sans-serif;margin-top:2px}
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
    // a single product.
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

    function fmt(n) { return n.toFixed(2).replace('.', ',') + '€'; }

    // Temu renders prices as split spans ("5" ",82" "€"), so find the deepest
    // element whose WHOLE text is a single price. "RRP 7,01€" and fee rows
    // never match (extra text).
    const FULL_PRICE_RE = /^\s*€?\s*\d+[.,]\d+\s*€\s*$/;
    function priceBoxOf(el) {
        let box = null;
        for (const n of el.querySelectorAll('*')) {
            if (n.dataset && (n.dataset.vmIcFee || n.dataset.vmIcNote
                || n.dataset.vmIcCorner || n.dataset.vmIcGlyph)) continue;
            if (FULL_PRICE_RE.test(n.textContent.trim()) && (!box || box.contains(n))) box = n;
        }
        return box;
    }

    function parsePrice(txt) {
        const m = txt.replace(/\s+/g, ' ').match(PRICE_RE);
        if (!m) return null;
        const n = parseFloat((m[1] || m[2]).replace(',', '.'));
        return isNaN(n) ? null : n;
    }

    // The mini-cart sidebar obfuscates amounts: each digit is a vertical
    // "reel" of 0-9 cells shifted by translateY(-N*100%) — N is the real
    // digit. Literal chars (",", "€") sit in unshifted slots. Returns the
    // decoded string ("17,34€") or null when no reels are present.
    function decodeReelText(root) {
        let out = '', reels = 0;
        const done = new Set();
        for (const el of root.querySelectorAll('*')) {
            if (el.children.length > 0) continue;
            if (el.dataset && (el.dataset.vmIcFee || el.dataset.vmIcNote)) continue;
            const t = el.textContent.trim();
            if (!/^[0-9,.€]$/.test(t)) continue;
            const p = el.parentElement;
            if (done.has(p)) continue;
            const m = /translateY\(-([\d.]+)%\)/.exec(p.getAttribute('style') || '');
            if (m && p.children.length >= 9) {
                done.add(p);
                reels++;
                out += Math.round(parseFloat(m[1]) / 100);
            } else out += t;
        }
        return reels ? out : null;
    }

    function mark(el, kind) {
        el.dataset.vmIc = 'charged';
        el.dataset.vmIcKind = kind || 'row';
        if (!el.querySelector('[data-vm-ic-corner]')) {
            // positioned children need a positioned parent — only set relative
            // on static elements so absolute/fixed layouts are never broken
            if (getComputedStyle(el).position === 'static') {
                el.dataset.vmIcRel = '1';
                el.style.position = 'relative';
            }
            const corner = document.createElement('span');
            corner.dataset.vmIcCorner = '1';
            const glyph = document.createElement('span');
            glyph.dataset.vmIcGlyph = '1';
            glyph.textContent = '!';
            el.appendChild(corner);
            el.appendChild(glyph);
        }
        // Price line: "5,82€ +3,63 → 9,45€" appended inline in red.
        // Skipped on checkout accordion rows — they already carry the real fee.
        if (!CHARGE_TEXT_RE.test(el.textContent) && !el.querySelector('[data-vm-ic-fee]')) {
            const box = priceBoxOf(el);
            const price = box ? parsePrice(box.textContent) : null;
            if (box && price !== null) {
                const fee = document.createElement('span');
                fee.dataset.vmIcFee = '1';
                fee.textContent = ` +3,63 → ${fmt(price + FEE)}`;
                box.appendChild(fee);
            }
        }
    }

    function unmarkAll() {
        for (const el of document.querySelectorAll('[data-vm-ic]')) {
            delete el.dataset.vmIc;
            delete el.dataset.vmIcKind;
            if (el.dataset.vmIcRel) { el.style.position = ''; delete el.dataset.vmIcRel; }
        }
        for (const el of document.querySelectorAll('[data-vm-ic-amount]')) delete el.dataset.vmIcAmount;
        for (const b of document.querySelectorAll(
            '[data-vm-ic-corner], [data-vm-ic-glyph], [data-vm-ic-fee], [data-vm-ic-note]')) b.remove();
    }

    // ---- scanning -----------------------------------------------------------

    function scan() {
        let marked = 0;
        // 1) listing cards (grid + carousels)
        for (const c of document.querySelectorAll(CONTAINER_SEL)) {
            const card = cardOf(c);
            if (!card) continue;
            if (card.dataset.vmIc === 'charged') { mark(card, 'card'); continue; } // heal wiped children
            if (classify(card) === 'charged') { mark(card, 'card'); marked++; }
        }
        // 2) any product image outside a listing card (cart, mini-cart, checkout, PDP)
        for (const img of document.querySelectorAll('img')) {
            if (img.closest(CONTAINER_SEL)) continue;
            const u = img.currentSrc || img.src || img.getAttribute('data-src') || '';
            if (!PRODUCT_IMG_RE.test(u) || LOCAL_IMG_RE.test(u)) continue;
            const box = itemBoxOf(img);
            if (box && classify(box) === 'charged') {
                if (box.dataset.vmIc !== 'charged') marked++;
                mark(box, 'row'); // idempotent: heals children Temu re-rendered away
            }
        }
        // 3) checkout accordion rows (explicit fee text)
        for (const el of document.querySelectorAll('div, li, span')) {
            if (el.children.length === 0 && CHARGE_TEXT_RE.test(el.textContent)) {
                const box = itemBoxOf(el) || el.parentElement;
                if (box) {
                    if (box.dataset.vmIc !== 'charged') marked++;
                    mark(box, 'row');
                }
            }
        }
        updateCartTotal();
        return marked;
    }

    // Cart page + mini-cart sidebar: extend the Subtotal/Total line with the
    // real total (fees of selected charged items) + Temu coverage note.
    function updateCartTotal() {
        const lbl = [...document.querySelectorAll('*')]
            .find(e => e.children.length === 0 && /^\s*(Subtotal|Total)\s*$/i.test(e.textContent.trim()));
        if (!lbl) return;
        // Lowest ancestor containing a pure-price element. In the mini-cart
        // the label and the amount are siblings, so this can be the whole
        // sidebar panel — don't bound by height.
        let row = lbl, amountBox = null;
        for (let i = 0; i < 10 && row.parentElement; i++) {
            row = row.parentElement;
            amountBox = row.querySelector('[data-vm-ic-amount]') || priceBoxOf(row);
            if (amountBox) break;
        }
        if (!amountBox) return;
        amountBox.dataset.vmIcAmount = '1';
        const subtotal = parsePrice(decodeReelText(amountBox) || amountBox.textContent);
        if (subtotal === null) return;

        // Only cart/mini-cart item rows count for fees — never listing cards.
        // aria-checked="true" is the real selection state; rows without a
        // checkbox (mini-cart tiles) count as selected.
        const rows = [...document.querySelectorAll('[data-vm-ic][data-vm-ic-kind="row"]')];
        const n = rows.filter(e => {
            const cb = e.querySelector('[aria-checked]');
            return !cb || cb.getAttribute('aria-checked') === 'true';
        }).length;

        const fees = n * FEE;
        const covered = subtotal > COVER_MIN_ORDER ? Math.min(fees * 0.5, COVER_MAX) : 0;

        // Inline "+fees → total" right after the price element
        let f = row.querySelector('[data-vm-ic-totalfee]');
        if (!f) {
            f = document.createElement('span');
            f.dataset.vmIcTotalfee = '1';
            f.dataset.vmIcFee = '1';
            amountBox.parentElement.insertBefore(f, amountBox.nextSibling);
        }
        f.textContent = ` +${fmt(fees)} → ${fmt(subtotal + fees)}`;

        // Coverage note under the subtotal line, inside the panel
        let anchor = lbl;
        while (anchor.parentElement && anchor.parentElement !== row) anchor = anchor.parentElement;
        const host = anchor.parentElement === row ? anchor : row;
        let note = row.parentElement.querySelector(':scope > [data-vm-ic-note]')
            || row.querySelector(':scope > [data-vm-ic-note]');
        if (!note) {
            note = document.createElement('div');
            note.dataset.vmIcNote = '1';
            host.parentElement.insertBefore(note, host.nextSibling);
        }
        note.textContent = covered
            ? `Temu covers ~50% of fees on orders >${COVER_MIN_ORDER}€ (max ${COVER_MAX}€, if eligible): you could pay ≈ ${fmt(subtotal + fees - covered)}`
            : (fees ? `Import fees on ${n} selected item(s): +${fmt(fees)}` : 'No import fees on selected items');
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
