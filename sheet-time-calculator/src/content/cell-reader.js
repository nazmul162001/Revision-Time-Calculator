"use strict";

/**
 * SheetAdapter
 * -------------
 * All Google Sheets DOM knowledge lives here.
 *
 * The grid itself is a canvas. Cell text is not in the DOM, so this module
 * does not query td elements or generated class names for cell contents.
 *
 * After Sheets handles a click it updates two stable controls:
 *   1. The name box (#t-name-box / input.waffle-name-box) — active address.
 *   2. The formula bar (#t-formula-bar-input / .cell-input) — entered value.
 *
 * Reading order:
 *   1. Accessibility label on a real gridcell, when Sheets exposes one.
 *   2. Name box + formula bar.
 *
 * The formula bar shows what was typed, or the formula text. It does not show
 * the calculated result of a formula. This module never copies the clipboard
 * and never guesses a value it cannot see.
 */

import { isGoogleSheets } from "./sheet-detector.js";

const NAME_BOX_SELECTORS = Object.freeze([
  "#t-name-box",
  "input.waffle-name-box",
  'input[aria-label="Name Box"]',
  'input[aria-label="Name box"]',
]);

const FORMULA_BAR_SELECTORS = Object.freeze([
  "#t-formula-bar-input",
  "#waffle-formula-bar .cell-input",
  ".waffle-formula-bar .cell-input",
  '[aria-label="Formula bar"]',
  '[aria-label="Formula Bar"]',
]);

const ACTIVE_TAB_SELECTORS = Object.freeze([
  ".docs-sheet-active-tab .docs-sheet-tab-name",
  ".docs-sheet-tab.docs-sheet-active-tab .docs-sheet-tab-name",
  '#sheet-tab-bar [aria-selected="true"]',
]);

const GRID_SELECTORS = Object.freeze([
  "#waffle-grid-container",
  ".grid4-inner-container",
  "#docs-editor",
]);

const TAB_BAR_SELECTORS = Object.freeze([
  "#sheet-tab-bar",
  ".docs-sheet-tab-bar",
  ".docs-sheet-container",
]);

const BLOCKED_CLICK_SELECTORS = [
  "#t-name-box",
  "#t-formula-bar-input",
  ".waffle-formula-bar",
  ".docs-sheet-tab",
  ".docs-sheet-tab-bar",
  ".docs-sheet-container",
  ".goog-menu",
  ".docs-material-menu",
  "#docs-menubar",
  "#docs-toolbar-wrapper",
  "#formula-bar",
].join(", ");

/**
 * @typedef {Object} ActiveCellInfo
 * @property {string} sheetName
 * @property {string} sheetId
 * @property {string} cellAddress
 * @property {string} rawValue
 * @property {number} row
 * @property {number} column
 * @property {"aria" | "formula-bar"} source
 * @property {string | null} readError
 */

export const SheetAdapter = Object.freeze({
  isGoogleSheets,
  getActiveCell,
  getCellValue,
  getCurrentSheetName,
  getCurrentSheetId,
  getSheetKey,
  isGridTarget,
  findTabBar,
});

/**
 * @returns {ActiveCellInfo | null}
 */
export function getActiveCell() {
  try {
    const address = readActiveAddress();
    if (!address) {
      return null;
    }

    const sheetName = getCurrentSheetName();
    const sheetId = getCurrentSheetId() || sheetName || "sheet";
    const ariaValue = readAriaCellValue(address.cellAddress);
    const formulaValue = getCellValue();
    const usedAria = ariaValue != null && !looksLikeFormula(ariaValue);
    const rawValue = usedAria ? ariaValue : formulaValue;

    /** @type {ActiveCellInfo} */
    const info = {
      sheetName: sheetName || "Sheet",
      sheetId,
      cellAddress: address.cellAddress,
      rawValue: rawValue == null ? "" : rawValue,
      row: address.row,
      column: address.column,
      source: usedAria ? "aria" : "formula-bar",
      readError: null,
    };

    if (rawValue == null) {
      info.readError = "no-value";
    } else if (!usedAria && looksLikeFormula(rawValue)) {
      info.readError = "formula";
    }

    return info;
  } catch {
    return null;
  }
}

/**
 * Displayed or entered text of the active cell, from the formula bar.
 * Returns null when the formula bar cannot be found.
 *
 * @returns {string | null}
 */
export function getCellValue() {
  const node = queryFirst(FORMULA_BAR_SELECTORS);
  if (!node) {
    return null;
  }
  return cleanCellText(readElementText(node));
}

/**
 * @returns {string}
 */
export function getCurrentSheetName() {
  const node = queryFirst(ACTIVE_TAB_SELECTORS);
  const text = node ? cleanCellText(node.textContent || "") : "";
  return text;
}

/**
 * Google Sheets puts the numeric sheet id in the URL hash: #gid=123.
 *
 * @returns {string}
 */
