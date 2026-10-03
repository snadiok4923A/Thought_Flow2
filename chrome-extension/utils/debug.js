// Shared diagnostic logger for the ThoughtFlow AI Capture extension.
// Writes short, content-free events to the console AND to a persistent
// ring buffer in chrome.storage.local that the popup "Diagnostics" section
// renders — so failures are visible without opening DevTools.
// NEVER logs conversation text — only lengths, counts, ids and statuses.
(function () {
  const KEY = "tfDebugLog";
  const CAP = 40;
  const PREFIX = "[ThoughtFlow Capture]";
  let lastKey = "";

  function log(event, detail) {
    const d = detail === undefined || detail === null ? "" : String(detail);
    const key = event + "|" + d;
    const now = Date.now();

    // Console line (throttled for identical events)
    if (key !== lastKey) {
      lastKey = key;
      console.info(PREFIX, event, d);
    }

    try {
      chrome.storage.local.get([KEY], (r) => {
        const arr = Array.isArray(r[KEY]) ? r[KEY] : [];
        arr.push({ t: now, e: event, d: d.slice(0, 160) });
        chrome.storage.local.set({ [KEY]: arr.slice(-CAP) });
      });
    } catch {
      /* storage unavailable during reload */
    }
  }

  globalThis.TFDebug = { log };
})();
