// Run: node chrome-extension/test/chatgpt-2026-search-unit-live.mjs
// A recorded Chat/Work layout may have no data-message-author-role, article,
// conversation-turn-N or #prompt-textarea. Test the actual shared capture
// engine on synthetic DOM from the documented September 2026 layout.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const coreSrc = fs.readFileSync(new URL("../content/capture-core.js", import.meta.url), "utf8");
const nativeSrc = fs.readFileSync(new URL("../content/selectors-chatgpt.js", import.meta.url), "utf8");
const universalSrc = fs.readFileSync(new URL("../content/selectors-universal.js", import.meta.url), "utf8");

let now = 1000, timerID = 0, observerCallback;
const timers = new Map(), listeners = new Map(), deliveries = [], logs = [];
const clock = { now: () => now };
function later(fn, ms = 0) {
  const id = ++timerID;
  timers.set(id, { fn, time: now + ms });
  return id;
}
function advance(ms) {
  const end = now + ms;
  for (let n = 0; n < 5000; n++) {
    const next = [...timers].filter(([, t]) => t.time <= end)
      .sort((a, b) => a[1].time - b[1].time)[0];
    if (!next) break;
    timers.delete(next[0]);
    now = next[1].time;
    next[1].fn();
  }
  now = end;
}

let serial = 0;
class Unit {
  constructor(role, text, key) {
    this.role = role;
    this.innerText = text;
    this.key = key;
    this.order = ++serial;
    this.id = "";
  }
  getAttribute(k) {
    if (k === "data-content-search-unit-key") return this.key;
    if (k === "data-conversation-role") return this.role;
    return null;
  }
  querySelector(selector) {
    if (this.role === "user" && selector.includes("data-user-message-bubble"))
      return { innerText: this.innerText };
    return null;
  }
  compareDocumentPosition(other) { return this.order < other.order ? 4 : 2; }
  closest() { return null; }
}
const units = [
  new Unit("user", "Historical question", "thread:0:user"),
  new Unit("assistant", "Historical answer", "thread:1:assistant"),
];

const composer = {
  innerText: "Explain a binary search with Python code",
  closest(selector) {
    return selector.includes('role="textbox"') ? this : null;
  },
};
const form = {
  matches(selector) { return selector.includes("data-chatgpt-composer"); },
};
const document = {
  documentElement: {},
  addEventListener(type, fn) { listeners.set(type, fn); },
  querySelectorAll(selector) {
    if (selector.includes("[data-content-search-unit-key]")) return [...units];
    return [];
  },
  querySelector(selector) {
    if (selector.includes("form[data-chatgpt-composer]")) return composer;
    return null;
  },
};
const ctx = {
  document, Date: clock, URLSearchParams,
  location: { hostname: "chatgpt.com", host: "chatgpt.com",
    pathname: "/c/abc", search: "" },
  Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  setTimeout: later, clearTimeout(id) { timers.delete(id); },
  setInterval() {},
  MutationObserver: class {
    constructor(fn) { observerCallback = fn; }
    observe() {}
  },
  sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  TFDebug: { log(type, info) { logs.push([type, info]); } },
  chrome: {
    storage: {
      local: { get(_k, callback) { callback({ tfSeen: [] }); }, set() {} },
      sync: { get(_k, callback) { callback({ captureEnabled: true, stabilityMs: 2000 }); } },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        if (message.type === "TF_TRY_SEND") {
          deliveries.push(message.payload);
          callback({ accepted: true });
        } else callback({});
      },
    },
  },
};
ctx.globalThis = ctx;
vm.runInNewContext(coreSrc, ctx);
vm.runInNewContext(nativeSrc, ctx);
vm.runInNewContext(universalSrc, ctx);
ctx.TFCapture.start(ctx.TF_SELECTORS);

assert.equal(ctx.TF_SELECTORS.collectMessages().length, 2);
assert.equal(ctx.TF_SELECTORS.probeStrategy(), "native");
advance(12000);
assert.equal(deliveries.length, 0, "opening existing conversations must not import old Q+A");

// New Chat/Work ProseMirror input then form submit; old send buttons absent.
listeners.get("input")({ target: composer });
listeners.get("submit")({ target: form });
const answer = [
  "Binary search requires a sorted list.",
  "Python code:",
  "def search(items, target):",
  "    lo, hi = 0, len(items) - 1",
  "    while lo <= hi:",
  "        mid = (lo + hi) // 2",
  "        if items[mid] == target: return mid",
  "        if items[mid] < target: lo = mid + 1",
  "        else: hi = mid - 1",
  "    return -1",
].join("\n");
units.push(new Unit("user", composer.innerText, "thread:2:user"));
units.push(new Unit("assistant", answer, "thread:3:assistant"));
observerCallback();
advance(18000);
assert.equal(deliveries.length, 1, "new submitted Q+A must capture exactly once");
assert.equal(deliveries[0].question, composer.innerText);
assert.equal(deliveries[0].answer, answer, "all code and prose must survive capture");
assert.ok(logs.some(([kind]) => kind === "send"));
assert.ok(logs.some(([kind]) => kind === "direct-ok" || kind === "send-ok"));

// DOM re-render after completion or late old history must not create nodes.
observerCallback();
advance(16000);
assert.equal(deliveries.length, 1);
units.push(new Unit("user", "another old question", "thread:4:user"));
units.push(new Unit("assistant", "another old answer", "thread:5:assistant"));
observerCallback();
advance(17000);
assert.equal(deliveries.length, 1, "late historical hydration is not a live question");
console.log("PASS Chat/Work new-role DOM, ProseMirror submit, full code answer, no duplicate or old-history import");
