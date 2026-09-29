"use strict";

import { DECIMAL_HOUR_PLACES } from "../shared/constants.js";

/**
 * Sum integer minutes. Non-numeric entries are skipped so one bad value
 * cannot break the total.
 *
 * @param {Array<number | null | undefined>} minuteValues
 * @returns {number}
 */
export function sumMinutes(minuteValues) {
  let total = 0;
  if (!Array.isArray(minuteValues)) {
    return 0;
  }
  for (const value of minuteValues) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    total += value;
  }
  return total;
}

/**
 * @param {number} totalMinutes
 * @returns {{ hours: number, minutes: number }}
 */
export function minutesToHoursMinutes(totalMinutes) {
  const safe = normalizeMinutes(totalMinutes);
  const hours = Math.trunc(safe / 60);
  const minutes = safe - hours * 60;
  return { hours, minutes };
}

/**
 * Decimal hours are totalMinutes / 60. They are not HH.MM.
 * 135 minutes → 2.25, never 2.15.
 *
 * @param {number} totalMinutes
 * @returns {number}
 */
export function minutesToDecimalHours(totalMinutes) {
  return normalizeMinutes(totalMinutes) / 60;
}

/**
 * @param {number} totalMinutes
 * @returns {string} Example: "2h 15m"
 */
export function formatHoursMinutes(totalMinutes) {
  const { hours, minutes } = minutesToHoursMinutes(totalMinutes);
  return `${hours}h ${minutes}m`;
}

/**
 * @param {number} totalMinutes
 * @returns {string} Example: "2.25"
 */
export function formatDecimalHours(totalMinutes) {
  return minutesToDecimalHours(totalMinutes).toFixed(DECIMAL_HOUR_PLACES);
}

/**
 * Primary clipboard format. Minutes come first because that is what gets submitted.
 *
 * @param {number} totalMinutes
 * @returns {string} Example: "236 minutes (3.93 hours)"
 */
export function formatCopyTime(totalMinutes) {
  const safe = normalizeMinutes(totalMinutes);
  return `${safe} minutes (${formatDecimalHours(safe)} hours)`;
}

/**
 * @param {{
 *   sheetName: string,
 *   items: Array<{ cellAddress: string, rawValue: string, detail: string }>,
 *   totalMinutes: number,
 * }} report
 * @returns {string}
 */
export function formatReport(report) {
  const lines = [
    `Sheet: ${report.sheetName || "Unknown"}`,
    "",
    "Selected cells:",
  ];

  if (!report.items.length) {
    lines.push("(none)");
  } else {
    for (const item of report.items) {
      lines.push(`${item.cellAddress} = ${item.rawValue} (${item.detail})`);
    }
  }

  lines.push(
    "",
    "Total:",
    formatCopyTime(report.totalMinutes),
    "",
    "Decimal:",
    `${formatDecimalHours(report.totalMinutes)} hours`,
  );

  return lines.join("\n");
}

/**
 * @param {number} totalMinutes
 * @returns {number}
 */
function normalizeMinutes(totalMinutes) {
  if (typeof totalMinutes !== "number" || !Number.isFinite(totalMinutes)) {
    return 0;
  }
  return Math.trunc(totalMinutes);
}
