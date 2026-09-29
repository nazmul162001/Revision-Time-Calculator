"use strict";

/**
 * @returns {{ mac: boolean, modifierLabel: string, hint: string }}
 */
export function detectPlatform() {
  const sources = [
    navigator.userAgentData?.platform,
    navigator.platform,
    navigator.userAgent,
  ];
  const raw = sources.filter(Boolean).join(" ");
  const mac = /Mac|iPhone|iPad|iPod/i.test(raw);
  const modifierLabel = mac ? "Cmd" : "Ctrl";
  return {
    mac,
    modifierLabel,
    hint: mac ? "Cmd + click to add or remove" : "Ctrl + click to add or remove",
  };
}

/**
 * Selection modifier only. Shift and Alt stay with Google Sheets
 * (range select, menus, and other native shortcuts).
 *
 * @param {MouseEvent | KeyboardEvent} event
 * @param {boolean} mac
 * @returns {boolean}
 */
export function isSelectionModifier(event, mac) {
  if (event.shiftKey || event.altKey) {
    return false;
  }
  if (mac) {
    return event.metaKey && !event.ctrlKey;
  }
  return event.ctrlKey && !event.metaKey;
}
