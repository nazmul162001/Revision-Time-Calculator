"use strict";

/**
 * @typedef {Object} SelectionEntry
 * @property {string} key
 * @property {string} sheetId
 * @property {string} sheetName
 * @property {string} cellAddress
 * @property {string} rawValue
 * @property {number | null} row
 * @property {number | null} column
 * @property {import("./time-parser.js").ParseResult} parse
 */

/**
 * Session-only selection. The same sheet cell cannot be stored twice.
 * The key is sheet id + address, for example "1171127302:H150".
 */
export function createSelectionManager() {
  /** @type {SelectionEntry[]} */
  let items = [];

  /**
   * @param {string} key
   */
  function findIndex(key) {
    return items.findIndex((item) => item.key === key);
  }

  return {
    /**
     * @returns {SelectionEntry[]}
     */
    list() {
      return items.slice();
    },

    /**
     * @param {string} key
     */
    has(key) {
      return findIndex(key) !== -1;
    },

    /**
     * Add the cell, or remove it when it is already selected.
     * If the incoming cell belongs to another sheet, previous items are dropped
     * first so two sheets are never mixed.
     *
     * @param {SelectionEntry} entry
     * @returns {{ action: "added" | "removed", clearedOtherSheet: boolean }}
     */
    toggle(entry) {
      let clearedOtherSheet = false;
      if (items.length > 0 && items[0].sheetId !== entry.sheetId) {
        items = [];
        clearedOtherSheet = true;
      }

      const index = findIndex(entry.key);
      if (index !== -1) {
        items.splice(index, 1);
        return { action: "removed", clearedOtherSheet };
      }

      items.push(entry);
      return { action: "added", clearedOtherSheet };
    },

    /**
     * @param {string} key
     * @returns {boolean}
     */
    remove(key) {
      const index = findIndex(key);
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

/**
 * @param {string} sheetId
 * @param {string} cellAddress
 * @returns {string}
 */
export function selectionKey(sheetId, cellAddress) {
  return `${sheetId}:${cellAddress}`;
}
