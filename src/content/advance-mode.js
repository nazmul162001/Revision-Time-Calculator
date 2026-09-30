"use strict";

import { formatDecimalHours } from "./calculator.js";
import { parseTimeToMinutes } from "./time-parser.js";

const MAX_ROWS = 30;

const HOUR_KEYS = Object.freeze({
  "man-hours": "revision",
  "man hours": "revision",
  "fb hours": "feedback",
  "fb-hours": "feedback",
  "check hours": "checking",
  "check-hours": "checking",
});

/**
 * @param {string} input
 * @returns {{ rows: number[] } | { tooWide: true } | null}
 */
export function parseRowSelection(input) {
  if (!input) {
    return null;
  }
  let text = String(input).trim();
  const bang = text.lastIndexOf("!");
  if (bang !== -1) {
    text = text.slice(bang + 1);
  }
  text = text.replace(/\$/g, "").replace(/\s/g, "");
  const match = /^(\d+):(\d+)$/.exec(text);
  if (!match) {
    return null;
  }
  let start = Number(match[1]);
  let end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1) {
    return null;
  }
  if (end < start) {
    const swap = start;
    start = end;
    end = swap;
  }
  if (end - start + 1 > MAX_ROWS) {
    return { tooWide: true };
  }
  const rows = [];
  for (let row = start; row <= end; row += 1) {
    rows.push(row);
  }
  return { rows };
}

/**
 * One copied sheet row. Quoted fields can contain tabs and line breaks.
 *
 * @param {unknown} input
 * @returns {string[]}
 */
