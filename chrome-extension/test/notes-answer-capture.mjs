// Regression tests for the REAL existing auto-capture Q+A collector rerouting
// a deliberate Notes -> ChatGPT answer to the original Notes panel.
// Run: node chrome-extension/test/notes-answer-capture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const coreCode = fs.readFileSync(new URL("../content/capture-core.js", import.meta.url), "utf8");
const bgCode = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const QUESTION = "give me some question about soft skill";
const ANSWER = "1. What are soft skills?\n2. Why is communication important?";

function questionKey(q) {
  const value = String(q || "").replace(/\s+/g, " ").trim();
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return value.length + ":" + (hash >>> 0).toString(36);
}

function pair() {
  return [
    { role: "user", text: QUESTION, id: "user-message" },
    { role: "assistant", text: ANSWER, id: "assistant-message" },
  ];
}

function contentHarness(initialMessages = [], captureEnabled = true) {
  let clock = 1000;
  let nextTimerId = 1;
  let mutation;
  const timers = new Map();
  const messages = [...initialMessages];
  const forwarded = [];
  const schedule = (fn, ms) => {
    const id = nextTimerId++;
    timers.set(id, { fn, at: clock + ms });
    return id;
  };
  const clear = (id) => timers.delete(id);
  const advance = (ms) => {
    const finish = clock + ms;
    for (let i = 0; i < 1000; i++) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= finish)
        .sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, timer] = due[0];
      timers.delete(id);
      clock = timer.at;
      timer.fn();
    }
    clock = finish;
  };
  const context = {
    document: { documentElement: {} },
    location: { host: "chatgpt.com" },
    Date: { now: () => clock },
    MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe() {}
    },
    setTimeout: schedule,
    clearTimeout: clear,
    setInterval() {},
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(payload, respond) {
          forwarded.push(payload);
          respond({ accepted: true, duplicate: true });
        },
      },
      storage: {
        local: {
          get(_keys, callback) { callback({ tfSeen: [] }); },
          set() {},
        },
        sync: {
          get(_defaults, callback) {
            callback({ captureEnabled, stabilityMs: 2000 });
          },
        },
        onChanged: { addListener() {} },
      },
    },
    TFDebug: { log() {} },
  };
  context.globalThis = context;
  vm.runInNewContext(coreCode, context, { filename: "capture-core.js" });
  context.TFCapture.start({
    platform: "chatgpt",
    label: "ChatGPT",
    isSupportedPage: () => true,
    collectMessages: () => messages,
    getConversationId: () => "/c/sample",
    isStreaming: () => false,
    probeStrategy: () => "test",
  });
  return { context, messages, forwarded, advance, trigger: () => mutation() };
}

// Historical conversation is NOT captured automatically.
const historic = contentHarness(pair());
historic.advance(5000);
assert.equal(historic.forwarded.length, 0);

// ChatGPT's complete-answer stabilization now uses up to an 8-second
// text-settle window. Tests wait beyond that without changing routing rules.
// Notes-initiated question in a new/empty conversation IS captured.
const newNote = contentHarness();
newNote.context.__tfOutboundQuestions = new Set([QUESTION]);
newNote.context.TFCapture.allowPendingNoteQuestion(questionKey(QUESTION));
newNote.messages.push(...pair());
newNote.trigger();
newNote.advance(10000);
assert.equal(newNote.forwarded.length, 1);
assert.equal(newNote.forwarded[0].type, "TF_TRY_SEND");
assert.equal(newNote.forwarded[0].payload.question, QUESTION);
assert.equal(newNote.forwarded[0].payload.answer, ANSWER);

// A 9-character fragment must NOT be treated as a completed ChatGPT answer
// after a two-second pause; wait for the fuller final answer to stabilize.
const partial = contentHarness();
partial.context.__tfOutboundQuestions = new Set([QUESTION]);
partial.messages.push(
  { role: "user", text: QUESTION, id: "partial-user" },
  { role: "assistant", text: "Very short", id: "partial-answer" },
);
partial.trigger();
partial.advance(2700);
assert.equal(partial.forwarded.length, 0, "ChatGPT fragment must not capture at 2 seconds");
partial.messages[1].text = ANSWER;
partial.trigger();
partial.advance(10000);
assert.equal(partial.forwarded.length, 1, "Only the stable full answer must capture");
assert.equal(partial.forwarded[0].payload.answer, ANSWER);

// After ChatGPT navigates, its fresh baseline may have already skipped
// the completed question. RESUME must unlock this exact pair.
const navigated = contentHarness(pair());
navigated.advance(1000);
assert.equal(navigated.forwarded.length, 0);
navigated.context.TFCapture.allowPendingNoteQuestion(questionKey(QUESTION));
navigated.advance(10000);
assert.equal(navigated.forwarded.length, 1);
assert.equal(navigated.forwarded[0].payload.answer, ANSWER);

// A prior, identical question must NOT be mistaken for the new answer
// when the user sends the same prompt again to the same conversation.
const repeated = contentHarness([
  ...pair(),
  { role: "user", text: QUESTION, id: "user-message-2" },
  { role: "assistant", text: "NEW answer only", id: "assistant-message-2" },
]);
repeated.advance(1000);
assert.equal(repeated.forwarded.length, 0);
repeated.context.TFCapture.allowPendingNoteQuestion(questionKey(QUESTION));
repeated.advance(10000);
assert.equal(repeated.forwarded.length, 1);
assert.equal(repeated.forwarded[0].payload.answer, "NEW answer only");

