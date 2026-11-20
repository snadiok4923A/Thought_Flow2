// Start the ChatGPT capture observer at most once per document. The
// background may reinject scripts to repair an already-open ChatGPT tab after
// an extension reload; duplicate observers would create repeated Q+A events.
if (!globalThis.__tfChatGPTCaptureStarted) {
  globalThis.__tfChatGPTCaptureStarted = true;
  try {
    globalThis.TFCapture.start(globalThis.TF_SELECTORS);
  } catch (error) {
    globalThis.__tfChatGPTCaptureStarted = false;
    throw error;
  }
}
