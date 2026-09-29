"use strict";

import { MESSAGE_TYPES } from "../shared/constants.js";

const SHEETS_PREFIX = "https://docs.google.com/spreadsheets/";

chrome.action.onClicked.addListener((tab) => {
  toggleTab(tab).catch(() => {
    // The page may be closed or blocked. There is nothing useful to surface.
  });
});

chrome.commands?.onCommand.addListener((command) => {
  if (command !== "toggle-calculator") {
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    toggleTab(tabs[0]).catch(() => {});
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== MESSAGE_TYPES.EXTENSION_STATE || !sender.tab?.id) {
    return;
  }
  setBadge(sender.tab.id, Boolean(message.active)).catch(() => {});
});

/**
 * @param {chrome.tabs.Tab | undefined} tab
 */
async function toggleTab(tab) {
  const tabId = tab?.id;
  const url = tab?.url || "";
  if (!tabId || !url.startsWith(SHEETS_PREFIX)) {
    return;
  }

  const toggled = await send(tabId, { type: MESSAGE_TYPES.TOGGLE_EXTENSION });
  if (toggled) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content/bootstrap.js"],
  });

  await sendWhenReady(tabId, { type: MESSAGE_TYPES.ACTIVATE });
}

/**
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<boolean>}
 */
async function send(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number} tabId
 * @param {object} message
 */
async function sendWhenReady(tabId, message) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await send(tabId, message)) {
      return;
    }
    await delay(40 * (attempt + 1));
  }
}

/**
 * @param {number} tabId
 * @param {boolean} active
 */
async function setBadge(tabId, active) {
  await chrome.action.setBadgeText({ tabId, text: active ? "ON" : "" });
  if (!active) {
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#14f195" });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ tabId, color: "#04140c" });
  }
}

/**
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
