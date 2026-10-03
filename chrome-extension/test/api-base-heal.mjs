// Verifies the popup's broken stored setting self-heals:
//   apiBase = "http://localhost:5173/Thought_Flow2/"  (the Vite frontend — wrong)
// must normalize to the real backend and the health call must succeed.
//   node test/api-base-heal.mjs
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syncStore = {
  apiBase: "http://localhost:5173/Thought_Flow2/", // exactly what the user had
  token: "tf-local-capture-token",
};

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
  URL,
  URLSearchParams,
  chrome: {
    storage: {
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
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: {
      lastError: null,
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
    },
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);

vm.runInContext(fs.readFileSync(path.join(dir, "utils", "debug.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(dir, "utils", "api.js"), "utf8"), ctx);

const results = [];
const check = (name, cond, extra) => {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  return cond;
};

const settings = await ctx.TFApi.getSettings();
check(
  "wrong 5173 URL normalized to backend",
  settings.apiBase === "http://localhost:5001/api",
  settings.apiBase
);
check("correction persisted to storage", syncStore.apiBase === "http://localhost:5001/api", syncStore.apiBase);

try {
  const h = await ctx.TFApi.health();
  check("health reachable after heal", h && (h.status === "ok" || h.ok === true), JSON.stringify(h));
} catch (e) {
  check("health reachable after heal", false, e.message);
}

// A host:port with a wrong path keeps the port, gains /api.
syncStore.apiBase = "http://localhost:5001/Thought_Flow2/";
const s2 = await ctx.TFApi.getSettings();
check(
  "custom port preserved, path fixed to /api",
  s2.apiBase === "http://localhost:5001/api",
  s2.apiBase
);

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "API-BASE HEAL: ALL PASS" : `API-BASE HEAL: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
