"use strict";

/**
 * @typedef {Object} ParseResult
 * @property {"ok" | "invalid" | "ignore" | "unreadable"} status
 * @property {string} raw
 * @property {number} [hours]
 * @property {number} [minutes]
 * @property {number} [totalMinutes]
 * @property {boolean} [padded]
 * @property {"minutes" | "text" | "negative" | "empty" | "formula"} [kind]
 * @property {string} [message]
 */

const TIME_PATTERN = /^(\d{1,6})(?:\.(\d{1,2}))?$/;

/**
 * Parse a spreadsheet cell as HH.MM, not as decimal hours.
 *
 * The digits after the decimal point are minutes:
 *   "3.13" → 3 hours 13 minutes
 *   "0.08" → 8 minutes
 *   "1"    → 1 hour
 *
 * Google Sheets stores these as numbers and drops a trailing zero, so a
 * typed 0.50 is shown as 0.5 and a typed 0.10 is shown as 0.1. A single
 * fractional digit is therefore the tens digit:
 *   "0.5" → 50 minutes
 *   "0.1" → 10 minutes
 *   "2.4" → 2 hours 40 minutes
 *
 * Two fractional digits are used as written. This matches the source sheet,
 * where 5 minutes is entered as 0.05 (not 0.5).
 *
 * A minute part of 60 or more is real time and is carried into hours:
 *   "0.67" → 67 minutes → 1h 7m
 *   "1.75" → 1h 75m → 2h 15m
 *
 * @param {unknown} value
 * @returns {ParseResult}
 */
export function parseTimeToMinutes(value) {
  if (value == null) {
    return ignore("");
  }

  const raw = String(value).replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, " ").trim();
  if (!raw) {
    return ignore(raw);
  }

  if (raw.startsWith("=")) {
    return {
      status: "unreadable",
      raw,
      kind: "formula",
      message: "Could not read this cell. The formula bar shows a formula, not the calculated time.",
    };
  }

  if (raw.startsWith("-")) {
    return {
      status: "invalid",
      raw,
      kind: "negative",
      message: `Negative time is not supported: ${raw}`,
    };
  }

  const normalized = raw.replace(/^(\d{1,6}),(\d{1,2})$/, "$1.$2");
  const match = TIME_PATTERN.exec(normalized);
  if (!match) {
    return {
      status: "invalid",
      raw,
      kind: "text",
      message: `Not a time value: ${raw}`,
    };
  }

  let hours = Number(match[1]);
  const fraction = match[2];
  let minutes = 0;
  let padded = false;

  if (fraction != null) {
    if (fraction.length === 1) {
      minutes = Number(fraction) * 10;
      padded = true;
    } else {
      minutes = Number(fraction);
    }
  }

  if (!Number.isSafeInteger(hours) || !Number.isSafeInteger(minutes)) {
    return invalidFormat(raw);
  }

  if (minutes >= 60) {
    hours += Math.floor(minutes / 60);
    minutes %= 60;
  }

  return {
    status: "ok",
    raw,
    hours,
    minutes,
    padded,
    totalMinutes: hours * 60 + minutes,
  };
}

/**
 * True when an invalid value still looks like a time the user tried to enter,
 * so it should stay visible in the selection list.
 *
 * @param {ParseResult} result
 */
export function shouldKeepInvalid(result) {
  return result.status === "invalid" && (result.kind === "minutes" || result.kind === "negative");
}

/**
 * @param {string} raw
 * @returns {ParseResult}
 */
function ignore(raw) {
  return { status: "ignore", raw, kind: "empty" };
}

/**
 * @param {string} raw
 * @returns {ParseResult}
 */
function invalidFormat(raw) {
  return {
    status: "invalid",
    raw,
    kind: "text",
    message: `Invalid time format: ${raw}`,
  };
}
