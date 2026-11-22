// Run: node chrome-extension/test/chatgpt-tab-session-capture.mjs
// Regression: a new ChatGPT conversation can fully replace its document,
// losing in-memory Send markers and accidentally baselining its first Q+A.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../content/capture-core.js", import.meta.url), "utf8");
const QUESTION = "Explain binary search using mango782.";
const ANSWER = "Binary search divides a sorted array into halves.";
const STORAGE_KEY = "thoughtflow:chatgpt:recent-send:v1";
const storageByTab = new Map();

function tabStorage(id) {
  if (!storageByTab.has(id)) storageByTab.set(id, new Map());
  const items = storageByTab.get(id);
  return {
    getItem(key) { return items.has(key) ? items.get(key) : null; },
    setItem(key, value) { items.set(key, String(value)); },
    removeItem(key) { items.delete(key); },
  };
}

function page({ tab = "tab1", oldPairs = [], provider = "chatgpt",
  question = QUESTION, time = 1000 } = {}) {
  let now = time;
  let timerId = 0;
  let observerCallback = null;
  const timers = new Map();
  const logs = [];
  const sent = [];
  const listeners = new Map();
  const msgs = [...oldPairs];
  let conversation = provider === "chatgpt" ? "" : "g1";
  const schedule = (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { fn, due: now + delay });
    return id;
  };
  const advance = (ms) => {
    const until = now + ms;
    for (let i = 0; i < 2000; i++) {
      const due = [...timers].filter(([, t]) => t.due <= until)
        .sort((a, b) => a[1].due - b[1].due);
      if (!due.length) break;
      const [id, t] = due[0];
      timers.delete(id);
      now = t.due;
      t.fn();
    }
    now = until;
  };
  const context = {
    Date: { now: () => now },
    location: { host: provider === "chatgpt" ? "chatgpt.com" : "gemini.google.com" },
    sessionStorage: tabStorage(tab),
    document: {
      documentElement: {},
      querySelector() { return { innerText: question }; },
      addEventListener(type, cb) {
        listeners.set(type, [...(listeners.get(type) || []), cb]);
      },
    },
    MutationObserver: class {
      constructor(cb) { observerCallback = cb; }
      observe() {}
    },
    setTimeout: schedule,
    clearTimeout(id) { timers.delete(id); },
    setInterval() {},
    chrome: {
      storage: {
        local: {
          get(_key, cb) { cb({ tfSeen: [] }); },
          set() {},
        },
        sync: {
          get(_default, cb) { cb({ captureEnabled: true, stabilityMs: 2000 }); },
        },
        onChanged: { addListener() {} },
      },
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          if (message.type === "TF_TRY_SEND") sent.push(message.payload);
          cb({ accepted: true });
        },
      },
    },
    TFDebug: { log(event, details) { logs.push({ event, details }); } },
  };
  context.globalThis = context;
  vm.runInNewContext(code, context, { filename: "capture-core.js" });
  context.TFCapture.start({
    platform: provider, label: provider,
    isSupportedPage() { return true; },
    collectMessages() { return msgs; },
    getConversationId() { return conversation; },
    isStreaming() { return false; },
  });
  return {
    context, sent, logs, advance,
    setConversation(id) { conversation = id; observerCallback(); },
    sendClick() {
      for (const cb of listeners.get("click") || []) {
        cb({ target: { closest() { return {}; } } });
      }
    },
    sendEnter() {
      for (const cb of listeners.get("keydown") || []) {
        cb({ target: { closest() { return {}; } }, key: "Enter",
          shiftKey: false, ctrlKey: false, altKey: false,
          metaKey: false, isComposing: false });
      }
    },
    addQA(q = QUESTION, answer = ANSWER) {
      msgs.push({ role: "user", text: q, id: "user-new" },
        { role: "assistant", text: answer, id: "assistant-new" });
      observerCallback();
    },
  };
}

// Simulate the real failure: Send is clicked on chatgpt.com/, then the
// entire JS world is torn down and a fresh page loads on /c/<new-id>.
// Without sessionStorage restoration, first Q+A is baseline-skipped.
for (const trigger of ["sendClick", "sendEnter", "notesAsk"]) {
  const tab = "case-" + trigger;
  const original = page({ tab });
  if (trigger === "notesAsk") original.context.TFCapture.markSubmittedQuestion(QUESTION);
  else original[trigger]();
  assert.ok(tabStorage(tab).getItem(STORAGE_KEY), trigger + ": marker saved");
  const replacement = page({
    tab, time: 1200,
    oldPairs: [
      { role: "user", text: QUESTION, id: "u" },
      { role: "assistant", text: ANSWER, id: "a" },
    ],
  });
  replacement.advance(8000);
  assert.equal(replacement.sent.length, 1, trigger + ": first Q+A captured once");
  assert.equal(replacement.sent[0].answer, ANSWER);
  assert.equal(tabStorage(tab).getItem(STORAGE_KEY), null, "marker consumed");
  assert.ok(replacement.logs.some((x) => x.event === "submission-restored"));
}

// Historical chat opened without a recent Send is never auto-imported.
const old = page({
  tab: "old", oldPairs: [
    { role: "user", text: QUESTION, id: "u" },
    { role: "assistant", text: ANSWER, id: "a" },
  ],
});
old.advance(8000);
assert.equal(old.sent.length, 0);
assert.ok(old.logs.some((x) => x.event === "baseline-skip"));

// Expired tab-local intent cannot unlock old Q+A.
tabStorage("expired").setItem(STORAGE_KEY,
  JSON.stringify({ key: "different", at: -300000 }));
const expired = page({
  tab: "expired", time: 400000, oldPairs: [
    { role: "user", text: QUESTION, id: "u" },
    { role: "assistant", text: ANSWER, id: "a" },
  ],
});
expired.advance(8000);
assert.equal(expired.sent.length, 0);
assert.equal(tabStorage("expired").getItem(STORAGE_KEY), null);

// Another tab cannot see the pending Send of the first tab.
const other = page({
  tab: "other", time: 1200, oldPairs: [
    { role: "user", text: QUESTION, id: "u" },
    { role: "assistant", text: ANSWER, id: "a" },
  ],
});
other.advance(8000);
assert.equal(other.sent.length, 0);

// Gemini must remain unchanged, including its normal history baseline.
tabStorage("gemini").setItem(STORAGE_KEY,
  JSON.stringify({ key: "fake", at: 1100 }));
const gemini = page({
  tab: "gemini", provider: "gemini", time: 1200, oldPairs: [
    { role: "user", text: QUESTION, id: "u" },
    { role: "assistant", text: ANSWER, id: "a" },
  ],
});
gemini.advance(8000);
assert.equal(gemini.sent.length, 0);
assert.equal(tabStorage("gemini").getItem(STORAGE_KEY) !== null, true);

console.log("PASS ChatGPT full-navigation Send/Enter/Notes, no history import, expiry, tab isolation, Gemini unchanged");
