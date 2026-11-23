// Live-only Q+A regression. Run: node chrome-extension/test/live-only-no-history.mjs
// Uses actual content/capture-core.js, a simulated DOM and a clock.
// Historical conversations must never create ThoughtFlow nodes.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../content/capture-core.js", import.meta.url), "utf8");
const background = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../src/App.jsx", import.meta.url), "utf8");

function qa(question, answer, i) {
  return [{ role: "user", text: question, id: "u" + i },
          { role: "assistant", text: answer, id: "a" + i }];
}
function harness({ platform = "chatgpt", original = [], enabled = true, delivery = "accepted" } = {}) {
  let now = 1000;
  let seq = 0;
  let mutation;
  let conversation = "conversation-A";
  const messages = [...original];
  const sent = [];
  const logs = [];
  const events = new Map();
  const timers = new Map();
  const chromeStorage = {};
  const settingHandlers = [];
  const timer = (callback, delay) => {
    const id = ++seq;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  const advance = (duration) => {
    const until = now + duration;
    for (let i = 0; i < 5000; i++) {
      const due = [...timers].filter(([, task]) => task.at <= until)
        .sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, task] = due[0];
      timers.delete(id);
      now = task.at;
      task.callback();
    }
    now = until;
  };
  const ctx = {
    Date: { now: () => now },
    location: { host: platform === "chatgpt" ? "chatgpt.com" : "gemini.google.com",
      pathname: "/c/existing" },
    document: {
      documentElement: {},
      addEventListener(type, handler) {
        events.set(type, [...(events.get(type) || []), handler]);
      },
      querySelector() { return null; },
    },
    MutationObserver: class {
      constructor(cb) { mutation = cb; }
      observe() {}
    },
    setTimeout: timer,
    clearTimeout(id) { timers.delete(id); },
    setInterval() {},
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    TFDebug: { log(type, detail) { logs.push({ type, detail }); } },
    chrome: {
      storage: {
        local: {
          get(_keys, cb) { cb({ tfSeen: chromeStorage.tfSeen || [] }); },
          set(patch) { Object.assign(chromeStorage, patch); },
        },
        sync: { get(_defaults, cb) { cb({ captureEnabled: enabled, stabilityMs: 2000 }); } },
        onChanged: { addListener(handler) { settingHandlers.push(handler); } },
      },
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          if (message.type === "TF_TRY_SEND") {
            sent.push(message.payload);
            callback(delivery === "accepted" ? { accepted: true } :
              { drop: true, reason: "website-off" });
          } else callback({ ok: true });
        },
      },
    },
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: "capture-core.js" });
  ctx.TFCapture.start({
    platform, label: platform,
    collectMessages() { return messages; },
    isSupportedPage() { return true; },
    getConversationId() { return conversation; },
    isStreaming() { return false; },
    probeStrategy() { return "roles"; },
  });
  return {
    ctx, sent, logs, messages, advance,
    changeConversation(value) { conversation = value; mutation(); },
    add(question, answer, i) { messages.push(...qa(question, answer, i)); mutation(); },
    type(question) {
      const target = {
        closest() { return { value: question }; },
      };
      for (const cb of events.get("input") || []) cb({ target });
    },
    enable(flag) {
      const before = enabled;
      enabled = flag;
      for (const cb of settingHandlers) {
        cb({ captureEnabled: { oldValue: before, newValue: flag } }, "sync");
      }
    },
    mutate() { mutation(); },
  };
}

// 1. Existing history must NEVER create nodes during extension load.
const old = harness({ original: [
  ...qa("another", "Previous answer #1", "old1"),
  ...qa("another", "Previous answer #2", "old2"),
  ...qa("another", "Previous answer #3", "old3"),
] });
old.advance(20000);
assert.equal(old.sent.length, 0);

// 2. Delayed history hydration is not live input. This previously caused
// the burst of duplicate "another" nodes when the user reopened ChatGPT.
const delayed = harness();
delayed.advance(1500);
delayed.add("another", "Old answer", "restored");
delayed.advance(15000);
assert.equal(delayed.sent.length, 0);
assert.ok(delayed.logs.some((row) => row.type === "history-ignored"));

// 3. A newly typed question in a loaded conversation is captured ONCE.
const chatgpt = harness({ original: qa("old", "older answer", "0") });
chatgpt.type("Give me a Python question");
chatgpt.add("Give me a Python question", "Here is a new coding challenge.", "1");
chatgpt.advance(12000);
assert.equal(chatgpt.sent.length, 1);
assert.equal(chatgpt.sent[0].question, "Give me a Python question");
assert.equal(chatgpt.sent[0].answer, "Here is a new coding challenge.");
assert.ok(chatgpt.logs.some((row) => row.type === "live-turn"));

// 4. Reply extends after a partial capture -> same fingerprint, not new node.
chatgpt.messages[3].text = "Here is a new coding challenge with examples and code.";
chatgpt.mutate();
chatgpt.advance(12000);
assert.equal(chatgpt.sent.length, 2);
assert.equal(chatgpt.sent[0].fingerprint, chatgpt.sent[1].fingerprint);
assert.notEqual(chatgpt.sent[0].answer, chatgpt.sent[1].answer);

// 5. Reopening old conversations after the Send must NOT reuse that intent.
chatgpt.changeConversation("historical-chat-B");
chatgpt.messages.splice(0, chatgpt.messages.length,
  ...qa("Give me a Python question", "Stored answer from history", "oldB"));
chatgpt.mutate();
chatgpt.advance(15000);
assert.equal(chatgpt.sent.length, 2);

// 6. Gemini uses the SAME live-only rule and keeps its shorter stability.
const gemini = harness({ platform: "gemini", original: qa("hi", "old Gemini reply", "g0") });
gemini.type("What is binary search?");
gemini.add("What is binary search?", "An algorithm for sorted data.", "g1");
gemini.advance(5000);
assert.equal(gemini.sent.length, 1);

// 7. OFF periods and the later ON transition cannot import old pairs.
const switched = harness();
switched.enable(false);
switched.type("Old typed question while OFF");
switched.add("Old typed question while OFF", "Old response", "o");
switched.advance(5000);
switched.enable(true);
switched.advance(15000);
assert.equal(switched.sent.length, 0);

// 8. No queue / delayed retries after the website was OFF.
const offline = harness({ delivery: "drop" });
offline.type("Live but page is closed");
offline.add("Live but page is closed", "Response", "off");
offline.advance(12000);
assert.equal(offline.sent.length, 1);
offline.mutate();
offline.advance(120000);
assert.equal(offline.sent.length, 1);
assert.ok(offline.logs.some((e) => e.type === "live-drop"));

// 9. Legacy queue and backend polling must not silently backfill old nodes.
assert.ok(!/if\s*\(alarm\.name\s*===\s*"tf-retry"\)\s*\{\s*flushQueue\(\)/.test(background));
assert.ok(!/await\s+applyAiCaptureItems\(items,\s*session\)/.test(app));

console.log("PASS live-only: history, delayed hydration, ChatGPT, Gemini, answer updates, ON/OFF, no retry/backfill");
