"use strict";

/**
 * @typedef {Object} SelectionEntry
 * @property {string} key
 * @property {string} rawValue
 * @property {import("./time-parser.js").ParseResult} parse
 */

/**
 * Session-only list of times. The same value can be added again.
 * Each entry has its own key so one number can be removed from the panel.
 */
export function createSelectionManager() {
  /** @type {SelectionEntry[]} */
  let items = [];
  let nextId = 1;

  return {
    /**
     * @returns {SelectionEntry[]}
     */
    list() {
      return items;
    },

    /**
     * @param {string} rawValue
     * @param {import("./time-parser.js").ParseResult} parse
     */
    add(rawValue, parse) {
      const key = String(nextId);
      nextId += 1;
      items.push({ key, rawValue, parse });
    },

    /**
     * @param {string} key
     * @returns {boolean}
     */
    remove(key) {
      const index = items.findIndex((item) => item.key === key);
      if (index === -1) {
        return false;
      }
      items.splice(index, 1);
      return true;
    },

    clear() {
      items = [];
    },
  };
}
