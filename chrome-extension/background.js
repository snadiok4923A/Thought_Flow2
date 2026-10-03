// ThoughtFlow AI Capture — background service worker (MV3).
// Receives completed Q+A pairs from content scripts, checks the website session
// (capture ON + start node), forwards to POST /api/ai-capture, and retries on failure.
// Conversation text is never written to console logs.

importScripts("utils/api.js");

const MAX_QUEUE = 50;
const MAX_TRIES = 20;

// ---- Session gate -----------------------------------------------------------
// The website panel owns capture state: it must be ON with a start node selected.
async function sessionAllowsCapture() {
  try {
    const session = await TFApi.getSession();
    return {
      ok: !!(session && session.enabled && (session.rootNodeId || session.currentParentNodeId)),
      session,
    };
  } catch {
    // Server unreachable — do not drop the pair; queue it and retry later.
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
      // Website capture switched off → drop (spec: OFF means no capture).
      continue;
    }
    try {
      const res = await TFApi.postCapture(entry.payload);
      if (res && !res.duplicate) await bumpCounter();
    } catch {
      entry.tries = (entry.tries || 0) + 1;
      if (entry.tries < MAX_TRIES) remaining.push(entry);
    }
  }
  await setQueue(remaining);
}

async function handleCapture(payload) {
  const settings = await TFApi.getSettings();
  if (!settings.captureEnabled) return { drop: true, reason: "extension-off" };

  const gate = await sessionAllowsCapture();
  if (gate.retry) {
    const q = await getQueue();
    q.push({ payload, tries: 0, at: Date.now() });
    await setQueue(q);
    return { accepted: true, queued: true };
  }
  if (!gate.ok) return { drop: true, reason: "website-off" };

  try {
    const res = await TFApi.postCapture(payload);
    if (res && !res.duplicate) await bumpCounter();
    return { accepted: true, duplicate: !!(res && res.duplicate) };
  } catch (err) {
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

// ---- Messaging ---------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "TF_TRY_SEND") {
    handleCapture(msg.payload || {})
      .then(sendResponse)
      .catch(() => sendResponse({ drop: true, reason: "error" }));
    return true; // async
  }

  if (msg.type === "TF_HEALTH") {
    TFApi.health()
      .then((h) => sendResponse({ connected: true, ...h }))
      .catch(() => sendResponse({ connected: false }));
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

// Periodic retry for queued captures (also warms up after browser restart).
chrome.alarms.create("tf-retry", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tf-retry") flushQueue();
});

chrome.runtime.onInstalled.addListener(async () => {
  await TFApi.setSettings({}); // seed defaults
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
  } catch {
    /* ignore badge errors */
  }
});
