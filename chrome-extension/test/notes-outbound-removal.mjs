// Run: node chrome-extension/test/notes-outbound-removal.mjs
// Removed UI must not accidentally disable automatic incoming Q+A capture.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const editor = read("../../src/components/RichTextEditor.jsx");
const app = read("../../src/App.jsx");
const bridge = read("../content/thoughtflow-bridge.js");
const background = read("../background.js");
const core = read("../content/capture-core.js");
const manifest = JSON.parse(read("../manifest.json"));

assert.doesNotMatch(editor, /Ask ChatGPT|onAsk|askStatus|asking\s*=/);
assert.doesNotMatch(app, /handleAskChatGPTFromNotes|noteAskPendingRef|noteAsk|onAsk=/);
assert.match(editor, /execCmd\('bold'\)/);
assert.match(editor, /execCmd\('italic'\)/);
assert.match(editor, /execCmd\('insertUnorderedList'\)/);
assert.match(editor, /handleZoomIn/);
assert.match(app, /<RichTextEditor/);
assert.match(app, /thoughtflow-capture-direct/);
assert.doesNotMatch(bridge, /TF_NOTES_AI_RESULT|thoughtflow-ask-chatgpt|TF_ASK_CHATGPT/);
assert.match(bridge, /TF_CAPTURE_DIRECT/);
assert.doesNotMatch(background, /TF_ASK_CHATGPT|TF_CHATGPT_ASK_RESULT|NOTE_JOB_PREFIX|chatgpt-ask\.js/);
assert.match(background, /if \(msg\.type === "TF_TRY_SEND"\)/);
assert.doesNotMatch(core, /allowPendingNoteQuestion|isPendingNotesQuestion|pendingNote/);
assert.match(core, /liveTurnEligible/);
assert.ok(manifest.content_scripts.some((script) =>
  script.js.includes("content/thoughtflow-bridge.js")
));
assert.equal(fs.existsSync(new URL("../content/chatgpt-ask.js", import.meta.url)), false);

// Verify actual background routes a live Q+A to a ThoughtFlow page. We mock
// Chrome API responses only; this uses the production background source.
const payload = {
  source: "ChatGPT", question: "What is binary search?",
  answer: "Binary search checks the middle of a sorted list.",
  fingerprint: "new-1",
};
let listener = null;
const delivered = [];
const stored = {};
const tab = { id: 2, url: "https://snadiok4923a.github.io/Thought_Flow2/" };
const chrome = {
  tabs: {
    onUpdated: { addListener() {} },
    onActivated: { addListener() {} },
    async query() { return [tab]; },
    async sendMessage(id, msg) {
      delivered.push({ id, msg });
      return { received: true, created: true };
    },
  },
  scripting: { async executeScript() {} },
  storage: {
    session: {
      async get(key) {
        if (typeof key === "string") return { [key]: stored[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, stored[k]]));
        return Object.assign({}, key || {}, stored);
      },
      async set(patch) { Object.assign(stored, patch); },
    },
    local: { async get() { return { retryQueue: [], tfDebugLog: [] }; } },
  },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {},
  },
  runtime: {
    onMessage: { addListener(fn) { listener = fn; } },
    onInstalled: { addListener() {} },
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
};
const sandbox = {
  chrome, URL, Date, setTimeout, clearTimeout,
  importScripts() {},
  TFDebug: { log() {} },
  TFApi: { async getSettings() { return { captureEnabled: true }; }, async putSession() {} },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(background, sandbox);
assert.equal(typeof listener, "function");
const result = await new Promise((resolve) => {
  const open = listener({ type: "TF_TRY_SEND", payload },
    { url: "https://chatgpt.com/c/new", tab: { id: 1 } }, resolve);
  assert.equal(open, true);
});
assert.equal(result.accepted, true);
assert.equal(delivered.length, 1);
assert.equal(delivered[0].id, tab.id);
assert.equal(delivered[0].msg.type, "TF_CAPTURE_DIRECT");
assert.equal(delivered[0].msg.payload.answer, payload.answer);
assert.equal(stored.liveCapturedCount, 1);

// No background handler exists to send a Notes question to ChatGPT.
const unused = listener({ type: "TF_ASK_CHATGPT", question: "Please ask ChatGPT" }, {}, () => {});
assert.equal(unused, undefined);
console.log("PASS Notes outbound UI removed, no Ask messaging, ChatGPT/Gemini inbound direct capture preserved");
