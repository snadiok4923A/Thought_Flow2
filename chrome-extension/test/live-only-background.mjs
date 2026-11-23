// Run: node chrome-extension/test/live-only-background.mjs
// The previous implementation stored retryQueue/capturedCount in local storage.
// Live-only must NOT replay that queue after an alarm, and live count starts 0.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
let alarmHandler = null;
let messageHandler = null;
let posted = 0;
const local = {
  retryQueue: [{ payload: { question: "old", answer: "historical answer" }, tries: 2 }],
  capturedCount: 48,
};
const session = {};
const chrome = {
  alarms: {
    create() {},
    onAlarm: { addListener(fn) { alarmHandler = fn; } },
  },
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { messageHandler = fn; } },
  },
  tabs: {
    onUpdated: { addListener() {} },
    async query() { return []; },
  },
  storage: {
    local: {
      async get(keys) { return { ...local }; },
      async set(update) { Object.assign(local, update); },
    },
    session: {
      async get(key) {
        if (key === null) return { ...session };
        if (typeof key === "string") return { [key]: session[key] };
        const result = { ...key };
        for (const k of Object.keys(key || {})) {
          if (Object.hasOwn(session, k)) result[k] = session[k];
        }
        return result;
      },
      async set(update) { Object.assign(session, update); },
      async remove(key) { for (const k of [].concat(key)) delete session[k]; },
    },
  },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {},
  },
};
const context = {
  chrome, Date, URL, console,
  importScripts() {},
  TFDebug: { log() {} },
  TFApi: {
    async putSession() {},
    async getSettings() { return { captureEnabled: true }; },
    async postCapture() { posted++; },
  },
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "background.js" });
assert.equal(typeof alarmHandler, "function");
assert.equal(typeof messageHandler, "function");

alarmHandler({ name: "tf-retry" });
for (let i = 0; i < 12; i++) await Promise.resolve();
assert.equal(posted, 0, "legacy queued conversations must never be posted");
assert.equal(local.retryQueue.length, 1, "do not silently delete older user data");
assert.equal(local.capturedCount, 48, "preserve historical counter without using it");

const liveCount = await new Promise((resolve) =>
  messageHandler({ type: "TF_STATS" }, {}, resolve));
assert.equal(liveCount.captured, 0, "popup counter starts at 0 for new live session");

console.log("PASS no old background queue replay, legacy data preserved, live counter is session-scoped");
