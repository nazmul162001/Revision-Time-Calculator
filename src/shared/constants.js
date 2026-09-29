"use strict";

/** @typedef {"inactive" | "active" | "paused"} ExtensionMode */

export const EXTENSION_MODES = Object.freeze({
  INACTIVE: "inactive",
  ACTIVE: "active",
  PAUSED: "paused",
});

export const MESSAGE_TYPES = Object.freeze({
  TOGGLE_EXTENSION: "TOGGLE_EXTENSION",
  ACTIVATE: "ACTIVATE",
  DEACTIVATE: "DEACTIVATE",
  CLEAR_SELECTION: "CLEAR_SELECTION",
  EXTENSION_STATE: "EXTENSION_STATE",
  OPEN_REVISION: "OPEN_REVISION",
});

export const ROOT_ID = "sheet-time-calculator-root";

export const STORAGE_KEYS = Object.freeze({
  PANEL_PREFS: "panelPrefs",
  REVISION_MINUTES: "revisionMinutes",
});

export const REVISION_REPORT_URL = "https://report-generator-pearl-two.vercel.app/detailed-report";

/** Spreadsheet host. The extension does not run selection logic elsewhere. */
export const SHEETS_ORIGIN_PREFIX = "https://docs.google.com/spreadsheets/";

/**
 * Delays after a grid click before reading the name box.
 * Google Sheets updates the name box and formula bar after it handles the click.
 * These are one-shot waits, not a polling loop.
 */
export const CELL_READ_DELAYS_MS = Object.freeze([70, 110, 150, 200, 260, 340]);

export const MAX_MINUTE_PART = 59;

export const DECIMAL_HOUR_PLACES = 2;

export const COPY_FEEDBACK_MS = 1400;

export const STATUS_CLEAR_MS = 4200;

export const PANEL_DEFAULTS = Object.freeze({
  width: 520,
  margin: 16,
});
