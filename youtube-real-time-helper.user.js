// ==UserScript==
// @name         YouTube Real Time, Savings & ETA
// @namespace    local.userscript.youtube.real-time
// @version      2.0.0
// @downloadURL  https://raw.githubusercontent.com/JoShMiQueL/violentmonkey-scripts/master/youtube-real-time-helper.user.js
// @updateURL    https://raw.githubusercontent.com/JoShMiQueL/violentmonkey-scripts/master/youtube-real-time-helper.user.js
// @description  Extends YouTube's own control-bar time display with the real time remaining at the current speed, time saved versus 1x, and an estimated finish time. English UI, no emojis, hides with the control bar.
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  "use strict";

  const VERSION = "2.0.0";

  /**
   * Tunable behaviour of the script.
   */
  const SETTINGS = Object.freeze({
    REFRESH_INTERVAL_MS: 250,
    WIDTH_REFRESH_INTERVAL_MS: 500,
    WIDTH_SAFETY_MARGIN_PX: 12,
    DEBUG: true,
    SHOW_BOOT_MARKER: true,
  });

  const INLINE_ID = "ytrt-inline-v2";
  const MEASURE_ID = "ytrt-measure-v2";
  const BOOT_MARKER_ID = "ytrt-boot-marker";
  const OLD_ELEMENT_IDS = [
    "ytrt-badge-v2",
    "ytrt-fixed-overlay-v5",
    "ytrt-badge-v1",
  ];

  const PLAYER_SELECTOR = "#movie_player";
  const TIME_DISPLAY_SELECTOR = ".ytp-time-display";
  const TIME_WRAPPER_SELECTOR = ".ytp-time-wrapper";
  const TIME_CONTENTS_SELECTOR = ".ytp-time-contents";
  const LEFT_CONTROLS_SELECTOR = ".ytp-left-controls";
  const CHROME_BOTTOM_SELECTOR = ".ytp-chrome-bottom";
  const LIVE_BADGE_SELECTOR = ".ytp-live-badge";

  const SEGMENT_SEPARATOR = " \u00b7 ";

  const VIDEO_EVENTS = [
    "ratechange",
    "timeupdate",
    "durationchange",
    "loadedmetadata",
    "seeked",
    "play",
    "pause",
    "waiting",
    "playing",
    "ended",
  ];

  // Order in which the segments are rendered, joined by SEGMENT_SEPARATOR.
  const ATOM_DISPLAY_ORDER = Object.freeze([
    "speed",
    "real",
    "savedPct",
    "content",
    "end",
  ]);

  // Order in which segments are kept when the available width is tight.
  const ATOM_PRIORITY_ORDER = Object.freeze([
    "real",
    "savedPct",
    "speed",
    "end",
    "content",
  ]);

  const ACCENTS = Object.freeze({
    faster: "#4ade80",
    slower: "#fbbf24",
    normal: "#eee",
  });

  const numberFormatter = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  const endTimeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  let inline = null;
  let measureSpan = null;
  let measureFontKey = "";
  let lastVideo = null;
  let anchorKind = "";
  let observedPlayer = null;
  let observer = null;
  let updateQueued = false;
  let budgetDirty = true;
  let budgetCache = { value: 0, at: 0 };
  let lastCurrentTime = null;
  let lastRate = null;
  let lastEndTimestamp = 0;
  let lastVisibility = null;
  let lastPointerEvents = null;
  let lastColor = null;
  let lastSignature = null;
  let lastTooltip = null;
  let lastHiddenReasonLogged = "init";
  let lastErrorMessage = "";
  let renderedOnce = false;
  let debugInfo = emptyDebugInfo();

  // ---------------------------------------------------------------------------
  // Styling helpers
  // ---------------------------------------------------------------------------

  function setImportantStyle(element, property, value) {
    element.style.setProperty(property, value, "important");
  }

  function log(...args) {
    if (SETTINGS.DEBUG) console.log("[YouTube Real Time]", ...args);
  }

  function applyInlineStyles(element) {
    setImportantStyle(element, "display", "inline");
    setImportantStyle(element, "padding-left", "8px");
    setImportantStyle(element, "white-space", "nowrap");
    setImportantStyle(element, "font-variant-numeric", "tabular-nums");
    // `vertical-align: top` lines our inline box up with YouTube's block
    // `.ytp-time-contents` inside the inherited 40px line box, so both glyph
    // runs are centred identically. `middle`/`baseline` render ~16px low.
    // `align-self` is a no-op inside the block time display, but centres us
    // vertically when the anchor falls back to the flex `.ytp-left-controls`.
    setImportantStyle(element, "vertical-align", "top");
    setImportantStyle(element, "align-self", "center");
    setImportantStyle(element, "cursor", "help");
    setImportantStyle(element, "pointer-events", "auto");
  }

  // ---------------------------------------------------------------------------
  // Formatting and calculations (pure functions)
  // ---------------------------------------------------------------------------

  function formatClock(totalSeconds) {
    let seconds = Math.max(0, Math.ceil(Number(totalSeconds) || 0));

    const days = Math.floor(seconds / 86400);
    seconds %= 86400;

    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;

    const minutes = Math.floor(seconds / 60);
    seconds %= 60;

    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");

    if (days > 0) {
      return `${days}d ${hours}:${mm}:${ss}`;
    }

    if (hours > 0) {
      return `${hours}:${mm}:${ss}`;
    }

    return `${minutes}:${ss}`;
  }

  function formatPlaybackSpeed(speed) {
    return `${numberFormatter.format(speed)}x`;
  }

  function computeEstimates(duration, currentTime, playbackRate) {
    const remainingContent = Math.max(0, duration - currentTime);
    const realRemaining = remainingContent / playbackRate;
    const savingFromHere = remainingContent - realRemaining;
    const savingTotal = duration - duration / playbackRate;
    const savingPercent =
      remainingContent > 0
        ? Math.abs(savingFromHere / remainingContent) * 100
        : 0;
    const savingTotalPercent =
      duration > 0 ? Math.abs(savingTotal / duration) * 100 : 0;

    return {
      remainingContent,
      realRemaining,
      savingFromHere,
      savingTotal,
      savingPercent,
      savingTotalPercent,
    };
  }

  function savingsLabel(seconds) {
    if (Math.abs(seconds) < 1) return "No savings";

    if (seconds > 0) return `Saved ${formatClock(seconds)}`;

    return `Added ${formatClock(Math.abs(seconds))}`;
  }

  function describeSavings(seconds) {
    if (Math.abs(seconds) < 1) return "no savings";

    if (seconds > 0) return `saves ${formatClock(seconds)}`;

    return `adds ${formatClock(Math.abs(seconds))}`;
  }

  function readPlayerNumber(player, method, fallback) {
    try {
      const value = player[method]();
      return Number.isFinite(value) ? value : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function getVideoTitle(player) {
    try {
      return player.getVideoData()?.title?.trim() || "This video";
    } catch (_) {
      return "This video";
    }
  }

  function isElementVisible(element) {
    if (!element) return false;

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function finiteOrZero(value) {
    return Number.isFinite(value) ? value : 0;
  }

  // ---------------------------------------------------------------------------
  // Inline display lifecycle
  // ---------------------------------------------------------------------------

  function createInline() {
    const element = document.createElement("span");
    element.id = INLINE_ID;
    element.setAttribute("aria-live", "off");
    applyInlineStyles(element);
    return element;
  }

  function anchorInline(player) {
    if (!player) return "";

    const timeDisplay = player.querySelector(TIME_DISPLAY_SELECTOR);
    if (timeDisplay) {
      const wrapper = timeDisplay.querySelector(TIME_WRAPPER_SELECTOR);
      if (wrapper) wrapper.insertAdjacentElement("afterend", inline);
      else timeDisplay.appendChild(inline);
      return "time-display";
    }

    const leftControls = player.querySelector(LEFT_CONTROLS_SELECTOR);
    if (leftControls) {
      leftControls.appendChild(inline);
      return "left-controls";
    }

    const chromeBottom = player.querySelector(CHROME_BOTTOM_SELECTOR);
    if (chromeBottom) {
      chromeBottom.appendChild(inline);
      return "chrome-bottom";
    }

    return "";
  }

  // The best anchor that currently exists in the player, using the same
  // priority order as anchorInline().
  function bestAnchorKind(player) {
    if (!player) return "";
    if (player.querySelector(TIME_DISPLAY_SELECTOR)) return "time-display";
    if (player.querySelector(LEFT_CONTROLS_SELECTOR)) return "left-controls";
    if (player.querySelector(CHROME_BOTTOM_SELECTOR)) return "chrome-bottom";
    return "";
  }

  function ensureInline(player) {
    // Only bail out early when the span already sits in the best anchor that
    // currently exists. A degraded anchor (e.g. `.ytp-chrome-bottom` while
    // YouTube is still building `.ytp-time-display`) must be upgraded once
    // the better anchor appears. Relocating moves only our own `ytrt-` node,
    // which the observer filters as a self mutation, and afterwards
    // anchorKind equals the best anchor again, so this cannot loop.
    if (
      inline &&
      inline.isConnected &&
      bestAnchorKind(player) === anchorKind
    ) {
      return inline;
    }

    if (!inline) inline = createInline();

    const kind = anchorInline(player);

    if (!kind) {
      if (anchorKind) log("anchor lost, retrying later");
      anchorKind = "";
      return null;
    }

    // Re-anchored (or injected for the first time): force a full re-render.
    lastVisibility = null;
    lastColor = null;
    lastSignature = null;
    lastTooltip = null;
    budgetDirty = true;
    cleanupOldElements();

    if (anchorKind !== kind) {
      log(
        anchorKind
          ? `re-anchored: ${anchorKind} -> ${kind}`
          : `injected into ${kind}`
      );
      anchorKind = kind;
    }

    ensureObserver(player);
    return inline;
  }

  function renderInline(parts, mode, tooltip) {
    if (!inline) return;

    const color = ACCENTS[mode] || ACCENTS.normal;
    if (color !== lastColor) {
      setImportantStyle(inline, "color", color);
      lastColor = color;
    }

    if (lastVisibility !== true) {
      setImportantStyle(inline, "display", "inline");
      lastVisibility = true;
    }

    const signature = parts
      .map((part) => `${part.kind}:${part.text}`)
      .join("|");

    if (signature !== lastSignature) {
      inline.textContent = "";

      for (let index = 0; index < parts.length; index += 1) {
        if (index > 0) {
          inline.appendChild(document.createTextNode(SEGMENT_SEPARATOR));
        }

        const span = document.createElement("span");
        span.textContent = parts[index].text;
        if (parts[index].kind === "speed") {
          setImportantStyle(span, "font-weight", "700");
        }
        inline.appendChild(span);
      }

      lastSignature = signature;
    }

    if (tooltip !== lastTooltip) {
      inline.title = tooltip;
      inline.setAttribute("aria-label", tooltip);
      lastTooltip = tooltip;
    }
  }

  function hideInline() {
    if (!inline || lastVisibility === false) return;
    setImportantStyle(inline, "display", "none");
    lastVisibility = false;
  }

  // Follows the `ytp-autohide` class on the player so our span does not keep
  // `pointer-events: auto` (and show a stray tooltip) while the control bar
  // is hidden. Value-gated like the other style writes, so nothing is
  // rewritten unless the autohide state actually flips.
  function syncPointerEvents(player) {
    if (!inline) return;

    const hidden = Boolean(
      player && player.classList.contains("ytp-autohide")
    );
    const value = hidden ? "none" : "auto";
    if (value === lastPointerEvents) return;

    setImportantStyle(inline, "pointer-events", value);
    lastPointerEvents = value;
  }

  function noteState(hiddenReason) {
    if (hiddenReason === lastHiddenReasonLogged) return;
    lastHiddenReasonLogged = hiddenReason;
    if (hiddenReason) log("hidden:", hiddenReason);
    else log("visible");
  }

  // ---------------------------------------------------------------------------
  // Width fitting and visibility
  // ---------------------------------------------------------------------------

  function rectWidth(element) {
    return element.getBoundingClientRect().width;
  }

  // Sums the given computed style properties (e.g. margins/paddings) as px.
  function styleSum(style, ...properties) {
    let total = 0;
    for (const property of properties) {
      total += finiteOrZero(parseFloat(style.getPropertyValue(property)));
    }
    return total;
  }

  // Space an element occupies in the flow: border box plus horizontal margins.
  function flowWidth(element) {
    const style = getComputedStyle(element);
    return rectWidth(element) + styleSum(style, "margin-left", "margin-right");
  }

  function ensureMeasureSpan() {
    if (measureSpan && measureSpan.isConnected) return measureSpan;

    const root = document.body || document.documentElement;
    if (!root) return null;

    measureSpan = document.createElement("span");
    measureSpan.id = MEASURE_ID;
    setImportantStyle(measureSpan, "position", "absolute");
    setImportantStyle(measureSpan, "visibility", "hidden");
    setImportantStyle(measureSpan, "white-space", "pre");
    setImportantStyle(measureSpan, "top", "-9999px");
    setImportantStyle(measureSpan, "left", "-9999px");
    setImportantStyle(measureSpan, "pointer-events", "none");
    setImportantStyle(measureSpan, "font-variant-numeric", "tabular-nums");
    // Match the rendered span's padding so measured widths equal rendered
    // widths; without this every candidate is measured 8px too narrow.
    setImportantStyle(measureSpan, "padding-left", "8px");
    root.appendChild(measureSpan);
    return measureSpan;
  }

  function syncMeasureFont(player) {
    const span = ensureMeasureSpan();
    if (!span) return;

    const timeDisplay = player && player.querySelector(TIME_DISPLAY_SELECTOR);
    const source = timeDisplay || inline;
    if (!source || !source.isConnected) return;

    const style = getComputedStyle(source);
    const key = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}`;
    if (key === measureFontKey) return;

    measureFontKey = key;
    setImportantStyle(span, "font-family", style.fontFamily);
    setImportantStyle(span, "font-size", style.fontSize);
    setImportantStyle(span, "font-weight", style.fontWeight);
  }

  function measureTextWidth(text, bold) {
    const span = ensureMeasureSpan();
    if (!span) return 0;

    span.textContent = text;
    const width = span.getBoundingClientRect().width;
    if (!bold) return width;

    // The speed atom renders bold; measure the candidate at that weight too
    // and keep the wider reading, since over-measuring is the safe direction.
    const weight = span.style.getPropertyValue("font-weight") || "400";
    setImportantStyle(span, "font-weight", "700");
    const boldWidth = span.getBoundingClientRect().width;
    setImportantStyle(span, "font-weight", weight);
    return Math.max(width, boldWidth);
  }

  function measureBudget(player) {
    if (!player) return 0;

    const timeDisplay = player.querySelector(TIME_DISPLAY_SELECTOR);
    const leftControls = player.querySelector(LEFT_CONTROLS_SELECTOR);

    if (leftControls) {
      // clientWidth includes the left controls' own padding, but the children
      // are laid out in the content box, so subtract the horizontal padding.
      const controlsStyle = getComputedStyle(leftControls);
      let budget =
        leftControls.clientWidth -
        styleSum(controlsStyle, "padding-left", "padding-right");

      for (const child of leftControls.children) {
        if (child === timeDisplay || child === inline) continue;
        if (inline && child.contains(inline)) continue;
        budget -= flowWidth(child);
      }

      if (timeDisplay) {
        // The time display's own margins and padding are not part of its
        // children's widths, but they still consume the free space.
        budget -= styleSum(
          getComputedStyle(timeDisplay),
          "margin-left",
          "margin-right",
          "padding-left",
          "padding-right"
        );
        for (const child of timeDisplay.children) {
          if (child === inline) continue;
          if (inline && child.contains(inline)) continue;
          budget -= flowWidth(child);
        }
      }

      return budget - SETTINGS.WIDTH_SAFETY_MARGIN_PX;
    }

    // Degraded anchor: reserve a slice of the player width.
    return player.clientWidth * 0.4 - SETTINGS.WIDTH_SAFETY_MARGIN_PX;
  }

  function refreshBudget(player) {
    const now = Date.now();

    if (
      !budgetDirty &&
      now - budgetCache.at < SETTINGS.WIDTH_REFRESH_INTERVAL_MS
    ) {
      return budgetCache.value;
    }

    budgetDirty = false;
    syncMeasureFont(player);
    budgetCache = { value: measureBudget(player), at: now };
    return budgetCache.value;
  }

  function joinAtomTexts(kinds, atoms) {
    const chosen = new Set(kinds);
    const texts = [];

    for (const kind of ATOM_DISPLAY_ORDER) {
      if (chosen.has(kind) && atoms[kind]) texts.push(atoms[kind]);
    }

    return texts.join(SEGMENT_SEPARATOR);
  }

  function selectAtoms(atoms, budget) {
    if (!(budget > 0)) return null;

    let chosen = [];

    for (const kind of ATOM_PRIORITY_ORDER) {
      if (!atoms[kind]) continue;
      const candidate = chosen.concat(kind);
      const text = joinAtomTexts(candidate, atoms);
      // The "real" segment is mandatory; everything else must fit.
      if (
        kind === "real" ||
        measureTextWidth(text, candidate.includes("speed")) <= budget
      ) {
        chosen = candidate;
      }
    }

    if (!chosen.length) return null;

    const finalText = joinAtomTexts(chosen, atoms);
    if (measureTextWidth(finalText, chosen.includes("speed")) > budget) {
      return null;
    }

    const chosenSet = new Set(chosen);
    return ATOM_DISPLAY_ORDER.filter((kind) => chosenSet.has(kind)).map(
      (kind) => ({ kind, text: atoms[kind] })
    );
  }

  function buildAtoms(state) {
    const estimates = state.estimates;
    const atoms = {
      speed: formatPlaybackSpeed(state.rate),
      real: `Real ${formatClock(estimates.realRemaining)}`,
      savedPct: null,
      content: null,
      end: `End ${endTimeFormatter.format(new Date(lastEndTimestamp))}`,
    };

    if (!state.nearOne) {
      if (Math.abs(estimates.savingFromHere) >= 1) {
        atoms.savedPct =
          `${savingsLabel(estimates.savingFromHere)} ` +
          `(${Math.round(estimates.savingPercent)}%)`;
      }
      atoms.content = `Content ${formatClock(estimates.remainingContent)}`;
    }

    return atoms;
  }

  function buildTooltip(player, state, endText) {
    const estimates = state.estimates;

    return [
      getVideoTitle(player),
      "",
      `Speed: ${formatPlaybackSpeed(state.rate)}`,
      `State: ${state.paused ? "Paused" : "Playing"}`,
      `Content remaining: ${formatClock(estimates.remainingContent)}`,
      `Real time remaining: ${formatClock(estimates.realRemaining)}`,
      (
        `Savings from here: ${describeSavings(estimates.savingFromHere)} ` +
        `(${Math.round(estimates.savingPercent)}% of the remaining content)`
      ),
      (
        "Savings for the whole video: " +
        `${describeSavings(estimates.savingTotal)} ` +
        `(${Math.round(estimates.savingTotalPercent)}% of the video)`
      ),
      `Estimated end: ${endText}`,
      "",
      "Estimate assumes continuous playback at this speed; pauses, buffering and ads are not included.",
    ].join("\n");
  }

  // ---------------------------------------------------------------------------
  // Video binding
  // ---------------------------------------------------------------------------

  function handleVideoEvent() {
    scheduleUpdate();
  }

  function unbindVideo() {
    if (!lastVideo) return;

    for (const eventName of VIDEO_EVENTS) {
      lastVideo.removeEventListener(eventName, handleVideoEvent);
    }

    lastVideo = null;
  }

  function bindVideo(video) {
    if (video === lastVideo) return;

    // Always release the previous video first, so its listeners are removed
    // and no strong reference to a detached <video> (which can retain MSE
    // buffers) survives until the next video binds.
    unbindVideo();
    lastCurrentTime = null;

    if (!video) {
      log("video element unbound");
      return;
    }

    for (const eventName of VIDEO_EVENTS) {
      video.addEventListener(eventName, handleVideoEvent);
    }

    lastVideo = video;
    lastEndTimestamp = 0;
    log("video element bound");
  }

  // ---------------------------------------------------------------------------
  // Main update loop
  // ---------------------------------------------------------------------------

  function readPlayerState(player, video) {
    const state = {
      hiddenReason: "",
      duration: 0,
      currentTime: 0,
      rate: 1,
      paused: false,
      estimates: null,
      nearOne: true,
      mode: "normal",
    };

    if (!player) {
      state.hiddenReason = "no-player";
      return state;
    }

    if (
      player.classList.contains("ad-showing") ||
      player.classList.contains("ad-interrupting")
    ) {
      state.hiddenReason = "ad";
      return state;
    }

    if (!video) {
      state.hiddenReason = "no-video";
      return state;
    }

    state.paused = Boolean(video.paused);

    let rate = readPlayerNumber(player, "getPlaybackRate", video.playbackRate);
    if (!Number.isFinite(rate) || rate <= 0) rate = 1;
    state.rate = rate;

    let playerDuration = NaN;
    try {
      playerDuration = Number(player.getDuration());
    } catch (_) {
      playerDuration = NaN;
    }

    const liveBadge = player.querySelector(LIVE_BADGE_SELECTOR);
    const badgeVisible = Boolean(liveBadge) && isElementVisible(liveBadge);

    if (
      badgeVisible ||
      video.duration === Infinity ||
      playerDuration === Infinity
    ) {
      state.hiddenReason = "live";
      return state;
    }

    const duration =
      Number.isFinite(playerDuration) && playerDuration > 0
        ? playerDuration
        : Number(video.duration);
    const currentTime = readPlayerNumber(
      player,
      "getCurrentTime",
      video.currentTime
    );

    state.duration = finiteOrZero(duration);
    state.currentTime = Number.isFinite(currentTime)
      ? Math.max(0, currentTime)
      : 0;

    if (!(state.duration > 0) || !Number.isFinite(currentTime)) {
      state.hiddenReason = "not-ready";
      return state;
    }

    state.estimates = computeEstimates(state.duration, state.currentTime, rate);
    state.nearOne = Math.abs(rate - 1) < 0.001;
    state.mode = state.nearOne ? "normal" : rate > 1 ? "faster" : "slower";
    return state;
  }

  function update() {
    try {
      const player = document.querySelector(PLAYER_SELECTOR);
      const video = player ? player.querySelector("video") : null;

      bindVideo(video);
      if (player) ensureObserver(player);

      const state = readPlayerState(player, video);

      if (!state.hiddenReason && !ensureInline(player)) {
        state.hiddenReason = "no-anchor";
      }

      if (state.hiddenReason) {
        hideInline();
        noteState(state.hiddenReason);
        publishDebug(state, null);
        return;
      }

      // The ETA only moves when the playhead or the playback speed changes,
      // so it stays frozen while paused, buffering, or during an ad, but a
      // speed change while paused is picked up immediately.
      if (
        lastEndTimestamp === 0 ||
        lastCurrentTime === null ||
        state.currentTime !== lastCurrentTime ||
        state.rate !== lastRate
      ) {
        lastEndTimestamp = Date.now() + state.estimates.realRemaining * 1000;
      }
      lastCurrentTime = state.currentTime;
      lastRate = state.rate;

      const atoms = buildAtoms(state);
      const budget = refreshBudget(player);
      const parts = selectAtoms(atoms, budget);

      if (!parts) {
        state.hiddenReason = "too-narrow";
        hideInline();
        noteState(state.hiddenReason);
        publishDebug(state, null);
        return;
      }

      const endText = endTimeFormatter.format(new Date(lastEndTimestamp));
      syncPointerEvents(player);
      renderInline(parts, state.mode, buildTooltip(player, state, endText));
      noteState("");
      publishDebug(state, parts);

      if (!renderedOnce) {
        renderedOnce = true;
        log(
          "first render:",
          parts.map((part) => part.text).join(SEGMENT_SEPARATOR)
        );
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (message !== lastErrorMessage) {
        lastErrorMessage = message;
        console.error("[YouTube Real Time]", error);
      }
    }
  }

  function scheduleUpdate() {
    if (updateQueued) return;
    updateQueued = true;

    const run = () => {
      updateQueued = false;
      update();
    };

    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function isOwnNode(node) {
    if (!node || node.nodeType !== 1) return false;
    return typeof node.id === "string" && node.id.indexOf("ytrt-") === 0;
  }

  function isSelfMutation(record) {
    if (inline && (record.target === inline || inline.contains(record.target))) {
      return true;
    }

    let sawNode = false;

    for (const node of record.addedNodes) {
      sawNode = true;
      if (!isOwnNode(node)) return false;
    }

    for (const node of record.removedNodes) {
      sawNode = true;
      if (!isOwnNode(node)) return false;
    }

    return sawNode;
  }

  function handleMutations(records) {
    // Never touch the DOM synchronously inside a mutation callback; just flag
    // that something changed and let the scheduled update re-anchor.
    for (const record of records) {
      if (!isSelfMutation(record)) {
        budgetDirty = true;
        scheduleUpdate();
        return;
      }
    }
  }

  function ensureObserver(player) {
    if (!player || typeof MutationObserver === "undefined") return;
    if (player === observedPlayer) return;

    if (observer) observer.disconnect();
    observer = new MutationObserver(handleMutations);
    observer.observe(player, { childList: true, subtree: true });
    observedPlayer = player;
    log("mutation observer attached");
  }

  // ---------------------------------------------------------------------------
  // Debug API
  // ---------------------------------------------------------------------------

  function emptyDebugInfo() {
    return {
      anchored: false,
      anchorKind: "",
      text: "",
      atoms: [],
      duration: 0,
      currentTime: 0,
      rate: 1,
      remainingContent: 0,
      realRemaining: 0,
      savingFromHere: 0,
      savingPercent: 0,
      savingTotal: 0,
      endTimestamp: 0,
      mode: "normal",
      hiddenReason: "not-started",
      alignDelta: 0,
    };
  }

  // Read-only geometry check for testing: rounded px between the vertical
  // centres of our span and YouTube's `.ytp-time-contents` (whose 40px block
  // half-leading-centres its glyphs, so a top-to-top comparison would report
  // ~+11px even when perfectly aligned). Returns 0 unless anchored in the
  // time display, when either element is missing, or on any error. Never
  // throws and never adjusts layout.
  function measureAlignDelta() {
    try {
      if (!inline || !inline.isConnected || anchorKind !== "time-display") {
        return 0;
      }

      const player = document.querySelector(PLAYER_SELECTOR);
      const timeDisplay = player && player.querySelector(TIME_DISPLAY_SELECTOR);
      const contents =
        timeDisplay && timeDisplay.querySelector(TIME_CONTENTS_SELECTOR);
      if (!contents) return 0;

      const ownRect = inline.getBoundingClientRect();
      const contentsRect = contents.getBoundingClientRect();
      if (!(ownRect.height > 0) || !(contentsRect.height > 0)) return 0;

      const delta =
        ownRect.top +
        ownRect.height / 2 -
        (contentsRect.top + contentsRect.height / 2);
      return Number.isFinite(delta) ? Math.round(delta) : 0;
    } catch (_) {
      return 0;
    }
  }

  function publishDebug(state, parts) {
    const estimates = state.estimates;

    debugInfo = {
      anchored: Boolean(inline && inline.isConnected),
      anchorKind,
      text: state.hiddenReason
        ? ""
        : (parts || []).map((part) => part.text).join(SEGMENT_SEPARATOR),
      atoms: parts || [],
      duration: finiteOrZero(state.duration),
      currentTime: finiteOrZero(state.currentTime),
      rate: finiteOrZero(state.rate) || 1,
      remainingContent: estimates ? finiteOrZero(estimates.remainingContent) : 0,
      realRemaining: estimates ? finiteOrZero(estimates.realRemaining) : 0,
      savingFromHere: estimates ? finiteOrZero(estimates.savingFromHere) : 0,
      savingPercent: estimates ? finiteOrZero(estimates.savingPercent) : 0,
      savingTotal: estimates ? finiteOrZero(estimates.savingTotal) : 0,
      endTimestamp: finiteOrZero(lastEndTimestamp),
      mode: state.mode,
      hiddenReason: state.hiddenReason,
    };
  }

  function installDebugApi() {
    try {
      window.__ytrt = Object.freeze({
        version: VERSION,
        state: () => {
          try {
            return Object.assign({}, debugInfo, {
              anchored: Boolean(inline && inline.isConnected),
              alignDelta: measureAlignDelta(),
              atoms: debugInfo.atoms.map((atom) => Object.assign({}, atom)),
            });
          } catch (_) {
            return emptyDebugInfo();
          }
        },
      });
    } catch (_) {
      // The debug API is optional; never break the page if it cannot exist.
    }
  }

  // ---------------------------------------------------------------------------
  // Boot marker (visual check that the script runs)
  // ---------------------------------------------------------------------------

  function removeBootMarker() {
    const marker = document.getElementById(BOOT_MARKER_ID);
    if (marker) marker.remove();
  }

  function createBootMarker() {
    removeBootMarker();

    const marker = document.createElement("div");
    marker.id = BOOT_MARKER_ID;
    marker.textContent = `YTRT ${VERSION}`;

    setImportantStyle(marker, "position", "fixed");
    setImportantStyle(marker, "top", "8px");
    setImportantStyle(marker, "left", "8px");
    setImportantStyle(marker, "z-index", "2147483646");
    setImportantStyle(marker, "padding", "3px 9px");
    setImportantStyle(marker, "color", "#f1f5f9");
    setImportantStyle(marker, "background", "rgba(0, 0, 0, 0.72)");
    setImportantStyle(marker, "border", "1px solid rgba(255, 255, 255, 0.25)");
    setImportantStyle(marker, "border-radius", "999px");
    setImportantStyle(marker, "font-family", "Arial, sans-serif");
    setImportantStyle(marker, "font-size", "11px");
    setImportantStyle(marker, "font-weight", "600");
    setImportantStyle(marker, "line-height", "1.35");
    setImportantStyle(marker, "pointer-events", "none");

    (document.body || document.documentElement).appendChild(marker);
    log("boot marker shown");

    setTimeout(() => {
      const current = document.getElementById(BOOT_MARKER_ID);
      if (current) current.remove();
    }, 2500);
  }

  function cleanupOldElements() {
    for (const id of OLD_ELEMENT_IDS) {
      const old = document.getElementById(id);
      if (old) {
        old.remove();
        log("removed leftover element", id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------

  function handleNavigation() {
    budgetDirty = true;
    cleanupOldElements();
    scheduleUpdate();
  }

  function handleLayoutChange() {
    budgetDirty = true;
    scheduleUpdate();
  }

  function start() {
    cleanupOldElements();
    installDebugApi();
    if (SETTINGS.SHOW_BOOT_MARKER) createBootMarker();
    log(`started v${VERSION}`);
    update();
    setInterval(update, SETTINGS.REFRESH_INTERVAL_MS);

    window.addEventListener("resize", handleLayoutChange);
    window.addEventListener("popstate", handleNavigation);
    window.addEventListener("yt-navigate-finish", handleNavigation);
    document.addEventListener("fullscreenchange", handleLayoutChange);
    document.addEventListener("visibilitychange", scheduleUpdate);
  }

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
})();
