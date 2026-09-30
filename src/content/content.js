"use strict";

import {
  EXTENSION_MODES,
  MESSAGE_TYPES,
  REVISION_REPORT_URL,
  STATUS_CLEAR_MS,
  STORAGE_KEYS,
} from "../shared/constants.js";
import {
  formatCopyTime,
  formatDecimalHours,
  formatHoursMinutes,
  formatReport,
  sumMinutes,
} from "./calculator.js";
import { clickedCellAddress, focusCell, parseSelectionLabel } from "./cell-reader.js";
import { detectPlatform } from "./platform.js";
import { createSelectionManager } from "./selection-manager.js";
import { copyText } from "./clipboard.js";
import { createFloatingPanel } from "./floating-panel.js";
import { isGoogleSheets } from "./sheet-detector.js";
import { parseTimeToMinutes, shouldKeepInvalid } from "./time-parser.js";

const REPORT_CATEGORIES = Object.freeze({
  revision: Object.freeze({
    addLabel: "Add to Revision",
    field: "Revision",
    name: "Revision",
  }),
  feedback: Object.freeze({
    addLabel: "Add Feedback",
    field: "Feedback Response",
    name: "Feedback",
  }),
  checking: Object.freeze({
    addLabel: "Add Checking",
    field: "Review",
    name: "Checking",
  }),
});

const BOOTED = Symbol.for("sheet-time-calculator.booted");

if (globalThis.chrome?.runtime?.id && !globalThis[BOOTED] && isGoogleSheets()) {
  globalThis[BOOTED] = true;
  boot();
}

