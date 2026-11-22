// Run: node chrome-extension/test/optin-site-registration.mjs
// Unknown AI sites must request a site-specific permission before reading chat.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../popup/popup.js", import.meta.url), "utf8");
let granted = false;
const requested = [];
const registered = [];
const injections = [];
const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) {
    const handlers = new Map();
    nodes.set(id, {
      id, handlers, hidden: true, open: false, disabled: false,
      value: "", textContent: "", className: "",
      setAttribute() {},
      querySelector() { return { textContent: "" }; },
      addEventListener(type, fn) { handlers.set(type, fn); },
    });
  }
  return nodes.get(id);
}
const document = {
  getElementById: node,
  addEventListener() {},
};
const currentTab = { id: 42, url: "https://my-ai-chat.example/room/123" };
const chrome = {
  tabs: {
    async query() { return [currentTab]; },
    async sendMessage() { return null; },
  },
  permissions: {
    async contains() { return granted; },
    async request(spec) {
      requested.push(spec);
      granted = true;
      return true;
    },
  },
  scripting: {
    async getRegisteredContentScripts() { return []; },
    async registerContentScripts(list) { registered.push(...list); },
    async updateContentScripts() { throw new Error("unexpected script update"); },
    async executeScript(spec) { injections.push(spec); },
  },
  runtime: {
    async sendMessage(msg) {
      if (msg.type === "TF_HEALTH") return { connected: true, storage: "direct" };
      if (msg.type === "TF_STATS") return { captured: 0 };
      if (msg.type === "TF_GET_SESSION") return { direction: "right" };
      return {};
    },
  },
  storage: { local: { get(_keys, cb) { cb({ tfDebugLog: [] }); } } },
};
const api = {
  DEFAULTS: { captureEnabled: true },
  async getSettings() {
    return { captureEnabled: true, stabilityMs: 2000, apiBase: "http://localhost:5001/api" };
  },
};
const context = { document, chrome, TFApi: api, URL, Date, console };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "popup.js" });

for (let i = 0; i < 25; i++) await Promise.resolve();
assert.equal(node("enableSiteRow").hidden, false);
assert.equal(registered.length, 0, "Unknown AI site must not auto-inject before consent");
const click = node("enableSiteBtn").handlers.get("click");
assert.equal(typeof click, "function");
await click();
assert.deepEqual(JSON.parse(JSON.stringify(requested)), [
  { origins: ["https://my-ai-chat.example/*"] },
]);
assert.equal(registered.length, 1);
assert.equal(registered[0].persistAcrossSessions, true);
assert.ok(registered[0].js.includes("content/universal.js"));
assert.ok(registered[0].js.includes("content/selectors-generic.js"));
assert.equal(injections.length, 1);
assert.equal(injections[0].target.tabId, 42);
assert.equal(node("enableSiteBtn").disabled, true);
console.log("PASS opt-in permission is per host, persisted, and no script injected before consent");
