// ==UserScript==
// @name         Temu: mark items with import charges
// @namespace    https://github.com/JoShMiQueL/violentmonkey-scripts
// @version      2.11
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
        [data-vm-ic-corner]{position:absolute;bottom:0;right:0;width:0;height:0;
            border-bottom:26px solid #e02424;border-left:26px solid transparent;pointer-events:none}
        [data-vm-ic-glyph]{position:absolute;bottom:1px;right:2px;color:#fff;
            font:700 12px/1 system-ui,sans-serif;pointer-events:none}
        [data-vm-ic-fee]{color:#e02424;font-weight:600;white-space:nowrap}
        [data-vm-ic-note]{color:#e02424;font:600 12px/1.4 system-ui,sans-serif}
        [data-vm-ic-line]{color:#e02424}
        [data-vm-ic-helpfb]{display:inline-flex;width:12px;height:12px;border:1px solid #e02424;
            border-radius:50%;color:#e02424;font-size:9px;line-height:1;align-items:center;
            justify-content:center;margin-left:3px;cursor:pointer;vertical-align:middle}
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
    const SKIP_SEL = '[data-vm-ic-fee],[data-vm-ic-note],[data-vm-ic-corner],'
        + '[data-vm-ic-glyph],[data-vm-ic-line],[data-vm-ic-help],[data-vm-ic-helpfb]';
    const FULL_PRICE_RE = /^\s*€?\s*\d+[.,]\d+\s*€\s*$/;
    // Deepest elements whose WHOLE text is a single price (one per branch —
    // Temu duplicates values for screen readers, so there can be several).
    // Text of a node ignoring our injected descendants (inline fee, fee line…)
    // so "5,82€ +3,63€ → 9,45€" still reads as the pure price "5,82€".
    function cleanText(n) {
        let t = '';
        for (const c of n.childNodes) {
            if (c.nodeType === Node.TEXT_NODE) t += c.textContent;
            else if (c.nodeType === 1 && !c.matches(SKIP_SEL)) t += cleanText(c);
        }
        return t;
    }
    function priceElsOf(el) {
        const boxes = [];
        for (const n of el.querySelectorAll('*')) {
            if (n.closest(SKIP_SEL)) continue;
            if (!FULL_PRICE_RE.test(cleanText(n).trim())) continue;
            const i = boxes.findIndex(b => b.contains(n));
            if (i >= 0) boxes[i] = n;
            else if (!boxes.some(b => n.contains(b))) boxes.push(n);
        }
        return boxes;
    }
    function priceBoxOf(el) {
        return priceElsOf(el)[0] || null;
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
            if (el.closest(SKIP_SEL)) continue;
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

    // Tightest ancestor that wraps the product image — the corner triangle
    // lives at ITS bottom-right (safe from delete buttons / qty selectors).
    function iconHost(el) {
        let best = null, area = 0;
        for (const img of el.querySelectorAll('img')) {
            const u = img.currentSrc || img.src || img.getAttribute('data-src') || '';
            if (!PRODUCT_IMG_RE.test(u)) continue;
            const r = img.getBoundingClientRect();
            if (r.width * r.height > area) { area = r.width * r.height; best = img; }
        }
        if (!best) return el;
        const ir = best.getBoundingClientRect();
        let host = best.parentElement || el;
        while (host !== el && host.parentElement) {
            const pr = host.parentElement.getBoundingClientRect();
            if (pr.width > ir.width * 1.3 || pr.height > ir.height * 1.3) break;
            host = host.parentElement;
        }
        return host;
    }

    // Reuse Temu's own RRP "?" icon (Ek9HiUKH > img[alt=Details]) so our help
    // icon looks identical; falls back to a circled "?" when none exists.
    // Hover shows a small popup styled like Temu's tooltips (native title is
    // slow and ugly).
    const HELP_TIP = 'Items shipped from outside the EU carry an import '
        + 'charge added at checkout: about 3€ + VAT per item (≈3,63€) on '
        + 'orders of 150€ or less. On orders over 20€ Temu covers ~50% of '
        + 'these charges (up to 10€) for eligible orders.';
    // Exact clone of Temu's detail popup (_1dYK2uzG): same classes/styles so
    // ours is indistinguishable — absolute root, arrow SVG, white dialog box,
    // and the same trailing link style (theirs links to whychoosetemu.html).
    const TIP_ARROW = '<svg viewBox="1 0 22 8" version="1.1" '
        + 'xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" '
        + 'class="_2ewe-jmW" aria-hidden="true"><path d="M0.913721065,9 '
        + 'C2.56449311,9 4.14234104,8.31987419 5.27579998,7.1197412 '
        + 'L10.5459737,1.53955726 C11.3043971,0.73652071 12.5702105,0.700354613 '
        + '13.3732471,1.45877803 C13.4009372,1.48492978 13.4278746,1.51186717 '
        + '13.4540263,1.53955726 L18.7242,7.1197412 C19.857659,8.31987419 '
        + '21.4355069,9 23.0862789,9"></path></svg>';
    const TIP_LINK = '<a class="_2Tl9qLr1 _3qAvUnip _3JB_DvH6" '
        + 'href="/shipping-info.html">Shipping info</a>';
    function tipOpen() { return document.querySelector('[data-vm-ic-tip]'); }
    function showTip(anchor) {
        hideTip();
        const tip = document.createElement('div');
        tip.className = '_1dYK2uzG';
        tip.dataset.vmIcTip = '1';
        tip.innerHTML = '<div tabindex="0" class="_1NfHXbXB"></div>'
            + '<div class="_3vr7b2Jf _28pVA9Oz" tabindex="-1" role="generic" '
            + 'style="padding-top:7px">' + TIP_ARROW
            + '<div class="_2RWBQk3A _1WSzHClN"><div class="_3HSkEm93" role="dialog">'
            + '<div class="_3qAvUnip"></div>' + TIP_LINK + '</div></div></div>'
            + '<div tabindex="0" class="_1NfHXbXB"></div>';
        tip.querySelector('div._3qAvUnip').textContent = HELP_TIP;
        tip.addEventListener('mouseenter', () => { tip._hover = true; });
        tip.addEventListener('mouseleave', () => {
            tip._hover = false;
            if (!tip._pinned) hideTip();
        });
        tip.style.visibility = 'hidden';
        document.body.appendChild(tip);
        const r = anchor.getBoundingClientRect();
        // The dialog centers itself under the root's origin; the arrow's left
        // edge sits at root.left, so shift half the arrow width (~6px) to aim
        // the arrow's center at the anchor's center (page coordinates).
        let left = r.left + scrollX + r.width / 2 - 6;
        tip.style.left = left + 'px';
        tip.style.top = (r.bottom + scrollY) + 'px';
        // Keep the white box inside the viewport.
        const br = tip.querySelector('._2RWBQk3A').getBoundingClientRect();
        if (br.right > innerWidth - 8) tip.style.left = (left - (br.right - innerWidth + 8)) + 'px';
        else if (br.left < 8) tip.style.left = (left + (8 - br.left)) + 'px';
        tip.style.visibility = '';
        return tip;
    }
    function hideTip() {
        const t = tipOpen();
        if (t) t.remove();
    }
    // A click outside any fee line closes a pinned tip (mirrors Temu).
    document.addEventListener('click', e => {
        const t = tipOpen();
        if (t && t._pinned && !e.target.closest('[data-vm-ic-line]')) hideTip();
    }, true);
    function helpIcon(scopeEl) {
        const tplImg = (scopeEl && scopeEl.querySelector('img[alt="Details"]'))
            || document.querySelector('img[alt="Details"]');
        let w;
        if (tplImg && tplImg.parentElement) {
            w = tplImg.parentElement.cloneNode(true);
            const im = w.querySelector('img');
            if (im) {
                const ds = im.getAttribute('data-src');
                if (ds && !/^https?:/.test(im.src)) im.src = ds;
            }
            w.style.cssText += ';display:inline-flex;vertical-align:middle;cursor:pointer';
        } else {
            w = document.createElement('span');
            w.dataset.vmIcHelpfb = '1';
            w.textContent = '?';
        }
        w.dataset.vmIcHelp = '1';
        return w;
    }
    // Hover on the whole fee group shows the tip (anchored at the "?"); a
    // click pins it until the next click — same affordance as Temu's "Details".
    function bindTip(zone, anchor) {
        zone.addEventListener('mouseenter', () => {
            const t = tipOpen();
            if (!(t && t._pinned)) showTip(anchor);
        });
        zone.addEventListener('mouseleave', () => {
            // Small delay so the pointer can reach the tip's own link first.
            setTimeout(() => {
                const t = tipOpen();
                if (t && !t._pinned && !t._hover) hideTip();
            }, 150);
        });
        zone.addEventListener('click', e => {
            e.stopPropagation();
            const t = tipOpen();
            if (t && t._zone === zone) {
                if (t._pinned) { t._pinned = false; hideTip(); } else t._pinned = true;
                return;
            }
            const tip = showTip(anchor);
            tip._zone = zone;
            tip._pinned = true;
        });
    }
    addEventListener('scroll', hideTip, true);

    // Climb from a pure-price element while the parent only wraps that price:
    // the result is the whole price row.
    function rowOf(box) {
        let n = box;
        const t = box.textContent.replace(/\s+/g, '');
        while (n.parentElement
            && n.parentElement.textContent.replace(/\s+/g, '') === t) n = n.parentElement;
        return n;
    }

    // "Import fees 3,63€ ?" — appended to the RRP row AFTER Temu's own "?"
    // icon (so theirs stays with RRP and ours with our label), or as its own
    // line under the price when no RRP row exists.
    function addFeesLine(el) {
        const rrpLeaf = [...el.querySelectorAll('*')]
            .find(n => n.children.length === 0 && /^\s*RRP\s*$/.test(n.textContent));
        if (rrpLeaf) {
            let lc = rrpLeaf, pb = null, rr = null;
            for (let i = 0; i < 8 && lc.parentElement && lc !== el; i++) {
                lc = lc.parentElement;
                // Never let the row escape its ~1-line height — otherwise the
                // flex/contents styling would land on the whole card.
                if (lc.getBoundingClientRect().height > 120) break;
                if (!pb) pb = priceBoxOf(lc);
                // rr = the FIRST (lowest) ancestor containing Temu's Details
                // icon — reassigning on every level used to climb into the
                // card root on some layouts.
                if (!rr && lc.querySelector('img[alt="Details"]')) rr = lc;
                if (pb && rr) break;
            }
            if (rr && pb) {
                // Our group must live OUTSIDE rr: the whole RRP row is Temu's
                // click/hover target, so anything inside it fires their popup.
                // The outer wrapper (_1K94Nm8R, block) only holds rr — making
                // it a flex row and rr display:contents merges its children
                // into the same visual line as our group (independent zone).
                const host = rr.parentElement;
                const slim = host && host.getBoundingClientRect().height < 120;
                if (slim && !host.dataset.vmIcFlex) {
                    host.dataset.vmIcFlex = '1';
                    host.style.display = 'flex';
                    host.style.flexWrap = 'wrap';
                    host.style.alignItems = 'baseline';
                }
                if (slim && !rr.dataset.vmIcFlex) {
                    rr.dataset.vmIcFlex = '1';
                    rr.style.display = 'contents';
                }
                const wrap = document.createElement('span');
                wrap.dataset.vmIcLine = '1';
                wrap.style.cssText = 'display:inline-flex;align-items:baseline;'
                    + 'column-gap:6px;margin-left:6px';
                const sep = document.createElement('span');
                sep.dataset.vmIcLine = '1';
                sep.style.color = '#999';
                sep.textContent = '|';
                const lbl2 = rrpLeaf.cloneNode(false);
                lbl2.dataset.vmIcLine = '1';
                lbl2.removeAttribute('aria-hidden');
                lbl2.style.color = '#e02424';
                lbl2.textContent = 'Import fees';
                const amt = pb.cloneNode(false);
                amt.dataset.vmIcLine = '1';
                amt.removeAttribute('aria-hidden');
                amt.style.color = '#e02424';
                amt.textContent = '+' + fmt(FEE);
                const icon = helpIcon(el);
                wrap.append(sep, lbl2, amt, icon);
                host.insertBefore(wrap, rr.nextSibling);
                // The "|" only makes sense while we share a line with Temu's
                // rendered RRP row (icon visible and same vertical position);
                // on wrapped/hidden-RRP cards it would dangle at line start.
                const ti = rr.querySelector('img[alt="Details"]');
                const tir = ti ? ti.getBoundingClientRect() : { top: -1, height: 0 };
                if (!(tir.height > 0
                    && Math.abs(wrap.getBoundingClientRect().top - tir.top) < 8)) {
                    sep.style.display = 'none';
                    wrap.style.marginLeft = '0';
                }
                bindTip(wrap, icon);
                return;
            }
        }
        const pb = priceBoxOf(el);
        if (!pb) return;
        // Climb past flex-row wrappers: inserting as a sibling of the price
        // row would land us INLINE (cramped next to the cart button). The
        // line must sit below the whole row, so anchor on the first
        // ancestor whose parent is not a row-direction flex container.
        let rowEl = rowOf(pb);
        for (let i = 0; i < 6 && rowEl.parentElement && rowEl !== el; i++) {
            const pcs = getComputedStyle(rowEl.parentElement);
            if (!(pcs.display === 'flex' && pcs.flexDirection.startsWith('row'))) break;
            if (rowEl.parentElement.getBoundingClientRect().height > 200) break;
            rowEl = rowEl.parentElement;
        }
        const line = document.createElement('div');
        line.dataset.vmIcLine = '1';
        line.style.cssText = 'font-size:12px;display:flex;align-items:baseline;'
            + 'column-gap:4px;margin-top:1px';
        const amt = document.createElement('span');
        amt.dataset.vmIcLine = '1';
        amt.textContent = `Import fees +${fmt(FEE)}`;
        const icon = helpIcon(el);
        line.append(amt, icon);
        rowEl.parentElement.insertBefore(line, rowEl.nextSibling);
        bindTip(line, icon);
    }

    function mark(el, kind) {
        el.dataset.vmIc = 'charged';
        el.dataset.vmIcKind = kind || 'row';
        const host = kind === 'card' ? el : iconHost(el);
        if (!host.querySelector('[data-vm-ic-corner]')) {
            // positioned children need a positioned parent — only set relative
            // on static elements so absolute/fixed layouts are never broken
            if (getComputedStyle(host).position === 'static') {
                host.dataset.vmIcRel = '1';
                host.style.position = 'relative';
            }
            const corner = document.createElement('span');
            corner.dataset.vmIcCorner = '1';
            const glyph = document.createElement('span');
            glyph.dataset.vmIcGlyph = '1';
            glyph.textContent = '!';
            host.appendChild(corner);
            host.appendChild(glyph);
        }
        // Fees line FIRST: it locates the pure-price box, and the inline fee
        // appended below would contaminate it (text becomes "1,28€ +3,63…").
        if (!CHARGE_TEXT_RE.test(el.textContent) && !el.querySelector('[data-vm-ic-line]')) {
            addFeesLine(el);
        }
        // Price line: "5,82€ +3,63€ → 9,45€" appended inline in red.
        // Skipped on checkout accordion rows — they already carry the real fee.
        if (!CHARGE_TEXT_RE.test(el.textContent) && !el.querySelector('[data-vm-ic-fee]')) {
            const box = priceBoxOf(el);
            const price = box ? parsePrice(box.textContent) : null;
            if (box && price !== null) {
                const fee = document.createElement('span');
                fee.dataset.vmIcFee = '1';
                fee.textContent = ` +${fmt(FEE)} → ${fmt(price + FEE)}`;
                box.appendChild(fee);
            }
        }
    }

    function unmarkAll() {
        for (const el of document.querySelectorAll('[data-vm-ic]')) {
            delete el.dataset.vmIc;
            delete el.dataset.vmIcKind;
        }
        for (const el of document.querySelectorAll('[data-vm-ic-rel]')) {
            el.style.position = '';
            delete el.dataset.vmIcRel;
        }
        for (const el of document.querySelectorAll('[data-vm-ic-flex]')) {
            el.style.display = '';
            el.style.flexWrap = '';
            el.style.alignItems = '';
            delete el.dataset.vmIcFlex;
        }
        for (const el of document.querySelectorAll('[data-vm-ic-amount]')) delete el.dataset.vmIcAmount;
        for (const b of document.querySelectorAll(
            '[data-vm-ic-corner], [data-vm-ic-glyph], [data-vm-ic-fee], [data-vm-ic-note],'
            + ' [data-vm-ic-line], [data-vm-ic-feesrow], [data-vm-ic-tip]')) b.remove();
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

    // Cart page + mini-cart sidebar: real total with fees + coverage note.
    // Cart page  → a native summary row cloned before the Total row.
    // Sidebar    → a compact block line under the subtotal row.
    function updateCartTotal() {
        if (/checkout/i.test(location.pathname)) return; // checkout shows real fees
        const lbl = [...document.querySelectorAll('*')]
            .filter(e => e.children.length === 0
                && /^\s*(Subtotal|Total|Item\(s\) total:?)\s*$/i.test(e.textContent.trim()))
            .pop(); // the grand-total label is the last one in DOM order
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
        const coverTxt = `Temu covers ~50% of fees on orders >${COVER_MIN_ORDER}€`
            + ` (max ${COVER_MAX}€, if eligible) → ≈ ${fmt(subtotal + fees - covered)}`;

        if (row.getBoundingClientRect().height > 150) {
            // ---- mini-cart sidebar: aligned summary rows under the subtotal ----
            let priceTop = amountBox;
            while (priceTop.parentElement && priceTop.parentElement !== row) {
                priceTop = priceTop.parentElement;
            }
            let line = row.querySelector(':scope > [data-vm-ic-note]');
            if (!line) {
                line = document.createElement('div');
                line.dataset.vmIcNote = '1';
                line.style.cssText = 'display:block;padding:4px 14px;box-sizing:border-box;'
                    + 'font:400 12px/1.5 system-ui,sans-serif';
                priceTop.parentElement.insertBefore(line, priceTop.nextSibling);
            }
            line.innerHTML = '';
            const mkRow = (l, v) => {
                const d = document.createElement('div');
                d.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
                const ls = document.createElement('span');
                ls.textContent = l;
                const vs = document.createElement('span');
                vs.textContent = v;
                vs.style.cssText = 'color:#e02424;font-weight:700;white-space:nowrap';
                d.append(ls, vs);
                return d;
            };
            if (fees) {
                const r1 = mkRow(`Import fees (${n})`, `+${fmt(fees)}`);
                r1.firstChild.style.color = '#e02424';
                const r2 = mkRow('Total with fees', fmt(subtotal + fees));
                r2.firstChild.style.color = '#e02424';
                line.append(r1, r2);
            } else {
                const r = document.createElement('div');
                r.style.color = '#0A8800';
                r.textContent = 'No import fees on selected items';
                line.appendChild(r);
            }
            const cov = document.createElement('div');
            cov.style.cssText = 'font-size:11px;color:#777;margin-top:2px';
            cov.textContent = covered ? coverTxt
                : `Orders >${COVER_MIN_ORDER}€: Temu covers ~50% of fees (max ${COVER_MAX}€)`;
            line.appendChild(cov);
            return;
        }

        // ---- cart page Order Summary: clone a native row before Total ----
        const wrap = row.parentElement;               // e.g. _36gn5Sma wrapper
        if (!wrap.parentElement.querySelector(':scope > [data-vm-ic-feesrow]')) {
            const clone = wrap.cloneNode(true);
            clone.removeAttribute('id');
            clone.dataset.vmIcFeesrow = '1';
            clone.className = clone.classList[0] || ''; // keep row style, drop total emphasis
            clone.querySelectorAll(SKIP_SEL).forEach(n => n.remove());
            const l = [...clone.querySelectorAll('*')]
                .find(s => s.children.length === 0 && /total/i.test(s.textContent));
            if (l) {
                l.textContent = `Import fees (${n}):`;
                l.style.color = '#e02424';
                l.style.fontWeight = '600';
            }
            // rewrite every price copy in the cloned row (sr-only + visible)
            for (const v of priceElsOf(clone)) {
                v.textContent = '+' + fmt(fees);
                v.style.color = '#e02424';
                v.style.fontWeight = '700';
            }
            wrap.parentElement.insertBefore(clone, wrap);
        }

        // Inline "+fees → total" on the Total price itself
        let f = row.querySelector('[data-vm-ic-totalfee]');
        if (!f) {
            f = document.createElement('span');
            f.dataset.vmIcTotalfee = '1';
            f.dataset.vmIcFee = '1';
            amountBox.parentElement.insertBefore(f, amountBox.nextSibling);
        }
        f.textContent = ` +${fmt(fees)} → ${fmt(subtotal + fees)}`;

        // Coverage fine-print under the fees row
        let note = wrap.parentElement.querySelector(':scope > [data-vm-ic-note]');
        if (!note) {
            note = document.createElement('div');
            note.dataset.vmIcNote = '1';
            note.style.cssText = 'font-weight:400;color:#777;font-size:13px;margin:2px 0 4px';
            wrap.parentElement.insertBefore(note, wrap);
        }
        note.textContent = covered ? coverTxt
            : (fees ? `Orders >${COVER_MIN_ORDER}€: Temu covers ~50% of fees (max ${COVER_MAX}€)`
                : 'No import fees on selected items');
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
