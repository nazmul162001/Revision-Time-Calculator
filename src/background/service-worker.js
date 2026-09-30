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
    const entries = reportEntries(message.entries);
    openRevisionTab(
      url,
      Number.isInteger(minutes) ? minutes : 0,
      reportCategory(message.category),
      entries,
    )
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === MESSAGE_TYPES.READ_SHEET_ROW && sender.tab?.id) {
    const row = Number(message.row);
    readSheetRow(sender.tab.id, row)
      .then((text) => sendResponse({ ok: true, text }))
      .catch(() => sendResponse({ ok: false, text: "" }));
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
 * Copy one whole sheet row from the page. Runs in the page so Sheets' own
 * copy handler supplies the cells. The name box is only used to select the
 * row. Nothing is typed into a cell.
 *
 * @param {number} tabId
 * @param {number} row
 * @returns {Promise<string>}
 */
async function readSheetRow(tabId, row) {
  if (!Number.isInteger(row) || row < 1 || row > 20000) {
    return "";
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: readSheetRowInPage,
    args: [row],
  });
  return typeof result?.result === "string" ? result.result : "";
}

/**
 * @param {number} rowNumber
 * @returns {Promise<string>}
 */
function readSheetRowInPage(rowNumber) {
  const row = Number(rowNumber);
  const address = `${row}:${row}`;

  const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

  const nameBox = () => {
    const node = document.getElementById("t-name-box") || document.querySelector("input.waffle-name-box");
    return node instanceof HTMLInputElement ? node : null;
  };

  const boxText = () => {
    const input = nameBox();
    let text = input ? input.value : "";
    const bang = text.lastIndexOf("!");
    if (bang !== -1) {
      text = text.slice(bang + 1);
    }
    return text.replace(/\$/g, "").replace(/\s/g, "").toUpperCase();
  };

  const formulaNode = () => document.getElementById("t-formula-bar-input") || document.querySelector(".cell-input");

  const formulaText = () => {
    const node = formulaNode();
    if (!node) {
      return "";
    }
    if ((node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && node.value) {
      return node.value.trim();
    }
    return (node.innerText || node.textContent || "").replace(/\u00a0/g, " ").trim();
  };

  const pressEnter = (target) => {
    for (const type of ["keydown", "keyup"]) {
      const event = new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        view: window,
      });
      try {
        Object.defineProperty(event, "keyCode", { get: () => 13 });
        Object.defineProperty(event, "which", { get: () => 13 });
      } catch {
        // The browser already exposes keyCode for Enter.
      }
      target.dispatchEvent(event);
    }
  };

  const goTo = async (targetAddress) => {
    const input = nameBox();
    if (!input) {
      return false;
    }
    const before = formulaText();
    input.focus();
    input.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
    if (document.activeElement === input) {
      input.select();
      document.execCommand("insertText", false, targetAddress);
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) {
        setter.call(input, targetAddress);
      } else {
        input.value = targetAddress;
      }
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: targetAddress,
        inputType: "insertText",
      }));
    }
    pressEnter(input);
    const started = Date.now();
    while (Date.now() - started < 900) {
      if (formulaText() !== before) {
        await sleep(40);
        return true;
      }
      await sleep(30);
    }
    return formulaText() !== before;
  };

  const columnLetters = (index) => {
    let n = index;
    let letters = "";
    while (n > 0) {
      const rem = (n - 1) % 26;
      letters = String.fromCharCode(65 + rem) + letters;
      n = Math.floor((n - 1) / 26);
    }
    return letters;
  };

  const copyText = async () => {
    const input = nameBox();
    input?.blur();
    const grid = document.querySelector("#waffle-grid-container canvas, #waffle-grid-container");
    if (grid instanceof HTMLElement) {
      grid.focus();
    }
    await sleep(40);
    let text = "";
    const onCopy = (event) => {
      const next = event.clipboardData?.getData("text/plain") || "";
      if (next) {
        text = next;
      }
    };
    document.addEventListener("copy", onCopy, false);
    document.execCommand("copy");
    document.removeEventListener("copy", onCopy, false);
    if (!text.includes("\t")) {
      try {
        const clip = await navigator.clipboard.readText();
        if (clip) {
          text = clip;
        }
      } catch {
        // The page may not allow a clipboard read. The copy event is enough.
      }
    }
    return text;
  };

  const readAcross = async () => {
    const cells = [];
    let empty = 0;
    let stuck = 0;
    for (let col = 1; col <= 30; col += 1) {
      const target = `${columnLetters(col)}${row}`.toUpperCase();
      const before = formulaText();
      await goTo(target);
      const value = formulaText();
      const onCell = boxText() === target;
      if (!onCell && value === before) {
        stuck += 1;
        if (stuck >= 3) {
          break;
        }
      } else {
        stuck = 0;
      }
      cells.push(value);
      if (!value) {
        empty += 1;
        if (empty >= 10 && col >= 16) {
          break;
        }
      } else {
        empty = 0;
      }
    }
    return cells.join("\t");
  };

  return (async () => {
    await goTo(`C${row}`);
    const moved = await goTo(address);
    const anchor = formulaText();
    const copied = await copyText();
    if (copied.includes("\t") && (moved || (anchor && copied.includes(anchor)))) {
      return copied;
    }
    return readAcross();
  })();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function reportCategory(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "feedback response") {
    return "Feedback Response";
  }
  if (text === "review") {
    return "Review";
  }
  return "Revision";
}

