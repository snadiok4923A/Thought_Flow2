// Regression for ChatGPT partial/echo reply vs full multi-block answer.
// Run from repo root: node chrome-extension/test/chatgpt-full-answer-quality.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const nativeSource = fs.readFileSync(new URL("../content/selectors-chatgpt.js", import.meta.url), "utf8");
const universalSource = fs.readFileSync(new URL("../content/selectors-universal.js", import.meta.url), "utf8");
const coreSource = fs.readFileSync(new URL("../content/capture-core.js", import.meta.url), "utf8");
const question = "Another";
const fullAnswer = "Python Coding Question: Find the maximum sum of any contiguous subarray.\n" +
  "Example input: [-2,1,-3,4,-1,2,1,-5,4]\nExpected output: 6\n" +
  "Python code:\ndef max_subarray(nums):\n    best = running = nums[0]\n" +
  "    for x in nums[1:]:\n        running = max(x, running + x)\n" +
  "        best = max(best, running)\n    return best\n";

function fake(id, text) {
  return {
    id, innerText: text, className: "", isConnected: true,
    getAttribute(name) { return name === "data-message-id" ? id : null; },
    compareDocumentPosition(el) { return id === "user" ? 4 : 2; },
    contains() { return false; },
    querySelector() { return null; },
  };
}
const user = fake("user", question);
const md = fake("snippet", "Another");
const assistantTurn = {
  ...fake("assistant", fullAnswer),
  querySelector(selector) {
    if (selector.includes('[data-message-author-role="assistant"]')) return null;
    if (selector.includes(".markdown")) return md;
    return null;
  },
};
const userTurn = {
  ...fake("user-turn", question),
  querySelector(selector) { return selector.includes("user-message") ? user : null; },
};

const nativeContext = {
  location: { hostname: "chatgpt.com", pathname: "/c/abc", search: "" },
  Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  URLSearchParams,
  document: {
    querySelectorAll(selector) {
      if (selector === '[data-testid="user-message"]') return [user];
      if (selector.includes("conversation-turn-assistant")) return [assistantTurn];
      if (selector === '[data-testid="conversation-turn-user"]') return [userTurn];
      return [];
    },
    querySelector() { return null; },
  },
};
nativeContext.globalThis = nativeContext;
vm.runInNewContext(nativeSource, nativeContext);
const extracted = nativeContext.TF_SELECTORS.collectMessages();
assert.equal(extracted.length, 2);
assert.equal(extracted[0].text, question);
assert.equal(extracted[1].text, fullAnswer.trim(), "Read full assistant turn, not first 'Another' snippet");

// Universal selector must favor complete ChatGPT answer if native DOM
// yields only a truncated assistant response but the generic role strategy
// identifies the same question and much longer answer.
const fallbackContext = {
  TFDebug: { log() {} },
  location: { hostname: "chatgpt.com" },
  TF_SELECTORS: {
    platform: "chatgpt", label: "ChatGPT", isSupportedPage: () => true,
    collectMessages: () => [
      { role: "user", text: question, id: "u" },
      { role: "assistant", text: "Another", id: "a" },
    ],
    getConversationId: () => "abc",
    isStreaming: () => false,
  },
  TF_GENERIC_SELECTORS: {
    platform: "generic", label: "AI Chat", isSupportedPage: () => true,
    collectMessages: () => [
      { role: "user", text: question, id: "u" },
      { role: "assistant", text: fullAnswer, id: "a" },
    ],
    getConversationId: () => "abc",
    probeStrategy: () => "roles",
    isStreaming: () => false,
  },
};
fallbackContext.globalThis = fallbackContext;
vm.runInNewContext(universalSource, fallbackContext);
assert.equal(fallbackContext.TF_SELECTORS.collectMessages()[1].text, fullAnswer.trim());
assert.equal(fallbackContext.TF_SELECTORS.probeStrategy(), "universal-fuller-answer");

// Gemini native content has priority even when a generic selector reports
// more text: no regression in the previously working provider.
const geminiContext = {
  ...fallbackContext,
  location: { hostname: "gemini.google.com" },
  TF_SELECTORS: {
    ...fallbackContext.TF_SELECTORS,
    platform: "gemini",
    collectMessages: () => [
      { role: "user", text: question, id: "u" },
      { role: "assistant", text: "Good answer from Gemini.", id: "a" },
    ],
  },
};
geminiContext.globalThis = geminiContext;
vm.runInNewContext(universalSource, geminiContext);
assert.equal(geminiContext.TF_SELECTORS.collectMessages()[1].text, "Good answer from Gemini.");

// Shared core must not create a node from a short echo, even after a long
// apparent "stable" pause. When a real full reply later appears, capture once.
let now = 1000;
let nextId = 0;
let mutation;
let currentAnswer = "Another";
const timers = new Map();
// Start empty: the user types BEFORE ChatGPT renders the turn, exactly like
// a real send. Typing after the echo row exists would (correctly) look like
// pre-existing history and stay ignored.
const messages = [];
const sent = [];
const logs = [];
const schedule = (fn, delay) => {
  const id = ++nextId;
  timers.set(id, { fn, at: now + delay });
  return id;
};
function advance(ms) {
  const until = now + ms;
  for (let i = 0; i < 3000; i++) {
    const due = [...timers].filter(([, t]) => t.at <= until)
      .sort((a,b) => a[1].at - b[1].at);
    if (due.length === 0) break;
    const [id, task] = due[0];
    timers.delete(id);
    now = task.at;
    task.fn();
  }
  now = until;
}
const events = new Map();
function typeIntoComposer(text) {
  // The shared engine is live-only: a turn is eligible only after real user
  // input. Simulate the composer input event, not a promise that it happened.
  const target = { closest() { return { value: text }; } };
  for (const cb of events.get("input") || []) cb({ target });
}
const ctx = {
  document: {
    documentElement: {},
    addEventListener(kind, cb) {
      if (!events.has(kind)) events.set(kind, []);
      events.get(kind).push(cb);
    },
    querySelector() { return null; },
  },
  location: { host: "chatgpt.com" },
  sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  Date: { now: () => now },
  MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} },
  setTimeout: schedule,
  clearTimeout(id) { timers.delete(id); },
  setInterval() {},
  TFDebug: { log(event, detail) { logs.push({ event, detail }); } },
  chrome: {
    storage: {
      local: { get(_k, cb) { cb({ tfSeen: [] }); }, set() {} },
      sync: { get(_k, cb) { cb({ captureEnabled: true, stabilityMs: 2000 }); } },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (msg.type === "TF_TRY_SEND") sent.push(msg.payload);
        cb({ accepted: true });
      },
    },
  },
};
ctx.globalThis = ctx;
vm.runInNewContext(coreSource, ctx);
ctx.TFCapture.start({
  platform: "chatgpt", label: "ChatGPT", isSupportedPage: () => true,
  collectMessages() { return messages; },
  getConversationId() { return "chat123"; },
  isStreaming: () => false,
  probeStrategy: () => "test",
});
typeIntoComposer(question);
messages.push(
  { role: "user", text: question, id: "u" },
  { role: "assistant", text: currentAnswer, id: "a" }
);
mutation();
advance(10000);
assert.equal(sent.length, 0, "Echo should never become a standalone node");
assert.ok(logs.some((e) => e.event === "answer-echo-wait"));
messages[1].text = fullAnswer;
mutation();
advance(12000);
assert.equal(sent.length, 1, "Full answer should be sent once");
assert.equal(sent[0].answer, fullAnswer);

console.log("PASS full multi-block ChatGPT extraction, fuller fallback, Gemini isolation, no early echo node");