// Manual Ask is explicit: it still works when general Auto Capture is OFF.
const captureOff = contentHarness([], false);
captureOff.context.__tfOutboundQuestions = new Set([QUESTION]);
captureOff.messages.push(...pair());
captureOff.trigger();
captureOff.advance(10000);
assert.equal(captureOff.forwarded.length, 1);
assert.equal(captureOff.forwarded[0].payload.answer, ANSWER);

// Background routes the captured Q+A to the originating Notes request.
const session = {};
const deliveries = [];
let handler = null;
let failNotesDelivery = false;
const mockChrome = {
  storage: {
    session: {
      async get(key) { return key === null ? { ...session } : { [key]: session[key] }; },
      async set(patch) { Object.assign(session, patch); },
      async remove(keys) { for (const key of [].concat(keys)) delete session[key]; },
    },
    local: { async get() { return { retryQueue: [], tfDebugLog: [] }; } },
  },
  tabs: {
    onUpdated: { addListener() {} },
    async query() {
      return [{ id: 11, url: "https://chatgpt.com/c/sample",
        lastAccessed: 12, windowId: 1 }];
    },
    async sendMessage(tabId, msg) {
      deliveries.push({ tabId, msg });
      if (tabId === 11) return { ok: true, started: true };
      if (failNotesDelivery) throw new Error("ThoughtFlow tab temporarily unavailable");
      return { received: true };
    },
  },
  scripting: { async executeScript() {} },
  runtime: {
    onMessage: { addListener(fn) { handler = fn; } },
    onInstalled: { addListener() {} },
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
};
const bgContext = {
  chrome: mockChrome, console, URL, Date, setTimeout, clearTimeout,
  importScripts() {}, TFDebug: { log() {} },
  TFApi: { async putSession() {}, async getSettings() { return { captureEnabled: true }; } },
};
bgContext.globalThis = bgContext;
vm.runInNewContext(bgCode, bgContext, { filename: "background.js" });
assert.equal(typeof handler, "function");
function sendMessage(msg, sender) {
  return new Promise((resolve) => {
    const async = handler(msg, sender, resolve);
    if (async !== true) resolve(undefined);
  });
}
const noteSender = { url: "http://localhost:5173/Thought_Flow2/", tab: { id: 22, windowId: 1 } };
const chatSender = { url: "https://chatgpt.com/c/sample", tab: { id: 11, windowId: 1 } };
const requestId = "tf-notes-123-qa";
assert.equal((await sendMessage({
  type: "TF_ASK_CHATGPT", requestId, question: QUESTION,
}, noteSender)).started, true);

const payload = newNote.forwarded[0].payload;
const accepted = await sendMessage({ type: "TF_TRY_SEND", payload }, chatSender);
assert.equal(accepted.accepted, true);
assert.equal(accepted.duplicate, true); // No child node.
const notes = deliveries.filter((item) => item.msg.type === "TF_NOTES_AI_RESULT");
assert.equal(notes.length, 1);
assert.equal(notes[0].tabId, 22);
assert.equal(notes[0].msg.requestId, requestId);
assert.equal(notes[0].msg.result.answer, ANSWER);

// Repeated auto-capture / DOM watcher completion cannot append twice.
assert.equal((await sendMessage({ type: "TF_TRY_SEND", payload }, chatSender)).duplicate, true);
assert.equal((await sendMessage({
  type: "TF_CHATGPT_ASK_RESULT", requestId, result: { ok: true, answer: ANSWER },
}, chatSender)).duplicate, true);
assert.equal(deliveries.filter((item) => item.msg.type === "TF_NOTES_AI_RESULT").length, 1);

// A failed ThoughtFlow delivery is retriable and must not make a child node.
const req2 = "tf-notes-456-retry";
assert.equal((await sendMessage({
  type: "TF_ASK_CHATGPT", requestId: req2, question: "What is teamwork?",
}, noteSender)).started, true);
const retryPair = { ...payload, question: "What is teamwork?", answer: "Working together." };
failNotesDelivery = true;
const failed = await sendMessage({ type: "TF_TRY_SEND", payload: retryPair }, chatSender);
assert.equal(failed.drop, true);
assert.equal(failed.reason, "note-answer-delivery-failed");
failNotesDelivery = false;
assert.equal((await sendMessage({ type: "TF_TRY_SEND", payload: retryPair }, chatSender)).duplicate, true);
assert.equal(deliveries.filter((item) => item.msg.type === "TF_NOTES_AI_RESULT" &&
  item.msg.requestId === req2 && item.msg.result.answer === "Working together.").length, 2); // failed attempt + retry

// A punctuation/case difference between Notes and the rendered ChatGPT
// user bubble must still return the answer to the original Notes node.
const looseRequest = "tf-notes-999-loose";
assert.equal((await sendMessage({
  type: "TF_ASK_CHATGPT", requestId: looseRequest, question: "What is leadership?",
}, noteSender)).started, true);
const loosePair = { ...payload, question: "what is leadership ?", answer: "Leadership is guiding a team." };
const looseDelivered = await sendMessage({ type: "TF_TRY_SEND", payload: loosePair }, chatSender);
assert.equal(looseDelivered.accepted, true);
assert.equal(looseDelivered.duplicate, true);
assert.equal(deliveries.filter((d) => d.msg.type === "TF_NOTES_AI_RESULT" &&
  d.msg.requestId === looseRequest).length, 1);
assert.equal((await sendMessage({ type: "TF_TRY_SEND", payload: loosePair }, chatSender)).duplicate, true);
assert.equal(deliveries.filter((d) => d.msg.type === "TF_NOTES_AI_RESULT" &&
  d.msg.requestId === looseRequest).length, 1);

console.log("PASS: ChatGPT full-answer stability, Notes strict/loose match, navigation, duplicate prevention and retry");
