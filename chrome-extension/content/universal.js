// Exactly one capture observer per AI-chat document, regardless of platform.
// Works with selectors-universal.js which provides a single extraction API.
(function () {
  if (globalThis.__tfUniversalCaptureStarted) return;
  const engine = globalThis.TFCapture;
  const selectors = globalThis.TF_SELECTORS;
  if (!engine || !selectors) return;
  globalThis.__tfUniversalCaptureStarted = true;
  // Browser diagnostics: report only counts, never Q+A content.
  if (!globalThis.__tfUniversalHealthListenerStarted) {
    globalThis.__tfUniversalHealthListenerStarted = true;
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== "TF_AI_DETECTOR_STATUS") return;
      try {
        const rows = selectors.collectMessages();
        let pairs = 0;
        let sawUser = false;
        for (const item of rows) {
          if (item.role === "user") sawUser = true;
          else if (sawUser && item.role === "assistant") {
            pairs++;
            sawUser = false;
          }
        }
        respond({ ready: true, platform: selectors.platform,
          messages: rows.length, pairs, strategy: selectors.probeStrategy?.() || "unknown" });
      } catch (error) {
        respond({ ready: false, reason: error?.message || "selector failed" });
      }
    });
  }
  try {
    engine.start(selectors);
  } catch (error) {
    globalThis.__tfUniversalCaptureStarted = false;
    throw error;
  }
})();
