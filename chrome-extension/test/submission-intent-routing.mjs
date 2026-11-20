// Validate MV3 ChatGPT submission markers across page reloads.
// Run: node chrome-extension/test/submission-intent-routing.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
let onMessage = null;
const session = {};
const diagnostics = [];
const sessionStore = {
  async set(patch) { Object.assign(session, patch); },
  async get(key) { return key === null ? { ...session } : { [key]: session[key] }; },
  async remove(keys) { for (const key of [].concat(keys)) delete session[key]; },
};
const context = {
  URL, Date, console,
  importScripts() {},
  TFApi: {
    async getSettings() { return { captureEnabled: true }; },
    async putSession() {},
  },
  TFDebug: { log(type, detail) { diagnostics.push({ type, detail }); } },
  chrome: {
    storage: {
      session: sessionStore,
      local: { async get() { return { retryQueue: [] }; }, async set() {} },
    },
    runtime: {
      onMessage: { addListener(fn) { onMessage = fn; } },
      onInstalled: { addListener() {} },
    },
    tabs: {
      onUpdated: { addListener() {} },
      async query() { return []; },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
    },
  },
};
context.globalThis = context;
vm.runInNewContext(script, context, { filename: "background.js" });
assert.equal(typeof onMessage, "function");

function request(message, sender) {
  return new Promise((resolve) => {
    const async = onMessage(message, sender, resolve);
    if (async !== true) resolve(undefined);
  });
}
const sender = { tab: { id: 13 }, url: "https://chatgpt.com/" };
const other = { tab: { id: 14 }, url: "https://chatgpt.com/c/other" };
const invalid = { tab: { id: 13 }, url: "https://example.com" };
const key = "35:ab123zz";

assert.equal((await request({ type: "TF_CHATGPT_SUBMISSION", key }, sender)).ok, true);
assert.equal((await request({ type: "TF_CHATGPT_SUBMISSION_GET" }, sender)).key, key);
assert.equal((await request({ type: "TF_CHATGPT_SUBMISSION_GET" }, other)).key, undefined);
assert.equal((await request({ type: "TF_CHATGPT_SUBMISSION_GET" }, invalid)).ok, false);
assert.equal((await request({ type: "TF_CHATGPT_SUBMISSION", key }, invalid)).ok, false);
assert.equal(Object.keys(session).length, 1);
assert.ok(!JSON.stringify(session).includes("Explain binary search"));
assert.ok(diagnostics.some((d) => d.type === "submission-persisted"));
assert.ok(diagnostics.some((d) => d.type === "submission-restored"));

const storedKey = Object.keys(session)[0];
session[storedKey].expiresAt = Date.now() - 1000;
assert.equal((await request({ type: "TF_CHATGPT_SUBMISSION_GET" }, sender)).key, undefined);
assert.equal(Object.keys(session).length, 0);

console.log("PASS: Send marker stored as fingerprint, scoped to ChatGPT tab, expires safely");