export function parseTsvRow(input) {
  const text = String(input || "").replace(/^\uFEFF/, "");
  /** @type {string[]} */
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "\t") {
      cells.push(current);
      current = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      break;
    }
    current += char;
  }
  if (current.length || cells.length) {
    cells.push(current);
  }
  return cells;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeName(value) {
  return String(value || "")
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, " ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whole-name match. "Nazmul" matches "Nazmul" and "Nazmul Ahmed".
 * A shorter fragment such as "Naz" does not match "Nazmul".
 *
 * @param {unknown} cellText
 * @param {unknown} query
 */
export function nameMatches(cellText, query) {
  const cell = normalizeName(cellText);
  const needle = normalizeName(query);
  if (!cell || !needle) {
    return false;
  }
  if (cell === needle || cell.startsWith(`${needle} `)) {
    return true;
  }
  const cellWords = cell.split(/[^a-z0-9\u0080-\uffff]+/).filter(Boolean);
  const queryWords = needle.split(/[^a-z0-9\u0080-\uffff]+/).filter(Boolean);
  return cellWords.includes(needle) || queryWords.includes(cell);
}

/**
 * After each cell that matches the name, skip the next column and add the
 * three hour columns beside it: revision, feedback, then checking.
 *
 * @param {string[]} cells
 * @param {string} query
 * @returns {{ revision: number, feedback: number, checking: number, matches: number }}
 */
export function hoursBesideName(cells, query) {
  const totals = { revision: 0, feedback: 0, checking: 0, matches: 0 };
  const list = Array.isArray(cells) ? cells : [];
  for (let index = 0; index < list.length; index += 1) {
    if (!nameMatches(list[index], query)) {
      continue;
    }
    totals.matches += 1;
    totals.revision += minutesFromCell(list[index + 2]);
    totals.feedback += minutesFromCell(list[index + 3]);
    totals.checking += minutesFromCell(list[index + 4]);
  }
  return totals;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeHeader(value) {
  return String(value || "")
    .replace(/[\u00a0]/g, " ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string[]} headers
 * @returns {{ engineer1: EngineerGroup | null, engineer2: EngineerGroup | null } | null}
 */
export function findEngineerColumns(headers) {
  const norm = headers.map(normalizeHeader);
  /** @type {EngineerGroup | null} */
  let engineer1 = null;
  /** @type {EngineerGroup | null} */
  let engineer2 = null;
  for (let index = 0; index < norm.length; index += 1) {
    const role = engineerRole(norm[index]);
    if (!role) {
      continue;
    }
    const hours = tripletAfter(norm, index);
    if (!hours) {
      continue;
    }
    const group = { nameIndex: index, hours };
    if (role === "engineer1") {
      engineer1 = group;
    } else {
      engineer2 = group;
    }
  }
  if (!engineer1 && !engineer2) {
    return null;
  }
  return { engineer1, engineer2 };
}

/**
 * @param {number} index 1-based column
 * @returns {string}
 */
export function columnIndexToLetters(index) {
  let n = index;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * @param {number} minutes
 * @returns {string}
 */
export function formatAdvanceTotal(minutes) {
  const total = Number(minutes) || 0;
  if (total <= 0) {
    return "0 min";
  }
  return `${total} min · ${formatDecimalHours(total)} hours`;
}

/**
 * Loaded only while Advance Mode is on.
 *
 * @param {{
 *   readNameBox: () => string,
 *   readRowText: (row: number) => Promise<string>,
 *   onChange: (state: AdvanceView) => void,
 * }} deps
 */
export function createAdvanceSession(deps) {
  let generation = 0;
  let alive = true;
  let phase = "idle";
  let query = "";
  /** @type {number[]} */
  const selected = [];
  /** @type {Set<number>} */
  const seen = new Set();
  const totals = { revision: 0, feedback: 0, checking: 0 };
  let tail = Promise.resolve();

  /**
   * @param {() => Promise<void> | void} job
   */
  function enqueue(job) {
    const run = tail.then(() => job(), () => job());
    tail = run.then(() => {}, () => {});
    return run;
  }

  /**
   * @param {{ phase?: string, note?: string, error?: string }} extra
   */
  function emit(extra) {
    if (!alive) {
      return;
    }
    if (extra.phase) {
      phase = extra.phase;
    }
    const sum = totals.revision + totals.feedback + totals.checking;
    deps.onChange({
      phase,
      note: extra.note || "",
      error: extra.error || "",
      revision: formatAdvanceTotal(totals.revision),
      feedback: formatAdvanceTotal(totals.feedback),
      checking: formatAdvanceTotal(totals.checking),
      ready: sum > 0 && phase === "result",
    });
  }

  /**
   * @param {string} name
   */
  function start(name) {
    query = normalizeName(name);
    if (!query) {
      emit({ phase: "idle", error: "Enter your name." });
      return;
    }
    generation += 1;
    selected.length = 0;
    seen.clear();
    totals.revision = 0;
    totals.feedback = 0;
    totals.checking = 0;
    emit({ phase: "selecting", note: "Select row numbers", error: "" });
  }

  function onSheetClick() {
    if (!alive || !query || (phase !== "selecting" && phase !== "result")) {
      return;
    }
    const parsed = parseRowSelection(deps.readNameBox());
    if (parsed) {
      rememberRows(parsed);
      return;
    }
    requestAnimationFrame(() => {
      if (!alive || (phase !== "selecting" && phase !== "result")) {
        return;
      }
      const later = parseRowSelection(deps.readNameBox());
      if (later) {
        rememberRows(later);
      }
    });
  }

  /**
   * Remember row numbers only. The sheet is not read until Calculate.
   *
   * @param {{ rows: number[] } | { tooWide: true }} parsed
   */
  function rememberRows(parsed) {
    if ("tooWide" in parsed) {
      emit({ phase: "selecting", note: "Select one row, or up to 30.", error: "" });
      return;
    }
    let added = false;
    for (let i = 0; i < parsed.rows.length; i += 1) {
      const row = parsed.rows[i];
      if (selected.includes(row) || selected.length >= MAX_ROWS) {
        continue;
      }
      selected.push(row);
      added = true;
    }
    if (!added) {
      return;
    }
    emit({ phase: "selecting", note: selectionNote(), error: "" });
  }

  function calculate() {
    if (!alive || !query || phase === "calculating") {
      return;
    }
    if (!selected.length) {
      emit({ phase: "selecting", note: "Select a row number first.", error: "" });
      return;
    }
    const token = ++generation;
    emit({ phase: "calculating", note: "", error: "" });
    enqueue(() => runCalculate(token));
  }

  /**
   * @param {number} token
   */
  async function runCalculate(token) {
    totals.revision = 0;
    totals.feedback = 0;
    totals.checking = 0;
    seen.clear();
    let readable = false;
    let matches = 0;
    for (let i = 0; i < selected.length; i += 1) {
      if (!current(token)) {
        return;
      }
      const row = selected[i];
      if (seen.has(row)) {
        continue;
      }
      seen.add(row);
      const text = await deps.readRowText(row);
      if (!current(token)) {
        return;
      }
      if (text.includes("\t")) {
        readable = true;
      }
      const part = hoursBesideName(parseTsvRow(text), query);
      matches += part.matches;
      totals.revision += part.revision;
      totals.feedback += part.feedback;
      totals.checking += part.checking;
    }
    if (!current(token)) {
      return;
    }
    if (!readable) {
      emit({
        phase: "selecting",
        note: selectionNote(),
        error: "Could not read the selected rows.",
      });
      return;
    }
    const sum = totals.revision + totals.feedback + totals.checking;
    let note = "";
    if (matches === 0) {
      note = "That name was not on the selected rows.";
    } else if (sum <= 0) {
      note = "No hours beside that name.";
    }
    emit({
      phase: "result",
      note,
      error: "",
    });
  }

  /**
   * @returns {string}
   */
  function selectionNote() {
    if (!selected.length) {
      return "Select row numbers";
    }
    if (selected.length > 12) {
      return `${selected.length} rows selected`;
    }
    return `Rows ${selected.join(", ")}`;
  }

  function entries() {
    /** @type {{ category: string, minutes: number }[]} */
    const list = [];
    if (totals.revision > 0) {
      list.push({ category: "Revision", minutes: totals.revision });
    }
    if (totals.feedback > 0) {
      list.push({ category: "Feedback Response", minutes: totals.feedback });
    }
    if (totals.checking > 0) {
      list.push({ category: "Review", minutes: totals.checking });
    }
    return list;
  }

  function stop() {
    alive = false;
    generation += 1;
    phase = "idle";
  }

  /**
   * @param {number} token
   */
  function current(token) {
    return alive && token === generation;
  }

  return { start, onSheetClick, calculate, entries, stop };
}

/**
 * @param {string} raw
 * @returns {number}
 */
function minutesFromCell(raw) {
  const parsed = parseTimeToMinutes(raw);
  if (parsed.status === "ok") {
    return parsed.totalMinutes || 0;
  }
  return 0;
}

/**
 * The three hour columns after an engineer name. The task column is skipped
 * because its header is not one of these hour labels.
 *
 * @param {string[]} headers
 * @param {number} nameIndex
 * @returns {{ revision: number, feedback: number, checking: number } | null}
 */
function tripletAfter(headers, nameIndex) {
  /** @type {{ key: string, index: number }[]} */
  const found = [];
  const end = Math.min(headers.length - 1, nameIndex + 8);
  for (let index = nameIndex + 1; index <= end; index += 1) {
    const key = hourRole(headers[index]);
    if (key) {
      found.push({ key, index });
    }
  }
  const revision = found.find((item) => item.key === "revision");
  const feedback = found.find((item) => item.key === "feedback");
  const checking = found.find((item) => item.key === "checking");
  if (!revision || !feedback || !checking) {
    return null;
  }
  return {
    revision: revision.index,
    feedback: feedback.index,
    checking: checking.index,
  };
}

/**
 * @param {string} label
 * @returns {"engineer1" | "engineer2" | ""}
 */
function engineerRole(label) {
  const compact = String(label || "").replace(/[^a-z0-9]/g, "");
  if (compact === "engineer1" || compact === "engineer2") {
    return compact;
  }
  return "";
}

/**
 * @param {string} label
 * @returns {"revision" | "feedback" | "checking" | ""}
 */
function hourRole(label) {
  const known = HOUR_KEYS[label];
  if (known) {
    return known;
  }
  const compact = String(label || "").replace(/[^a-z]/g, "");
  if (compact === "manhours" || compact === "manhour") {
    return "revision";
  }
  if (compact === "fbhours" || compact === "fbhour") {
    return "feedback";
  }
  if (compact === "checkhours" || compact === "checkhour") {
    return "checking";
  }
  return "";
}

/**
 * @typedef {Object} EngineerGroup
 * @property {number} nameIndex
 * @property {{ revision: number, feedback: number, checking: number }} hours
 */

/**
 * @typedef {Object} ColumnMap
 * @property {string} key
 * @property {number} headerRow
 * @property {EngineerGroup | null} engineer1
 * @property {EngineerGroup | null} engineer2
 */

/**
 * @typedef {Object} AdvanceView
 * @property {string} phase
 * @property {string} note
 * @property {string} error
 * @property {string} revision
 * @property {string} feedback
 * @property {string} checking
 * @property {boolean} ready
 */
