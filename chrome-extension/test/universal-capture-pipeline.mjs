// Run: node chrome-extension/test/universal-capture-pipeline.mjs
// Executes real shared capture core + real universal selector wrapper/entry.
// Mocks DOM messages only; does not claim live website compatibility.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const core = fs.readFileSync(new URL("../content/capture-core.js", import.meta.url), "utf8");
const universal = fs.readFileSync(new URL("../content/selectors-universal.js", import.meta.url), "utf8");
const entry = fs.readFileSync(new URL("../content/universal.js", import.meta.url), "utf8");
const question = "What is a linked list?";
const answer = "A linked list is a chain of nodes with pointers to the next.";

function harness({ host, provider, useNative, nativePartial = false }) {
  let clock = 1000;
  let nextId = 0;
  let mutation;
  const timers = new Map();
  const captures = [];
  const listeners = [];
  let composerInput = null;
  const messages = [];
  const addTimer = (fn, ms) => {
    const id = ++nextId;
    timers.set(id, { fn, time: clock + ms });
    return id;
  };
  const advance = (ms) => {
    const until = clock + ms;
    for (let i = 0; i < 3000; i++) {
      const due = [...timers].filter(([, t]) => t.time <= until)
        .sort((a, b) => a[1].time - b[1].time);
      if (!due.length) break;
      const [id, t] = due[0];
      timers.delete(id);
      clock = t.time;
      t.fn();
    }
    clock = until;
  };
  const generic = {
    platform: provider,
    label: provider,
    isSupportedPage: () => true,
    collectMessages: () => messages,
    probeStrategy: () => "roles",
    getConversationId: () => "/c/test",
    isStreaming: () => false,
  };
  const native = {
    ...generic,
    collectMessages: () => nativePartial ? messages.filter((x) => x.role === "user") : messages,
  };
  const ctx = {
    document: {
      documentElement: {},
      querySelector() { return null; },
      addEventListener(type, cb) { if (type === "input") composerInput = cb; },
    },
    location: { hostname: host, host, pathname: "/c/test" },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    Date: { now: () => clock },
    MutationObserver: class {
      constructor(fn) { mutation = fn; }
      observe() {}
    },
    setTimeout: addTimer,
    clearTimeout: (id) => timers.delete(id),
    setInterval() {},
    TFDebug: { log() {} },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener(fn) { listeners.push(fn); } },
        sendMessage(msg, respond) {
          if (msg.type === "TF_TRY_SEND") captures.push(msg.payload);
          respond({ accepted: true });
        },
      },
      storage: {
        local: { get(_k, fn) { fn({ tfSeen: [] }); }, set() {} },
        sync: { get(_k, fn) { fn({ captureEnabled: true, stabilityMs: 2000 }); } },
        onChanged: { addListener() {} },
      },
    },
  };
  ctx.globalThis = ctx;
  ctx.TF_GENERIC_SELECTORS = generic;
  ctx.TF_SELECTORS = useNative ? native : generic;
  vm.runInNewContext(core, ctx);
  vm.runInNewContext(universal, ctx);
  vm.runInNewContext(entry, ctx);

  return {
    ctx, captures, advance,
    pushPair() {
      // A real live question is composed in the chat textarea BEFORE it is sent.
      // Without this event, imported history must not create a node.
      composerInput?.({ target: { closest: () => ({ value: question }) } });
      messages.push(
        { role: "user", text: question, id: "question" },
        { role: "assistant", text: answer, id: "answer" },
      );
      mutation();
    },
    status() {
      let output;
      for (const fn of listeners) fn({ type: "TF_AI_DETECTOR_STATUS" }, {}, (v) => { output = v; });
      return output;
    },
  };
}

for (const options of [
  { host: "chatgpt.com", provider: "chatgpt", useNative: true, nativePartial: true },
  { host: "gemini.google.com", provider: "gemini", useNative: true },
  { host: "chat.deepseek.com", provider: "deepseek", useNative: false },
  { host: "copilot.microsoft.com", provider: "copilot", useNative: false },
  { host: "opted-ai.example", provider: "generic", useNative: false },
]) {
  const t = harness(options);
  assert.equal(t.status().pairs, 0);
  t.pushPair();
  t.advance(9000);
  assert.equal(t.captures.length, 1, options.host + " should capture one complete Q+A");
  assert.equal(t.captures[0].question, question);
  assert.equal(t.captures[0].answer, answer);
  assert.equal(t.status().pairs, 1);
}
console.log("PASS one real shared capture pipeline across ChatGPT/Gemini/DeepSeek/Copilot/opted-in role-marked chat");
