// text.js — selection translation UI for regular web pages.
//
// This first version deliberately contains no translation provider. It only
// captures a stable text selection and presents the future translation window.
(() => {
  "use strict";

  if (window.__ytdsSelectionUiLoaded) return;
  window.__ytdsSelectionUiLoaded = true;

  const OPEN_DELAY = 500;
  const VIEWPORT_MARGIN = 12;
  const SELECTION_GAP = 10;

  let openTimer = 0;
  let pointerSelecting = false;
  let host = null;
  let panel = null;
  let sourceText = null;

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
          margin-top: 12px;
          padding: 11px 12px;
          border-radius: 10px;
          background: #f6f8fb;
          color: #8a94a6;
          font-size: 13px;
        }

        @keyframes ytds-selection-in {
          from { opacity: 0; transform: translateY(4px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        @media (prefers-reduced-motion: reduce) {
          .window { animation: none; }
        }
      </style>

      <section class="window" role="dialog" aria-label="翻译选中文案" hidden>
        <header class="header">
          <span class="title">翻译</span>
          <span class="status">待接入</span>
          <button class="close" type="button" aria-label="关闭">×</button>
        </header>
        <div class="content">
          <div class="label">原文</div>
          <div class="source"></div>
          <div class="translation">翻译功能即将接入</div>
        </div>
      </section>
    `;

    panel = shadow.querySelector(".window");
    sourceText = shadow.querySelector(".source");

    const close = shadow.querySelector(".close");
    close.addEventListener("pointerdown", (event) => event.preventDefault());
    close.addEventListener("click", hide);

    (document.body || document.documentElement).appendChild(host);
  }

  function isTextControl(element) {
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    return /^(text|search|url|tel|email)$/i.test(element.type);
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

  function show(selection) {
    ensureUi();
    sourceText.textContent = selection.text;
    panel.hidden = false;
    placePanel(selection.rect);
  }

  function hide() {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = 0;
    }
    if (panel) panel.hidden = true;
  }

  function scheduleOpen() {
    if (openTimer) clearTimeout(openTimer);
    openTimer = window.setTimeout(() => {
      openTimer = 0;
      const selection = readSelection();
      if (selection) show(selection);
      else hide();
    }, OPEN_DELAY);
  }

  document.addEventListener("pointerdown", (event) => {
    if (host && event.composedPath().includes(host)) return;
    pointerSelecting = true;
    hide();
  }, true);

  document.addEventListener("pointerup", (event) => {
    if (host && event.composedPath().includes(host)) return;
    pointerSelecting = false;
    scheduleOpen();
  }, true);

  document.addEventListener("pointercancel", () => {
    pointerSelecting = false;
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
    if (event.shiftKey || event.key === "Shift") scheduleOpen();
  }, true);

  window.addEventListener("blur", () => {
    pointerSelecting = false;
    hide();
  });
  window.addEventListener("resize", hide);
  document.addEventListener("scroll", hide, true);
})();
