"use strict";

import { COPY_FEEDBACK_MS, PANEL_DEFAULTS, ROOT_ID } from "../shared/constants.js";

/**
 * @typedef {Object} PanelItem
 * @property {string} key
 * @property {string} cellAddress
 * @property {string} rawValue
 * @property {string} parsedLabel
 * @property {boolean} invalid
 * @property {string} message
 */

/**
 * @typedef {Object} PanelView
 * @property {"active" | "paused"} mode
 * @property {boolean} minimized
 * @property {string} sheetName
 * @property {string} hint
 * @property {string} candidateText
 * @property {PanelItem[]} items
 * @property {number} totalMinutes
 * @property {string} hoursLabel
 * @property {number} invalidCount
 * @property {string} statusText
 * @property {"info" | "warn" | "error" | ""} statusTone
 */

/**
 * Shadow-DOM calculator. Page styles cannot leak in, and closed mode keeps
 * the panel's internals off the page's element tree.
 *
 * @param {{
 *   platform: { hint: string },
 *   loadStyles: () => Promise<CSSStyleSheet | string>,
 *   onAction: (name: string, detail?: string) => void,
 *   onPrefs: (prefs: { left: number, top: number, width: number, height: number }) => void,
 *   prefs: { left?: number | null, top?: number | null, width?: number | null, height?: number | null } | null,
 * }} options
 */
