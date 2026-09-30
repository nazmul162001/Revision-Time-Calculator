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
  let watchedSheetKey = "";
  let statusText = "";
  let statusTone = "";
  let statusTimer = 0;
  let saveTimer = 0;
  let toggleToken = 0;
  /** @type {{ label: string, raw: string } | null} */
  let pointerBefore = null;

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
    watchedSheetKey = SheetAdapter.getCurrentSheetId() || "sheet";
    render();
    reportState(true);
  }

  function deactivate() {
    mode = EXTENSION_MODES.INACTIVE;
    minimized = false;
    unbindGrid();
    window.clearTimeout(statusTimer);
    window.clearTimeout(saveTimer);
    toggleToken += 1;
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

  /** @type {{ stopLoop: () => void, attempt: (finalAttempt: boolean) => boolean } | null} */
  let pendingClick = null;

  /**
   * Snapshot the formula bar before Sheets handles the press.
   * Ordinary clicks return immediately and never touch the sheet.
   *
   * @param {PointerEvent} event
   */
  function onPointerDown(event) {
    if (mode !== EXTENSION_MODES.ACTIVE || event.button !== 0) {
      return;
    }
    if (!isSelectionModifier(event, platform.mac)) {
      return;
    }
    if (eventHitsPanel(event) || !SheetAdapter.isGridTarget(event)) {
      return;
    }
    finishPendingClick();
    pointerBefore = SheetAdapter.readGridSnapshot();
  }

  /**
   * Capture phase runs after the earlier pointerdown, when Sheets has
   * usually already written the new value. Only Ctrl/Cmd+click reads it.
   *
   * @param {MouseEvent} event
   */
  function onGridClick(event) {
    if (mode !== EXTENSION_MODES.ACTIVE || event.button !== 0) {
      return;
    }
    if (!isSelectionModifier(event, platform.mac)) {
      return;
    }
    if (eventHitsPanel(event) || !SheetAdapter.isGridTarget(event)) {
      return;
    }
    const token = (toggleToken += 1);
    const before = pointerBefore || { label: "", raw: "" };
    pointerBefore = null;
    readClickedValue(token, before);
  }

  /**
   * @param {Event} event
   */
  function eventHitsPanel(event) {
    const host = panel?.host;
    if (!host) {
      return false;
    }
    const path = event.composedPath();
    for (let i = 0; i < path.length; i += 1) {
      if (path[i] === host) {
        return true;
      }
    }
    return false;
  }

  /**
   * Read the formula bar now. If Sheets has already written the new value,
   * paint it in this same turn. A few frames follow only when the bar is
   * still the previous cell or a two-cell range.
   *
   * @param {number} token
   * @param {{ label: string, raw: string }} before
   */
  function readClickedValue(token, before) {
    let focused = false;
    let settled = false;
    let framesOn = true;
    const beforeAddress = cellAddressFromLabel(before.label);

    /**
     * @param {boolean} finalAttempt
     * @param {boolean} [allowSameCell]
     * @returns {boolean} true when this click is finished
     */
    const attempt = (finalAttempt, allowSameCell = false) => {
      if (settled || token !== toggleToken || mode !== EXTENSION_MODES.ACTIVE) {
        return true;
      }
      let snap = SheetAdapter.readGridSnapshot();
      let named = SheetAdapter.parseSelectionLabel(snap.label);
      if (named?.kind === "range" && !focused) {
        const target = SheetAdapter.clickedCellAddress(snap.label, beforeAddress);
        if (target) {
          SheetAdapter.focusCell(target);
          focused = true;
          snap = SheetAdapter.readGridSnapshot();
          named = SheetAdapter.parseSelectionLabel(snap.label);
        }
      }
      if (!named || named.kind !== "cell") {
        if (!finalAttempt) {
          return false;
        }
        settled = true;
        framesOn = false;
        pendingClick = null;
        setStatus("Could not read this cell.", "error");
        render();
        return true;
      }

      const moved = Boolean(beforeAddress) && named.cellAddress !== beforeAddress;
      const valueChanged = snap.raw !== before.raw;
      if (!finalAttempt) {
        if (!snap.raw || (beforeAddress && !moved) || (moved && !valueChanged)) {
          return false;
        }
      } else if (!moved && !allowSameCell) {
        settled = true;
        framesOn = false;
        pendingClick = null;
        return true;
      } else if (focused && named.cellAddress === beforeAddress) {
        settled = true;
        framesOn = false;
        pendingClick = null;
        setStatus("Could not read this cell.", "error");
        render();
        return true;
      }

      settled = true;
      framesOn = false;
      pendingClick = null;
      applyToggle({
        sheetName: "",
        sheetId: SheetAdapter.getCurrentSheetId() || "sheet",
        cellAddress: named.cellAddress,
        rawValue: snap.raw,
        row: named.row,
        column: named.column,
        source: "formula-bar",
        readError: snap.raw ? (snap.raw.trim().startsWith("=") ? "formula" : null) : "no-value",
      });
      return true;
    };

    pendingClick = {
      stopLoop() {
        framesOn = false;
      },
      attempt,
    };

    if (attempt(false)) {
      return;
    }
    queueMicrotask(() => {
      if (!framesOn || settled) {
        return;
      }
      if (attempt(false)) {
        return;
      }
      let frame = 0;
      const step = () => {
        if (!framesOn || settled) {
          return;
        }
        frame += 1;
        if (!attempt(frame >= 3, true)) {
          requestAnimationFrame(step);
        }
      };
      requestAnimationFrame(step);
    });
  }

  function finishPendingClick() {
    const job = pendingClick;
    if (!job) {
      return;
    }
    pendingClick = null;
    job.stopLoop();
    job.attempt(true, false);
  }

  /**
   * @param {string} label
   * @returns {string}
   */
  function cellAddressFromLabel(label) {
    const named = SheetAdapter.parseSelectionLabel(label);
    return named?.kind === "cell" ? named.cellAddress : "";
  }

  /**
   * @param {import("./cell-reader.js").ActiveCellInfo} info
   */
  function applyToggle(info) {
    const sheetChanged = syncSheet();

    if (info.readError === "no-value") {
      setStatus(sheetChanged
        ? "Switched sheets. Previous selection was cleared."
        : "Could not read this cell.", sheetChanged ? "warn" : "error");
      render();
      return;
    }

    const parsed = parseTimeToMinutes(info.rawValue);

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

    selection.toggle({
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
    } else if (parsed.status === "invalid") {
      setStatus(parsed.message || "Invalid time format.", "warn");
    } else {
      setStatus("", "");
    }
    render();
  }

  /**
   * @returns {boolean} true when an existing selection belonged to another sheet
   */
  function syncSheet() {
    const nextKey = SheetAdapter.getCurrentSheetId() || "sheet";
    const changed = Boolean(watchedSheetKey) && nextKey !== watchedSheetKey && selection.list().length > 0;
    watchedSheetKey = nextKey;
    if (!changed) {
      return false;
    }
    selection.clear();
    return true;
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
      case "copy-report":
        await copyAndFlash("copy-report", buildReport());
        break;
      default:
        break;
    }
  }

  async function addToRevision() {
    const minutes = currentTotal();
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setStatus("Add a time before sending it to Revision.", "warn");
      render();
      return;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.REVISION_MINUTES]: {
        minutes,
        requestedAt: Date.now(),
      },
    });
    const opened = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.OPEN_REVISION,
      url: REVISION_REPORT_URL,
      minutes,
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
    const sheetName = selection.list()[0]?.sheetName || "Sheet";
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
    const total = sumMinutes(items.map((item) => (
      item.parse.status === "ok" ? item.parse.totalMinutes : null
    )));
    panel.update({
      mode: mode === EXTENSION_MODES.PAUSED ? "paused" : "active",
      minimized,
      hint: platform.hint,
      items: items.map(toPanelItem),
      totalMinutes: total,
      hoursLabel: formatHoursMinutes(total),
      invalidCount: items.filter((item) => item.parse.status !== "ok").length,
      statusText,
      statusTone,
    });
  }

  /**
   * @param {import("./selection-manager.js").SelectionEntry} item
   */
  function toPanelItem(item) {
    const ok = item.parse.status === "ok";
    return {
      key: item.key,
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