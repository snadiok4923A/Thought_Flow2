// ThoughtFlow AI Capture — background service worker (MV3).
// Receives completed Q+A pairs from content scripts and delivers them
// DIRECTLY to the open ThoughtFlow tab (no server, no queue, no MongoDB):
// background → thoughtflow-bridge content script → React app → node.
// The website must be open in a tab while chatting; if it is closed the
// pair is dropped and the content script retries after its cooldown.
// (Legacy server queue/heartbeat code below is kept for backward compat
// but is no longer on the capture path.)
// Conversation text is never written to console logs.

importScripts("hosted-config.js", "utils/debug.js", "utils/api.js");

const MAX_QUEUE = 50;
const MAX_TRIES = 40; // ~20 min of retries at 30 s per flush — bridges most server restarts

// NOTE: Chrome match patterns do NOT support ports — "http://localhost/*"
// matches localhost on ANY port (5173, 5174, …). Never use :5173 here.
const THOUGHTFLOW_URLS = [
  "https://snadiok4923a.github.io/Thought_Flow2/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
];

function dbg(event, detail) {
  globalThis.TFDebug.log(event, detail);
}

// ---- Session gate -----------------------------------------------------------
// The website panel owns capture state: it must be ON with a start node selected.
async function sessionAllowsCapture() {
  try {
    const session = await TFApi.getSession();
    const ok = !!(session && session.enabled && (session.rootNodeId || session.currentParentNodeId));
    dbg("gate", ok ? "open" : `closed (enabled=${!!(session && session.enabled)} start=${(session && session.rootNodeId) || "-"})`);
    return { ok, session, retry: false };
  } catch (err) {
    // Server unreachable — do not drop the pair; queue it and retry later.
    dbg("gate", `api-unreachable (${err && err.message})`);
    return { ok: false, retry: true };
  }
}

// ---- Retry queue ------------------------------------------------------------
async function getQueue() {
  const { retryQueue = [] } = await chrome.storage.local.get("retryQueue");
  return retryQueue;
}

async function setQueue(q) {
  await chrome.storage.local.set({ retryQueue: q.slice(-MAX_QUEUE) });
}

async function bumpCounter() {
  const { capturedCount = 0 } = await chrome.storage.local.get("capturedCount");
  const next = capturedCount + 1;
  await chrome.storage.local.set({ capturedCount: next });
  try {
    await chrome.action.setBadgeText({ text: String(next > 999 ? "999+" : next) });
    await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
  } catch {
    /* action may be unavailable during install */
  }
  return next;
}

async function flushQueue() {
  const queue = await getQueue();
  if (!queue.length) return;

  const gate = await sessionAllowsCapture();
  if (gate.retry) return; // still offline

  const remaining = [];
  for (const entry of queue) {
    if (!gate.ok) {
      dbg("queue-drop", "website capture switched off");
      continue; // OFF means no capture
    }
    try {
      const res = await TFApi.postCapture(entry.payload);
      dbg("queue-retry-ok", res && res.duplicate ? "duplicate" : "applied");
      if (res && !res.duplicate) await bumpCounter();
    } catch (err) {
      dbg("queue-retry-fail", `HTTP ${err && err.status}`);
      entry.tries = (entry.tries || 0) + 1;
      if (entry.tries < MAX_TRIES) remaining.push(entry);
    }
  }
  await setQueue(remaining);
}

// ---- Direct delivery to the open ThoughtFlow tab ---------------------------
// No server, no queue. Finds the ThoughtFlow tab and asks its bridge
// content script to hand the pair to the React app, which creates the
// node (or drops it if the panel is OFF / no start node / no board).
async function findThoughtFlowTab() {
  try {
    const tabs = await chrome.tabs.query({ url: THOUGHTFLOW_URLS });
    return tabs && tabs.length ? tabs[0] : null;
  } catch {
    return null;
  }
}

async function deliverDirect(payload) {
  const tab = await findThoughtFlowTab();
  if (!tab || typeof tab.id !== "number") return { delivered: false, reason: "website-off" };
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "TF_CAPTURE_DIRECT",
      requestId,
      payload,
    });
    if (!result || !result.received) return { delivered: false, reason: "website-off" };
    return { delivered: true, result };
  } catch (err) {
    dbg("direct-error", (err && err.message) || "no bridge");
    return { delivered: false, reason: "website-off" };
  }
}

async function handleCapture(payload) {
  const settings = await TFApi.getSettings();
  if (!settings.captureEnabled) {
    dbg("reject", "extension capture OFF (popup)");
    return { drop: true, reason: "extension-off" };
  }

  const direct = await deliverDirect(payload);
  if (!direct.delivered) {
    // No ThoughtFlow tab (or bridge not ready) — drop; the content script
    // retries after its cooldown, so opening the website promptly still works.
    dbg("reject", "no ThoughtFlow tab open (direct)");
    return { drop: true, reason: "website-off" };
  }
  const r = direct.result || {};
  if (r.created) {
    dbg("direct-ok", "node created");
    await bumpCounter();
    return { accepted: true, duplicate: !!r.duplicate };
  }
  // Tab received it but the website dropped it (panel OFF / no start node /
  // no board open). Transient — content script retries after cooldown.
  dbg("direct-dropped", r.reason || "website-off");
  return { drop: true, reason: r.reason || "website-off" };
}

