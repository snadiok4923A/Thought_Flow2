// Regression test for the Notes -> ChatGPT -> SAME Notes routing handshake.
// No live browser or API needed. Run: node chrome-extension/test/notes-port-routing.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const session = {};
const deliveries = [];
const injections = [];
let onMessage;

const sessionStorage = {
  async get(key) {
    if (key === null) return { ...session };
    return { [key]: session[key] };
  },
  async set(patch) { Object.assign(session, patch); },
  async remove(keys) {
    for (const key of [].concat(keys)) delete session[key];
  },
};
const context = {
  console, URL, Date, setTimeout, clearTimeout,
  importScripts() {},
  TFDebug: { log() {} },
  TFApi: { async putSession() {} },
  chrome: {
    storage: {
      session: sessionStorage,
      local: { async get() { return { retryQueue: [], tfDebugLog: [] }; } },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    tabs: {
      onUpdated: { addListener() {} },
      async query() {
        return [{ id: 10, windowId: 4, lastAccessed: 12,
          url: "https://chatgpt.com/c/known-conversation" }];
      },
      async sendMessage(tabId, message) {
        deliveries.push({ tabId, message });
        return tabId === 10
          ? { ok: true, started: true } // fast, no 110-second wait
          : { received: true };
      },
    },
    scripting: {
      async executeScript({ target, files }) {
        injections.push({ tabId: target.tabId, files });
      },
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    runtime: {
      onMessage: { addListener(fn) { onMessage = fn; } },
      onInstalled: { addListener() {} },
    },
  },
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "background.js" });
assert.equal(typeof onMessage, "function");

function send(message, sender) {
  return new Promise((resolve) => {
    const waiting = onMessage(message, sender, resolve);
    if (waiting !== true) resolve(undefined);
  });
}

const noteSender = {
  url: "http://localhost:5173/Thought_Flow2/",
  tab: { id: 20, windowId: 4 },
};
const chatSender = {
  url: "https://chatgpt.com/c/known-conversation",
  tab: { id: 10, windowId: 4 },
};
const requestId = "tf-notes-123-abc";
const ack = await send({
  type: "TF_ASK_CHATGPT", requestId, question: "What is AI?",
}, noteSender);
assert.deepEqual(JSON.parse(JSON.stringify(ack)), { ok: true, started: true });
assert.deepEqual(injections[0].files, ["content/chatgpt-ask.js"]);
assert.equal(deliveries[0].message.type, "TF_CHATGPT_ASK_START");
assert.equal(deliveries[0].message.requestId, requestId);
assert.equal(deliveries[0].tabId, 10);
assert.equal(Object.keys(session).length, 1);
assert.ok(!JSON.stringify(session).includes("What is AI?")); // only routing IDs

// Result from another ChatGPT tab must not be allowed to change Notes.
const spoof = await send({
  type: "TF_CHATGPT_ASK_RESULT", requestId,
  result: { ok: true, answer: "Wrong account" },
}, { url: "https://chatgpt.com/", tab: { id: 999 } });
assert.equal(spoof.ok, false);
assert.equal(deliveries.length, 1);

// The correct tab sends a fresh short response after generation finishes.
const completion = await send({
  type: "TF_CHATGPT_ASK_RESULT", requestId,
  result: { ok: true, answer: "AI is machine intelligence." },
}, chatSender);
assert.equal(completion.ok, true);
assert.equal(completion.delivered, true);
assert.equal(deliveries[1].tabId, 20);
assert.equal(deliveries[1].message.type, "TF_NOTES_AI_RESULT");
assert.equal(deliveries[1].message.result.answer, "AI is machine intelligence.");
assert.equal(Object.keys(session).length, 0);

// Reject a request coming from any website other than ThoughtFlow.
const blocked = await send({
  type: "TF_ASK_CHATGPT", requestId: "tf-notes-456-def", question: "Q",
}, { url: "https://example.com/", tab: { id: 77, windowId: 4 } });
assert.equal(blocked.ok, false);

// Errors also go back to the original note without waiting for a long port.
const req2 = "tf-notes-789-xyz";
assert.equal((await send({
  type: "TF_ASK_CHATGPT", requestId: req2, question: "Q2",
}, noteSender)).started, true);
const errCompletion = await send({
  type: "TF_CHATGPT_ASK_RESULT", requestId: req2,
  result: { ok: false, error: "Composer unavailable" },
}, chatSender);
assert.equal(errCompletion.ok, true);
assert.equal(deliveries.at(-1).message.result.ok, false);
assert.match(deliveries.at(-1).message.result.error, /Composer unavailable/);

console.log("PASS: immediate start, routing persistence, tab validation, separate result and error forwarding");
