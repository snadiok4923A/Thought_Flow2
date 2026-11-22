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

// ---- Direct delivery to the open ThoughtFlow tab ---------------------------
// No server, no queue. Finds the ThoughtFlow tab and asks its bridge
// content script to hand the pair to the React app, which creates the
// node (or drops it if the panel is OFF / no start node / no board).
async function findThoughtFlowTab() {
  try {
    const tabs = await chrome.tabs.query({ url: THOUGHTFLOW_URLS });
    // Chrome URL match patterns cannot filter ports. Exclude unrelated local apps.
    return (tabs || []).find((tab) => isThoughtFlowUrl(tab.url)) || null;
  } catch {
    return null;
  }
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

// Node Notes -> extension -> logged-in ChatGPT -> SAME Note.
// Never hold a Chrome/Brave MV3 message port open for the full AI response.
// Use chrome.storage.session to retain routing IDs across service-worker sleeps;
// NO conversation/question/answer text is stored here.
const NOTE_JOB_PREFIX = "tf-note-job:";
const NOTE_JOB_TTL_MS = 180000; // React has its own shorter visible timeout.
const noteJobKey = (requestId) => NOTE_JOB_PREFIX + requestId;

// Match the exact pending question without persisting its raw text.
function noteQuestionKey(question, loose = false) {
  // Strict key stays backward-compatible. The optional loose key ignores
  // punctuation/case differences introduced by rich-text/UI extraction,
  // but is only considered on the SAME ChatGPT tab for an active Ask job.
  const plain = String(question || "").replace(/\s+/g, " ").trim();
  const value = loose ? plain.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") : plain;
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return value.length + ":" + (hash >>> 0).toString(36);
}

const validNoteRequestId = (id) => typeof id === "string" &&
  /^tf-notes-[A-Za-z0-9_-]{1,100}$/.test(id);

function isChatGPTUrl(raw) {
  try {
    const url = new URL(raw || "");
    return url.protocol === "https:" &&
      (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com");
  } catch { return false; }
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

async function ensureChatGPTCapture(tabId) {
  return ensureAICapture({ id: tabId, url: "https://chatgpt.com/" });
}

// The manifest normally installs scripts on navigation, but an already-open
// chat can survive an extension reload. Repair it without requiring a reload.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && captureFilesForUrl(tab?.url || info.url)) {
    ensureAICapture({ id: tabId, url: tab?.url || info.url }).catch(() => {});
  }
});

// The first response only confirms that the question was accepted for
// delivery. The finished answer returns later in TF_CHATGPT_ASK_RESULT.
async function startChatGPTNoteJob(sender, question, requestId) {
  const sourceUrl = sender?.url || sender?.tab?.url || "";
  const sourceTabId = sender?.tab?.id;
  if (!isThoughtFlowUrl(sourceUrl) || typeof sourceTabId !== "number") {
    return { ok: false, error: "Request was not sent from a ThoughtFlow tab." };
  }
  if (!validNoteRequestId(requestId)) {
    return { ok: false, error: "Invalid Notes request ID." };
  }
  const text = typeof question === "string" ? question.trim() : "";
  if (!text || text.length > 12000) {
    return { ok: false, error: "Write a question of at most 12,000 characters in Notes." };
  }

  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  });
  const validTabs = tabs.filter((tab) =>
    isChatGPTUrl(tab.url) && typeof tab.id === "number"
  );
  const sameWindow = validTabs.filter((tab) => tab.windowId === sender.tab?.windowId);
  const candidates = sameWindow.length ? sameWindow : validTabs;
  candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const target = candidates[0];
  if (!target) {
    return { ok: false, error: "Open a logged-in ChatGPT tab and try again." };
  }

  const key = noteJobKey(requestId);
  try {
    await ensureChatGPTCapture(target.id);
    await chrome.scripting.executeScript({
      target: { tabId: target.id },
      world: "ISOLATED",
      files: ["content/chatgpt-ask.js"],
    });
    // Save routing data before sending; a fast ChatGPT error may return
    // before the initial START acknowledgement reaches this worker.
    await chrome.storage.session.set({
      [key]: {
        thoughtflowTabId: sourceTabId,
        chatgptTabId: target.id,
        questionKey: noteQuestionKey(text),
        looseQuestionKey: noteQuestionKey(text, true),
        questionLength: text.length,
        started: false,
        expiresAt: Date.now() + NOTE_JOB_TTL_MS,
      },
    });
    const started = await chrome.tabs.sendMessage(target.id, {
      type: "TF_CHATGPT_ASK_START",
      requestId,
      question: text,
    });
    if (!started?.ok || !started.started) {
      await chrome.storage.session.remove(key);
      return { ok: false, error: started?.error || "ChatGPT could not start answering." };
    }
    const current = (await chrome.storage.session.get(key))[key];
    if (current) {
      dbg("note-job-started", `q=${text.length}c target-tab=${target.id}`);
      await chrome.storage.session.set({ [key]: { ...current, started: true } });
      // In case ChatGPT navigated before the START acknowledgement reached us,
      // also attempt recovery here. A live watcher rejects redundant RESUME.
      resumeChatGPTNoteJobs(target.id).catch(() => {});
    }
    return { ok: true, started: true };
  } catch (err) {
    await chrome.storage.session.remove(key).catch(() => {});
    return {
      ok: false,
      error: "Could not start ChatGPT: " + ((err && err.message) || "extension unavailable"),
    };
  }
}

