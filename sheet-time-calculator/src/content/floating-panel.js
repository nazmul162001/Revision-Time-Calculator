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
 * @property {string} decimalLabel
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
    if (typeof prefs.width === "number") {
      panel.style.width = `${prefs.width}px`;
    }
    if (typeof prefs.height === "number") {
      panel.style.height = `${prefs.height}px`;
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

    setText(panel, "[data-field='sheet']", next.sheetName || "Sheet");
    setText(panel, "[data-field='mode']", next.mode === "active" ? "Selection live" : "Selection off");
    panel.querySelector(".stc-pip")?.classList.toggle("is-on", next.mode === "active");
    setText(panel, "[data-field='hint']", next.hint);
    setText(panel, "[data-field='empty']", "Nothing selected yet.");
    setText(panel, "[data-field='candidate']", next.candidateText || "No active cell yet");

    const pause = panel.querySelector(".stc-pause");
    if (pause) {
      const paused = next.mode === "paused";
      pause.textContent = paused ? "Resume" : "Pause";
      pause.setAttribute("aria-pressed", paused ? "true" : "false");
      pause.dataset.action = paused ? "resume" : "pause";
    }

    const count = panel.querySelector("[data-field='count']");
    if (count) {
      count.textContent = String(next.items.length);
    }

    renderItems(next.items);
    setText(panel, "[data-field='minutes']", `${next.totalMinutes} minutes`);
    setText(panel, "[data-field='hours']", next.hoursLabel);
    setText(panel, "[data-field='decimal']", `${next.decimalLabel} decimal hours`);

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
  function renderItems(items) {
    const list = panel.querySelector("[data-field='list']");
    const empty = panel.querySelector("[data-field='empty']");
    if (!list || !empty) {
      return;
    }
    const scroll = list.scrollTop;
    list.replaceChildren();
    empty.hidden = items.length !== 0;
    list.hidden = items.length === 0;

    for (const item of items) {
      const row = document.createElement("li");
      row.className = item.invalid ? "stc-item is-invalid" : "stc-item";

      const body = document.createElement("div");
      body.className = "stc-item-body";

      const top = document.createElement("div");
      top.className = "stc-item-top";
      const address = document.createElement("span");
      address.className = "stc-address";
      address.textContent = item.cellAddress;
      const raw = document.createElement("span");
      raw.className = "stc-raw";
      raw.textContent = item.rawValue;
      top.append(address, raw);

      const detail = document.createElement("div");
      detail.className = "stc-detail";
      detail.textContent = item.invalid ? item.message : `${item.rawValue} → ${item.parsedLabel}`;

      body.append(top, detail);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "stc-icon-button";
      remove.dataset.action = "remove";
      remove.dataset.key = item.key;
      remove.setAttribute("aria-label", `Remove ${item.cellAddress}`);
      remove.textContent = "×";

      row.append(body, remove);
      list.append(row);
    }
    list.scrollTop = scroll;
  }

  /**
   * @param {string} action
   * @param {string} label
   */
  function flash(action, label) {
    const button = panel.querySelector(`[data-action='${action}']`);
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const original = button.dataset.label || button.textContent || "";
    button.dataset.label = original;
    button.textContent = label;
    button.classList.add("is-copied");
    const timer = window.setTimeout(() => {
      button.textContent = original;
      button.classList.remove("is-copied");
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
          <div class="stc-subtitle"><span data-field="sheet">Sheet</span> · <span data-field="mode">Selection live</span></div>
        </div>
      </div>
      <div class="stc-header-actions">
        <button type="button" class="stc-text-button stc-pause" data-action="pause" aria-pressed="false">Pause</button>
        <button type="button" class="stc-icon-button" data-action="minimize" aria-label="Minimize calculator">×</button>
      </div>
    </header>
    <div class="stc-body">
      <p class="stc-hint" data-field="hint"></p>
      <button type="button" class="stc-add" data-action="add-active">Add active cell</button>
      <div class="stc-candidate" data-field="candidate">No active cell yet</div>
      <div class="stc-section-label">Selected <span data-field="count">0</span></div>
      <p class="stc-empty" data-field="empty"></p>
      <ul class="stc-list" data-field="list" hidden></ul>
      <p class="stc-invalid" data-field="invalid" hidden></p>
      <div class="stc-total">
        <div class="stc-kicker">Total minutes</div>
        <div class="stc-minutes" data-field="minutes">0 minutes</div>
        <div class="stc-hours" data-field="hours">0h 0m</div>
        <div class="stc-decimal"><span data-field="decimal">0.00 decimal hours</span></div>
      </div>
      <div class="stc-copies">
        <button type="button" class="stc-primary" data-action="copy-minutes">Copy Minutes</button>
        <button type="button" class="stc-primary" data-action="copy-time">Copy Time</button>
        <button type="button" class="stc-ghost" data-action="copy-report">Copy Report</button>
      </div>
      <p class="stc-status" data-field="status" role="status" hidden></p>
      <div class="stc-footer">
        <button type="button" class="stc-text-button" data-action="clear">Clear All</button>
        <button type="button" class="stc-stop" data-action="stop">Stop</button>
      </div>
    </div>
  `;
  const hintNode = panel.querySelector("[data-field='hint']");
  const emptyNode = panel.querySelector("[data-field='empty']");
  if (hintNode) {
    hintNode.textContent = hint;
  }
  if (emptyNode) {
    emptyNode.textContent = "Nothing selected yet.";
  }
  return panel;
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
    .stc-panel { width: 320px; background: #080d12; color: #d7ffe9; font: 13px/1.4 ui-monospace, monospace; border: 1px solid #3effb0; border-radius: 12px; pointer-events: auto; }
    .stc-header, .stc-footer, .stc-copies { display: flex; gap: 8px; justify-content: space-between; }
    button { font: inherit; }
  `;
}