function boot() {
  const platform = detectPlatform();
  const selection = createSelectionManager();

  let mode = EXTENSION_MODES.INACTIVE;
  let minimized = false;
  let panel = null;
  let gridBound = false;
  let statusText = "";
  let statusTone = "";
  let statusTimer = 0;
  let saveTimer = 0;
  let categoryId = "revision";
  /** @type {Element | null} */
  let formulaNode = null;
  /** @type {Element | null} */
  let nameBoxNode = null;
  /** @type {Element | null} */
  let gridNode = null;
  /** @type {{ label: string, raw: string } | null} */
  let clickBefore = null;
  /** @type {{ x: number, y: number } | null} */
  let lastPoint = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then(() => sendResponse({ ok: true, mode }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  });

  /**
   * @param {{ type?: string }} message
   */
  async function handleMessage(message) {
    switch (message?.type) {
      case MESSAGE_TYPES.TOGGLE_EXTENSION:
        if (mode === EXTENSION_MODES.INACTIVE) {
          await activate();
        } else {
          deactivate();
        }
        break;
      case MESSAGE_TYPES.ACTIVATE:
        await activate();
        break;
      case MESSAGE_TYPES.DEACTIVATE:
        deactivate();
        break;
      case MESSAGE_TYPES.CLEAR_SELECTION:
        selection.clear();
        render();
        break;
      default:
        break;
    }
  }

  async function activate() {
    if (!isGoogleSheets()) {
      return;
    }
    if (!panel) {
      const prefs = await loadPrefs();
      panel = await createFloatingPanel({
        platform,
        prefs,
        loadStyles,
        onAction: (name, detail) => {
          handleAction(name, detail).catch(() => {
            setStatus("Something went wrong. Try that action again.", "error");
            render();
          });
        },
        onPrefs: queueSavePrefs,
      });
      panel.mount();
    }
    minimized = false;
    mode = EXTENSION_MODES.ACTIVE;
    bindGrid();
    render();
    reportState(true);
  }

  function deactivate() {
    mode = EXTENSION_MODES.INACTIVE;
    minimized = false;
    unbindGrid();
    window.clearTimeout(statusTimer);
    window.clearTimeout(saveTimer);
    selection.clear();
    statusText = "";
    statusTone = "";
    panel?.destroy();
    panel = null;
    reportState(false);
  }

  function pause() {
    if (mode !== EXTENSION_MODES.ACTIVE) {
      return;
    }
    mode = EXTENSION_MODES.PAUSED;
    unbindGrid();
    render();
  }

  function resume() {
    if (mode !== EXTENSION_MODES.PAUSED) {
      return;
    }
    mode = EXTENSION_MODES.ACTIVE;
    bindGrid();
    render();
  }

  function bindGrid() {
    if (gridBound) {
      return;
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onGridClick, true);
    gridBound = true;
  }

  function unbindGrid() {
    if (!gridBound) {
      return;
    }
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("click", onGridClick, true);
    gridBound = false;
  }

  /**
   * Remember the formula bar before Sheets handles the press.
   * A repeat click on the same cell can make Sheets show the previous cell.
   *
   * @param {PointerEvent} event
   */
  function onPointerDown(event) {
    if (!isAddClick(event)) {
      return;
    }
    clickBefore = {
      label: readNameBox(),
      raw: readFormulaText(),
    };
  }

  /**
   * @param {MouseEvent} event
   */
  function onGridClick(event) {
    if (!isAddClick(event)) {
      return;
    }
    const before = clickBefore || { label: "", raw: "" };
    clickBefore = null;
    const label = readNameBox();
    const raw = readFormulaText();
    if (isSameCellClick(before.label, label, event)) {
      rememberPoint(event);
      addRawValue(before.raw || raw);
      return;
    }
    if (raw && raw !== before.raw) {
      rememberPoint(event);
      addRawValue(raw);
      return;
    }
    const named = parseSelectionLabel(label);
    const beforeCell = singleCell(before.label);
    if (named?.kind === "range" && beforeCell) {
      const target = clickedCellAddress(label, beforeCell);
      if (target && target !== beforeCell) {
        focusCell(target);
        rememberPoint(event);
        requestAnimationFrame(() => {
          addRawValue(readFormulaText() || raw);
        });
        return;
      }
    }
    rememberPoint(event);
    addRawValue(raw || before.raw);
  }

  /**
   * A normal left click on the grid adds the time.
   * Shift and Alt stay with Google Sheets.
   *
   * @param {MouseEvent | PointerEvent} event
   */
  function isAddClick(event) {
    if (mode !== EXTENSION_MODES.ACTIVE || event.button !== 0) {
      return false;
    }
    if (event.shiftKey || event.altKey) {
      return false;
    }
    const host = panel?.host;
    if (host && event.target === host) {
      return false;
    }
    const target = event.target;
    return target instanceof Element && isGridClick(target);
  }

  /**
   * @param {string} beforeLabel
   * @param {string} nowLabel
   * @param {MouseEvent} event
   */
  function isSameCellClick(beforeLabel, nowLabel, event) {
    const beforeCell = singleCell(beforeLabel);
    const nowCell = singleCell(nowLabel);
    if (beforeCell && nowCell && beforeCell === nowCell) {
      return true;
    }
    if (lastPoint) {
      const dx = event.clientX - lastPoint.x;
      const dy = event.clientY - lastPoint.y;
      if (dx * dx + dy * dy <= 14 * 14) {
        return true;
      }
    }
    return false;
  }

  /**
   * @param {string} label
   * @returns {string}
   */
  function singleCell(label) {
    const named = parseSelectionLabel(label);
    return named?.kind === "cell" ? named.cellAddress : "";
  }

  /**
   * @param {MouseEvent} event
   */
  function rememberPoint(event) {
    lastPoint = { x: event.clientX, y: event.clientY };
  }

  /**
   * @param {Element} target
   */
  function isGridClick(target) {
    if (target.tagName === "CANVAS") {
      return true;
    }
    if (!gridNode?.isConnected) {
      gridNode = document.getElementById("waffle-grid-container");
    }
    return Boolean(gridNode && gridNode.contains(target));
  }

  /**
   * @returns {string}
   */
  function readFormulaText() {
    if (!formulaNode?.isConnected) {
      formulaNode = document.getElementById("t-formula-bar-input");
    }
    if (!formulaNode) {
      return "";
    }
    if ("value" in formulaNode && typeof formulaNode.value === "string") {
      return formulaNode.value.trim();
    }
    return (formulaNode.textContent || "").trim();
  }

  function readNameBox() {
    if (!nameBoxNode?.isConnected) {
      nameBoxNode = document.getElementById("t-name-box");
    }
    if (!nameBoxNode) {
      return "";
    }
    if ("value" in nameBoxNode && typeof nameBoxNode.value === "string") {
      return nameBoxNode.value.trim();
    }
    return (nameBoxNode.textContent || "").trim();
  }

  /**
   * @param {string} raw
   */
  function addRawValue(raw) {
    if (!raw) {
      return;
    }
    const parsed = parseTimeToMinutes(raw);
    if (parsed.status === "ignore") {
      return;
    }
    if (parsed.status === "unreadable" || (parsed.status === "invalid" && !shouldKeepInvalid(parsed))) {
      setStatus(parsed.message || "Could not read this value.", "warn");
      render();
      return;
    }
    selection.add(parsed.raw || raw, parsed);
    if (parsed.status === "invalid") {
      setStatus(parsed.message || "Invalid time format.", "warn");
    } else if (statusText) {
      setStatus("", "");
    }
    render();
  }

  /**
   * @param {string} name
   * @param {string} [key]
   */
  async function handleAction(name, key) {
    switch (name) {
      case "remove":
        selection.remove(key || "");
        render();
        break;
      case "clear":
        selection.clear();
        setStatus("Selection cleared.", "info");
        render();
        break;
      case "stop":
        deactivate();
        break;
      case "minimize":
        minimized = true;
        render();
        break;
      case "restore":
        minimized = false;
        render();
        break;
      case "pause":
        pause();
        break;
      case "resume":
        resume();
        break;
      case "add-active":
        addActive();
        break;
      case "copy-minutes":
        await copyAndFlash("copy-minutes", String(currentTotal()));
        break;
      case "copy-time":
        await copyAndFlash("copy-time", formatCopyTime(currentTotal()));
        break;
      case "add-revision":
        await addToRevision();
        break;
      case "category":
        if (Object.prototype.hasOwnProperty.call(REPORT_CATEGORIES, key || "")) {
          categoryId = key || "revision";
          render();
        }
        break;
      case "copy-report":
        await copyAndFlash("copy-report", buildReport());
        break;
      default:
        break;
    }
  }

  async function addToRevision() {
    const category = REPORT_CATEGORIES[categoryId] || REPORT_CATEGORIES.revision;
    const minutes = currentTotal();
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setStatus(`Add a time before sending it to ${category.name}.`, "warn");
      render();
      return;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.REVISION_MINUTES]: {
        minutes,
        category: category.field,
        requestedAt: Date.now(),
      },
    });
    const opened = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.OPEN_REVISION,
      url: REVISION_REPORT_URL,
      minutes,
      category: category.field,
    }).catch(() => null);
    if (!opened?.ok) {
      setStatus("Could not open the report page.", "error");
      render();
      return;
    }
    deactivate();
  }

  function addActive() {
    if (mode !== EXTENSION_MODES.ACTIVE) {
      setStatus("Selection mode is paused.", "info");
      render();
      return;
    }
    addRawValue(readFormulaText());
  }

  function currentTotal() {
    return sumMinutes(selection.list().map((item) => (
      item.parse.status === "ok" ? item.parse.totalMinutes : null
    )));
  }

  function buildReport() {
    const items = selection.list().map((item) => ({
      cellAddress: item.rawValue,
      rawValue: item.rawValue,
      detail: item.parse.status === "ok"
        ? formatHoursMinutes(item.parse.totalMinutes || 0)
        : (item.parse.message || "invalid"),
    }));
    return formatReport({
      sheetName: "",
      items,
      totalMinutes: currentTotal(),
    });
  }

  /**
   * @param {string} action
   * @param {string} text
   */
  async function copyAndFlash(action, text) {
    const copied = await copyText(text);
    panel?.flash(action, copied ? "Copied!" : "Copy failed");
  }

  function render() {
    if (!panel || mode === EXTENSION_MODES.INACTIVE) {
      return;
    }
    const items = selection.list();
    let total = 0;
    let invalidCount = 0;
    /** @type {Array<{ key: string, rawValue: string, parsedLabel: string, invalid: boolean, message: string }>} */
    const viewItems = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const ok = item.parse.status === "ok";
      if (ok) {
        total += item.parse.totalMinutes || 0;
      } else {
        invalidCount += 1;
      }
      viewItems.push({
        key: item.key,
        rawValue: item.rawValue,
        parsedLabel: ok ? formatHoursMinutes(item.parse.totalMinutes || 0) : "",
        invalid: !ok,
        message: item.parse.message || "Invalid time format",
      });
    }
    panel.update({
      mode: mode === EXTENSION_MODES.PAUSED ? "paused" : "active",
      minimized,
      hint: platform.hint,
      items: viewItems,
      totalMinutes: total,
      hoursLabel: `${formatDecimalHours(total)} hours`,
      invalidCount,
      statusText,
      statusTone,
      category: categoryId,
      addLabel: (REPORT_CATEGORIES[categoryId] || REPORT_CATEGORIES.revision).addLabel,
    });
  }

  /**
   * @param {string} text
   * @param {string} tone
   */
  function setStatus(text, tone) {
    statusText = text;
    statusTone = tone;
    window.clearTimeout(statusTimer);
    if (!text) {
      return;
    }
    statusTimer = window.setTimeout(() => {
      statusText = "";
      statusTone = "";
      render();
    }, STATUS_CLEAR_MS);
  }

  /**
   * @param {{ left: number, top: number, width: number, height: number }} next
   */
  function queueSavePrefs(next) {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      chrome.storage?.local?.set({ [STORAGE_KEYS.PANEL_PREFS]: next }).catch(() => {});
    }, 200);
  }

  async function loadPrefs() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.PANEL_PREFS);
      return stored[STORAGE_KEYS.PANEL_PREFS] || null;
    } catch {
      return null;
    }
  }

  async function loadStyles() {
    const url = chrome.runtime.getURL("src/content/styles.css");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Unable to load calculator styles.");
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(await response.text());
    return sheet;
  }

  /**
   * @param {boolean} active
   */
  function reportState(active) {
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.EXTENSION_STATE,
      active,
    }).catch(() => {});
  }
}