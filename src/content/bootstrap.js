"use strict";

const moduleUrl = chrome.runtime.getURL("src/content/content.js");
import(moduleUrl).catch(() => {});
