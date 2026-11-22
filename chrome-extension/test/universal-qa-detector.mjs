// Run: node chrome-extension/test/universal-qa-detector.mjs
// The same selector wrapper is used on ChatGPT, Gemini, DeepSeek, Copilot,
// and per-site opted-in AI chats. Never capture unrelated generic page blocks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../content/selectors-universal.js", import.meta.url), "utf8");
const genericSource = readFileSync(new URL("../content/selectors-generic.js", import.meta.url), "utf8");
const entry = readFileSync(new URL("../content/universal.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

const q = { role: "user", text: "What is Python?", id: "q1" };
const a = { role: "assistant", text: "Python is a programming language.", id: "a1" };
const q2 = { role: "user", text: "What is JavaScript?", id: "q2" };
const a2 = { role: "assistant", text: "JavaScript runs web applications.", id: "a2" };

function platform({ hostname, primaryRows, genericRows,
  genericStrategy = "roles", nativeStreaming = false,
  genericStreaming = false, platform = "generic" }) {
  let nativeRead = 0;
  let genericRead = 0;
  const generic = {
    platform: platform === "generic" ? "generic" : platform,
    label: platform,
    isSupportedPage: () => true,
    collectMessages: () => { genericRead++; return genericRows; },
    probeStrategy: () => genericStrategy,
    getConversationId: () => "/c/abc",
    isStreaming: () => genericStreaming,
  };
  const primary = primaryRows === null ? generic : {
    platform, label: platform,
    isSupportedPage: () => true,
    collectMessages: () => { nativeRead++; return primaryRows; },
    getConversationId: () => "/c/abc",
    isStreaming: () => nativeStreaming,
  };
  const context = {
    location: { hostname },
    TFDebug: { log() {} },
    TF_SELECTORS: primary,
    TF_GENERIC_SELECTORS: generic,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  const result = context.TF_SELECTORS;
  return {
    result,
    get nativeRead() { return nativeRead; },
    get genericRead() { return genericRead; },
  };
}

// ChatGPT's first/native extractor sees only one role. A role-based
// universal fallback can recover the answer instead of returning pairs=0.
const chatgpt = platform({
  hostname: "chatgpt.com", platform: "chatgpt",
  primaryRows: [q], genericRows: [q, a],
});
assert.equal(chatgpt.result.platform, "chatgpt");
assert.equal(chatgpt.result.collectMessages().length, 2);
assert.equal(chatgpt.result.probeStrategy(), "universal-roles");

// Gemini native adapter is more precise (removes "You said" labels).
// Generic extraction must NOT override it or its native streaming indicator.
const gemini = platform({
  hostname: "gemini.google.com", platform: "gemini",
  primaryRows: [q, a], genericRows: [q, a],
  nativeStreaming: false, genericStreaming: true,
});
assert.deepEqual(JSON.parse(JSON.stringify(gemini.result.collectMessages())), [q, a]);
assert.equal(gemini.result.probeStrategy(), "native");
assert.equal(gemini.result.isStreaming(), false);

// DeepSeek / Copilot / Claude etc. don't require separate JS capture logic.
for (const hostname of ["chat.deepseek.com", "copilot.microsoft.com", "claude.ai"]) {
  const known = platform({
    hostname, platform: "deepseek", primaryRows: null,
    genericRows: [q, a], genericStrategy: "roles",
  });
  assert.equal(known.result.collectMessages().length, 2, hostname);
  assert.equal(known.result.probeStrategy(), "universal-roles");
}

// An unknown opted-in AI site may be captured if the DOM includes
// recognizable, explicit user and assistant roles.
const opted = platform({
  hostname: "private-chat.example", primaryRows: null,
  genericRows: [q, a], genericStrategy: "roles",
});
assert.equal(opted.result.collectMessages().length, 2);

// Do NOT guess Q+A from arbitrary alternating blocks on unknown websites,
// even if they look like two plausible messages.
const unsafe = platform({
  hostname: "private-chat.example", primaryRows: null,
  genericRows: [q, a], genericStrategy: "alternating",
});
assert.equal(unsafe.result.collectMessages().length, 0);

// Known native adapter may emit an incomplete user turn while streaming;
// it should remain visible to the core until the assistant appears.
const onlyUser = platform({
  hostname: "gemini.google.com", platform: "gemini",
  primaryRows: [q], genericRows: [],
});
assert.equal(onlyUser.result.collectMessages().length, 1);
assert.equal(onlyUser.result.probeStrategy(), "native-partial");

// Actual generic selector regression: role attributes expose only the user,
// while turn containers contain both user and assistant. The selector must
// continue to the second strategy instead of returning msgs=1, pairs=0.
function fakeElement(text, role = "", id = "") {
  return {
    innerText: text, isConnected: true, id, tagName: "DIV",
    className: "", getClientRects: () => [1],
    getAttribute(name) { return name === "data-message-author-role" ? role : null; },
    contains(other) { return other === this; },
    compareDocumentPosition(other) { return this.id === "u" ? 4 : 2; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}
const userBody = fakeElement(q.text, "user", "u");
const assistantBody = fakeElement(a.text, "assistant", "a");
const userArticle = { ...fakeElement(q.text), querySelector(selector) {
  if (selector.includes(".whitespace-pre-wrap")) return userBody;
  return null;
} };
const assistantArticle = { ...fakeElement(a.text), querySelector(selector) {
  if (selector.includes(".markdown")) return assistantBody;
  return null;
} };
const genericContext = {
  location: { hostname: "chat.deepseek.com", pathname: "/chat/abc", search: "" },
  Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  URLSearchParams,
  document: { querySelectorAll(selector) {
    if (selector.includes("[data-message-author-role]")) return [userBody];
    if (selector.includes("main article")) return [userArticle, assistantArticle];
    return [];
  } },
};
genericContext.globalThis = genericContext;
vm.runInNewContext(genericSource, genericContext);
assert.equal(genericContext.TF_GENERIC_SELECTORS.collectMessages().length, 2);
assert.equal(genericContext.TF_GENERIC_SELECTORS.probeStrategy(), "turns");

// Shared capture entry is idempotent and status never reveals raw Q+A text.
let startCount = 0;
let onMessage;
const ctx = {
  TFCapture: { start(sel) { startCount++; assert.ok(sel.collectMessages); } },
  TF_SELECTORS: gemini.result,
  chrome: { runtime: { onMessage: { addListener(fn) { onMessage = fn; } } } },
};
ctx.globalThis = ctx;
vm.runInNewContext(entry, ctx);
vm.runInNewContext(entry, ctx);
assert.equal(startCount, 1);
let status;
onMessage({ type: "TF_AI_DETECTOR_STATUS" }, {}, (r) => { status = r; });
assert.equal(status.ready, true);
assert.equal(status.messages, 2);
assert.equal(status.pairs, 1);
assert.ok(!JSON.stringify(status).includes("Python is"));

// Installed supported hosts all use the same selector wrapper & capture entry.
for (const scripts of manifest.content_scripts.slice(0, 3)) {
  assert.ok(scripts.js.includes("content/capture-core.js"));
  assert.ok(scripts.js.includes("content/selectors-universal.js"));
  assert.ok(scripts.js.includes("content/universal.js"));
}
assert.ok(manifest.optional_host_permissions.includes("https://*/*"));

console.log("PASS: ChatGPT fallback, Gemini native preservation, DeepSeek/Copilot, safe opt-in, one shared engine");
