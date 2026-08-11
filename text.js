// text.js — selection translation UI for regular web pages.
//
// Captures a stable text selection, then uses the same DeepSeek streaming Port
// as content.js. Network access remains in background.js/api.js; this isolated
// content script receives text deltas only.
(() => {
  "use strict";

  if (window.__ytdsSelectionUiLoaded) return;
  window.__ytdsSelectionUiLoaded = true;

  const OPEN_DELAY = 500;
  const VIEWPORT_MARGIN = 12;
  const SELECTION_GAP = 10;
  const t = (key, fallback) =>
    (chrome.i18n && chrome.i18n.getMessage(key)) || fallback;

  let openTimer = 0;
  let pointerSelecting = false;
  let pointerMoved = false;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let selectionAtPointerDown = "";
  let suppressOutsideClick = false;
  let dismissed = false;
  let targetLang = "zh-CN";
  let host = null;
  let panel = null;
  let sourceText = null;
  let translationText = null;
  let statusText = null;
  let translationPort = null;
  let translationRun = 0;
  let anchorRect = null;
  let placementFrame = 0;

  function ensureUi() {
    if (host && host.isConnected) return;

    host = document.createElement("div");
    host.id = "ytds-selection-ui";
    host.setAttribute("data-ytds-ui", "selection-translation");
    // Inline !important styles keep aggressive page-wide CSS resets from
    // moving or hiding the shadow host. The UI inside remains fully isolated.
    const hostStyle = {
      all: "initial",
      display: "block",
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      pointerEvents: "none"
    };
    Object.entries(hostStyle).forEach(([property, value]) => {
      host.style.setProperty(
        property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
        value,
        "important"
      );
    });

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          pointer-events: none;
          color-scheme: light;
        }

        .window {
          position: fixed;
          box-sizing: border-box;
          width: min(360px, calc(100vw - 24px));
          max-height: calc(100vh - 24px);
          overflow: hidden;
          border: 1px solid rgba(15, 23, 42, 0.12);
          border-radius: 14px;
          background: #ffffff;
          color: #172033;
          box-shadow:
            0 18px 48px rgba(15, 23, 42, 0.18),
            0 3px 10px rgba(15, 23, 42, 0.10);
          font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont,
            "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          letter-spacing: normal;
          text-align: left;
          pointer-events: auto;
          animation: ytds-selection-in 140ms ease-out;
        }

        .window[hidden] {
          display: none;
        }

        .header {
          display: flex;
          align-items: center;
          min-height: 42px;
          padding: 0 10px 0 14px;
          border-bottom: 1px solid #edf0f5;
        }

        .title {
          color: #111827;
          font-size: 14px;
          font-weight: 700;
        }

        .status {
          margin-left: 8px;
          padding: 2px 7px;
          border-radius: 999px;
          background: #fff4df;
          color: #a35b00;
          font-size: 11px;
          font-weight: 600;
        }

        .status[data-state="done"] {
          background: #e9f8ef;
          color: #18794e;
        }

        .status[data-state="error"] {
          background: #fff0f0;
          color: #b42318;
        }

        .close {
          all: unset;
          box-sizing: border-box;
          display: grid;
          width: 28px;
          height: 28px;
          margin-left: auto;
          place-items: center;
          border-radius: 8px;
          color: #667085;
          cursor: pointer;
          font: 20px/1 system-ui, sans-serif;
        }

        .close:hover {
          background: #f2f4f7;
          color: #111827;
        }

        .close:focus-visible {
          outline: 2px solid #4477ee;
          outline-offset: 1px;
        }

        .content {
          box-sizing: border-box;
          max-height: calc(100vh - 67px);
          overflow: auto;
          padding: 12px 14px 14px;
        }

        .label {
          margin-bottom: 5px;
          color: #8a94a6;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }

        .source {
          max-height: 112px;
          overflow: auto;
          color: #253047;
          font-size: 14px;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }

        .translation {
          min-height: 42px;
          max-height: 180px;
          margin-top: 5px;
          overflow: auto;
          padding: 11px 12px;
          border-radius: 10px;
          background: #f6f8fb;
          color: #253047;
          font-size: 13px;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }

        .translation-label {
          margin-top: 12px;
        }

        .translation[data-state="loading"] {
          color: #8a94a6;
        }

        .translation[data-state="error"] {
          background: #fff7f7;
          color: #b42318;
        }

        @keyframes ytds-selection-in {
          from { opacity: 0; transform: translateY(4px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        @media (prefers-reduced-motion: reduce) {
          .window { animation: none; }
        }
      </style>

      <section class="window" role="dialog" hidden>
        <header class="header">
          <span class="title">翻译</span>
          <span class="status" data-state="loading">翻译中</span>
          <button class="close" type="button" aria-label="关闭">×</button>
        </header>
        <div class="content">
          <div class="label source-label">原文</div>
          <div class="source"></div>
          <div class="label translation-label">译文</div>
          <div class="translation" data-state="loading">正在翻译…</div>
        </div>
      </section>
    `;

    panel = shadow.querySelector(".window");
    sourceText = shadow.querySelector(".source");
    translationText = shadow.querySelector(".translation");
    statusText = shadow.querySelector(".status");

    panel.setAttribute("aria-label", t("selectionDialogAria", "Translate selected text"));
    shadow.querySelector(".title").textContent = t("secTranslation", "Translation");
    shadow.querySelector(".source-label").textContent = t("exportOrig", "Original");
    shadow.querySelector(".translation-label").textContent = t("tabTrans", "Translation");

    const close = shadow.querySelector(".close");
    close.setAttribute("aria-label", t("selectionClose", "Close"));
    close.addEventListener("pointerdown", (event) => event.preventDefault());
    close.addEventListener("click", hide);

    (document.body || document.documentElement).appendChild(host);
  }

  function isTextControl(element) {
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    return /^(text|search|url|tel|email)$/i.test(element.type);
  }

  function selectedTextOnly() {
    const active = document.activeElement;
    if (isTextControl(active)) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (typeof start === "number" && typeof end === "number" && end > start) {
        return active.value.slice(start, end).trim();
      }
    }
    const selection = window.getSelection();
    return selection ? selection.toString().trim() : "";
  }

  function readSelection() {
    ensureUi();

    const shadow = host.shadowRoot;
    if (shadow && shadow.activeElement) return null;

    const active = document.activeElement;
    if (isTextControl(active)) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (typeof start === "number" && typeof end === "number" && end > start) {
        const text = active.value.slice(start, end).trim();
        if (text) return { text, rect: active.getBoundingClientRect() };
      }
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const text = selection.toString().trim();
    if (!text) return null;

    const range = selection.getRangeAt(0);
    if (range.commonAncestorContainer.getRootNode() === shadow) return null;

    let rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      const rects = range.getClientRects();
      rect = rects.length ? rects[rects.length - 1] : rect;
    }
    if (!rect || (!rect.width && !rect.height)) return null;

    return { text, rect };
  }

  function placePanel(rect) {
    if (!panel || panel.hidden || !rect) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);

    let left = rect.left + (rect.width - width) / 2;
    left = Math.min(Math.max(left, VIEWPORT_MARGIN), maxLeft);

    let top = rect.bottom + SELECTION_GAP;
    if (top + height + VIEWPORT_MARGIN > window.innerHeight) {
      top = rect.top - height - SELECTION_GAP;
    }
    top = Math.min(Math.max(top, VIEWPORT_MARGIN), maxTop);

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function queuePanelPlacement() {
    if (placementFrame || !anchorRect) return;
    placementFrame = requestAnimationFrame(() => {
      placementFrame = 0;
      placePanel(anchorRect);
    });
  }

  function setTranslationState(state, text) {
    if (!translationText || !statusText) return;
    translationText.dataset.state = state;
    translationText.textContent = text;
    statusText.dataset.state = state;
    statusText.textContent = state === "done"
      ? t("selectionDone", "Done")
      : state === "error"
        ? t("selectionFailed", "Failed")
        : t("selectionTranslating", "Translating");
    queuePanelPlacement();
  }

  function errorText(code) {
    if (code === "NO_DEEPSEEK_KEY") {
      return t("aiStreamNoKey", "Configure the DeepSeek Key in settings first");
    }
    if (code === "EMPTY_SOURCE") {
      return t("selectionEmpty", "No text selected");
    }
    return t("aiStreamFailed", "AI request failed");
  }

  function cancelTranslation() {
    translationRun++;
    const port = translationPort;
    translationPort = null;
    if (port) {
      try { port.disconnect(); } catch (_error) { /* already disconnected */ }
    }
  }

  function startTranslation(text) {
    cancelTranslation();
    const run = translationRun;
    setTranslationState("loading", t("selectionTranslatingEllipsis", "Translating…"));

    let port = null;
    try {
      port = chrome.runtime.connect({ name: "ytds-ai-translation" });
    } catch (_error) {
      setTranslationState("error", t("selectionReload", "Reload this page to use the extension"));
      return;
    }
    translationPort = port;

    let output = "";
    let settled = false;

    function finishPort() {
      if (translationPort === port) translationPort = null;
      try { port.disconnect(); } catch (_error) { /* already disconnected */ }
    }

    function showError(code, message) {
      if (settled || run !== translationRun) return;
      settled = true;
      setTranslationState("error", errorText(code));
      if (message) console.warn("[YTDS] Selection translation:", message);
      finishPort();
    }

    port.onMessage.addListener((message) => {
      if (settled || run !== translationRun || !message) return;
      if (message.type === "delta") {
        output += String(message.content || "");
        if (output) setTranslationState("loading", output);
        return;
      }
      if (message.type === "error") {
        showError(message.code, message.message);
        return;
      }
      if (message.type === "done") {
        settled = true;
        if (output) {
          setTranslationState("done", output);
        } else {
          setTranslationState("error", t("aiStreamEmpty", "AI returned no result"));
        }
        finishPort();
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled || run !== translationRun) return;
      translationPort = null;
      showError("AI_STREAM_DISCONNECTED", "The translation stream disconnected");
    });

    try {
      port.postMessage({
        type: "start",
        mode: "translate",
        text,
        targetLang
      });
    } catch (_error) {
      showError("AI_STREAM_DISCONNECTED", "Unable to start the translation stream");
    }
  }

  function show(selection) {
    ensureUi();
    dismissed = false;
    sourceText.textContent = selection.text;
    anchorRect = {
      left: selection.rect.left,
      right: selection.rect.right,
      top: selection.rect.top,
      bottom: selection.rect.bottom,
      width: selection.rect.width,
      height: selection.rect.height
    };
    panel.hidden = false;
    placePanel(anchorRect);
    startTranslation(selection.text);
  }

  function hide() {
    dismissed = true;
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = 0;
    }
    cancelTranslation();
    anchorRect = null;
    if (placementFrame) {
      cancelAnimationFrame(placementFrame);
      placementFrame = 0;
    }
    if (panel) panel.hidden = true;
  }

  function scheduleOpen() {
    if (dismissed) return;
    if (openTimer) clearTimeout(openTimer);
    openTimer = window.setTimeout(() => {
      openTimer = 0;
      const selection = readSelection();
      if (selection) show(selection);
    }, OPEN_DELAY);
  }

  document.addEventListener("pointerdown", (event) => {
    if (host && event.composedPath().includes(host)) return;
    pointerSelecting = true;
    pointerMoved = false;
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
    selectionAtPointerDown = selectedTextOnly();
    dismissed = false;
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = 0;
    }
  }, true);

  document.addEventListener("pointermove", (event) => {
    if (!pointerSelecting || pointerMoved) return;
    if (Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY) > 4) {
      pointerMoved = true;
    }
  }, true);

  document.addEventListener("pointerup", (event) => {
    pointerSelecting = false;
    if (host && event.composedPath().includes(host)) return;
    const selectedNow = selectedTextOnly();
    if (pointerMoved || (selectedNow && selectedNow !== selectionAtPointerDown)) {
      // Browsers may emit a click after a drag-selection. Ignore that synthetic
      // follow-up so it cannot immediately close the new translation window.
      suppressOutsideClick = true;
      setTimeout(() => { suppressOutsideClick = false; }, 0);
      scheduleOpen();
    }
  }, true);

  document.addEventListener("pointercancel", () => {
    pointerSelecting = false;
    pointerMoved = false;
    selectionAtPointerDown = "";
    suppressOutsideClick = false;
  }, true);

  document.addEventListener("click", (event) => {
    if (host && event.composedPath().includes(host)) return;
    if (suppressOutsideClick) {
      suppressOutsideClick = false;
      return;
    }
    hide();
  }, true);

  document.addEventListener("selectionchange", () => {
    if (pointerSelecting) {
      if (openTimer) clearTimeout(openTimer);
      openTimer = 0;
      return;
    }
    scheduleOpen();
  });

  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      hide();
      return;
    }
    if (event.shiftKey || event.key === "Shift") {
      dismissed = false;
      scheduleOpen();
    }
  }, true);

  try {
    chrome.storage.sync.get({ targetLang: "zh-CN" }, (stored) => {
      if (chrome.runtime.lastError) return;
      targetLang = String((stored && stored.targetLang) || "zh-CN");
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.targetLang) {
        targetLang = String(changes.targetLang.newValue || "zh-CN");
      }
    });
  } catch (_error) { /* extension was reloaded; the UI reports it on use */ }

  window.addEventListener("blur", () => {
    pointerSelecting = false;
    pointerMoved = false;
    suppressOutsideClick = false;
  });
  window.addEventListener("resize", queuePanelPlacement);
})();
