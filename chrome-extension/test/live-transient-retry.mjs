// Run: node chrome-extension/test/live-transient-retry.mjs
// A LIVE Q+A may retry a transient busy response in memory, but a closed
// website must never build a backlog that reappears hours later.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const core = fs.readFileSync(new URL("../content/capture-core.js", import.meta.url), "utf8");

function harness(firstDrop) {
  let now = 1000, timerId = 0, mutation;
  const timers = new Map(), listeners = new Map(), sent = [], events = [];
  const msgs = [];
  const schedule = (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { fn, at: now + delay });
    return id;
  };
  const ctx = {
    Date: { now: () => now },
    location: { host: "chatgpt.com", pathname: "/c/new" },
    document: {
      documentElement: {},
      querySelector() { return null; },
      addEventListener(type, fn) { listeners.set(type, fn); },
    },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    MutationObserver: class { constructor(cb) { mutation = cb; } observe() {} },
    setTimeout: schedule, clearTimeout(id) { timers.delete(id); },
    setInterval() {},
    TFDebug: { log(type) { events.push(type); } },
    chrome: {
      storage: {
        local: { get(_k, cb) { cb({ tfSeen: [] }); }, set() {} },
        sync: { get(_k, cb) { cb({ captureEnabled: true, stabilityMs: 2000 }); } },
        onChanged: { addListener() {} },
      },
      runtime: {
        lastError: null,
        sendMessage(msg, respond) {
          if (msg.type === "TF_TRY_SEND") {
            sent.push(msg.payload);
            respond(sent.length === 1 ? { drop: true, reason: firstDrop } : { accepted: true });
          } else respond({ ok: true });
        },
      },
    },
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(core, ctx);
  ctx.TFCapture.start({
    platform: "chatgpt", label: "ChatGPT",
    isSupportedPage: () => true,
    collectMessages: () => msgs,
    isStreaming: () => false,
    getConversationId: () => "c-new",
  });
  function advance(ms) {
    const end = now + ms;
    for (let n = 0; n < 3000; n++) {
      const next = [...timers].filter(([, task]) => task.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  }
  listeners.get("input")({ target: { closest: () => ({ value: "Create a Python example" }) } });
  msgs.push({ role: "user", text: "Create a Python example", id: "u1" },
            { role: "assistant", text: "Here is a Python example with code.", id: "a1" });
  mutation();
  advance(45000);
  return { sent, events };
}

const busy = harness("busy");
assert.equal(busy.sent.length, 2);
assert.equal(busy.sent[0].fingerprint, busy.sent[1].fingerprint);
assert.ok(busy.events.includes("live-retry"));
assert.ok(busy.events.includes("send-ok"));

const offline = harness("website-off");
assert.equal(offline.sent.length, 1, "closed page must not generate a replay queue");
assert.ok(offline.events.includes("live-drop"));

console.log("PASS active-chat busy retry, no closed-website backlog or new duplicate fingerprint");
