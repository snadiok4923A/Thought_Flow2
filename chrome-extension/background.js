// ThoughtFlow AI Capture — background service worker (MV3).
// Receives completed Q+A pairs from content scripts, checks the website session
// (capture ON + start node), forwards to POST /api/ai-capture, retries on failure,
// and heartbeats the API so the website can show real extension connectivity.
// Conversation text is never written to console logs.

importScripts("utils/debug.js", "utils/api.js");

const MAX_QUEUE = 50;
const MAX_TRIES = 20;

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

async function handleCapture(payload) {
  const settings = await TFApi.getSettings();
  if (!settings.captureEnabled) {
    dbg("reject", "extension capture OFF (popup)");
    return { drop: true, reason: "extension-off" };
  }

  const gate = await sessionAllowsCapture();
  if (gate.retry) {
    const q = await getQueue();
    q.push({ payload, tries: 0, at: Date.now() });
    await setQueue(q);
    dbg("queued", `API offline, queue=${q.length}`);
    return { accepted: true, queued: true };
  }
  if (!gate.ok) {
    dbg("reject", "website session gate closed");
    return { drop: true, reason: "website-off" };
  }

  try {
    const res = await TFApi.postCapture(payload);
    dbg("api", res && res.duplicate ? "200 duplicate" : "201 created");
    if (res && !res.duplicate) await bumpCounter();
    return { accepted: true, duplicate: !!(res && res.duplicate) };
  } catch (err) {
    dbg("api-error", `HTTP ${err && err.status}`);
    if (err.status === 400 || err.status === 401) {
      // Permanent failure (validation/auth) — do not retry forever.
      return { drop: true, reason: err.status === 401 ? "auth" : "invalid" };
    }
    const q = await getQueue();
    q.push({ payload, tries: 0, at: Date.now() });
    await setQueue(q);
    return { accepted: true, queued: true };
  }
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
  let api = null;
  try {
    const h = await TFApi.health();
    // Only the ThoughtFlow API answers with ok/status fields — JSON from any
    // other server at that URL must not count as connected.
    const real = !!h && (h.ok === true || h.status === "ok");
    api = real
      ? { ok: true, storage: h.storage, status: h.status || "ok" }
      : { ok: false, status: "wrong service", url: settings.apiBase + "/health" };
  } catch (err) {
    api = { ok: false, status: err && err.status, url: err && err.url };
  }
  let session = null;
  let sessionErr = null;
  try {
    session = await TFApi.getSession();
  } catch (e) {
    sessionErr = e && e.status;
  }
  const gate = !api.ok
    ? "API unreachable"
    : !settings.captureEnabled
      ? "popup Capture is OFF"
      : sessionErr === 401
        ? "invalid capture token (popup Settings)"
        : !session
          ? "session unreadable"
          : !session.enabled
            ? "website panel is OFF"
            : !(session.rootNodeId || session.currentParentNodeId)
              ? "no start node selected in ThoughtFlow"
              : "OK";
  const { retryQueue = [] } = await chrome.storage.local.get("retryQueue");
  const { tfDebugLog = [] } = await chrome.storage.local.get("tfDebugLog");
  return { settings, api, session, gate, queue: retryQueue.length, events: tfDebugLog.slice(-15).reverse() };
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
    TFApi.health()
      .then((h) => {
        const real = !!h && (h.ok === true || h.status === "ok");
        sendResponse(real ? { connected: true, ...h } : { connected: false });
      })
      .catch(() => sendResponse({ connected: false }));
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
