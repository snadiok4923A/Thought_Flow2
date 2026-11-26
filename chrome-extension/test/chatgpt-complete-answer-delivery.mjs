// Regression for the exact reported failure: a live ChatGPT turn is captured
// while the assistant container holds only "ChatGPT said:", producing a node
// with the question and no answer.
//   node chrome-extension/test/chatgpt-complete-answer-delivery.mjs
//
// Covers:
//   A. label-only container never becomes a completed Q+A
//   B. progressive streaming → one node, one stable turn identity
//   C. long Python answer (prose + list + code) delivered complete
//   D. the SAME node is updated when the answer grows, manual edits preserved
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildCaptureNoteHtml, decideDirectCapture } from "../../src/utils/aiCapture.js";

const coreSource = fs.readFileSync(
  new URL("../content/capture-core.js", import.meta.url),
  "utf8"
);

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
  for (let i = 0; i < 20000; i++) {
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
  getConversationId() { return "conv-live"; },
  isStreaming: () => false,
  probeStrategy: () => "test",
});

const question = "another";
const fullAnswer = [
  "Sure — here is another Python coding question.",
  "",
  "Problem: find the maximum sum of a contiguous subarray.",
  "",
  "Steps:",
  "1. Keep a running sum.",
  "2. Restart it when it becomes smaller than the current number.",
  "",
  "Solution:",
  "def max_subarray(nums):",
  "    best = running = nums[0]",
  "    for x in nums[1:]:",
  "        running = max(x, running + x)",
  "        best = max(best, running)",
  "    return best",
  "",
  "print(max_subarray([-2, 1, -3, 4, -1, 2, 1, -5, 4]))",
].join("\n");
const summaryAnswer = "Sure — here is another Python coding question.";

advance(100);
assert.equal(sent.length, 0);

// ---- A. ChatGPT renders the turn (speaker heading only) before the body.
type(question);
messages = [
  { role: "user", text: question, id: "u1" },
  { role: "assistant", text: "ChatGPT said:", id: "a1" },
];
mutate();
advance(30000);
assert.equal(sent.length, 0, "a label-only answer must never create a node");
assert.ok(logs.some((l) => l.event === "answer-label-wait"),
  "the wait is diagnosable without logging conversation text");

// ---- B/C. The answer streams in; only meaningful text is captured.
messages = [
  { role: "user", text: question, id: "u1" },
  { role: "assistant", text: summaryAnswer, id: "a1" },
];
mutate();
advance(20000);
assert.equal(sent.length, 1, "the first real text creates exactly one node");
assert.equal(sent[0].question, question);
assert.equal(sent[0].answer, summaryAnswer);
const fp = sent[0].fingerprint;
assert.doesNotMatch(sent[0].answer, /said:/i);

// ---- B/D. Completion after streaming: same turn, SAME node, complete answer.
messages = [
  { role: "user", text: question, id: "u1" },
  { role: "assistant", text: fullAnswer, id: "a1" },
];
mutate();
advance(20000);
assert.equal(sent.length, 2, "the completed answer is re-sent for an in-place update");
assert.equal(sent[1].fingerprint, fp, "same conversation turn → same node");
assert.equal(sent[1].answer, fullAnswer, "the full answer including code is delivered");
assert.ok(sent[1].answer.includes("def max_subarray(nums):"));
assert.ok(sent[1].answer.includes("    return best"), "indentation preserved");
assert.ok(!sent[1].answer.includes("ChatGPT said:"), "no role label in the delivered answer");

// Re-rendering the finished turn must not repeat the delivery.
mutate();
advance(20000);
assert.equal(sent.length, 2, "no duplicate node after completion re-render");

// ---- D. The website updates the existing node, and never clobbers edits.
const partialNotes = buildCaptureNoteHtml({ question, answer: summaryAnswer });
assert.deepEqual(
  decideDirectCapture({
    question,
    answer: fullAnswer,
    ledgerEntry: { nodeId: "node-1", question, answer: summaryAnswer },
    nodeNotes: partialNotes,
  }),
  { action: "update" },
  "the completed answer targets the node created for the same turn"
);
assert.deepEqual(
  decideDirectCapture({
    question,
    answer: fullAnswer,
    ledgerEntry: { nodeId: "node-1", question, answer: summaryAnswer },
    nodeNotes: "<p>my own edited notes</p>",
  }),
  { action: "duplicate" },
  "manually edited notes are preserved"
);

// ---- No conversation text or tokens in diagnostics.
for (const entry of logs) {
  assert.doesNotMatch(String(entry.detail || ""), /max_subarray|another Python|return best/);
}

console.log("PASS ChatGPT label-only stub blocked, streaming answer completes one node with the full reply");
