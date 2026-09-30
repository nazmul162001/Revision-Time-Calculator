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

/** @type {Element | null} */
let cachedNameBox = null;
/** @type {Element | null} */
let cachedFormulaBar = null;

/**
 * Name box and formula bar are stable inputs. Keep the nodes so a click
 * does not search the spreadsheet document again.
 *
 * @returns {Element | null}
 */
function nameBoxElement() {
  if (cachedNameBox?.isConnected) {
    return cachedNameBox;
  }
  cachedNameBox = document.getElementById("t-name-box") || queryFirst(NAME_BOX_SELECTORS);
  return cachedNameBox;
}

/**
 * @returns {Element | null}
 */
function formulaBarElement() {
  if (cachedFormulaBar?.isConnected) {
    return cachedFormulaBar;
  }
  cachedFormulaBar = document.getElementById("t-formula-bar-input") || queryFirst(FORMULA_BAR_SELECTORS);
  return cachedFormulaBar;
}

/**
 * The two strings a click needs: name-box label and formula-bar text.
 * No sheet tab lookup and no accessibility-tree walk.
 *
 * @returns {{ label: string, raw: string }}
 */
export function readGridSnapshot() {
  const nameBox = nameBoxElement();
  const formula = formulaBarElement();
  return {
    label: nameBox ? readElementText(nameBox).trim() : "",
    raw: formula ? cleanCellText(readElementText(formula)) : "",
  };
}

export const SheetAdapter = Object.freeze({
  isGoogleSheets,
  getActiveCell,
  getCellValue,
  readGridSnapshot,
  readNameBoxText,
  parseSelectionLabel,
  clickedCellAddress,
  focusCell,
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
    const snap = readGridSnapshot();
    const named = parseSelectionLabel(snap.label);
    if (!named || named.kind !== "cell") {
      return null;
    }

    /** @type {ActiveCellInfo} */
    const info = {
      sheetName: "",
      sheetId: getCurrentSheetId() || "sheet",
      cellAddress: named.cellAddress,
      rawValue: snap.raw,
      row: named.row,
      column: named.column,
      source: "formula-bar",
      readError: null,
    };

    if (!snap.raw) {
      info.readError = "no-value";
    } else if (looksLikeFormula(snap.raw)) {
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
  const node = formulaBarElement();
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
  if (target.tagName === "CANVAS") {
    return true;
  }
  const grid = document.getElementById("waffle-grid-container");
  if (grid?.contains(target)) {
    return !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement);
  }
  if (target.closest(BLOCKED_CLICK_SELECTORS)) {
    return false;
  }
  if (target.closest("input, textarea, select, [contenteditable='true']")) {
    return false;
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
  const fromNameBox = parseSelectionLabel(readNameBoxText());
  if (fromNameBox?.kind === "cell") {
    return fromNameBox;
  }
  return null;
}

/**
 * Raw name-box text, including a range such as "M644:M645".
 *
 * @returns {string}
 */
export function readNameBoxText() {
  const nameBox = nameBoxElement();
  if (!nameBox) {
    return "";
  }
  return readElementText(nameBox).trim();
}

/**
 * A single cell, or the two corners of a name-box range.
 * Sheets writes a vertical drag from M644 onto M645 as "M644:M645".
 *
 * @param {string} input
 * @returns {{ kind: "cell", cellAddress: string, column: number, row: number }
 *   | { kind: "range", start: { cellAddress: string, column: number, row: number }, end: { cellAddress: string, column: number, row: number } }
 *   | null}
 */
export function parseSelectionLabel(input) {
  if (!input) {
    return null;
  }
  let text = String(input).trim();
  const bang = text.lastIndexOf("!");
  if (bang !== -1) {
    text = text.slice(bang + 1);
  }
  text = text.replace(/\$/g, "").trim();
  const range = /^([A-Z]+\d+)\s*:\s*([A-Z]+\d+)$/i.exec(text);
  if (range) {
    const start = parseCellAddress(range[1]);
    const end = parseCellAddress(range[2]);
    if (!start || !end) {
      return null;
    }
    return { kind: "range", start, end };
  }
  const cell = parseCellAddress(text);
  return cell ? { kind: "cell", ...cell } : null;
}

/**
 * Which cell a click was aiming at. A press on the row under the active cell
 * often lands in the name box as "M644:M645"; the new cell is the other corner.
 *
 * @param {string} label
 * @param {string} beforeAddress
 * @returns {string}
 */
export function clickedCellAddress(label, beforeAddress) {
  const named = parseSelectionLabel(label);
  if (!named) {
    return "";
  }
  if (named.kind === "cell") {
    return named.cellAddress;
  }
  const start = named.start.cellAddress;
  const end = named.end.cellAddress;
  if (beforeAddress && start === beforeAddress && end !== beforeAddress) {
    return end;
  }
  if (beforeAddress && end === beforeAddress && start !== beforeAddress) {
    return start;
  }
  return end;
}

/**
 * Move the Sheets selection to one cell. Used when a click on the next row
 * leaves the name box on a two-cell range, so the formula bar still shows
 * the previous cell.
 *
 * @param {string} address
 * @returns {boolean}
 */
export function focusCell(address) {
  const nameBox = nameBoxElement();
  if (!(nameBox instanceof HTMLInputElement) || !address) {
    return false;
  }
  try {
    nameBox.focus();
    nameBox.select();
    const inserted = document.execCommand("insertText", false, address);
    if (!inserted) {
      nameBox.value = address;
      nameBox.dispatchEvent(new Event("input", { bubbles: true }));
    }
    nameBox.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));
    nameBox.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  } catch {
    return false;
  }
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