// ---- Heartbeat: proves extension ↔ API connectivity for the website --------
async function heartbeat() {
  try {
    await TFApi.putSession({ extensionHeartbeat: Date.now() });
  } catch {
    /* API offline — website will show Connected: No */
  }
}

// ---- One-click diagnostics for the popup ------------------------------------
async function diagnose() {
  const settings = await TFApi.getSettings();
  // Direct mode: is a ThoughtFlow tab open, and what does its panel say?
  const tab = await findThoughtFlowTab();
  let panel = null;
  if (tab) {
    try {
      const requestId = `panel-${Date.now()}`;
      panel = await chrome.tabs.sendMessage(tab.id, { type: "TF_GET_PANEL_STATE", requestId });
    } catch {
      panel = null;
    }
  }
  // Legacy server check (kept for backward compat; not on the direct path).
  let api = null;
  try {
    const h = await TFApi.health();
    const real = !!h && (h.ok === true || h.status === "ok");
    api = real
      ? { ok: true, storage: h.storage, status: h.status || "ok" }
      : { ok: false, status: "wrong service", url: settings.apiBase + "/health" };
  } catch (err) {
    api = { ok: false, status: err && err.status, url: err && err.url };
  }
  let session = null;
  try {
    session = await TFApi.getSession();
  } catch {
    session = null;
  }
  const gate = !settings.captureEnabled
    ? "popup Capture is OFF"
    : !tab
      ? "no ThoughtFlow tab open (direct mode needs the website open)"
      : !panel
        ? "website panel unreadable (reload the ThoughtFlow tab)"
        : !panel.enabled
          ? "website panel is OFF"
          : !panel.hasStartNode
            ? "no start node selected in ThoughtFlow"
            : "OK";
  const { retryQueue = [] } = await chrome.storage.local.get("retryQueue");
  const { tfDebugLog = [] } = await chrome.storage.local.get("tfDebugLog");
  return { settings, api, session, panel, gate, queue: retryQueue.length, events: tfDebugLog.slice(-15).reverse() };
}

// ---- Messaging ---------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "TF_TRY_SEND") {
    handleCapture(msg.payload || {})
      .then(sendResponse)
      .catch((e) => {
        dbg("send-fatal", (e && e.message) || "error");
        sendResponse({ drop: true, reason: "error" });
      });
    return true; // async
  }

  if (msg.type === "TF_HEALTH") {
    // Direct mode first: an open ThoughtFlow tab with the bridge counts
    // as connected (no server needed). Fall back to server health for
    // backward compat with hosted/localhost deployments.
    (async () => {
      const tab = await findThoughtFlowTab();
      if (tab) return sendResponse({ connected: true, storage: "direct", ok: true, status: "ok" });
      try {
        const h = await TFApi.health();
        const real = !!h && (h.ok === true || h.status === "ok");
        return sendResponse(real ? { connected: true, ...h } : { connected: false });
      } catch {
        return sendResponse({ connected: false });
      }
    })();
    return true;
  }

  if (msg.type === "TF_GET_PANEL_STATE") {
    (async () => {
      const tab = await findThoughtFlowTab();
      if (!tab) return sendResponse({ open: false });
      try {
        const requestId = `panel-${Date.now()}`;
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: "TF_GET_PANEL_STATE",
          requestId,
        });
        return sendResponse(result || { open: false });
      } catch {
        return sendResponse({ open: false });
      }
    })();
    return true;
  }

  if (msg.type === "TF_SET_DIRECTION_DIRECT") {
    (async () => {
      const tab = await findThoughtFlowTab();
      if (!tab) return sendResponse({ ok: false });
      try {
        const requestId = `dir-${Date.now()}`;
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: "TF_SET_DIRECTION",
          requestId,
          direction: msg.direction,
        });
        return sendResponse(result || { ok: false });
      } catch {
        return sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === "TF_DIAGNOSE") {
    diagnose().then(sendResponse);
    return true;
  }

  if (msg.type === "TF_STATS") {
    TFApi.getStats()
      .then((s) => sendResponse(s))
      .catch(() => sendResponse({ captured: null }));
    return true;
  }

  if (msg.type === "TF_GET_SESSION") {
    TFApi.getSession()
      .then((s) => sendResponse(s))
      .catch(() => sendResponse(null));
    return true;
  }

  if (msg.type === "TF_PUT_SESSION") {
    TFApi.putSession(msg.patch || {})
      .then((s) => sendResponse(s))
      .catch(() => sendResponse(null));
    return true;
  }

  if (msg.type === "TF_GET_SETTINGS") {
    TFApi.getSettings().then(sendResponse);
    return true;
  }

  if (msg.type === "TF_SET_SETTINGS") {
    TFApi.setSettings(msg.patch || {}).then(() => TFApi.getSettings().then(sendResponse));
    return true;
  }
});

// Periodic retry for queued captures + connectivity heartbeat.
chrome.alarms.create("tf-retry", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tf-retry") {
    flushQueue();
    heartbeat();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await TFApi.setSettings({}); // seed defaults
  dbg("background", "installed");
  heartbeat();
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
  } catch {
    /* ignore badge errors */
  }
});

// Service worker startup / wake.
dbg("background", "service worker started");
heartbeat();