export function getCurrentSheetId() {
  try {
    const hash = globalThis.location?.hash || "";
    const match = /(?:^|[&#])gid=(\d+)/.exec(hash);
    if (match) {
      return match[1];
    }
    const search = globalThis.location?.search || "";
    const query = /(?:^|[?&])gid=(\d+)/.exec(search);
    return query ? query[1] : "";
  } catch {
    return "";
  }
}

/**
 * Identity used to detect a sheet change. Prefers the gid, then the tab name.
 *
 * @returns {string}
 */
export function getSheetKey() {
  const id = getCurrentSheetId();
  const name = getCurrentSheetName();
  if (id && name) {
    return `${id}:${name}`;
  }
  return id || name || "";
}

/**
 * True when the event landed on the grid canvas rather than chrome,
 * the formula bar, sheet tabs, or a menu.
 *
 * @param {Event} event
 * @returns {boolean}
 */
export function isGridTarget(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.closest(BLOCKED_CLICK_SELECTORS)) {
    return false;
  }
  if (target.closest("input, textarea, select, [contenteditable='true']")) {
    return false;
  }
  if (target.tagName === "CANVAS" || target.closest("canvas")) {
    return true;
  }
  return Boolean(target.closest(GRID_SELECTORS.join(", ")));
}

/**
 * Small subtree used to notice sheet-tab changes. Null if Sheets has not
 * rendered the tab strip yet.
 *
 * @returns {Element | null}
 */
export function findTabBar() {
  return queryFirst(TAB_BAR_SELECTORS);
}

/**
 * @param {string} input
 * @returns {{ cellAddress: string, column: number, row: number } | null}
 */
export function parseCellAddress(input) {
  if (!input) {
    return null;
  }
  let text = String(input).trim();
  const bang = text.lastIndexOf("!");
  if (bang !== -1) {
    text = text.slice(bang + 1);
  }
  text = text.replace(/\$/g, "").trim();
  const match = /^([A-Z]+)(\d+)$/i.exec(text);
  if (!match) {
    return null;
  }
  const row = Number(match[2]);
  if (!Number.isSafeInteger(row) || row < 1) {
    return null;
  }
  const letters = match[1].toUpperCase();
  return {
    cellAddress: letters + String(row),
    column: columnLettersToIndex(letters),
    row,
  };
}

/**
 * @param {string} letters
 * @returns {number}
 */
export function columnLettersToIndex(letters) {
  let index = 0;
  const upper = String(letters).toUpperCase();
  for (let i = 0; i < upper.length; i += 1) {
    const code = upper.charCodeAt(i);
    if (code < 65 || code > 90) {
      return 0;
    }
    index = index * 26 + (code - 64);
  }
  return index;
}

/**
 * @returns {{ cellAddress: string, column: number, row: number } | null}
 */
function readActiveAddress() {
  const fromAria = readAriaAddress();
  if (fromAria) {
    return fromAria;
  }
  const nameBox = queryFirst(NAME_BOX_SELECTORS);
  if (!nameBox) {
    return null;
  }
  const value = "value" in nameBox ? String(nameBox.value || "") : (nameBox.textContent || "");
  return parseCellAddress(value);
}

/**
 * Some Sheets accessibility modes expose the active cell as a gridcell.
 * The canvas grid usually does not. This is attempted first and ignored
 * when it is absent.
 *
 * @returns {{ cellAddress: string, column: number, row: number } | null}
 */
function readAriaAddress() {
  const selected = document.querySelector('[role="gridcell"][aria-selected="true"]');
  if (!selected) {
    return null;
  }
  const label = selected.getAttribute("aria-label") || "";
  const match = /\b([A-Z]+\d+)\b/.exec(label);
  return match ? parseCellAddress(match[1]) : null;
}

/**
 * @param {string} cellAddress
 * @returns {string | null}
 */
function readAriaCellValue(cellAddress) {
  const selected = document.querySelector('[role="gridcell"][aria-selected="true"]');
  if (!selected) {
    return null;
  }
  const label = selected.getAttribute("aria-label") || "";
  if (!label.includes(cellAddress)) {
    return null;
  }
  const text = cleanCellText(selected.textContent || "");
  if (!text || text === cellAddress) {
    return null;
  }
  return text;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeFormula(value) {
  return String(value).trim().startsWith("=");
}

/**
 * @param {Element} node
 * @returns {string}
 */
function readElementText(node) {
  if ("value" in node && typeof node.value === "string" && node.tagName === "INPUT") {
    return node.value;
  }
  return node.innerText || node.textContent || "";
}

/**
 * @param {string} value
 * @returns {string}
 */
function cleanCellText(value) {
  return String(value).replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * @param {readonly string[]} selectors
 * @returns {Element | null}
 */
function queryFirst(selectors) {
  for (const selector of selectors) {
    try {
      const node = document.querySelector(selector);
      if (node) {
        return node;
      }
    } catch {
      // A future Sheets build may make a selector invalid. Skip it.
    }
  }
  return null;
}
