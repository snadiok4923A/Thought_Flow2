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

// ---- Retry queue (retired) --------------------------------------------------
// Live-only mode never replays a whole conversation: there is no durable
// capture queue and no flush timer. Any legacy `retryQueue` value from older
// versions is left untouched on disk, read-only, for diagnostics.

async function bumpCounter() {
  // This is a LIVE session counter, not a historical archive.
  // The previous all-time local counter is preserved but no longer used.
  const { liveCapturedCount = 0 } = await chrome.storage.session.get("liveCapturedCount");
  const next = liveCapturedCount + 1;
  await chrome.storage.session.set({ liveCapturedCount: next });
  try {
    await chrome.action.setBadgeText({ text: String(next > 999 ? "999+" : next) });
    await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
  } catch {
    /* action may be unavailable during install */
  }
  return next;
}

// Automatically recover the content-script bridge when Brave/Chrome did not
// inject it after an extension reload, SPA navigation, or browser restart.
// This requires the MV3 "scripting" permission and existing host permissions.
function isThoughtFlowUrl(raw) {
  try {
    const url = new URL(raw || "");
    const local = url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    const hosted = url.protocol === "https:" &&
      url.hostname === "snadiok4923a.github.io";
    return (local || hosted) &&
      (url.pathname === "/Thought_Flow2" || url.pathname.startsWith("/Thought_Flow2/"));
  } catch {
    return false;
  }
}

async function ensureThoughtFlowBridge(tab) {
  if (!tab || typeof tab.id !== "number") return { ok: false, reason: "no-tab" };
  if (!isThoughtFlowUrl(tab.url)) return { ok: false, reason: "wrong-tab" };
  try {
    // Safe if the manifest already injected it: bridge has an idempotent guard.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/thoughtflow-bridge.js"],
    });
    return { ok: true };
  } catch (err) {
    const reason = (err && err.message) || "script injection blocked";
    dbg("bridge-injection-failed", reason);
    return { ok: false, reason };
  }
}

// Direct captures recover the bridge automatically, and popup diagnostics
// expose a useful failure reason instead of silently returning "Offline".
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && isThoughtFlowUrl(tab && tab.url)) {
    ensureThoughtFlowBridge(tab).catch(() => {});
  }
});

// ---- Direct delivery to the chosen ThoughtFlow board -----------------------
// Multiple ThoughtFlow tabs may be open: e.g. localhost AND GitHub Pages.
// Previously we used .find(), so whichever tab Chrome returned FIRST silently
// received ALL captures. Prefer the board the user most recently activated.
// Persist only its tab ID across MV3 service-worker sleeps (not chat text).
const PREFERRED_BOARD_TAB_KEY = "tfPreferredBoardTabId";
const PINNED_BOARD_TAB_KEY = "tfPinnedBoardTabId";
chrome.tabs.onActivated?.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isThoughtFlowUrl(tab?.url)) {
      await chrome.storage.session.set({ [PREFERRED_BOARD_TAB_KEY]: tabId });
      dbg("board-target", tab.url.startsWith("https:") ? "GitHub Pages" : "localhost");
    }
  } catch { /* tab closed/navigated before lookup */ }
});

async function getOpenThoughtFlowTabs() {
  try {
    return (await chrome.tabs.query({ url: THOUGHTFLOW_URLS }))
      .filter((tab) => typeof tab.id === "number" && isThoughtFlowUrl(tab.url));
  } catch { return []; }
}

async function findThoughtFlowTab() {
  const tabs = await getOpenThoughtFlowTabs();
  if (!tabs.length) return null;
  let pinnedId, preferredId;
  try {
    const state = await chrome.storage.session.get([PINNED_BOARD_TAB_KEY, PREFERRED_BOARD_TAB_KEY]);
    pinnedId = state[PINNED_BOARD_TAB_KEY];
    preferredId = state[PREFERRED_BOARD_TAB_KEY];
  } catch { /* use best fallback */ }
  const pinned = tabs.find((tab) => tab.id === pinnedId);
  if (pinned) return pinned;
  const preferred = tabs.find((tab) => tab.id === preferredId);
  if (preferred) return preferred;
  // Default to production when both are open and no board has been selected.
  // Unlike localhost, the hosted site is the user's published destination.
  const hosted = tabs.find((tab) => tab.url.startsWith("https://snadiok4923a.github.io/"));
  if (hosted) return hosted;
  return [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

// A bridge that holds the message port open for a page ack must never hang the
// service worker (or the content script's in-flight pair) indefinitely.
function sendToTabWithTimeout(tabId, message, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ __timeout: true });
    }, timeoutMs);
    chrome.tabs
      .sendMessage(tabId, message)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ __error: error });
      });
  });
}

