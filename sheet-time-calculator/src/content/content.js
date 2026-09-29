"use strict";

import {
  CELL_READ_DELAYS_MS,
  EXTENSION_MODES,
  MESSAGE_TYPES,
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
import { SheetAdapter } from "./cell-reader.js";
import { copyText } from "./clipboard.js";
import { createFloatingPanel } from "./floating-panel.js";
import { detectPlatform, isSelectionModifier } from "./platform.js";
import { createSelectionManager, selectionKey } from "./selection-manager.js";
import { isGoogleSheets } from "./sheet-detector.js";
import { parseTimeToMinutes, shouldKeepInvalid } from "./time-parser.js";

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
  let sheetObserver = null;
  let watchedSheetKey = "";
  let candidate = null;
  let statusText = "";
  let statusTone = "";
  let statusTimer = 0;
  let saveTimer = 0;
  let toggleToken = 0;
  let candidateToken = 0;

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
    watchSheet();
    render();
    reportState(true);
  }

  function deactivate() {
    mode = EXTENSION_MODES.INACTIVE;
    minimized = false;
    unbindGrid();
    unwatchSheet();
    window.clearTimeout(statusTimer);
    window.clearTimeout(saveTimer);
    toggleToken += 1;
    candidateToken += 1;
    selection.clear();
    candidate = null;
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
    document.addEventListener("click", onGridClick, true);
    gridBound = true;
  }

  function unbindGrid() {
    if (!gridBound) {
      return;
    }
    document.removeEventListener("click", onGridClick, true);
    gridBound = false;
  }

  /**
   * @param {MouseEvent} event
   */
  function onGridClick(event) {
    if (mode !== EXTENSION_MODES.ACTIVE || event.button !== 0) {
      return;
    }
    if (panel?.host && event.composedPath().includes(panel.host)) {
      return;
    }
    if (!SheetAdapter.isGridTarget(event)) {
      return;
    }
    ensureSheetWatch();

    if (isSelectionModifier(event, platform.mac)) {
      scheduleRead("toggle");
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    scheduleRead("candidate");
  }

  /**
   * @param {"toggle" | "candidate"} kind
   */
  function scheduleRead(kind) {
    const token = kind === "toggle" ? (toggleToken += 1) : (candidateToken += 1);
    readAfterSheetsUpdates(token, kind).catch(() => {
      setStatus("Could not read this cell.", "error");
      render();
    });
  }

  /**
   * @param {number} token
   * @param {"toggle" | "candidate"} kind
   */
  async function readAfterSheetsUpdates(token, kind) {
    let latest = null;
    for (const step of CELL_READ_DELAYS_MS) {
      await wait(step);
      if (!isCurrentRead(token, kind)) {
        return;
      }
      const info = SheetAdapter.getActiveCell();
      if (info?.cellAddress) {
        latest = info;
      }
    }
    if (!isCurrentRead(token, kind)) {
      return;
    }
    if (!latest) {
      setStatus("Could not read this cell.", "error");
      render();
      return;
    }
    if (kind === "toggle") {
      applyToggle(latest);
    } else {
      setCandidate(latest);
    }
  }

  /**
   * @param {number} token
   * @param {"toggle" | "candidate"} kind
   */
  function isCurrentRead(token, kind) {
    const current = kind === "toggle" ? toggleToken : candidateToken;
    return token === current && mode === EXTENSION_MODES.ACTIVE;
  }

  /**
   * @param {import("./cell-reader.js").ActiveCellInfo} info
   */
  function applyToggle(info) {
    const sheetChanged = syncSheet();

    if (info.readError === "no-value") {
      setCandidate(info);
      setStatus(sheetChanged
        ? "Switched sheets. Previous selection was cleared."
        : "Could not read this cell.", sheetChanged ? "warn" : "error");
      render();
      return;
    }

    const parsed = parseTimeToMinutes(info.rawValue);
    setCandidate(info, parsed);

    if (parsed.status === "ignore") {
      setStatus(sheetChanged
        ? "Switched sheets. Previous selection was cleared."
        : "Empty cell skipped.", sheetChanged ? "warn" : "info");
      render();
      return;
    }
    if (parsed.status === "unreadable" || (parsed.status === "invalid" && !shouldKeepInvalid(parsed))) {
      setStatus(
        sheetChanged
          ? "Switched sheets. Previous selection was cleared."
          : (parsed.message || "Could not read this cell."),
        "warn",
      );
      render();
      return;
    }

    const result = selection.toggle({
      key: selectionKey(info.sheetId, info.cellAddress),
      sheetId: info.sheetId,
      sheetName: info.sheetName,
      cellAddress: info.cellAddress,
      rawValue: parsed.raw || info.rawValue,
      row: info.row,
      column: info.column,
      parse: parsed,
    });

    if (sheetChanged) {
      setStatus("Switched sheets. Previous selection was cleared.", "warn");
    } else if (result.action === "removed") {
      setStatus(`${info.cellAddress} removed.`, "info");
    } else if (parsed.status === "invalid") {
      setStatus(parsed.message || "Invalid time format.", "warn");
    } else {
      setStatus("", "");
    }
    render();
  }

  /**
   * @param {import("./cell-reader.js").ActiveCellInfo} info
   * @param {import("./time-parser.js").ParseResult} [parsed]
   */
  function setCandidate(info, parsed) {
    candidate = {
      info,
      parsed: parsed || parseTimeToMinutes(info.rawValue),
    };
  }

  /**
   * @returns {boolean} true when an existing selection belonged to another sheet
   */
  function syncSheet() {
    const nextKey = SheetAdapter.getSheetKey();
    if (!nextKey) {
      return false;
    }
    const changed = Boolean(watchedSheetKey) && nextKey !== watchedSheetKey && selection.list().length > 0;
    watchedSheetKey = nextKey;
    if (!changed) {
      return false;
    }
    selection.clear();
    candidate = null;
    return true;
  }

  function watchSheet() {
    unwatchSheet();
    const bar = SheetAdapter.findTabBar();
    watchedSheetKey = SheetAdapter.getSheetKey();
    if (!bar) {
      return;
    }
    sheetObserver = new MutationObserver(() => {
      const next = SheetAdapter.getSheetKey();
      if (!next || next === watchedSheetKey) {
        return;
      }
      watchedSheetKey = next;
      if (!selection.list().length) {
        render();
        return;
      }
      selection.clear();
      candidate = null;
      setStatus("Switched sheets. Selection cleared.", "warn");
      render();
    });
    sheetObserver.observe(bar, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "aria-selected"],
    });
  }

  function ensureSheetWatch() {
    if (!sheetObserver) {
      watchSheet();
    }
  }

  function unwatchSheet() {
    sheetObserver?.disconnect();
    sheetObserver = null;
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
      case "copy-report":
        await copyAndFlash("copy-report", buildReport());
        break;
      default:
        break;
    }
  }

  function addActive() {
    if (mode !== EXTENSION_MODES.ACTIVE) {
      setStatus("Selection mode is paused.", "info");
      render();
      return;
    }
    const info = SheetAdapter.getActiveCell();
    if (!info?.cellAddress) {
      setStatus("Could not read this cell.", "error");
      render();
      return;
    }
    applyToggle(info);
  }

  function currentTotal() {
    return sumMinutes(selection.list().map((item) => (
      item.parse.status === "ok" ? item.parse.totalMinutes : null
    )));
  }

  function buildReport() {
    const items = selection.list().map((item) => ({
      cellAddress: item.cellAddress,
      rawValue: item.rawValue,
      detail: item.parse.status === "ok"
        ? formatHoursMinutes(item.parse.totalMinutes || 0)
        : (item.parse.message || "invalid"),
    }));
    const sheetName = selection.list()[0]?.sheetName || SheetAdapter.getCurrentSheetName() || "Sheet";
    return formatReport({
      sheetName,
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
    const total = currentTotal();
    panel.update({
      mode: mode === EXTENSION_MODES.PAUSED ? "paused" : "active",
      minimized,
      sheetName: SheetAdapter.getCurrentSheetName() || items[0]?.sheetName || "Sheet",
      hint: platform.hint,
      candidateText: formatCandidate(),
      items: items.map(toPanelItem),
      totalMinutes: total,
      hoursLabel: formatHoursMinutes(total),
      decimalLabel: formatDecimalHours(total),
      invalidCount: items.filter((item) => item.parse.status !== "ok").length,
      statusText,
      statusTone,
    });
  }

  function formatCandidate() {
    if (!candidate?.info) {
      return "No active cell yet";
    }
    const { info, parsed } = candidate;
    if (!parsed || parsed.status === "ignore") {
      return `${info.cellAddress}  empty`;
    }
    if (parsed.status === "ok") {
      return `${info.cellAddress}  ${parsed.raw} → ${formatHoursMinutes(parsed.totalMinutes || 0)}`;
    }
    return `${info.cellAddress}  ${parsed.message || info.rawValue || "Could not read this cell."}`;
  }

  /**
   * @param {import("./selection-manager.js").SelectionEntry} item
   */
  function toPanelItem(item) {
    const ok = item.parse.status === "ok";
    return {
      key: item.key,
      cellAddress: item.cellAddress,
      rawValue: item.rawValue,
      parsedLabel: ok ? formatHoursMinutes(item.parse.totalMinutes || 0) : "",
      invalid: !ok,
      message: item.parse.message || "Invalid time format",
    };
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

/**
 * @param {number} ms
 */
function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
