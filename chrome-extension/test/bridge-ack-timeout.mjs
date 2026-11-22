// Regression: a ThoughtFlow tab that never acks a direct capture must not
// leave the background port (and the content script's in-flight pair) hanging.
//   node chrome-extension/test/bridge-ack-timeout.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../content/thoughtflow-bridge.js", import.meta.url), "utf8");

let now = 0;
let nextId = 0;
const timers = new Map();
const schedule = (fn, ms) => {
  const id = ++nextId;
  timers.set(id, { fn, at: now + ms });
  return id;
};
function advance(ms) {
  const until = now + ms;
  for (let i = 0; i < 1000; i++) {
    const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at);
    if (!due.length) break;
    const [id, task] = due[0];
    timers.delete(id);
    now = task.at;
    task.fn();
  }
  now = until;
}

const posted = [];
const windowListeners = new Map();
let onMessage = null;
const ctx = {
  setTimeout: schedule,
  clearTimeout(id) { timers.delete(id); },
  Date,
  JSON,
  Map,
  window: {
    location: { origin: "http://localhost:5173" },
    postMessage(message) { posted.push(message); },
    addEventListener(type, fn) {
      windowListeners.set(type, (windowListeners.get(type) || []).concat(fn));
    },
  },
  document: { documentElement: { setAttribute() {} } },
  chrome: {
    runtime: {
      onMessage: { addListener(fn) { onMessage = fn; } },
      sendMessage() {},
    },
  },
};
ctx.globalThis = ctx;
vm.runInNewContext(source, ctx);

assert.equal(typeof onMessage, "function", "bridge registers a message listener");
assert.ok(posted.some((m) => m.source === "thoughtflow-bridge-ready"));

// 1) The app never acks (reloading / crashed render): bounded failure.
let first = null;
const keep = onMessage(
  { type: "TF_CAPTURE_DIRECT", requestId: "r1", payload: {} },
  {},
  (result) => { first = result; }
);
assert.equal(keep, true, "port stays open while waiting for the app ack");
advance(7999);
assert.equal(first, null, "no premature timeout");
advance(1);
assert.equal(first.received, false);
assert.equal(first.reason, "app-timeout");
advance(20000);
assert.equal(first.reason, "app-timeout", "answers once");

// 2) A real page ack resolves the request, cancels its timer and is not
//    followed by a timeout response.
let second = null;
onMessage({ type: "TF_CAPTURE_DIRECT", requestId: "r2", payload: {} }, {}, (result) => { second = result; });
assert.ok(posted.some((m) => m.requestId === "r2"), "payload forwarded to the page");
for (const listener of windowListeners.get("message") || []) {
  listener({
    source: ctx.window,
    data: {
      source: "thoughtflow-capture-ack",
      requestId: "r2",
      result: { received: true, created: true },
    },
  });
}
assert.equal(second.received, true);
assert.equal(second.created, true);
advance(20000);
assert.equal(second.created, true, "no second response after ack");

// 3) Panel/direction queries use the same bounded ack path.
let panel = null;
onMessage({ type: "TF_GET_PANEL_STATE", requestId: "p1" }, {}, (result) => { panel = result; });
advance(8000);
assert.equal(panel.received, false);
assert.equal(panel.reason, "app-timeout");

console.log("PASS bridge acks are bounded, real acks cancel the timeout");