async function deliverDirect(payload) {
  const tab = await findThoughtFlowTab();
  if (!tab || typeof tab.id !== "number") return { delivered: false, reason: "website-off" };
  const bridge = await ensureThoughtFlowBridge(tab);
  if (!bridge.ok) return { delivered: false, reason: "bridge-unavailable", detail: bridge.reason };
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const result = await sendToTabWithTimeout(
      tab.id,
      { type: "TF_CAPTURE_DIRECT", requestId, payload },
      12000
    );
    if (result && result.__timeout) {
      dbg("direct-timeout", "bridge did not acknowledge within 12s");
      return { delivered: false, reason: "bridge-timeout" };
    }
    if (result && result.__error) {
      dbg("direct-error", result.__error.message || "no bridge");
      return { delivered: false, reason: "bridge-unavailable" };
    }
    if (!result || !result.received) {
      return { delivered: false, reason: (result && result.reason) || "app-unavailable" };
    }
    return { delivered: true, result };
  } catch (err) {
    dbg("direct-error", (err && err.message) || "no bridge");
    return { delivered: false, reason: "bridge-unavailable" };
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
    // Transient (no tab, blocked bridge, or the page never acked). Report the
    // REAL reason so diagnostics are actionable; the content script retries
    // after its cooldown so opening the website promptly still works.
    dbg("reject", direct.reason || "website-off");
    return { drop: true, reason: direct.reason || "website-off", detail: direct.detail };
  }
  const r = direct.result || {};
  if (r.created || r.updated || r.duplicate) {
    dbg("direct-ok", r.created ? "node created" : r.updated ? "node updated" : "duplicate acknowledged");
    if (r.created) await bumpCounter();
    return { accepted: true, duplicate: !!r.duplicate, updated: !!r.updated };
  }
  // Tab received it but the website dropped it (panel OFF / no start node /
  // no board open). Transient — content script retries after cooldown.
  dbg("direct-dropped", r.reason || "website-off");
  return { drop: true, reason: r.reason || "website-off" };
}

// Recover the shared capture engine on already-open AI tabs after an
// extension update/reload. One pipeline handles all supported platforms.
const AI_GENERIC_HOSTS = new Set([
  "arena.ai","www.arena.ai","lmarena.ai","www.lmarena.ai",
  "chat.lmsys.org","grok.com","grok.x.ai","x.ai","claude.ai",
  "chat.deepseek.com","deepseek.com","www.perplexity.ai","perplexity.ai",
  "copilot.microsoft.com","www.poe.com","poe.com","you.com","chat.you.com",
  "duck.ai","meta.ai","www.meta.ai","chat.mistral.ai","chat.qwen.ai",
  "kimi.com","www.kimi.com","felo.ai","chat.z.ai","chat.minimax.io",
]);

function captureFilesForUrl(raw) {
  let host;
  try {
    const url = new URL(raw || "");
    if (url.protocol !== "https:") return null;
    host = url.hostname.toLowerCase();
  } catch { return null; }
  const base = ["utils/debug.js","content/capture-core.js","content/selectors-generic.js"];
  if (host === "chatgpt.com" || host === "chat.openai.com") {
    return [...base,"content/selectors-chatgpt.js",
      "content/selectors-universal.js","content/universal.js"];
  }
  if (host === "gemini.google.com") {
    return [...base,"content/selectors-gemini.js",
      "content/selectors-universal.js","content/universal.js"];
  }
  if (AI_GENERIC_HOSTS.has(host)) {
    return [...base,"content/selectors-universal.js","content/universal.js"];
  }
  return null; // other hosts must be enabled explicitly via popup
}

async function ensureAICapture(tab) {
  const files = captureFilesForUrl(tab?.url);
  if (!files || typeof tab?.id !== "number") return { ready: false, reason: "unsupported-tab" };
  try {
    const probe = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: "ISOLATED",
      func: () => !!(globalThis.__tfUniversalCaptureStarted &&
        globalThis.TF_SELECTORS?.collectMessages && globalThis.TFCapture?.start),
    });
    if (probe?.[0]?.result === true) return { ready: true, repaired: false };
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: "ISOLATED", files,
    });
    dbg("ai-capture-repaired", "universal detector reinstalled after extension reload");
    return { ready: true, repaired: true };
  } catch (error) {
    dbg("ai-capture-repair-failed", error?.message || "injection failed");
    return { ready: false, reason: error?.message || "injection failed" };
  }
}

