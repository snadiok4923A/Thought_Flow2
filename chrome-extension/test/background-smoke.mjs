// Smoke test: executes the REAL background.js (chrome shims, no browser)
// against the LIVE capture API and asserts the message pipeline.
//   node test/background-smoke.mjs
// Exit code 0 = all assertions passed.
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "http://localhost:5001/api";
const TOKEN = "tf-local-capture-token";

const localStore = {};
const syncStore = {};
let messageHandler = null;

const ctx = {
  console,
  fetch,
  setTimeout,
  clearTimeout,
  Date,
  JSON,
  Math,
  String,
  Number,
  Array,
  Object,
  Promise,
  Error,
  Boolean,
  RegExp,
  URLSearchParams,
  importScripts: (...files) =>
    files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx)),
  chrome: {
    storage: {
      local: {
        // Real chrome.storage supports callback AND promise styles.
        get: (k, cb) => {
          const out = {};
          if (Array.isArray(k)) k.forEach((key) => (out[key] = localStore[key]));
          else if (k && typeof k === "object")
            Object.keys(k).forEach((key) => (out[key] = key in localStore ? localStore[key] : k[key]));
          else if (typeof k === "string") out[k] = localStore[k];
          if (cb) cb(out);
          else return Promise.resolve(out);
        },
        set: (o, cb) => {
          Object.assign(localStore, o);
          if (cb) cb();
          else return Promise.resolve();
        },
      },
      sync: {
        get: (d, cb) => {
          const out = { ...(d || {}), ...syncStore };
          if (cb) cb(out);
          else return Promise.resolve(out);
        },
        set: (o, cb) => {
          Object.assign(syncStore, o);
          if (cb) cb();
          else return Promise.resolve();
        },
      },
      onChanged: { addListener: () => {} },
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: {
      lastError: null,
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn) => (messageHandler = fn) },
    },
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);

vm.runInContext(fs.readFileSync(path.join(dir, "background.js"), "utf8"), ctx);

if (typeof messageHandler !== "function") {
  console.error("FAIL: background.js did not register onMessage");
  process.exit(1);
}

const send = (msg) =>
  new Promise((resolve) => {
    const async = messageHandler(msg, {}, resolve);
    if (async !== true) resolve(undefined);
  });

const api = (p, method = "GET", body) =>
  fetch(API + p, {
    method,
    headers: { "Content-Type": "application/json", "X-Capture-Token": TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra) => {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  return cond;
};

// Wait for the top-level heartbeat() to reach the API.
await sleep(1500);

const health = await send({ type: "TF_HEALTH" });
check("TF_HEALTH reports connected", health && health.connected === true, JSON.stringify(health));

const session0 = await api("/ai-capture/session");
check(
  "heartbeat written to session",
  typeof session0.extensionHeartbeat === "number" && Date.now() - session0.extensionHeartbeat < 10000
);

const diag = await send({ type: "TF_DIAGNOSE" });
check("TF_DIAGNOSE gate OK", diag && diag.gate === "OK", diag && diag.gate);
check("TF_DIAGNOSE api ok", diag && diag.api && diag.api.ok === true);

// 1) Happy path: capture reaches the API with the website session open.
const payload = {
  source: "chatgpt",
  conversationId: "smoke",
  question: "Smoke test question?",
  answer: "Smoke test answer.",
};
const res1 = await send({ type: "TF_TRY_SEND", payload });
check("TF_TRY_SEND accepted", res1 && res1.accepted === true, JSON.stringify(res1));
const pending = await api("/ai-capture/pending");
check("pair visible as pending", pending.items.some((i) => i.question === payload.question));

// 2) Popup OFF → drop.
syncStore.captureEnabled = false;
const res2 = await send({ type: "TF_TRY_SEND", payload: { ...payload, question: "Q2?" } });
check("popup OFF drops", res2 && res2.drop === true && res2.reason === "extension-off", JSON.stringify(res2));
syncStore.captureEnabled = true;

// 3) Website panel OFF → drop.
const savedSession = { ...session0 };
await api("/ai-capture/session", "PUT", { enabled: false });
const res3 = await send({ type: "TF_TRY_SEND", payload: { ...payload, question: "Q3?" } });
check("panel OFF drops", res3 && res3.drop === true && res3.reason === "website-off", JSON.stringify(res3));

// 4) Panel ON but no start node → drop.
await api("/ai-capture/session", "PUT", { enabled: true, rootNodeId: null, currentParentNodeId: null });
const res4 = await send({ type: "TF_TRY_SEND", payload: { ...payload, question: "Q4?" } });
check("no start node drops", res4 && res4.drop === true && res4.reason === "website-off", JSON.stringify(res4));

// Cleanup: remove smoke pair, restore session, clear simulated heartbeat.
await api("/ai-capture/session", "PUT", {
  enabled: true,
  direction: "right",
  rootNodeId: "root",
  currentParentNodeId: "root",
  extensionHeartbeat: null,
});
await api("/ai-capture/pending").then(async (p) => {
  for (const item of p.items.filter((i) => i.conversationId === "smoke")) {
    await fetch(`${API}/ai-capture/${item.id}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Capture-Token": TOKEN },
      body: JSON.stringify({ status: "unapplied", nodeId: null }),
    });
  }
});

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "SMOKE TEST: ALL PASS" : `SMOKE TEST: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
