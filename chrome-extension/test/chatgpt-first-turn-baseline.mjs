// Regression test for first ChatGPT answer after / -> /c/<conversation-id>
// Run from project root: node chrome-extension/test/chatgpt-first-turn-baseline.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const core = readFileSync(new URL("../content/capture-core.js", import.meta.url), "utf8");
const QUESTION = "Explain binary search with mango782.";
const ANSWER = "Binary search halves a sorted search range.";

function harness({ initial = [], conversationId = "", platform = "chatgpt" } = {}) {
  let time = 1000, next = 1, observer;
  const timers = new Map();
  const listeners = new Map();
  const messages = [...initial];
  const sent = [];
  const logs = [];
  const schedule = (fn, ms) => {
    const id = next++;
    timers.set(id, { fn, at: time + ms });
    return id;
  };
  const clear = (id) => timers.delete(id);
  const advance = (ms) => {
    const end = time + ms;
    for (let i = 0; i < 1000; i++) {
      const due = [...timers].filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, timer] = due[0];
      timers.delete(id);
      time = timer.at;
      timer.fn();
    }
    time = end;
  };
  const ctx = {
    document: {
      documentElement: {},
      querySelector: () => ({ innerText: QUESTION }),
      addEventListener(type, handler) {
        listeners.set(type, [...(listeners.get(type) || []), handler]);
      },
    },
    location: { host: platform === "chatgpt" ? "chatgpt.com" : "gemini.google.com" },
    Date: { now: () => time },
    MutationObserver: class {
      constructor(handler) { observer = handler; }
      observe() {}
    },
    setTimeout: schedule,
    clearTimeout: clear,
    setInterval() {},
    chrome: {
      storage: {
        local: {
          get(_keys, handler) { handler({ tfSeen: [] }); },
          set() {},
        },
        sync: {
          get(_keys, handler) { handler({ captureEnabled: true, stabilityMs: 2000 }); },
        },
        onChanged: { addListener() {} },
      },
      runtime: {
        lastError: null,
        sendMessage(message, response) {
          if (message.type === "TF_TRY_SEND") sent.push(message.payload);
          response(message.type === "TF_CHATGPT_SUBMISSION_GET"
            ? { ok: true } : { accepted: true });
        },
      },
    },
    TFDebug: { log(event, detail) { logs.push({ event, detail }); } },
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(core, ctx, { filename: "capture-core.js" });
  ctx.TFCapture.start({
    platform,
    label: platform,
    isSupportedPage: () => true,
    collectMessages: () => messages,
    getConversationId: () => conversationId,
    isStreaming: () => false,
    probeStrategy: () => "test",
  });
  return {
    ctx, messages, logs, sent, advance,
    setConversation(id) { conversationId = id; observer(); },
    submitClick() {
      for (const callback of listeners.get("click") || []) {
        callback({ target: { closest: () => ({}) } });
      }
    },
    submitEnter() {
      for (const callback of listeners.get("keydown") || []) {
        callback({
          key: "Enter", isComposing: false, shiftKey: false,
          altKey: false, ctrlKey: false, metaKey: false,
          target: { closest: () => ({}) },
        });
      }
    },
    append(question = QUESTION, answer = ANSWER, id = "1") {
      messages.push(
        { role: "user", text: question, id: "u" + id },
        { role: "assistant", text: answer, id: "a" + id },
      );
      observer();
    },
  };
}

// User click -> SPA route change -> first Q+A already complete before scan.
// Previous code incorrectly emitted baseline-skip and sent ZERO pairs.
for (const submission of ["submitClick", "submitEnter"]) {
  const t = harness();
  t[submission]();
  t.setConversation("new-chat");
  t.append();
  t.advance(10000);
  assert.equal(t.sent.length, 1, submission + " should capture first turn");
  assert.equal(t.sent[0].question, QUESTION);
  assert.equal(t.sent[0].answer, ANSWER);
}

// Extension's existing Notes Ask feature marks the question directly.
const notes = harness();
notes.ctx.TFCapture.markSubmittedQuestion(QUESTION);
notes.setConversation("notes-chat");
notes.append();
notes.advance(10000);
assert.equal(notes.sent.length, 1, "Notes Ask first response must capture");

// Opening an old conversation without Send must NEVER import prior Q+A.
const oldChat = harness();
oldChat.setConversation("old-chat");
oldChat.append();
oldChat.advance(10000);
assert.equal(oldChat.sent.length, 0);
assert.ok(oldChat.logs.some((entry) => entry.event === "baseline-skip"));

// A different submitted question must not unlock historical Q+A.
const mismatch = harness();
mismatch.ctx.TFCapture.markSubmittedQuestion("Something unrelated");
mismatch.setConversation("old-chat");
mismatch.append();
mismatch.advance(10000);
assert.equal(mismatch.sent.length, 0);

// Only the last matching newly submitted Q+A should pass baseline, not older
// content that was present when ChatGPT changed its conversation URL.
const mixed = harness();
mixed.ctx.TFCapture.markSubmittedQuestion(QUESTION);
mixed.setConversation("new-chat-with-history");
mixed.append("Older question", "Older answer", "0");
mixed.append();
mixed.advance(10000);
assert.equal(mixed.sent.length, 1);
assert.equal(mixed.sent[0].answer, ANSWER);

// Gemini is unchanged: a new historical conversation is still baselined.
const gemini = harness({ platform: "gemini" });
gemini.setConversation("some-chat");
gemini.append();
gemini.advance(10000);
assert.equal(gemini.sent.length, 0);

console.log("PASS first ChatGPT turn via click/Enter/Notes, history protection, Gemini isolation");
