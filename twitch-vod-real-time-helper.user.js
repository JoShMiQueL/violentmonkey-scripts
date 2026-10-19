// ==UserScript==
// @name         Twitch VOD Real Time, Savings & ETA
// @namespace    local.userscript.twitch.vod-real-time
// @version      1.0.0
// @downloadURL  https://raw.githubusercontent.com/JoShMiQueL/violentmonkey-scripts/master/twitch-vod-real-time-helper.user.js
// @updateURL    https://raw.githubusercontent.com/JoShMiQueL/violentmonkey-scripts/master/twitch-vod-real-time-helper.user.js
// @description  Extends the Twitch VOD player's own time display with the real time remaining at the current speed, time saved versus 1x, and an estimated finish time. English UI, no emojis, hides with the control bar.
// @match        https://www.twitch.tv/videos/*
// @grant        none
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  "use strict";

  const VERSION = "1.0.0";

  /**
   * Tunable behaviour of the script.
   */
  const SETTINGS = Object.freeze({
    REFRESH_INTERVAL_MS: 250,
    WIDTH_REFRESH_INTERVAL_MS: 500,
    WIDTH_SAFETY_MARGIN_PX: 12,
    AD_DURATION_TOLERANCE_SECONDS: 2,
    // false renders the estimated end as 21:05, true as 9:05 PM.
    HOUR_24: true,
    DEBUG: false,
    SHOW_BOOT_MARKER: false,
  });

  const INLINE_ID = "twrt-inline-v1";
  const MEASURE_ID = "twrt-measure-v1";
  const BOOT_MARKER_ID = "twrt-boot-marker";
  // Nothing to clean up from older versions (yet); keep the loop so a
  // future id bump only has to append here.
  const OLD_ELEMENT_IDS = [];

  // Stable hooks only: the styled-components classes around the seekbar
  // (iNsphT, khmzxI, kRFqIu, joAHyC) are build-time hashes that can change
  // with any Twitch deploy, so never depend on them.
  const PLAYER_SELECTOR = ".video-player";
  const TIME_LABELS_SELECTOR = ".vod-seekbar-time-labels";
  const CURRENT_TIME_SELECTOR = '[data-a-target="player-seekbar-current-time"]';
  const DURATION_SELECTOR = '[data-a-target="player-seekbar-duration"]';
  const PLAYER_CONTROLS_SELECTOR = '[data-a-target="player-controls"]';
  const LIVE_BUTTON_SELECTOR = '[data-a-target="player-seekbar-live-button"]';
  const AD_WRAPPER_SELECTOR = '[class*="stream-display-ad__wrapper"]';

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
    "end",
  ]);

  // Order in which segments are kept when the available width is tight.
  const ATOM_PRIORITY_ORDER = Object.freeze([
    "real",
    "savedPct",
    "speed",
    "end",
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

  // `hourCycle` rather than `hour12`, so the 24h mode cannot leak the
  // "24:00" that some engines render for midnight with `hour12: false`.
  const endTimeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: SETTINGS.HOUR_24 ? "h23" : "h12",
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
  let lastColor = null;
  let lastSignature = "";
  let segmentTextNodes = [];
  // The native tooltip is dismissed and re-queued whenever its `title`
  // changes while visible, so the tooltip is frozen while the pointer rests
  // on our span and refreshed on the way out.
  let pointerInside = false;
  let desiredTooltip = "";
  let appliedTooltip = null;
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
    if (SETTINGS.DEBUG) console.log("[Twitch VOD Real Time]", ...args);
  }

  function applyInlineStyles(element) {
    setImportantStyle(element, "display", "inline");
    setImportantStyle(element, "padding-left", "8px");
    setImportantStyle(element, "white-space", "nowrap");
    setImportantStyle(element, "font-variant-numeric", "tabular-nums");
    // The time row is `display: flex; justify-content: space-between`, so
    // our span is blockified into the middle flex item and `align-self:
    // center` centres it vertically next to Twitch's labels. `vertical-align:
    // top` keeps the glyph run flush at the top of the inherited line box in
    // the fallback anchors, where flex does not apply.
    setImportantStyle(element, "vertical-align", "top");
    setImportantStyle(element, "align-self", "center");
    setImportantStyle(element, "cursor", "help");
    // There is no autohide class to mirror (unlike YouTube's `ytp-autohide`):
    // the span lives INSIDE Twitch's control bar, so Twitch hides it
    // automatically whenever it hides that bar. Keep the pointer events on
    // unconditionally so the tooltip works whenever the bar is shown.
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

  // Parses a Twitch clock label ("02:30:00" or "12:34") into seconds.
  // Returns NaN for anything it cannot parse.
  function parseClockLabel(text) {
    const value = String(text == null ? "" : text).trim();
    const match = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/.exec(value);
    if (!match) return NaN;

    const first = Number(match[1]);
    const second = Number(match[2]);

    if (match[3] === undefined) return first * 60 + second;
    return first * 3600 + second * 60 + Number(match[3]);
  }

  // Twitch's <title> is "<video title> - Twitch"; strip the site suffix so
  // the tooltip leads with the video itself.
  function getVideoTitle() {
    const title = String(document.title || "").trim();
    const cleaned = title.replace(/\s*[-|]\s*Twitch\s*$/i, "").trim();
    return cleaned || "This video";
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

  // Returns the first VISIBLE match for the selector. Twitch renders some
  // controls twice (an offscreen, zero-size copy next to the live one), so
  // every lookup must pick the visible instance, never just the first node.
  function firstVisible(selector) {
    const matches = Array.from(document.querySelectorAll(selector));
    return matches.find(isElementVisible) || null;
  }

  // The visible .vod-seekbar-time-labels row; the hidden duplicate has a
  // zero-size rect, which isElementVisible() rejects.
  function visibleTimeRow() {
    return firstVisible(TIME_LABELS_SELECTOR);
  }

  // The visible time label inside the visible row (either the
  // `player-seekbar-current-time` or the `player-seekbar-duration` <p>).
  function visibleTimeLabel(targetSelector) {
    const row = visibleTimeRow();
    if (!row) return null;

    const label = row.querySelector(targetSelector);
    return label && isElementVisible(label) ? label : null;
  }

  function finiteOrZero(value) {
    return Number.isFinite(value) ? value : 0;
  }

  // ---------------------------------------------------------------------------
  // Inline display lifecycle
  // ---------------------------------------------------------------------------

  function handlePointerEnter() {
    pointerInside = true;
  }

  // Refreshes the tooltip only once the pointer is gone, so the native
  // tooltip that is currently on screen is never dismissed by our own write.
  function handlePointerLeave() {
    pointerInside = false;
    if (desiredTooltip !== appliedTooltip) {
      applyTooltip(desiredTooltip);
    }
  }

  function applyTooltip(tooltip) {
    if (!inline) return;
    inline.title = tooltip;
    inline.setAttribute("aria-label", tooltip);
    appliedTooltip = tooltip;
  }

  function createInline() {
    const element = document.createElement("span");
    element.id = INLINE_ID;
    element.setAttribute("aria-live", "off");
    element.addEventListener("mouseenter", handlePointerEnter);
    element.addEventListener("mouseleave", handlePointerLeave);
    applyInlineStyles(element);
    return element;
  }

  // Twitch's row is `display: flex; justify-content: space-between` with two
  // <p> children, so a span inserted after `player-seekbar-current-time`
  // becomes the middle flex item: measured before/after, Twitch's labels
  // stay pinned to the edges (current time x=66 w=59, duration x=544 w=60)
  // and our span centres in the free space between them. We never move or
  // restyle Twitch's own elements.
  function anchorInline(player) {
    if (!player) return "";

    const currentTime = visibleTimeLabel(CURRENT_TIME_SELECTOR);
    if (currentTime) {
      currentTime.insertAdjacentElement("afterend", inline);
      return "seekbar-labels";
    }

    const controls = firstVisible(PLAYER_CONTROLS_SELECTOR);
    if (controls) {
      controls.appendChild(inline);
      return "player-controls";
    }

    const root = firstVisible(PLAYER_SELECTOR);
    if (root) {
      root.appendChild(inline);
      return "player";
    }

    return "";
  }

  // The best anchor that currently exists in the player, using the same
  // priority order as anchorInline().
  function bestAnchorKind() {
    if (visibleTimeLabel(CURRENT_TIME_SELECTOR)) return "seekbar-labels";
    if (firstVisible(PLAYER_CONTROLS_SELECTOR)) return "player-controls";
    if (firstVisible(PLAYER_SELECTOR)) return "player";
    return "";
  }

  function ensureInline(player) {
    // Only bail out early when the span already sits in the best anchor that
    // currently exists. A degraded anchor (e.g. the visible player controls
    // while Twitch is still building the time row) must be upgraded once the
    // better anchor appears. Relocating moves only our own `twrt-` node,
    // which the observer filters as a self mutation, and afterwards
    // anchorKind equals the best anchor again, so this cannot loop.
    if (
      inline &&
      inline.isConnected &&
      bestAnchorKind() === anchorKind
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
    lastSignature = "";
    segmentTextNodes = [];
    appliedTooltip = null;
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

  // Rebuilds the segment nodes only when their shape (the sequence of kinds)
  // changes. The usual case is the same shape with a new value, and that is
  // written into the existing text node via `.data` (a characterData
  // mutation), so nothing is removed from under the pointer and the native
  // tooltip is not dismissed. Replacing `textContent` here would delete and
  // recreate the text nodes every tick, which is what made the tooltip
  // restart on every update.
  function renderSegments(parts) {
    const shape = parts.map((part) => part.kind).join("|");

    if (shape !== lastSignature) {
      inline.textContent = "";
      segmentTextNodes = [];

      for (let index = 0; index < parts.length; index += 1) {
        if (index > 0) {
          inline.appendChild(document.createTextNode(SEGMENT_SEPARATOR));
        }

        const span = document.createElement("span");
        if (parts[index].kind === "speed") {
          setImportantStyle(span, "font-weight", "700");
        }

        const textNode = document.createTextNode(parts[index].text);
        segmentTextNodes.push(textNode);
        span.appendChild(textNode);
        inline.appendChild(span);
      }

      lastSignature = shape;
      return;
    }

    for (let index = 0; index < parts.length; index += 1) {
      const textNode = segmentTextNodes[index];
      if (!textNode) continue;
      const text = parts[index].text;
      if (textNode.data !== text) textNode.data = text;
    }
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

    renderSegments(parts);

    // Remember the newest text, but only write it once the pointer has left:
    // changing `title` while the native tooltip is on screen closes it and
    // restarts the hover delay, which reads as the tooltip resetting every
    // second.
    desiredTooltip = tooltip;

    if (!pointerInside && desiredTooltip !== appliedTooltip) {
      applyTooltip(desiredTooltip);
    }
  }

  function hideInline() {
    // Hidden while hovered: the pointer is no longer over anything, so drop
    // the frozen state too or the tooltip would stay stale forever.
    pointerInside = false;

    if (!inline || lastVisibility === false) return;
    setImportantStyle(inline, "display", "none");
    lastVisibility = false;
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

  // Measures in the font Twitch renders its own time labels with (Inter
  // 14px, weight 400), so candidate widths match the rendered span; falls
  // back to our span and then to the player box when the labels are gone.
  function syncMeasureFont(player) {
    const span = ensureMeasureSpan();
    if (!span) return;

    const label = visibleTimeLabel(CURRENT_TIME_SELECTOR);
    const source = label || inline || player;
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

    const row = visibleTimeRow();

    if (row) {
      // `justify-content: space-between` pins Twitch's two labels to the
      // edges, so the free space between them is exactly what our span may
      // consume: row clientWidth minus the flow width of every child except
      // our own span, minus the safety margin. Measured 538 - 60 - 60 =
      // 418px of headroom at the default player size, so the full line fits.
      let budget = row.clientWidth;

      for (const child of row.children) {
        if (child === inline) continue;
        if (inline && child.contains(inline)) continue;
        budget -= flowWidth(child);
      }

      return budget - SETTINGS.WIDTH_SAFETY_MARGIN_PX;
    }

    const controls = firstVisible(PLAYER_CONTROLS_SELECTOR);
    if (controls) {
      // Degraded anchor: reserve half of the control bar.
      return controls.clientWidth * 0.5 - SETTINGS.WIDTH_SAFETY_MARGIN_PX;
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
      real: `Done in ${formatClock(estimates.realRemaining)}`,
      savedPct: null,
      end: `End ${endTimeFormatter.format(new Date(lastEndTimestamp))}`,
    };

    if (!state.nearOne && Math.abs(estimates.savingFromHere) >= 1) {
      atoms.savedPct =
        `${savingsLabel(estimates.savingFromHere)} ` +
        `(${Math.round(estimates.savingPercent)}%)`;
    }

    return atoms;
  }

  function buildTooltip(state, endText) {
    const estimates = state.estimates;

    return [
      getVideoTitle(),
      "",
      `Speed: ${formatPlaybackSpeed(state.rate)}`,
      `State: ${state.paused ? "Paused" : "Playing"}`,
      `Content remaining: ${formatClock(estimates.remainingContent)}`,
      `Done in: ${formatClock(estimates.realRemaining)}`,
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

  // Signal 1: an active `stream-display-ad__wrapper*` element. Twitch marks
  // the inactive state with a class containing `hidden` (e.g.
  // `stream-display-ad__wrapper-hidden`), which deactivates the wrapper
  // regardless of geometry; the `_squeezeback` variants can also be present
  // with a zero-size rect while inactive, which the visibility check covers.
  // Signal 2: the duration label belongs to the VOD (measured: `02:30:00`
  // for `video.duration === 9000`), while a playing ad reports its own
  // duration on the element, so a mismatch beyond the tolerance means the
  // on-screen media is not the VOD.
  function hasActiveAd(duration) {
    const wrappers = Array.from(
      document.querySelectorAll(AD_WRAPPER_SELECTOR)
    );

    for (const wrapper of wrappers) {
      const classes = Array.from(wrapper.classList).filter((name) =>
        name.indexOf("stream-display-ad__wrapper") === 0
      );
      const hidden = classes.some((name) => name.indexOf("hidden") !== -1);

      if (classes.length && !hidden && isElementVisible(wrapper)) return true;
    }

    if (!Number.isFinite(duration)) return false;

    const label = visibleTimeLabel(DURATION_SELECTOR);
    if (!label) return false;

    const labelSeconds = parseClockLabel(label.textContent);
    if (!Number.isFinite(labelSeconds) || !(labelSeconds > 0)) return false;

    return (
      Math.abs(duration - labelSeconds) >
      SETTINGS.AD_DURATION_TOLERANCE_SECONDS
    );
  }

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

    if (!video) {
      state.hiddenReason = "no-video";
      return state;
    }

    state.paused = Boolean(video.paused);

    // On Twitch the player's own Settings -> Speed submenu writes
    // `video.playbackRate` directly (verified: picking 2x leaves
    // `video.playbackRate === 2`), so the element is the single source of
    // truth for Twitch's own menu and for third-party speed extensions
    // alike. Unlike on YouTube there is no separate player API rate that
    // could disagree with it, so no API-vs-element precedence is needed.
    state.rate =
      Number.isFinite(video.playbackRate) && video.playbackRate > 0
        ? video.playbackRate
        : 1;

    // Defensive guard: /videos/* is a VOD page, but if the URL ever resolves
    // to something live, Twitch's own label must never be mistaken for a
    // finite duration.
    const liveButton = firstVisible(LIVE_BUTTON_SELECTOR);
    if (video.duration === Infinity || liveButton) {
      state.hiddenReason = "live";
      return state;
    }

    const duration = video.duration;
    const currentTime = video.currentTime;

    state.duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    state.currentTime = Number.isFinite(currentTime)
      ? Math.max(0, currentTime)
      : 0;

    if (hasActiveAd(duration)) {
      state.hiddenReason = "ad";
      return state;
    }

    if (!(state.duration > 0) || !Number.isFinite(currentTime)) {
      state.hiddenReason = "not-ready";
      return state;
    }

    state.estimates = computeEstimates(
      state.duration,
      state.currentTime,
      state.rate
    );
    state.nearOne = Math.abs(state.rate - 1) < 0.001;
    state.mode = state.nearOne ? "normal" : state.rate > 1 ? "faster" : "slower";
    return state;
  }

  function update() {
    try {
      const player = document.querySelector(PLAYER_SELECTOR);
      // Measured: the page has exactly one <video> element, so the
      // document-wide fallback cannot pick the wrong media.
      const video = player
        ? player.querySelector("video") || document.querySelector("video")
        : null;

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
      renderInline(parts, state.mode, buildTooltip(state, endText));
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
        console.error("[Twitch VOD Real Time]", error);
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
    return typeof node.id === "string" && node.id.indexOf("twrt-") === 0;
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
  // centres of our span and Twitch's duration label (both are line boxes
  // centred in the flex row, so a top-to-top comparison would report any
  // line-box difference rather than a misalignment). Returns 0 unless we are
  // the middle flex item of the seekbar labels row, when either element is
  // missing, or on any error. Never throws and never adjusts layout.
  function measureAlignDelta() {
    try {
      if (!inline || !inline.isConnected || anchorKind !== "seekbar-labels") {
        return 0;
      }

      const durationLabel = visibleTimeLabel(DURATION_SELECTOR);
      if (!durationLabel) return 0;

      const ownRect = inline.getBoundingClientRect();
      const durationRect = durationLabel.getBoundingClientRect();
      if (!(ownRect.height > 0) || !(durationRect.height > 0)) return 0;

      const delta =
        ownRect.top +
        ownRect.height / 2 -
        (durationRect.top + durationRect.height / 2);
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
      window.__twrt = Object.freeze({
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
    marker.textContent = `TWRT ${VERSION}`;

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
    document.addEventListener("fullscreenchange", handleLayoutChange);
    document.addEventListener("visibilitychange", scheduleUpdate);
  }

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
})();
