// Exactly one capture observer per AI-chat document, regardless of platform.
// Works with selectors-universal.js which provides a single extraction API.
(function () {
  if (globalThis.__tfUniversalCaptureStarted) return;
  const engine = globalThis.TFCapture;
  const selectors = globalThis.TF_SELECTORS;
  if (!engine || !selectors) return;
  globalThis.__tfUniversalCaptureStarted = true;
  try {
    engine.start(selectors);
  } catch (error) {
    globalThis.__tfUniversalCaptureStarted = false;
    throw error;
  }
})();
