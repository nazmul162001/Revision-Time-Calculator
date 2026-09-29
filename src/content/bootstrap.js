"use strict";

(async () => {
  const moduleUrl = chrome.runtime.getURL("src/content/content.js");
  await import(moduleUrl);
})();
