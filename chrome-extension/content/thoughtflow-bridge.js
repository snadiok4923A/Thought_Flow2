// Direct bridge: ThoughtFlow website tab ↔ extension background.
//
// Runs ONLY on the ThoughtFlow site (see manifest.json). The extension
// background sends TF_CAPTURE_DIRECT to this tab; this script forwards
// it to the React app via window.postMessage and relays the app's ack
// (created / dropped) back to the background.
//
// No server, no queue, no MongoDB — the website must be open in a tab
// while chatting. If the tab is closed, the background drops the pair
// and the content script retries after its cooldown.

// Idempotent: static manifest injection and scripting.executeScript recovery
// may both run. Install message listeners only once in the isolated world.
(function () {
  if (globalThis.__tfBridgeStarted) {
    document.documentElement.setAttribute("data-thoughtflow-bridge", "ready");
    window.postMessage({ source: "thoughtflow-bridge-ready" }, "*");
    return;
  }
  globalThis.__tfBridgeStarted = true;
// Chrome extension content scripts run in an isolated JavaScript world.
// Use a DOM attribute (shared with the page) for presence detection.
document.documentElement.setAttribute("data-thoughtflow-bridge", "ready");
window.postMessage({ source: "thoughtflow-bridge-ready" }, "*");

// The page ack must be bounded: if the React app has not mounted its listener
// (reloading, wrong route, crashed render) the port would otherwise stay open
// forever and the content script would wait on an in-flight pair.
const ACK_TIMEOUT_MS = 8000;
const pending = new Map(); // requestId -> { sendResponse, timer }

function awaitAck(requestId, sendResponse) {
  const timer = setTimeout(() => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    try {
      entry.sendResponse({ received: false, reason: "app-timeout" });
    } catch {
      /* port already closed */
    }
  }, ACK_TIMEOUT_MS);
  pending.set(requestId, { sendResponse, timer });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "TF_CAPTURE_DIRECT") {
    const requestId = msg.requestId || String(Date.now());
    awaitAck(requestId, sendResponse);
    window.postMessage(
      { source: "thoughtflow-capture-direct", requestId, payload: msg.payload },
      "*"
    );
    // Keep the message channel open until the page acks.
    return true;
  }
  if (msg.type === "TF_GET_PANEL_STATE") {
    const requestId = msg.requestId || `panel-${Date.now()}`;
    awaitAck(requestId, sendResponse);
    window.postMessage({ source: "thoughtflow-panel-query", requestId }, "*");
    return true;
  }
  if (msg.type === "TF_SET_DIRECTION") {
    const requestId = msg.requestId || `dir-${Date.now()}`;
    awaitAck(requestId, sendResponse);
    window.postMessage(
      { source: "thoughtflow-set-direction", requestId, direction: msg.direction },
      "*"
    );
    return true;
  }
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "thoughtflow-capture-ack") return;
  const entry = pending.get(data.requestId);
  if (entry) {
    pending.delete(data.requestId);
    clearTimeout(entry.timer);
    try {
      entry.sendResponse(data.result || { received: true });
    } catch {
      /* port closed by the sender */
    }
  }
});



})();
