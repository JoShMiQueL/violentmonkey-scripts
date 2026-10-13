// ==UserScript==
// @name         Moodle: estado de entregas
// @namespace    https://github.com/vm-userscripts
// @version      1.3
// @description  Muestra junto a cada tarea del curso si ha sido entregada (con resumen flotante) y en "Mis cursos" los totales, el profesor y la próxima entrega por curso.
// @match        https://aulavirtual.murciaeduca.es/course/view.php*
// @match        https://aulavirtual.murciaeduca.es/my/*
// @match        https://aulavirtual.murciaeduca.es/my/courses.php*
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const LOG = '[vm-assign-status]';
    console.log(LOG, 'script cargado en', location.href);
    const CACHE_TTL = 30 * 60 * 1000; // 30 minutos
    const CONCURRENCY = 8;            // peticiones simultáneas máximas (pool global)

    // Estilos de las insignias, totales por curso y resumen flotante
    const style = document.createElement('style');
    style.textContent = `
.vm-assign-badge {
    display: inline-block;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    margin-left: 8px;
    color: #fff;
    background: #9e9e9e;
    white-space: nowrap;
    vertical-align: middle;
}
.vm-assign-badge--ok   { background: #2e7d32; }
.vm-assign-badge--none { background: #c62828; }
.vm-assign-badge--due  { background: #ef6c00; }
.vm-assign-badge--course { font-size: 12px; margin-left: 0; }
.vm-course-info { margin-top: 6px; font-size: 11px; line-height: 1.5; }
.vm-course-extra { color: #555; }
.vm-course-extra div { margin-top: 1px; }
.vm-assign-summary {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 9999;
    background: #fff;
    border: 2px solid #9e9e9e;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    box-shadow: 0 2px 8px rgba(0,0,0,.2);
    display: flex;
    align-items: center;
    gap: 8px;
}
.vm-assign-summary--ok   { border-color: #2e7d32; }
.vm-assign-summary--none { border-color: #c62828; }
.vm-assign-summary__close {
    border: 0;
    background: none;
    cursor: pointer;
    font-size: 13px;
    padding: 0;
    color: #666;
}
`;
    document.head.appendChild(style);

    // ---------- utilidades compartidas ----------

    // Extraer si la tarea está entregada leyendo "Estado de la entrega" del documento de la tarea
    function parseSubmitted(doc) {
        for (const tr of doc.querySelectorAll('table.generaltable tr')) {
            const th = tr.querySelector('th');
            const td = tr.querySelector('td');
            if (!th || !td) continue;
            if (th.textContent.includes('Estado de la entrega')) {
                const txt = td.textContent;
                // "No se ha enviado nada" contiene "enviado": comprobar la negación primero
                if (/no se ha enviado|no ha realizado|nada|sin enviar/i.test(txt)) return false;
                return /enviado|entregado/i.test(txt); // "Enviado para calificar" → true
            }
        }
        return false;
    }

    // Nombre del profesor a partir del <title> de una página de actividad:
    // "maria.banon_maria.banon_DWC 26-27: Práctica 3.1 | AulaVirtual" → "Maria Banon"
    function parseTeacherFromTitle(title) {
        if (!title) return null;
        const head = title.split(':')[0];           // parte antes del primer ':'
        if (!head.includes('_')) return null;       // sin prefijo "USUARIO_CURSO_" no hay profesor
        const name = head.split('_')[0].replace(/\./g, ' ').trim();
        if (!/[a-záéíóúñ]/i.test(name)) return null; // descartar títulos sin nombre de usuario
        return name.replace(/\S+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
    }

    // "Cierre: martes, 22 de septiembre de 2026, 14:10" → Date (o null)
    const MESES = {
        enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
        julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11
    };
    function parseSpanishDate(str) {
        const m = /(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?/i.exec(str);
        if (!m) return null;
        const month = MESES[m[2].toLowerCase()];
        if (month === undefined) return null;
        return new Date(+m[3], month, +m[1], +(m[4] || 0), +(m[5] || 0));
    }

    // Tiempo restante hasta `dueDate` en formato "3d 4h 12m" / "2h 05m" / "45m 30s" / "vencida"
    function timeLeft(dueDate) {
        const diff = dueDate - Date.now();
        if (diff <= 0) return 'vencida';
        const s = Math.floor(diff / 1000);
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
        return `${m}m ${String(sec).padStart(2, '0')}s`;
    }

    // Timers activos para actualizar cada 30 s las etiquetas de cuenta atrás
    const liveTimers = [];
    setInterval(() => {
        for (const { el, dueDate, prefix } of liveTimers) {
            const t = timeLeft(dueDate);
            el.textContent = prefix + t;
            el.classList.toggle('vm-assign-badge--none', t === 'vencida');
        }
    }, 30000);

    // Caché genérica en localStorage con TTL (persistente entre pestañas/sesiones)
    function cacheGet(key) {
        try {
            const raw = localStorage.getItem(key);
            if (raw) {
                const cached = JSON.parse(raw);
                if (Date.now() - cached.t < CACHE_TTL) return cached.data;
            }
        } catch (e) { /* caché ilegible, se ignora */ }
        return undefined;
    }
    function cacheSet(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify({ t: Date.now(), data }));
        } catch (e) { /* almacenamiento lleno, se ignora */ }
    }

    const inflight = new Map(); // url -> promesa en curso, evita peticiones duplicadas

    // Pool global de concurrencia: TODAS las peticiones (de todos los cursos)
    // comparten el mismo límite, así no hay esperas entre cursos secuenciales.
    let poolActive = 0;
    const poolWaiters = [];
    function poolAcquire() {
        if (poolActive < CONCURRENCY) { poolActive++; return Promise.resolve(); }
        return new Promise(res => poolWaiters.push(res));
    }
    function poolRelease() {
        poolActive--;
        if (poolWaiters.length) { poolActive++; poolWaiters.shift()(); }
    }
    async function poolRun(fn) {
        await poolAcquire();
        try { return await fn(); } finally { poolRelease(); }
    }

    // fetch con timeout y un reintento (el aula a veces corta peticiones en ráfaga)
    async function fetchHtml(url, timeoutMs = 15000) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), timeoutMs);
                const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
                clearTimeout(timer);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return await res.text();
            } catch (e) {
                if (attempt === 1) throw e;
                await new Promise(r => setTimeout(r, 800)); // pausa antes de reintentar
            }
        }
    }

    // Obtener { submitted, teacher } con caché persistente
    // (los valores cacheados antiguos como booleano se tratan como { submitted, teacher: null })
    async function getStatus(url) {
        const cached = cacheGet('vm-assign:' + url);
        if (cached !== undefined) {
            return typeof cached === 'boolean' ? { submitted: cached, teacher: null } : cached;
        }
        if (inflight.has(url)) return inflight.get(url);
        const p = poolRun(async () => {
            const html = await fetchHtml(url);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const data = { submitted: parseSubmitted(doc), teacher: parseTeacherFromTitle(doc.title) };
            cacheSet('vm-assign:' + url, data);
            return data;
        });
        inflight.set(url, p);
        try { return await p; } finally { inflight.delete(url); }
    }

    // Obtener tareas únicas ({ url, name, dueDate }) de la página de un curso (también con caché)
    // (los valores cacheados antiguos como array de strings se adaptan a { url, name: '', dueDate: null })
    async function getAssigns(courseUrl) {
        const cached = cacheGet('vm-assign-course:' + courseUrl);
        if (cached !== undefined) {
            return cached.map(a => typeof a === 'string' ? { url: a, name: '', dueDate: null } : a);
        }
        const doc = new DOMParser().parseFromString(await poolRun(() => fetchHtml(courseUrl)), 'text/html');
        const seen = new Map(); // url -> { url, name, dueDate }
        for (const li of doc.querySelectorAll('li.activity.modtype_assign')) {
            const a = li.querySelector('a[href*="/mod/assign/view.php?id="]');
            if (!a) continue;
            const url = new URL(a.getAttribute('href'), courseUrl).href;
            if (seen.has(url)) continue;
            // El texto del enlace es "Práctica 3.1 Tarea …": el nombre va antes de "Tarea"
            const name = a.textContent.split(/\n|Tarea/)[0].trim();
            // Fecha de cierre en el texto del <li>, si existe
            let dueDate = null;
            const cierre = /cierre:\s*(.+)/i.exec(li.textContent.replace(/\s+/g, ' '));
            if (cierre) {
                const d = parseSpanishDate(cierre[1]);
                if (d) dueDate = d.getTime();
            }
            seen.set(url, { url, name, dueDate });
        }
        const assigns = [...seen.values()];
        cacheSet('vm-assign-course:' + courseUrl, assigns);
        return assigns;
    }

    // Ejecutar tareas todas a la vez: el pool global limita la concurrencia real
    async function runAll(items, worker) {
        await Promise.all(items.map(worker));
    }

    // ---------- modo página de curso (/course/view.php) ----------

    // Crear insignia junto al nombre de la actividad
    function addBadge(link) {
        const badge = document.createElement('span');
        badge.className = 'vm-assign-badge';
        badge.textContent = '⏳ …';
        link.insertAdjacentElement('afterend', badge);
        return badge;
    }

    function render(badge, submitted) {
        badge.className = 'vm-assign-badge ' + (submitted ? 'vm-assign-badge--ok' : 'vm-assign-badge--none');
        badge.textContent = submitted ? '✓ Entregada' : '✗ No entregada';
    }

    // Resumen flotante inferior derecha, descartable durante la sesión
    function showSummary(submitted, total) {
        const key = 'vm-assign-dismissed:' + location.href;
        try { if (sessionStorage.getItem(key)) return; } catch (e) { /* sin storage */ }
        const complete = submitted >= total;
        const box = document.createElement('div');
        box.className = 'vm-assign-summary ' + (complete ? 'vm-assign-summary--ok' : 'vm-assign-summary--none');
        const text = document.createElement('span');
        text.textContent = `Tareas: ${submitted}/${total} entregadas`;
        const close = document.createElement('button');
        close.className = 'vm-assign-summary__close';
        close.textContent = '✕';
        close.title = 'Ocultar';
        close.addEventListener('click', () => {
            try { sessionStorage.setItem(key, '1'); } catch (e) { /* sin storage */ }
            box.remove();
        });
        box.append(text, close);
        document.body.appendChild(box);
    }

    async function initCoursePage() {
        // Recoger tareas del curso: url -> { link, name, dueDate }
        const seen = new Map();
        for (const li of document.querySelectorAll('li.modtype_assign')) {
            const a = li.querySelector('a[href*="/mod/assign/view.php"]');
            if (!a || seen.has(a.href)) continue;
            const cierre = /cierre:\s*(.+)/i.exec(li.textContent.replace(/\s+/g, ' '));
            const d = cierre ? parseSpanishDate(cierre[1]) : null;
            seen.set(a.href, { link: a, dueDate: d ? d.getTime() : null });
        }
        console.log(LOG, 'tareas encontradas:', seen.size);
        if (!seen.size) return;

        let submitted = 0;
        await runAll([...seen.entries()], async ([url, { link, dueDate }]) => {
            const badge = addBadge(link);
            try {
                const { submitted: ok } = await getStatus(url);
                if (ok) submitted++;
                render(badge, ok);
                // Si no está entregada y tiene fecha, mostrar cuenta atrás junto al badge
                if (!ok && dueDate) {
                    const tag = document.createElement('span');
                    tag.className = 'vm-assign-badge ' + (dueDate > Date.now() ? 'vm-assign-badge--due' : 'vm-assign-badge--none');
                    tag.textContent = '⏱ ' + timeLeft(dueDate);
                    badge.insertAdjacentElement('afterend', tag);
                    liveTimers.push({ el: tag, dueDate, prefix: '⏱ ' });
                }
            } catch (e) {
                badge.textContent = '⚠ error';
                console.warn(LOG, 'error en', url, e);
            }
        });
        showSummary(submitted, seen.size);
        console.log(LOG, 'completado:', submitted + '/' + seen.size);
    }

    // ---------- modo "Mis cursos" (/my/courses.php) ----------

    async function processCard(card) {
        const link = card.querySelector('a[href*="/course/view.php?id="]');
        if (!link) return;
        const badge = document.createElement('span');
        badge.className = 'vm-assign-badge vm-assign-badge--course';
        badge.textContent = '⏳ –/–'; // cargando: aún no se sabe cuántas tareas hay
        // Contenedor con la insignia y las líneas extra (profesor, próxima entrega)
        const info = document.createElement('div');
        info.className = 'vm-course-info';
        info.appendChild(badge);
        (card.querySelector('.card-body') || card).appendChild(info);

        let assigns;
        try {
            assigns = await getAssigns(link.href);
        } catch (e) {
            badge.textContent = '⚠ error';
            console.warn(LOG, 'error cargando curso', link.href, e);
            return;
        }
        if (!assigns.length) {
            badge.textContent = '—'; // el curso no tiene tareas
            return;
        }
        badge.textContent = `⏳ 0/${assigns.length}`; // ya se sabe el total, empieza la cuenta
        let submitted = 0, errors = 0, done = 0, teacher = null;
        const pending = new Set(); // urls de tareas sin entregar (para la próxima entrega)
        await runAll(assigns, async (assign) => {
            try {
                const st = await getStatus(assign.url);
                if (st.submitted) submitted++;
                else pending.add(assign.url);
                if (!teacher && st.teacher) teacher = st.teacher; // primer profesor encontrado
            } catch (e) {
                errors++;
                console.warn(LOG, 'error en', assign.url, e);
            }
            badge.textContent = `⏳ ${++done}/${assigns.length}`; // progreso
        });
        if (errors === assigns.length) {
            badge.textContent = '⚠ error';
            return;
        }
        const complete = submitted === assigns.length;
        badge.className = 'vm-assign-badge vm-assign-badge--course ' +
            (complete ? 'vm-assign-badge--ok' : 'vm-assign-badge--none');
        badge.textContent = `${complete ? '✓' : '⚠'} ${submitted}/${assigns.length}`;

        // Líneas extra: profesor y próxima entrega pendiente (con enlace a la tarea)
        if (teacher || pending.size) {
            const box = document.createElement('div');
            box.className = 'vm-course-extra';
            if (teacher) {
                const div = document.createElement('div');
                div.textContent = '👤 ' + teacher;
                box.appendChild(div);
            }
            const now = Date.now();
            const deadlines = assigns.filter(a => pending.has(a.url) && a.dueDate !== null);
            if (deadlines.length) {
                const future = deadlines.filter(a => a.dueDate > now)
                    .sort((x, y) => x.dueDate - y.dueDate);
                const next = future.length ? future[0] // la más próxima futura
                    : deadlines.sort((x, y) => y.dueDate - x.dueDate)[0]; // o la pasada más reciente
                const div = document.createElement('div');
                div.append('📅 ');
                const a = document.createElement('a');
                a.href = next.url;
                a.textContent = (next.name || 'Entrega') + ': ' + timeLeft(next.dueDate);
                a.addEventListener('click', e => e.stopPropagation()); // no navegar la card
                div.appendChild(a);
                box.appendChild(div);
                if (next.dueDate > now) liveTimers.push({ el: a, dueDate: next.dueDate, prefix: (next.name || 'Entrega') + ': ' });
            }
            info.appendChild(box);
        }
    }

    async function initOverview() {
        // Las cards pueden cargarse por JS tras document-idle: esperarlas
        const cards = await waitForElements('div.course-card[data-course-id]');
        console.log(LOG, 'cursos encontrados:', cards.length);
        if (!cards.length) return;
        // Todos los cursos en paralelo; el pool global limita las peticiones reales
        await runAll(cards, async (card) => {
            try {
                await processCard(card);
            } catch (e) {
                console.warn(LOG, 'error procesando curso', e);
            }
        });
        console.log(LOG, 'completado');
    }

    // Esperar a que existan elementos en el DOM (máx. 10 s)
    function waitForElements(selector) {
        return new Promise(resolve => {
            const found = document.querySelectorAll(selector);
            if (found.length) return resolve([...found]);
            const obs = new MutationObserver(() => {
                const els = document.querySelectorAll(selector);
                if (els.length) { obs.disconnect(); resolve([...els]); }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); resolve([...document.querySelectorAll(selector)]); }, 10000);
        });
    }

    // ---------- entrada ----------

    console.log(LOG, 'pathname:', location.pathname);
    if (location.pathname.includes('/course/view.php')) initCoursePage();
    else if (location.pathname.startsWith('/my')) initOverview();
})();