export async function createFloatingPanel(options) {
  const host = document.createElement("div");
  host.id = ROOT_ID;
  host.style.position = "fixed";
  host.style.zIndex = "2147483000";
  host.style.pointerEvents = "none";
  host.style.right = `${PANEL_DEFAULTS.margin}px`;
  host.style.bottom = `${PANEL_DEFAULTS.margin}px`;

  const shadow = host.attachShadow({ mode: "closed" });
  try {
    const styles = await options.loadStyles();
    if (typeof CSSStyleSheet !== "undefined" && styles instanceof CSSStyleSheet) {
      shadow.adoptedStyleSheets = [styles];
    } else if (typeof styles === "string") {
      const tag = document.createElement("style");
      tag.textContent = styles;
      shadow.append(tag);
    }
  } catch {
    const tag = document.createElement("style");
    tag.textContent = fallbackCss();
    shadow.append(tag);
  }

  const panel = buildPanel(options.platform.hint);
  const chip = buildChip();
  shadow.append(panel, chip);

  /** @type {PanelView | null} */
  let view = null;
  let minimized = false;
  /** @type {number[]} */
  const feedbackTimers = [];
  /** @type {{ dx: number, dy: number } | null} */
  let drag = null;

  applyPrefs(options.prefs);

  panel.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const control = target.closest("[data-action]");
    if (!(control instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    options.onAction(control.dataset.action || "", control.dataset.key || "");
  });

  shadow.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      options.onAction("minimize");
    }
  });

  const header = panel.querySelector(".stc-header");
  header?.addEventListener("pointerdown", (event) => {
    if (!(event instanceof PointerEvent)) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest("button")) {
      return;
    }
    const rect = host.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    header.setPointerCapture(event.pointerId);
  });

  header?.addEventListener("pointermove", (event) => {
    if (!drag || !(event instanceof PointerEvent)) {
      return;
    }
    const width = host.offsetWidth || PANEL_DEFAULTS.width;
    const height = host.offsetHeight || 200;
    const left = clamp(event.clientX - drag.dx, 8, window.innerWidth - Math.min(width, 120));
    const top = clamp(event.clientY - drag.dy, 8, window.innerHeight - 48);
    place(left, top);
  });

  header?.addEventListener("pointerup", () => {
    if (!drag) {
      return;
    }
    drag = null;
    publishPrefs();
  });

  chip.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const control = target.closest("[data-action]");
    if (!(control instanceof HTMLElement)) {
      return;
    }
    options.onAction(control.dataset.action || "restore");
  });

  const resizeObserver = new ResizeObserver(() => {
    if (!minimized) {
      publishPrefs();
    }
  });
  resizeObserver.observe(panel);

  function place(left, top) {
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
  }

  function applyPrefs(prefs) {
    if (!prefs) {
      return;
    }
    if (typeof prefs.width === "number" && prefs.width >= 460) {
      panel.style.width = `${Math.min(prefs.width, 720)}px`;
    }
    if (typeof prefs.left === "number" && typeof prefs.top === "number") {
      place(prefs.left, prefs.top);
    }
  }

  function publishPrefs() {
    if (minimized || panel.offsetWidth < 200 || panel.offsetHeight < 160) {
      return;
    }
    const rect = host.getBoundingClientRect();
    options.onPrefs({
      left: rect.left,
      top: rect.top,
      width: panel.offsetWidth,
      height: panel.offsetHeight,
    });
  }

  /**
   * @param {PanelView} next
   */
  function update(next) {
    view = next;
    minimized = next.minimized;
    host.hidden = false;
    panel.hidden = minimized;
    chip.hidden = !minimized;
    if (minimized) {
      const chipText = chip.querySelector(".stc-chip-text");
      if (chipText) {
        chipText.textContent = next.mode === "active" ? `STC  ${next.totalMinutes}m` : "STC  paused";
      }
      return;
    }

    const paused = next.mode === "paused";
    setText(panel, "[data-field='sheet']", next.sheetName || "Sheet");
    setText(panel, "[data-field='mode']", paused ? "Paused" : next.hint);
    panel.querySelector(".stc-pip")?.classList.toggle("is-on", !paused);

    const candidate = panel.querySelector("[data-field='candidate']");
    if (candidate) {
      const text = next.candidateText && next.candidateText !== "No active cell yet" ? next.candidateText : "";
      candidate.hidden = !text;
      candidate.textContent = text;
    }

    renderExpression(next.items);
    renderItems(next.items);
    setText(panel, "[data-field='minutes']", String(next.totalMinutes));
    setText(panel, "[data-field='hours']", next.hoursLabel);

    const invalid = panel.querySelector("[data-field='invalid']");
    if (invalid) {
      invalid.hidden = next.invalidCount === 0;
      invalid.textContent = next.invalidCount === 1
        ? "1 invalid value excluded from the total"
        : `${next.invalidCount} invalid values excluded from the total`;
    }

    const status = panel.querySelector("[data-field='status']");
    if (status) {
      status.textContent = next.statusText || "";
      status.dataset.tone = next.statusTone || "";
      status.hidden = !next.statusText;
    }
  }

  /**
   * @param {PanelItem[]} items
   */
  function renderExpression(items) {
    const expr = panel.querySelector("[data-field='expr']");
    if (!expr) {
      return;
    }
    expr.replaceChildren();
    if (!items.length) {
      const zero = document.createElement("span");
      zero.className = "stc-term is-zero";
      zero.textContent = "0";
      expr.append(zero);
      return;
    }
    items.forEach((item, index) => {
      if (index > 0) {
        const plus = document.createElement("span");
        plus.className = "stc-plus";
        plus.textContent = "+";
        expr.append(plus);
      }
      const term = document.createElement("span");
      term.className = item.invalid ? "stc-term is-invalid" : "stc-term";
      term.textContent = item.rawValue;
      term.title = item.invalid
        ? `${item.cellAddress}: ${item.message}`
        : `${item.cellAddress} → ${item.parsedLabel}`;
      expr.append(term);
    });
  }

  /**
   * @param {PanelItem[]} items
   */
  function renderItems(items) {
    const list = panel.querySelector("[data-field='list']");
    if (!list) {
      return;
    }
    list.replaceChildren();
    list.hidden = items.length === 0;

    for (const item of items) {
      const row = document.createElement("li");
      row.className = item.invalid ? "stc-token is-invalid" : "stc-token";
      row.title = item.invalid ? item.message : `${item.rawValue} → ${item.parsedLabel}`;

      const address = document.createElement("span");
      address.className = "stc-address";
      address.textContent = item.cellAddress;

      const raw = document.createElement("span");
      raw.className = "stc-raw";
      raw.textContent = item.rawValue;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "stc-token-x";
      remove.dataset.action = "remove";
      remove.dataset.key = item.key;
      remove.setAttribute("aria-label", `Remove ${item.cellAddress}`);
      remove.textContent = "×";

      row.append(address, raw, remove);
      list.append(row);
    }
  }

  /**
   * @param {string} action
   * @param {string} label
   */
  function flash(action, label) {
    const button = panel.querySelector(`[data-action='${action}']`);
    const status = panel.querySelector("[data-field='status']");
    if (button instanceof HTMLButtonElement) {
      button.classList.add("is-copied");
    }
    if (status) {
      status.hidden = false;
      status.dataset.tone = label === "Copied!" ? "info" : "error";
      status.textContent = label;
    }
    const timer = window.setTimeout(() => {
      button?.classList.remove("is-copied");
      if (status && status.textContent === label) {
        status.hidden = true;
        status.textContent = "";
      }
    }, COPY_FEEDBACK_MS);
    feedbackTimers.push(timer);
  }

  return {
    host,
    /**
     * @param {ParentNode} [parent]
     */
    mount(parent = document.body) {
      if (!host.isConnected) {
        parent.append(host);
      }
    },
    /**
     * @param {PanelView} next
     */
    update,
    /**
     * @param {string} action
     * @param {string} label
     */
    flash,
    destroy() {
      resizeObserver.disconnect();
      for (const timer of feedbackTimers) {
        window.clearTimeout(timer);
      }
      host.remove();
    },
  };
}

