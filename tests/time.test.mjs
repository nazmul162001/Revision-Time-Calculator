import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCopyTime,
  formatDecimalHours,
  formatHoursMinutes,
  minutesToDecimalHours,
  sumMinutes,
} from "../src/content/calculator.js";
import { parseCellAddress, clickedCellAddress, parseSelectionLabel } from "../src/content/cell-reader.js";
import { createSelectionManager } from "../src/content/selection-manager.js";
import { isGoogleSheets } from "../src/content/sheet-detector.js";
import { parseTimeToMinutes } from "../src/content/time-parser.js";
import {
  columnIndexToLetters,
  createAdvanceSession,
  findEngineerColumns,
  hoursBesideName,
  nameMatches,
  parseRowSelection,
  parseTsvRow,
} from "../src/content/advance-mode.js";

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

test("carries minute parts of 60 or more into the total", () => {
  assert.equal(parseTimeToMinutes("0.67").status, "ok");
  assert.equal(parseTimeToMinutes("0.67").totalMinutes, 67);
  assert.equal(formatHoursMinutes(parseTimeToMinutes("0.67").totalMinutes), "1h 7m");
  assert.equal(parseTimeToMinutes("0.75").totalMinutes, 75);
  assert.equal(parseTimeToMinutes("1.60").totalMinutes, 120);
  assert.equal(parseTimeToMinutes("1.75").totalMinutes, 135);
  assert.equal(formatHoursMinutes(parseTimeToMinutes("1.75").totalMinutes), "2h 15m");
});