// The manifest normally installs scripts on navigation, but an already-open
// chat can survive an extension reload. Repair it without requiring a reload.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && captureFilesForUrl(tab?.url || info.url)) {
    ensureAICapture({ id: tabId, url: tab?.url || info.url }).catch(() => {});
  }
});

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
  const bridge = tab ? await ensureThoughtFlowBridge(tab) : { ok: false, reason: "no ThoughtFlow tab" };
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
  return { settings, api, session, panel, bridge, gate, queue: retryQueue.length, events: tfDebugLog.slice(-15).reverse() };
}

// ---- Messaging ---------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "TF_TRY_SEND") {
    // Incoming live Q+A always goes to the selected ThoughtFlow board.
    // There is no Notes-to-ChatGPT outbound request or special Notes job.
    handleCapture(msg.payload || {})
      .then(sendResponse)
      .catch((error) => {
        dbg("send-fatal", error?.message || "error");
        sendResponse({ drop: true, reason: "error" });
      });
    return true;
  }

  if (msg.type === "TF_LIST_BOARDS") {
    (async () => {
      const tabs = await getOpenThoughtFlowTabs();
      const target = await findThoughtFlowTab();
      let pinnedId = null;
      try {
        pinnedId = (await chrome.storage.session.get(PINNED_BOARD_TAB_KEY))[PINNED_BOARD_TAB_KEY] ?? null;
      } catch { /* optional */ }
      sendResponse({
        ok: true,
        tabs: tabs.map((tab) => ({
          id: tab.id, label: tab.url.startsWith("https:") ? "GitHub Pages" : "localhost",
        })),
        targetId: target?.id ?? null,
        pinnedId,
      });
    })().catch(() => sendResponse({ ok: false, tabs: [] }));
    return true;
  }

  if (msg.type === "TF_PIN_BOARD") {
    (async () => {
      const id = msg.tabId;
      if (id === null) {
        await chrome.storage.session.remove(PINNED_BOARD_TAB_KEY);
        sendResponse({ ok: true });
        return;
      }
      const tabs = await getOpenThoughtFlowTabs();
      const tab = tabs.find((t) => t.id === id);
      if (!tab) { sendResponse({ ok: false, reason: "board-tab-closed" }); return; }
      await chrome.storage.session.set({ [PINNED_BOARD_TAB_KEY]: tab.id });
      sendResponse({ ok: true, target: tab.url.startsWith("https:") ? "GitHub Pages" : "localhost" });
    })().catch((error) => sendResponse({ ok: false, reason: error?.message || "not set" }));
    return true;
  }

  if (msg.type === "TF_HEALTH") {
    // Direct mode first: an open ThoughtFlow tab with the bridge counts
    // as connected (no server needed). Fall back to server health for
    // backward compat with hosted/localhost deployments.
    (async () => {
      const tab = await findThoughtFlowTab();
      if (tab) {
        const bridge = await ensureThoughtFlowBridge(tab);
        return sendResponse(bridge.ok
          ? { connected: true, storage: "direct", ok: true, status: "ok",
              target: tab.url.startsWith("https:") ? "GitHub Pages" : "localhost" }
          : { connected: false, reason: bridge.reason });
      }
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
    chrome.storage.session.get({ liveCapturedCount: 0 })
      .then(({ liveCapturedCount }) => sendResponse({ captured: liveCapturedCount }))
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
    // LIVE-ONLY MODE: never replay previously stored pending conversations.
    // Existing legacy data is left untouched for safety, but is not imported.
    heartbeat();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  // Even if settings seeding fails temporarily, do not abort tab repair.
  try {
    await TFApi.setSettings({}); // seed defaults
  } catch (error) {
    dbg("settings-init-failed", error?.message || "defaults unavailable");
  }
  dbg("background", "installed");
  heartbeat();
  // On update, users may already have active Gemini/ChatGPT/other AI tabs.
  // Chrome doesn't necessarily reinject declarative content scripts until
  // those tabs navigate. Repair supported tabs now.
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all((tabs || []).filter((tab) => captureFilesForUrl(tab.url))
      .map((tab) => ensureAICapture(tab)));
  } catch (error) {
    dbg("ai-capture-repair-failed", error?.message || "tab discovery");
  }
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
  } catch {
    /* ignore badge errors */
  }
});

// Service worker startup / wake.
dbg("background", "service worker started");
heartbeat();
