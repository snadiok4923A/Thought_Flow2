// Direct bridge: ThoughtFlow website tab ↔ extension background.
//
// Runs ONLY on the ThoughtFlow site (see manifest.json). The extension
// background sends TF_CAPTURE_DIRECT / TF_GET_PANEL_STATE / TF_SET_DIRECTION
// to this tab; this script forwards them to the React app via
// window.postMessage and relays the app's ack back to the background.
//
// Important: content scripts run in an ISOLATED world. `window.__thoughtflow_bridge`
// set here is NOT visible to the page's React code, so presence is announced
// with window messages (`thoughtflow-bridge-ready`) instead. The page can also
// ask at any time with `thoughtflow-bridge-ping`.
//
// No server, no queue, no MongoDB — the website must be open in a tab
// while chatting. Every forwarded request has a timeout, so a page that is
// loaded but not listening (or a stale bridge) can never leave the background
// waiting on a dead message channel.

(() => {
  const ACK_TIMEOUT_MS = 8000;
  const ANNOUNCE_MS = 5000;

  function announce() {
    try {
      window.postMessage({ source: "thoughtflow-bridge-ready", at: Date.now() }, "*");
    } catch {
      /* page navigating */
    }
  }

  announce();
  try {
    setInterval(announce, ANNOUNCE_MS);
  } catch {
    /* ignore */
  }

  const pending = new Map(); // requestId -> { sendResponse, timer }

  function respond(requestId, result) {
    const entry = pending.get(requestId);
    if (!entry) return; // already answered / timed out
    pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.sendResponse(result);
    } catch {
      /* channel already closed */
    }
  }

  function forward(requestId, sendResponse, message, timeoutMs = ACK_TIMEOUT_MS) {
    pending.set(requestId, { sendResponse, timer: null });
    // Never leave the background's channel open forever: a page that is not
    // listening (React not mounted, stale tab) acks as a transient drop.
    const timer = setTimeout(() => {
      respond(requestId, { received: false, created: false, reason: "timeout" });
    }, timeoutMs);
    const entry = pending.get(requestId);
    if (entry) entry.timer = timer;
    try {
      window.postMessage(message, "*");
    } catch {
      respond(requestId, { received: false, created: false, reason: "post-message-failed" });
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "TF_CAPTURE_DIRECT") {
      const requestId = msg.requestId || String(Date.now());
      forward(
        requestId,
        sendResponse,
        { source: "thoughtflow-capture-direct", requestId, payload: msg.payload }
      );
      return true; // keep the channel open until the page acks
    }

    if (msg.type === "TF_GET_PANEL_STATE") {
      const requestId = msg.requestId || `panel-${Date.now()}`;
      forward(requestId, sendResponse, { source: "thoughtflow-panel-query", requestId });
      return true;
    }

    if (msg.type === "TF_SET_DIRECTION") {
      const requestId = msg.requestId || `dir-${Date.now()}`;
      forward(requestId, sendResponse, {
        source: "thoughtflow-set-direction",
        requestId,
        direction: msg.direction,
      });
      return true;
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data.source !== "string") return;

    if (data.source === "thoughtflow-bridge-ping") {
      announce();
      return;
    }

    if (data.source !== "thoughtflow-capture-ack") return;
    // Panel queries / direction changes are acked with the same message type;
    // the app always includes requestId in its ack.
    if (!data.requestId) return;
    respond(data.requestId, data.result || { received: true });
  });
})();
