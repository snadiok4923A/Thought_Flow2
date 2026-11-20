// Regression tests for Gemini's hidden "You said" / "Gemini said" labels.
// Run from the repository root: node chrome-extension/test/gemini-clean-capture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildCaptureNoteHtml, shortenQuestionTitle } from "../../src/utils/aiCapture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const selectorFile = fs.readFileSync(path.join(here, "..", "content", "selectors-gemini.js"), "utf8");

function extract({ userText, assistantText, userLines = [], assistantBody = null }) {
  const user = {
    innerText: userText,
    id: "user-1",
    contains: () => false,
    getAttribute: () => null,
    compareDocumentPosition: () => 4,
    querySelectorAll: (selector) => selector.includes("query-text-line")
      ? userLines.map((innerText) => ({ innerText }))
      : [],
    querySelector: () => null,
  };
  const assistant = {
    innerText: assistantText,
    id: "model-1",
    contains: () => false,
    getAttribute: () => null,
    compareDocumentPosition: () => 2,
    querySelectorAll: () => [],
    querySelector: (selector) => selector.includes("model-response-text") && assistantBody
      ? { innerText: assistantBody }
      : null,
  };
  const context = {
    document: {
      querySelectorAll: (selector) =>
        selector === "user-query" ? [user] :
          selector === "model-response" ? [assistant] : [],
      querySelector: () => null,
    },
    location: { hostname: "gemini.google.com", pathname: "/app/test-conversation" },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  };
  context.globalThis = context;
  vm.runInNewContext(selectorFile, context);
  return Array.from(context.TF_SELECTORS.collectMessages(), ({ role, text }) => ({ role, text }));
}

const first = extract({
  userText: "You said hi\nhi",
  assistantText: "Gemini said\nHey! How can I help you today?",
  userLines: ["hi"],
  assistantBody: "Hey! How can I help you today?",
});
assert.deepEqual(first, [
  { role: "user", text: "hi" },
  { role: "assistant", text: "Hey! How can I help you today?" },
]);

const multiline = extract({
  userText: "You said\nFirst line\nSecond line",
  assistantText: "Gemini said\nTwo lines\nOf answer",
  userLines: ["First line", "Second line"],
  assistantBody: "Two lines\nOf answer",
});
assert.deepEqual(multiline, [
  { role: "user", text: "First line\nSecond line" },
  { role: "assistant", text: "Two lines\nOf answer" },
]);

assert.deepEqual(extract({
  userText: "You said\nWhat is AI?",
  assistantText: "Gemini said\nA computer science field.",
}), [
  { role: "user", text: "What is AI?" },
  { role: "assistant", text: "A computer science field." },
]);

assert.deepEqual(extract({
  userText: "You said hi\nhi",
  assistantText: "Gemini said\nHello.",
}), [
  { role: "user", text: "hi" },
  { role: "assistant", text: "Hello." },
]);

const html = buildCaptureNoteHtml({
  source: "gemini",
  question: "What is AI?",
  answer: "AI means artificial intelligence.",
});
assert.equal(html, "<p>What is AI?</p><p><br></p><p>AI means artificial intelligence.</p>");
assert.equal(shortenQuestionTitle(first[0].text), "hi");
assert.equal(
  buildCaptureNoteHtml({ source: "chatgpt", question: "<b>hi</b>", answer: "A&B" }),
  "<p>&lt;b&gt;hi&lt;/b&gt;</p><p><br></p><p>A&amp;B</p>"
);
console.log("PASS Gemini clean Q+A capture, multiline, fallbacks, titles and HTML escaping");
