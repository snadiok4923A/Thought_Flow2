// Run: node chrome-extension/test/chatgpt-semantic-pairing.mjs
// Regression: ChatGPT must NEVER let arbitrary markdown blocks masquerade
// as new user/assistant turns just because the generic scanner counts more.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const nativeSource = readFileSync(new URL("../content/selectors-chatgpt.js", import.meta.url), "utf8");
const universalSource = readFileSync(new URL("../content/selectors-universal.js", import.meta.url), "utf8");

function el(index, text, role = "", id = "") {
  return {
    index, id, innerText: text, isConnected: true, className: "",
    getAttribute(n) { return n === "data-message-author-role" ? role :
      n === "data-message-id" ? id : null; },
    compareDocumentPosition(other) { return index < other.index ? 4 : 2; },
    contains(other) { return other === this; },
    querySelector() { return null; },
  };
}

const u1 = el(1, "old Q", "user", "u1");
const a1 = el(2, "old answer", "assistant", "a1");
const u2 = el(3, "Write Python code", "user", "u2");
const fullAnswer = "A complete Python example, including the whole code:\n" +
  "def solve(n):\n    return n*n\n\nThis works for integers.";
const a2 = el(4, fullAnswer, "", "a2");
const turns = [a1, a2].map((body) => ({
  ...el(body.index, body.innerText, "", body.id),
  querySelector(sel) { return sel.includes(".markdown") ? body : null; },
}));
const dom = {
  querySelectorAll(sel) {
    if (sel === "[data-message-author-role]") return [u1, a1, u2];
    if (sel === '[data-testid="user-message"]') return [u1, u2];
    if (sel.includes('conversation-turn-assistant')) return turns;
    return [];
  },
  querySelector() { return null; },
};
const ctx = {
  location: { hostname: "chatgpt.com", pathname: "/c/one", search: "" },
  document: dom, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, URLSearchParams,
};
ctx.globalThis = ctx;
vm.runInNewContext(nativeSource, ctx);
const rows = ctx.TF_SELECTORS.collectMessages();
assert.equal(rows.length, 4);
assert.equal(rows[3].role, "assistant");
assert.equal(rows[3].text, fullAnswer);
assert.equal(ctx.TF_SELECTORS.probeStrategy(), "testid");

// Native 1 complete pair vs generic 5 bogus alternating "pairs":
// the native transcript must win, never mode universal-alternating.
const primary = {
  platform: "chatgpt", label: "ChatGPT",
  isSupportedPage: () => true,
  getConversationId: () => "1",
  collectMessages: () => [
    { role: "user", text: "real question" },
    { role: "assistant", text: "real full answer" },
  ],
  isStreaming: () => false,
};
const generic = {
  ...primary, platform: "generic", probeStrategy: () => "alternating",
  collectMessages: () => Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    text: "misidentified markdown fragment " + i,
  })),
};
const shared = {
  location: { hostname: "chatgpt.com" },
  TF_SELECTORS: primary,
  TF_GENERIC_SELECTORS: generic,
};
shared.globalThis = shared;
vm.runInNewContext(universalSource, shared);
assert.equal(shared.TF_SELECTORS.probeStrategy(), "native");
assert.equal(shared.TF_SELECTORS.collectMessages().length, 2);
assert.equal(shared.TF_SELECTORS.probeStrategy(), "native");

// A semantically identified generic Q+A can still rescue incomplete native.
primary.collectMessages = () => [{ role: "user", text: "real question" }];
generic.probeStrategy = () => "roles";
generic.collectMessages = () => [
  { role: "user", text: "real question" },
  { role: "assistant", text: fullAnswer },
];
assert.equal(shared.TF_SELECTORS.collectMessages().length, 2);
assert.equal(shared.TF_SELECTORS.probeStrategy(), "universal-roles");

console.log("PASS native complete ChatGPT turn, reject bogus alternating, trust semantic fallback");