/**
 * @param {string} hint
 */
function buildPanel(hint) {
  const panel = document.createElement("section");
  panel.className = "stc-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Sheet Time Calculator");

  panel.innerHTML = `
    <header class="stc-header">
      <div class="stc-brand">
        <span class="stc-pip is-on" aria-hidden="true"></span>
        <div>
          <div class="stc-title">Sheet Time Calculator</div>
          <div class="stc-subtitle"><span data-field="sheet">Sheet</span> · <span data-field="mode"></span></div>
        </div>
      </div>
    </header>
    <div class="stc-body">
      <div class="stc-lcd" aria-live="polite">
        <div class="stc-expr" data-field="expr"></div>
        <div class="stc-readout"><span data-field="minutes">0</span><span class="stc-unit">minutes</span></div>
        <div class="stc-meta"><span data-field="hours">0h 0m</span></div>
      </div>
      <p class="stc-candidate" data-field="candidate" hidden></p>
      <ul class="stc-tokens" data-field="list" hidden></ul>
      <p class="stc-invalid" data-field="invalid" hidden></p>
      <div class="stc-tools">
        <button type="button" class="stc-tool is-clear" data-action="clear" aria-label="Clear" title="Clear"></button>
        <button type="button" class="stc-tool is-close" data-action="stop" aria-label="Close" title="Close"></button>
        <button type="button" class="stc-tool is-copy" data-action="copy-time" aria-label="Copy" title="Copy"></button>
        <button type="button" class="stc-revision" data-action="add-revision">Add to Revision</button>
      </div>
      <p class="stc-status" data-field="status" role="status" hidden></p>
    </div>
  `;
  panel.querySelector("[data-action='clear']")?.append(svgIcon("reload"));
  panel.querySelector("[data-action='stop']")?.append(svgIcon("close"));
  panel.querySelector("[data-action='copy-time']")?.append(svgIcon("copy"));
  const modeNode = panel.querySelector("[data-field='mode']");
  if (modeNode) {
    modeNode.textContent = hint;
  }
  return panel;
}

/**
 * @param {string} name
 * @returns {SVGElement}
 */
function svgIcon(name) {
  const tones = {
    reload: ["#ff5ea8", "#7b5cff"],
    close: ["#ffe14a", "#ff7a1a"],
    copy: ["#5af0ff", "#3aa0ff"],
  };
  const strokes = {
    reload: ["M20 12a8 8 0 1 1-2.2-5.5", "M20 4v5h-5"],
    close: ["M7 7l10 10", "M17 7L7 17"],
    copy: [
      "M9 9h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z",
      "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
    ],
  };
  const [from, to] = tones[name] || tones.copy;
  const id = `stc-grad-${name}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${from}"/>
        <stop offset="1" stop-color="${to}"/>
      </linearGradient>
    </defs>
  `;
  for (const d of strokes[name] || strokes.copy) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", `url(#${id})`);
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}

function buildChip() {
  const chip = document.createElement("div");
  chip.className = "stc-chip";
  chip.hidden = true;
  const restore = document.createElement("button");
  restore.type = "button";
  restore.className = "stc-chip-text";
  restore.dataset.action = "restore";
  restore.textContent = "STC";
  restore.setAttribute("aria-label", "Restore Sheet Time Calculator");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "stc-chip-close";
  close.dataset.action = "stop";
  close.setAttribute("aria-label", "Stop Sheet Time Calculator");
  close.textContent = "×";
  chip.append(restore, close);
  return chip;
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @param {string} text
 */
function setText(root, selector, text) {
  const node = root.querySelector(selector);
  if (node) {
    node.textContent = text;
  }
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function fallbackCss() {
  return `
    .stc-panel { width: 520px; background: #1c1e22; color: #eceae6; font: 13px/1.4 system-ui, sans-serif; border-radius: 28px; pointer-events: auto; }
    .stc-header, .stc-footer, .stc-copies { display: flex; gap: 8px; justify-content: space-between; }
    button { font: inherit; }
  `;
}