test("rejects non-time text", () => {
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
  assert.equal(formatCopyTime(135), "135 minutes (2.25 hours)");
  assert.equal(formatCopyTime(236), "236 minutes (3.93 hours)");
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

test("adds the same value more than once", () => {
  const selection = createSelectionManager();
  const parsed = parseTimeToMinutes("3.13");
  selection.add("3.13", parsed);
  selection.add("3.13", parsed);
  assert.equal(selection.list().length, 2);
  assert.equal(selection.list()[0].rawValue, "3.13");
  assert.equal(selection.list()[1].rawValue, "3.13");
  selection.remove(selection.list()[0].key);
  assert.equal(selection.list().length, 1);
});

test("treats a click on the next row as the other cell in the name-box range", () => {
  assert.equal(parseSelectionLabel("M644:M645")?.kind, "range");
  assert.equal(clickedCellAddress("M644:M645", "M644"), "M645");
  assert.equal(clickedCellAddress("September!$M$644:$M$645", "M645"), "M644");
  assert.equal(clickedCellAddress("M644", "M643"), "M644");
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

test("splits a copied sheet row into cells", () => {
  assert.deepEqual(parseTsvRow("Engineer1\tEngineer1 task\tman-hours\tFB hours\tCheck hours"), [
    "Engineer1",
    "Engineer1 task",
    "man-hours",
    "FB hours",
    "Check hours",
  ]);
  assert.deepEqual(parseTsvRow('"Nazmul\tAhmed"\t1.17\nextra'), ["Nazmul\tAhmed", "1.17"]);
  assert.deepEqual(parseTsvRow(""), []);
});

test("reads a row-number selection and ignores a normal cell", () => {
  assert.deepEqual(parseRowSelection("42:42"), { rows: [42] });
  assert.deepEqual(parseRowSelection("September!$42:$42"), { rows: [42] });
  assert.deepEqual(parseRowSelection("10:12"), { rows: [10, 11, 12] });
  assert.equal(parseRowSelection("H42"), null);
  assert.equal(parseRowSelection("H:H"), null);
  assert.equal(parseRowSelection("M644:M645"), null);
  assert.deepEqual(parseRowSelection("1:40"), { tooWide: true });
});

test("matches an engineer name without matching a shorter fragment", () => {
  assert.equal(nameMatches("Nazmul", "Nazmul"), true);
  assert.equal(nameMatches("Nazmul Ahmed", "nazmul"), true);
  assert.equal(nameMatches("  Nazmul  ", "Nazmul"), true);
  assert.equal(nameMatches("Nazmul", "Naz"), false);
  assert.equal(nameMatches("Solayman", "Solay"), false);
  assert.equal(nameMatches("", "Nazmul"), false);
});

test("maps Engineer hour columns and skips the task column", () => {
  const headers = [
    "No",
    "Case name",
    "Assistant",
    "Assistant task",
    "man-hours",
    "FB hours",
    "Check hours",
    "Engineer1",
    "Engineer1 task",
    "man-hours",
    "FB hours",
    "Check hours",
    "Engineer2",
    "Engineer2 task",
    "man-hours",
    "FB hours",
    "Check hours",
  ];
  const found = findEngineerColumns(headers);
  assert.equal(found.engineer1.nameIndex, 7);
  assert.deepEqual(found.engineer1.hours, { revision: 9, feedback: 10, checking: 11 });
  assert.equal(found.engineer2.nameIndex, 12);
  assert.deepEqual(found.engineer2.hours, { revision: 14, feedback: 15, checking: 16 });
  assert.equal(columnIndexToLetters(found.engineer1.nameIndex + 1), "H");
  assert.equal(columnIndexToLetters(found.engineer1.hours.revision + 1), "J");
});

test("counts the three hour columns after each matching name", () => {
  const row = [
    "実行後",
    "2026/10/01",
    "case",
    "status",
    "Assistant",
    "task",
    "0.5",
    "0.17",
    "",
    "Nazmul",
    "1st check",
    "0.33",
    "0.08",
    "",
    "Nazmul",
    "2nd check",
    "1.17",
    "0.25",
    "0.5",
  ];
  assert.deepEqual(hoursBesideName(row, "Nazmul"), {
    revision: 110,
    feedback: 33,
    checking: 50,
    matches: 2,
  });
  assert.equal(hoursBesideName(row, "Solay").matches, 0);
});

test("finds Engineer1 on the October header row", () => {
  const headers = [
    "No",
    "Delivery date",
    "Case name",
    "Status",
    "Assistant",
    "Assistant task",
    "man-hours",
    "Check hours",
    "Assistant checker",
    "Engineer1",
    "Engineer1 task",
    "man-hours",
    "FB hours",
    "Check hours",
    "Engineer2",
    "Engineer2 task",
    "man-hours",
    "FB hours",
    "Check hours",
  ];
  const found = findEngineerColumns(headers);
  assert.equal(found.engineer1.nameIndex, 9);
  assert.deepEqual(found.engineer1.hours, { revision: 11, feedback: 12, checking: 13 });
  assert.equal(found.engineer2.nameIndex, 14);
  assert.deepEqual(found.engineer2.hours, { revision: 16, feedback: 17, checking: 18 });
});

test("adds extra feedback hours only after confirm", async () => {
  const row = ["Nazmul", "task", "1.00", "", "0.21"].join("\t");
  /** @type {import("../src/content/advance-mode.js").AdvanceView | null} */
  let view = null;
  const session = createAdvanceSession({
    readNameBox: () => "12:12",
    readRowText: async () => row,
    onChange: (state) => {
      view = state;
    },
  });
  session.start("Nazmul");
  session.onSheetClick();
  await session.calculate();
  assert.equal(view?.revision, "60 min · 1.00 hours");
  assert.equal(view?.feedback, "0 min");
  assert.equal(view?.checking, "21 min · 0.35 hours");
  session.beginAddFeedback();
  assert.equal(view?.adding, true);
  session.addFeedbackRaw("0.30");
  session.addFeedbackRaw("0.15");
  session.addFeedbackRaw("Completed");
  assert.equal(view?.feedback, "0 min");
  assert.equal(view?.revision, "60 min · 1.00 hours");
  assert.equal(view?.checking, "21 min · 0.35 hours");
  assert.equal(view?.pending, "45 min · 0.75 hours");
  session.confirmFeedback();
  assert.equal(view?.adding, false);
  assert.equal(view?.pending, "");
  assert.equal(view?.feedback, "45 min · 0.75 hours");
  assert.equal(view?.revision, "60 min · 1.00 hours");
  assert.equal(view?.checking, "21 min · 0.35 hours");
  const feedback = session.entries().find((entry) => entry.category === "Feedback Response");
  const revision = session.entries().find((entry) => entry.category === "Revision");
  assert.equal(feedback?.minutes, 45);
  assert.equal(revision?.minutes, 60);
});
