// Run: node chrome-extension/test/two-board-routing.mjs
// Regression: both localhost and GitHub Pages open. Captures must be sent to
// the last deliberately selected board, never the first result of tabs.query.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const local = "http://localhost:5173/Thought_Flow2/";
const hosted = "https://snadiok4923a.github.io/Thought_Flow2/";
let tabs = [
  { id: 11, url: local, lastAccessed: 2000 },
  { id: 22, url: hosted, lastAccessed: 1000 },
];
const saved = {};
const deliveries = [];
let activated;
let onMessage;
const chrome = {
  alarms: { create() {}, onAlarm: { addListener() {} } },
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { onMessage = fn; } },
  },
  tabs: {
    onUpdated: { addListener() {} },
    onActivated: { addListener(fn) { activated = fn; } },
    async get(id) { const t = tabs.find((tab) => tab.id === id); if (!t) throw Error("tab closed"); return t; },
    async query() { return [...tabs]; },
    async sendMessage(id, msg) {
      if (msg.type === "TF_CAPTURE_DIRECT") {
        deliveries.push({ id, question: msg.payload.question });
        return { received: true, created: true };
      }
      if (msg.type === "TF_GET_PANEL_STATE") {
        return { open: true, enabled: true, hasStartNode: true };
      }
      return { received: true };
    },
  },
  scripting: { async executeScript() {} },
  storage: {
    session: {
      async get(key) {
        if (key === null) return { ...saved };
        if (typeof key === "string") return { [key]: saved[key] };
        return Object.assign({}, key, saved);
      },
      async set(patch) { Object.assign(saved, patch); },
      async remove(key) { delete saved[key]; },
    },
    local: {
      async get() { return { capturedCount: 0 }; },
      async set() {},
    },
  },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
};
const context = {
  chrome, URL, Date, console, setTimeout, clearTimeout,
  importScripts() {},
  TFDebug: { log() {} },
  TFApi: {
    async putSession() {},
    async getSettings() { return { captureEnabled: true }; },
    async getSession() { return { enabled: true, rootNodeId: "root" }; },
    async health() { return { ok: false }; },
  },
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "background.js" });
assert.equal(typeof activated, "function");
assert.equal(typeof context.findThoughtFlowTab, "function");
assert.equal(typeof context.deliverDirect, "function");

// Initial state: both tabs present, lastAccessed (local) wins, not array order.
assert.equal((await context.findThoughtFlowTab()).id, 11);

// User intentionally opens GitHub Pages, then ChatGPT: stick with hosted.
await activated({ tabId: 22 });
assert.equal((await context.findThoughtFlowTab()).id, 22);
const hostedDelivery = await context.deliverDirect({ question: "New Q", answer: "New A" });
assert.equal(hostedDelivery.delivered, true);
assert.deepEqual(deliveries, [{ id: 22, question: "New Q" }]);

// Health / popup must display the actual selected board.
const health = await new Promise((resolve) => onMessage({ type: "TF_HEALTH" }, {}, resolve));
assert.equal(health.connected, true);
assert.equal(health.target, "GitHub Pages");

// Switching focus to localhost intentionally selects local for the next Q+A.
await activated({ tabId: 11 });
assert.equal((await context.findThoughtFlowTab()).id, 11);
await context.deliverDirect({ question: "Second Q", answer: "Second A" });
assert.deepEqual(deliveries.map((x) => x.id), [22, 11]);

// If the saved tab closes, fall back to another open ThoughtFlow tab.
tabs = tabs.filter((x) => x.id !== 11);
assert.equal((await context.findThoughtFlowTab()).id, 22);
await context.deliverDirect({ question: "Third Q", answer: "Third A" });
assert.deepEqual(deliveries.map((x) => x.id), [22, 11, 22]);

// Browser/session restarts: resort by last-access time, never first match.
tabs = [
  { id: 11, url: local, lastAccessed: 500 },
  { id: 22, url: hosted, lastAccessed: 1500 },
];
delete saved.tfPreferredBoardTabId;
assert.equal((await context.findThoughtFlowTab()).id, 22);
tabs.reverse();
assert.equal((await context.findThoughtFlowTab()).id, 22);

// One destination per Q+A, never duplicate writes to all open boards.
assert.equal(deliveries.length, 3);

console.log("PASS both boards open, hosted focus routing, local switch, closed-tab fallback, health target, no fanout");