// A new conversation can replace ChatGPT's document right after Send is
// clicked. Restart the answer watcher on the new page; do not resubmit the
// question. The current request ID + question fingerprint are enough.
async function resumeChatGPTNoteJobs(tabId) {
  const all = await chrome.storage.session.get(null);
  const jobs = Object.entries(all).filter(([key, job]) =>
    key.startsWith(NOTE_JOB_PREFIX) &&
    job?.started === true &&
    !job.completed &&
    job.chatgptTabId === tabId &&
    job.expiresAt > Date.now() &&
    typeof job.questionKey === "string"
  );
  if (!jobs.length) return;
  for (const [key, job] of jobs) {
    try {
      await ensureChatGPTCapture(tabId);
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        files: ["content/chatgpt-ask.js"],
      });
      const requestId = key.slice(NOTE_JOB_PREFIX.length);
      await chrome.tabs.sendMessage(tabId, {
        type: "TF_CHATGPT_ASK_RESUME",
        requestId,
        questionKey: job.questionKey,
      });
    } catch (err) {
      dbg("ask-resume-wait", err?.message || "ChatGPT tab not ready");
    }
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // URL changes occur for SPA navigation; "complete" handles full reloads.
  if ((info.url || info.status === "complete") &&
      isChatGPTUrl(tab?.url || info.url)) {
    resumeChatGPTNoteJobs(tabId).catch(() => {});
  }
});

async function resumeAllPendingNoteJobs() {
  const all = await chrome.storage.session.get(null);
  const ids = new Set(Object.entries(all)
    .filter(([key, job]) => key.startsWith(NOTE_JOB_PREFIX) && job?.started &&
      !job.completed && job.expiresAt > Date.now())
    .map(([, job]) => job.chatgptTabId));
  await Promise.all([...ids].map((tabId) => resumeChatGPTNoteJobs(tabId)));
}

// This is a NEW short-lived message from the ChatGPT content script. A paused
// or restarted service worker can pick up the routing data from session storage.
// Avoid duplicate Notes updates if the DOM watcher and Q+A collector finish
// at the same time. A service-worker restart is covered by stored.completed.
const noteAnswerDelivering = new Set();

async function forwardChatGPTNoteResult(sender, msg) {
  const requestId = msg?.requestId;
  if (!validNoteRequestId(requestId) || !isChatGPTUrl(sender?.url || sender?.tab?.url)) {
    return { ok: false, error: "Invalid ChatGPT reply origin." };
  }
  const key = noteJobKey(requestId);
  const stored = (await chrome.storage.session.get(key))[key];
  if (!stored || stored.chatgptTabId !== sender?.tab?.id || stored.expiresAt < Date.now()) {
    return { ok: false, error: "The Notes request is no longer active." };
  }
  if (stored.completed || noteAnswerDelivering.has(key)) {
    return { ok: true, duplicate: true };
  }

  const result = msg.result?.ok && typeof msg.result.answer === "string" && msg.result.answer.trim()
    ? { ok: true, answer: msg.result.answer }
    : { ok: false, error: String(msg.result?.error || "ChatGPT did not return an answer.") };

  noteAnswerDelivering.add(key);
  try {
    const response = await chrome.tabs.sendMessage(stored.thoughtflowTabId, {
      type: "TF_NOTES_AI_RESULT",
      requestId,
      result,
    });
    if (!response?.received) throw new Error("ThoughtFlow did not acknowledge the reply.");
    // Keep a short-lived fingerprint so automatic capture does not create a
    // duplicate child node if it scans just after the Notes reply is applied.
    await chrome.storage.session.set({
      [key]: { ...stored, completed: true, expiresAt: Date.now() + 120000 },
    });
    return { ok: true, delivered: true };
  } catch (err) {
    // Keep only tab IDs for the short TTL; no private answer data is persisted.
    return { ok: false, error: "ThoughtFlow tab unavailable: " + (err?.message || "message failed") };
  } finally {
    noteAnswerDelivering.delete(key);
  }
}

