// Run: node chrome-extension/test/reload-repairs-ai-tabs.mjs
// Both ChatGPT and Gemini can remain open while an extension is reloaded.
// This test verifies the shared injector repairs both tabs, not just one.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
let installed = null;
const injections = [];
const updates = [];
const mockChrome = {
  storage: {
    local: { async get() { return { retryQueue: [] }; }, async set() {} },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
  },
  runtime: {
    onMessage: { addListener() {} },
    onInstalled: { addListener(handler) { installed = handler; } },
  },
  tabs: {
    onUpdated: { addListener(fn) { updates.push(fn); } },
    async query() {
      return [
        { id: 10, url: "https://chatgpt.com/c/xyz" },
        { id: 11, url: "https://gemini.google.com/app/abc" },
        { id: 12, url: "https://chat.deepseek.com/a" },
        { id: 13, url: "https://sensitive.example/account" }, // NEVER inject
      ];
    },
  },
  scripting: {
    async executeScript({ target, func, files, world }) {
      assert.equal(world, "ISOLATED");
      if (func) return [{ result: false }]; // old tabs have no loaded script
      injections.push({ tab: target.tabId, files });
    },
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {},
  },
};
const context = {
  chrome: mockChrome, console, URL, Date, setTimeout, clearTimeout,
  importScripts() {},
  TFDebug: { log() {} },
  TFApi: { async putSession() {}, async setSettings() {} },
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "background.js" });

assert.equal(typeof installed, "function");
await installed({ reason: "update" });

assert.deepEqual(injections.map((x) => x.tab).sort((a, b) => a - b), [10, 11, 12]);
const chatgpt = injections.find((x) => x.tab === 10);
const gemini = injections.find((x) => x.tab === 11);
const generic = injections.find((x) => x.tab === 12);
assert.ok(chatgpt.files.includes("content/selectors-chatgpt.js"));
assert.ok(gemini.files.includes("content/selectors-gemini.js"));
assert.ok(generic.files.includes("content/selectors-generic.js"));
for (const injection of injections) {
  assert.ok(injection.files.includes("content/selectors-universal.js"));
  assert.ok(injection.files.includes("content/universal.js"));
}
assert.ok(!injections.some((x) => x.tab === 13));
assert.ok(updates.length > 0);
console.log("PASS existing ChatGPT/Gemini/DeepSeek tabs repaired with shared detector; unrelated sites untouched");
