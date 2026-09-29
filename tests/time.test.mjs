import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCopyTime,
  formatDecimalHours,
  formatHoursMinutes,
  minutesToDecimalHours,
  sumMinutes,
} from "../src/content/calculator.js";
import { parseCellAddress } from "../src/content/cell-reader.js";
import { createSelectionManager, selectionKey } from "../src/content/selection-manager.js";
import { isGoogleSheets } from "../src/content/sheet-detector.js";
import { parseTimeToMinutes } from "../src/content/time-parser.js";

test("parses HH.MM spreadsheet values into integer minutes", () => {
  assert.equal(parseTimeToMinutes("3.13").totalMinutes, 193);
  assert.equal(parseTimeToMinutes("0.33").totalMinutes, 33);
  assert.equal(parseTimeToMinutes("0.17").totalMinutes, 17);
  assert.equal(parseTimeToMinutes("1.17").totalMinutes, 77);
  assert.equal(parseTimeToMinutes("2.08").totalMinutes, 128);
  assert.equal(parseTimeToMinutes("0").totalMinutes, 0);
  assert.equal(parseTimeToMinutes("1").totalMinutes, 60);
  assert.equal(parseTimeToMinutes("1.05").totalMinutes, 65);
  assert.equal(parseTimeToMinutes("1.59").totalMinutes, 119);
  assert.equal(parseTimeToMinutes("0.08").totalMinutes, 8);
  assert.equal(parseTimeToMinutes("0.03").totalMinutes, 3);
  assert.equal(parseTimeToMinutes("0.10").totalMinutes, 10);
  assert.equal(parseTimeToMinutes("  1.17  ").totalMinutes, 77);
  assert.equal(parseTimeToMinutes("1,17").totalMinutes, 77);
});

test("treats a single decimal digit as a dropped trailing zero", () => {
  assert.equal(parseTimeToMinutes("0.5").totalMinutes, 50);
  assert.equal(parseTimeToMinutes("0.1").totalMinutes, 10);
  assert.equal(parseTimeToMinutes("2.4").totalMinutes, 160);
  assert.equal(parseTimeToMinutes("1.0").totalMinutes, 60);
  assert.equal(parseTimeToMinutes("2.5").totalMinutes, 170);
});

test("rejects minutes of 60 or more and non-time text", () => {
  assert.equal(parseTimeToMinutes("1.60").status, "invalid");
  assert.equal(parseTimeToMinutes("1.75").status, "invalid");
  assert.equal(parseTimeToMinutes("0.75").status, "invalid");
  assert.equal(parseTimeToMinutes("1.75").message, "Invalid time format: 1.75");
  assert.equal(parseTimeToMinutes("abc").status, "invalid");
  assert.equal(parseTimeToMinutes("Completed").status, "invalid");
  assert.equal(parseTimeToMinutes("").status, "ignore");
  assert.equal(parseTimeToMinutes("   ").status, "ignore");
  assert.equal(parseTimeToMinutes("=H7+M7").status, "unreadable");
  assert.equal(parseTimeToMinutes("-1.17").status, "invalid");
});

test("sums minutes and formats every representation separately", () => {
  const minutes = ["1.17", "0.33", "0.25"].map((value) => parseTimeToMinutes(value).totalMinutes);
  assert.deepEqual(minutes, [77, 33, 25]);
  assert.equal(sumMinutes(minutes), 135);
  assert.equal(formatHoursMinutes(135), "2h 15m");
  assert.equal(minutesToDecimalHours(135), 2.25);
  assert.equal(formatDecimalHours(135), "2.25");
  assert.equal(formatCopyTime(135), "135 minutes (2h 15m)");
});

test("formats the product example as 145 minutes, 2h 25m, 2.42 decimal hours", () => {
  const total = sumMinutes(["1.17", "0.33", "0.25", "0.10"].map((value) => (
    parseTimeToMinutes(value).totalMinutes
  )));
  assert.equal(total, 145);
  assert.equal(formatHoursMinutes(total), "2h 25m");
  assert.equal(formatDecimalHours(total), "2.42");
});

test("sums 3.13, 0.33, 0.17, and 1.17 as 5h 20m", () => {
  const total = sumMinutes(["3.13", "0.33", "0.17", "1.17"].map((value) => (
    parseTimeToMinutes(value).totalMinutes
  )));
  assert.equal(total, 320);
  assert.equal(formatHoursMinutes(total), "5h 20m");
  assert.equal(formatDecimalHours(total), "5.33");
});

test("does not treat 1.17 as decimal hours", () => {
  const parsed = parseTimeToMinutes("1.17");
  assert.equal(parsed.totalMinutes, 77);
  assert.notEqual(parsed.totalMinutes, Math.round(1.17 * 60));
});

test("toggles a cell and refuses a duplicate key", () => {
  const selection = createSelectionManager();
  const entry = {
    key: selectionKey("1171127302", "H150"),
    sheetId: "1171127302",
    sheetName: "September",
    cellAddress: "H150",
    rawValue: "3.13",
    row: 150,
    column: 8,
    parse: parseTimeToMinutes("3.13"),
  };

  assert.equal(selection.toggle(entry).action, "added");
  assert.equal(selection.toggle(entry).action, "removed");
  assert.equal(selection.list().length, 0);

  selection.toggle(entry);
  selection.toggle({ ...entry, key: selectionKey("999", "H150"), sheetId: "999", sheetName: "October" });
  assert.equal(selection.list().length, 1);
  assert.equal(selection.list()[0].sheetName, "October");
});

test("parses A1 addresses without reading the grid", () => {
  assert.deepEqual(parseCellAddress("H150"), { cellAddress: "H150", column: 8, row: 150 });
  assert.deepEqual(parseCellAddress("September!AA10"), { cellAddress: "AA10", column: 27, row: 10 });
  assert.equal(parseCellAddress("H150:H160"), null);
  assert.equal(parseCellAddress("H:H"), null);
});

test("recognizes only Google Sheets URLs", () => {
  assert.equal(isGoogleSheets(new URL("https://docs.google.com/spreadsheets/d/abc/edit")), true);
  assert.equal(isGoogleSheets(new URL("https://docs.google.com/document/d/abc/edit")), false);
  assert.equal(isGoogleSheets(new URL("https://example.com/spreadsheets")), false);
});