async function cleanupExpiredNoteJobs() {
  const all = await chrome.storage.session.get(null);
  const expired = Object.keys(all).filter((key) =>
    key.startsWith(NOTE_JOB_PREFIX) && (!all[key]?.expiresAt || all[key].expiresAt < Date.now())
  );
  if (expired.length) await chrome.storage.session.remove(expired);
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

  if (msg.type === "TF_ASK_CHATGPT") {
    startChatGPTNoteJob(sender, msg.question, msg.requestId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || "ChatGPT request failed." }));
    return true;
  }

  if (msg.type === "TF_CHATGPT_ASK_RESULT") {
    forwardChatGPTNoteResult(sender, msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || "Reply delivery failed." }));
    return true;
  }

  if (msg.type === "TF_TRY_SEND") {
    // The EXISTING auto-capture engine already knows how to extract a
    // completed ChatGPT question+answer. Reuse that working path to return
    // answers for deliberate Notes questions, rather than silently dropping
    // the pair and depending on a fragile, separate DOM watcher.
    (async () => {
      const payload = msg.payload || {};
      if (isChatGPTUrl(sender?.url || sender?.tab?.url) &&
          typeof sender?.tab?.id === "number" &&
          typeof payload.question === "string" &&
          typeof payload.answer === "string" && payload.answer.trim()) {
        const all = await chrome.storage.session.get(null);
        const key = noteQuestionKey(payload.question);
        const looseKey = noteQuestionKey(payload.question, true);
        // Include recently completed jobs in dedupe lookup: a late normal
        // Q+A scan must NOT become a child node after the Notes reply arrived.
        const jobsInTab = Object.entries(all).filter(([k, job]) =>
          k.startsWith(NOTE_JOB_PREFIX) &&
          job?.chatgptTabId === sender.tab.id &&
          job.expiresAt > Date.now()
        );
        const activeInTab = jobsInTab.filter(([, job]) => !job.completed);
        const entry = jobsInTab.find(([, job]) => job.questionKey === key ||
          job.looseQuestionKey === looseKey
        );
        if (!entry) {
          // The diagnostics log contains no private question/answer text.
          dbg(activeInTab.length ? "note-qa-unmatched" : "chatgpt-qa-normal",
            `q=${payload.question.length}c answer=${payload.answer.length}c pending=${activeInTab.length}`);
        }
        if (entry) {
          if (entry[1].questionKey !== key) {
            dbg("note-qa-loose-match", `q=${payload.question.length}c`);
          }
          const requestId = entry[0].slice(NOTE_JOB_PREFIX.length);
          const delivery = await forwardChatGPTNoteResult(sender, {
            requestId,
            result: { ok: true, answer: payload.answer },
          });
          if (delivery.ok) {
            dbg("note-answer-captured", delivery.duplicate ? "already delivered" : "delivered");
            // Mark the Q+A seen but do NOT make a child node.
            return { accepted: true, duplicate: true };
          }
          dbg("note-answer-retry", delivery.error || "delivery unavailable");
          // Preserve this Q+A for retry; never route it to a child node.
          return { drop: true, reason: "note-answer-delivery-failed" };
        }
      }
      return handleCapture(payload);
    })()
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
      if (tab) {
        const bridge = await ensureThoughtFlowBridge(tab);
        return sendResponse(bridge.ok
          ? { connected: true, storage: "direct", ok: true, status: "ok" }
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
    chrome.storage.local.get({ capturedCount: 0 })
      .then(({ capturedCount }) => sendResponse({ captured: capturedCount }))
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
    cleanupExpiredNoteJobs().catch(() => {});
    // Fallback when a ChatGPT SPA route change did not emit a tabs.onUpdated
    // event, or when the browser suspended the previous document.
    resumeAllPendingNoteJobs().catch(() => {});
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
