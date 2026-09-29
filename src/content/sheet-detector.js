"use strict";

import { SHEETS_ORIGIN_PREFIX } from "../shared/constants.js";

/**
 * @param {Location | URL | { href?: string, hostname?: string, pathname?: string }} [loc]
 * @returns {boolean}
 */
export function isGoogleSheets(loc) {
  const target = loc || globalThis.location;
  if (!target) {
    return false;
  }
  if (typeof target.href === "string" && target.href.startsWith(SHEETS_ORIGIN_PREFIX)) {
    return true;
  }
  return target.hostname === "docs.google.com" &&
    typeof target.pathname === "string" &&
    target.pathname.startsWith("/spreadsheets/");
}
