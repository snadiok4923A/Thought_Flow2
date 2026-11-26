// Regression: one conversation turn = one node.
//  - an assistant reply split across several DOM rows is merged, not truncated
//  - a streamed answer that keeps growing keeps the SAME fingerprint and is
//    resent so the app can update its existing node
//  - re-rendered message ids never create another node
//  - a repeated identical question is a separate turn
//   node chrome-extension/test/capture-turn-identity.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const coreSource = fs.readFileSync(new URL("../content/capture-core.js", import.meta.url), "utf8");

let now = 1000;
let nextId = 0;
const timers = new Map();
let mutate = null;
const sent = [];
const logs = [];

const schedule = (fn, delay) => {
  const id = ++nextId;
  timers.set(id, { fn, at: now + delay });
  return id;
};
function advance(ms) {
  const until = now + ms;
  for (let i = 0; i < 5000; i++) {
    const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at);
    if (!due.length) break;
    const [id, task] = due[0];
    timers.delete(id);
    now = task.at;
    task.fn();
  }
  now = until;
}

let messages = [];
const events = new Map();
function type(text) {
  // Live-only capture unlocks a turn only from a real user submission, so the
  // fixture must simulate the composer input event like a person typing.
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
  MutationObserver: class {
    constructor(cb) { mutate = cb; }
    observe() {}
  },
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
  platform: "chatgpt",
  label: "ChatGPT",
  isSupportedPage: () => true,
  collectMessages() { return messages.map((m) => ({ ...m })); },
  getConversationId() { return "conv-1"; },
  isStreaming: () => false,
  probeStrategy: () => "test",
});

advance(100);
assert.equal(sent.length, 0);

// Split assistant rows (markdown body + code block) must be merged.
type("Explain closures");
messages = [
  { role: "user", text: "Explain closures", id: "u1" },
  { role: "assistant", text: "A closure captures its scope.", id: "a1" },
  { role: "assistant", text: "Example:\nfunction f() {}", id: "a2" },
];
mutate();
advance(20000);
assert.equal(sent.length, 1, "one node per turn");
assert.equal(
  sent[0].answer,
  "A closure captures its scope.\n\nExample:\nfunction f() {}",
  "split assistant rows are merged instead of truncated"
);
const firstFp = sent[0].fingerprint;

// The answer keeps streaming: same turn, same fingerprint, fuller payload.
messages[2].text = "Example:\nfunction f() { return 1; }";
mutate();
advance(20000);
assert.equal(sent.length, 2, "growth after the first capture is resent");
assert.equal(sent[1].fingerprint, firstFp, "stable turn identity across answer growth");
assert.match(sent[1].answer, /return 1/);

// Re-rendered DOM ids alone must never create another node.
messages = messages.map((m, i) => ({ ...m, id: "rerendered-" + i }));
mutate();
advance(20000);
assert.equal(sent.length, 2, "id churn does not resend");

// A repeated identical question is a separate turn with its own node.
type("Explain closures");
messages = messages.concat([
  { role: "user", text: "Explain closures", id: "u2" },
  { role: "assistant", text: "Same question, second answer.", id: "a3" },
]);
mutate();
advance(20000);
assert.equal(sent.length, 3);
assert.notEqual(sent[2].fingerprint, firstFp, "repeated question is a new turn");
assert.equal(sent[2].answer, "Same question, second answer.");

// No conversation text leaks into diagnostics.
for (const entry of logs) {
  assert.doesNotMatch(String(entry.detail || ""), /closure|function f|Example/);
}

console.log("PASS one turn = one stable fingerprint, merged split rows, no id churn duplicates");
