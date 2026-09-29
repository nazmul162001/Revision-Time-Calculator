"use strict";

import { MESSAGE_TYPES, REVISION_REPORT_URL } from "../shared/constants.js";

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPES.OPEN_REVISION) {
    const minutes = Number(message.minutes);
    const url = typeof message.url === "string" && message.url.startsWith("https://report-generator-pearl-two.vercel.app/")
      ? message.url
      : REVISION_REPORT_URL;
    openRevisionTab(url, Number.isInteger(minutes) ? minutes : 0)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
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
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1c1e22" });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ tabId, color: "#ff6b57" });
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

/**
 * Opens the detailed report and types the total minutes into Revision.
 * The page only saves that field from its own React handlers, so the fill
 * runs in the page and calls those handlers after any welcome dialog closes.
 *
 * @param {string} url
 * @param {number} minutes
 */
async function openRevisionTab(url, minutes) {
  const tab = await chrome.tabs.create({ url, active: true });
  if (!tab.id) {
    return;
  }
  await waitForTab(tab.id);
  await delay(600);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: fillRevisionMinutes,
    args: [minutes],
  });
}

/**
 * @param {number} tabId
 */
function waitForTab(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        finish();
      }
    }).catch(finish);
    setTimeout(finish, 12000);
  });
}

/**
 * Runs inside the report page. Kept self-contained so Chrome can inject it.
 *
 * @param {number} minutes
 */
function fillRevisionMinutes(minutes) {
  const text = String(minutes);
  const deadline = Date.now() + 3 * 60 * 1000;

  const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

  const dialogOpen = () => {
    const dialogs = document.querySelectorAll('[aria-modal="true"]');
    for (const dialog of dialogs) {
      if (!(dialog instanceof HTMLElement)) {
        continue;
      }
      if (dialog.getAttribute("aria-hidden") === "true") {
        continue;
      }
      const style = getComputedStyle(dialog);
      if (style.display === "none" || style.visibility === "hidden") {
        continue;
      }
      const rect = dialog.getBoundingClientRect();
      if (rect.width > 1 && rect.height > 1) {
        return true;
      }
    }
    return false;
  };

  const revisionInput = () => {
    const rows = document.querySelectorAll(".work-breakdown-row");
    for (const row of rows) {
      const category = row.querySelector('input[id^="wb-category-"]');
      if (!(category instanceof HTMLInputElement)) {
        continue;
      }
      if (category.value.trim().toLowerCase() !== "revision") {
        continue;
      }
      const field = row.querySelector('input[id^="wb-minutes-"]');
      if (field instanceof HTMLInputElement) {
        return field;
      }
    }
    return null;
  };

  const saved = (input) => {
    const row = input.closest(".work-breakdown-row");
    if (/custom minutes/i.test(row?.textContent || "") && input.value.replace(/[^\d]/g, "") === text) {
      return true;
    }
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const dialog of dialogs) {
      if (/remove topics/i.test(dialog.textContent || "")) {
        return true;
      }
    }
    return false;
  };

  const commit = async (input) => {
    const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps"));
    const props = propsKey ? input[propsKey] : null;
    input.readOnly = false;
    input.focus();
    await sleep(150);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) {
      return false;
    }
    setter.call(input, text);
    const target = { target: input, currentTarget: input };
    if (typeof props?.onChange === "function") {
      props.onChange(target);
    }
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: text,
      inputType: "insertText",
    }));
    if (typeof props?.onBlur === "function") {
      props.onBlur(target);
    } else {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }));
      input.blur();
    }
    await sleep(350);
    return saved(input);
  };

  (async () => {
    while (Date.now() < deadline) {
      if (dialogOpen()) {
        await sleep(300);
        continue;
      }
      const input = revisionInput();
      if (!input) {
        await sleep(300);
        continue;
      }
      if (saved(input) || await commit(input)) {
        return;
      }
      await sleep(400);
    }
  })();
}