/**
 * @param {unknown} value
 * @returns {{ category: string, minutes: number }[] | null}
 */
function reportEntries(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  /** @type {{ category: string, minutes: number }[]} */
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const text = typeof item.category === "string" ? item.category.trim().toLowerCase() : "";
    if (text !== "revision" && text !== "feedback response" && text !== "review") {
      continue;
    }
    const minutes = Number(item.minutes);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      continue;
    }
    out.push({ category: reportCategory(text), minutes });
  }
  return out.length ? out : null;
}

/**
 * Opens the detailed report and types minutes into one category, or into
 * each category when Advance Mode sends Revision, Feedback Response, and Review.
 *
 * @param {string} url
 * @param {number} minutes
 * @param {string} category
 * @param {{ category: string, minutes: number }[] | null} [entries]
 */
async function openRevisionTab(url, minutes, category, entries = null) {
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
    args: [minutes, category, entries],
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
 * @param {string} categoryLabel
 * @param {{ category: string, minutes: number }[] | null} [entries]
 */
function fillRevisionMinutes(minutes, categoryLabel, entries) {
  const jobs = Array.isArray(entries) && entries.length
    ? entries.map((job) => ({
      wanted: String(job.category || "").trim().toLowerCase(),
      text: String(job.minutes),
    })).filter((job) => Number(job.text) > 0)
    : (Number(minutes) > 0
      ? [{ wanted: String(categoryLabel || "Revision").trim().toLowerCase(), text: String(minutes) }]
      : []);
  if (!jobs.length) {
    return;
  }
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

  const minutesInput = (wanted) => {
    const rows = document.querySelectorAll(".work-breakdown-row");
    for (const row of rows) {
      const category = row.querySelector('input[id^="wb-category-"]');
      if (!(category instanceof HTMLInputElement)) {
        continue;
      }
      if (category.value.trim().toLowerCase() !== wanted) {
        continue;
      }
      const field = row.querySelector('input[id^="wb-minutes-"]');
      if (field instanceof HTMLInputElement) {
        return field;
      }
    }
    return null;
  };

  const saved = (input, text) => {
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

  const commit = async (input, text) => {
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
    return saved(input, text);
  };

  (async () => {
    for (const job of jobs) {
      let done = false;
      while (!done && Date.now() < deadline) {
        if (dialogOpen()) {
          await sleep(300);
          continue;
        }
        const input = minutesInput(job.wanted);
        if (!input) {
          await sleep(300);
          continue;
        }
        if (saved(input, job.text) || await commit(input, job.text)) {
          done = true;
        } else {
          await sleep(400);
        }
      }
    }
  })();
}
