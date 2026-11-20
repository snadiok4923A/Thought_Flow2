// Regression for Gemini streamed-answer updates and ChatGPT page replacement.
// Run: node chrome-extension/test/streaming-turn-upsert.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildCaptureNoteHtml, planDirectCaptureUpsert } from "../../src/utils/aiCapture.js";

const core = fs.readFileSync(new URL("../content/capture-core.js", import.meta.url), "utf8");
const clockBase = 1000;
const question = "Explain binary search using mango782.";
const shortAnswer = "A short partial answer";
const fullAnswer = "Binary search repeatedly halves the sorted interval to find an item.";
const mockSubmissionStorage = new Map();

function keyForSubmission(s) {
  const normalized = String(s).replace(/\s+/g, " ").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  let hash = 2166136261;
  for (const ch of normalized) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return normalized.length + ":" + (hash >>> 0).toString(36);
}

function harness({ platform = "gemini", existing = [], conversation = "test",
  persistedKey = null } = {}) {
  let now = clockBase;
  let nextTimer = 0;
  const tasks = new Map();
  const messages = [...existing];
  const sent = [];
  const logs = [];
  const listeners = new Map();
  let mutation = null;
  const schedule = (fn, delay) => {
    const id = ++nextTimer;
    tasks.set(id, { at: now + delay, fn });
    return id;
  };
  const advance = (duration) => {
    const deadline = now + duration;
    for (let count = 0; count < 1000; count++) {
      const due = [...tasks.entries()].filter(([, t]) => t.at <= deadline)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      const [id, task] = due[0];
      tasks.delete(id);
      now = task.at;
      task.fn();
    }
    now = deadline;
  };
  const context = {
    document: {
      documentElement: {},
      querySelector: () => ({ innerText: question }),
      addEventListener(type, handler) { listeners.set(type, handler); },
    },
    location: { host: platform === "gemini" ? "gemini.google.com" : "chatgpt.com" },
    Date: { now: () => now },
    MutationObserver: class {
      constructor(fn) { mutation = fn; }
      observe() {}
    },
    setTimeout: schedule, clearTimeout: (id) => tasks.delete(id),
    setInterval() {},
    chrome: {
      storage: {
        local: { get(_k, cb) { cb({ tfSeen: [] }); }, set() {} },
        sync: { get(_k, cb) { cb({ captureEnabled: true, stabilityMs: 2000 }); } },
        onChanged: { addListener() {} },
      },
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          if (message.type === "TF_TRY_SEND") {
            sent.push(message.payload);
            cb({ accepted: true });
          } else if (message.type === "TF_CHATGPT_SUBMISSION") {
            mockSubmissionStorage.set("key", message.key);
            mockSubmissionStorage.set("at", now);
            cb({ ok: true });
          } else if (message.type === "TF_CHATGPT_SUBMISSION_GET") {
            // A full reload can first baseline-skip a completed Q+A. The
            // background reply restores its marker in a later task.
            schedule(() => cb(persistedKey
              ? { ok: true, key: persistedKey, at: now - 50, expiresAt: now + 120000 }
              : { ok: true }), 700);
          }
        },
      },
    },
    TFDebug: { log(event, detail) { logs.push({ event, detail }); } },
  };
  context.globalThis = context;
  vm.runInNewContext(core, context, { filename: "capture-core.js" });
  context.TFCapture.start({
    platform, label: platform, isSupportedPage: () => true,
    collectMessages: () => messages,
    getConversationId: () => conversation,
    isStreaming: () => false, probeStrategy: () => "test",
  });
  return {
    ctx: context, sent, logs, messages, advance,
    append(q, answer, uid, aid) {
      messages.push({ role: "user", text: q, id: uid }, { role: "assistant", text: answer, id: aid });
      mutation();
    },
    replaceAnswer(index, answer) {
      messages[index].text = answer;
      mutation();
    },
  };
}

// Gemini: partial response settles, then grows and settles again.
// Two sends MUST refer to the same turn so React updates one node.
const gemini = harness();
gemini.append(question, shortAnswer, "u1", "a1");
gemini.advance(6100);
assert.equal(gemini.sent.length, 1);
gemini.replaceAnswer(1, fullAnswer);
gemini.advance(6100);
assert.equal(gemini.sent.length, 2);
assert.equal(gemini.sent[0].turnKey, gemini.sent[1].turnKey);
assert.notEqual(gemini.sent[0].fingerprint, gemini.sent[1].fingerprint);

const initialHtml = buildCaptureNoteHtml({ question, answer: shortAnswer });
const finalHtml = buildCaptureNoteHtml({ question, answer: fullAnswer });
assert.equal(
  planDirectCaptureUpsert({ nodeId: "node1", noteHtml: initialHtml }, { notes: initialHtml }, finalHtml),
  "update",
);
assert.equal(
  planDirectCaptureUpsert({ nodeId: "node1", noteHtml: finalHtml }, { notes: finalHtml }, finalHtml),
  "duplicate",
);
assert.equal(
  planDirectCaptureUpsert({ nodeId: "node1", noteHtml: initialHtml },
    { notes: initialHtml + "<p>My own note</p>" }, finalHtml),
  "duplicate", // user modifications must never be overwritten
);

// Two distinct turns with identical questions must have different identities.
gemini.append(question, fullAnswer, "u2", "a2");
gemini.advance(6100);
assert.equal(gemini.sent.length, 3);
assert.notEqual(gemini.sent[1].turnKey, gemini.sent[2].turnKey);

// First ChatGPT message after the tab's full document reload.
// A previously sent question is still pending in MV3 session storage,
// although this page starts with a completed answer already visible.
const key = keyForSubmission(question);
const recovered = harness({
  platform: "chatgpt", persistedKey: key,
  existing: [{ role: "user", text: question, id: "user1" },
    { role: "assistant", text: fullAnswer, id: "assistant1" }],
  conversation: "new-chat-route",
});
recovered.advance(10000);
assert.equal(recovered.sent.length, 1);
assert.ok(recovered.logs.some((l) => l.event === "submission-unlocked"));

// No marker means opening old history must NOT create a new node.
const history = harness({
  platform: "chatgpt", existing: [{ role: "user", text: question, id: "u" },
    { role: "assistant", text: fullAnswer, id: "a" }],
});
history.advance(10000);
assert.equal(history.sent.length, 0);

console.log("PASS Gemini stable-turn streamed update, edited-note protection, repeated turns, ChatGPT reload recovery");
