// Regression test for Notes -> logged-in ChatGPT browser tab -> same Note.
// Run from the repository root: node chrome-extension/test/ask-chatgpt-note.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../content/chatgpt-ask.js", import.meta.url), "utf8");

function harness({ draft = "", reply = "NEW ANSWER", noReply = false } = {}) {
  let listener = null;
  let now = 10000;
  let sent = false;
  const editor = { tagName: "DIV", innerText: draft, focus() {} };
  const messages = [{ role: "assistant", text: "OLD ANSWER" }];
  const send = {
    disabled: false,
    click() {
      sent = true;
      messages.push({ role: "user", text: editor.innerText });
      if (!noReply) messages.push({ role: "assistant", text: reply });
    },
  };
  const context = {
    chrome: {
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
      },
    },
    document: {
      querySelector(selector) {
        if (selector.includes("#prompt-textarea")) return editor;
        if (selector.includes('button[data-testid="send-button"]')) return send;
        return null;
      },
      execCommand(command, unused, text) {
        assert.equal(command, "insertText");
        editor.innerText = text;
        return true;
      },
    },
    Date: { now: () => now },
    setTimeout(fn, ms) { now += ms; queueMicrotask(fn); return 1; },
  };
  context.globalThis = context;
  context.TF_SELECTORS = {
    collectMessages: () => messages,
    isStreaming: () => false,
  };
  vm.runInNewContext(code, context, { filename: "chatgpt-ask.js" });
  assert.equal(typeof listener, "function");
  return {
    async ask(question) {
      return new Promise((resolve) => {
        const keepOpen = listener({ type: "TF_CHATGPT_ASK", question }, {}, resolve);
        assert.equal(keepOpen, true);
      });
    },
    get sent() { return sent; },
    get editorText() { return editor.innerText; },
    get suppressed() { return context.__tfOutboundQuestions || new Set(); },
  };
}

const success = harness();
const response = await success.ask("What is CSS?");
assert.equal(response.ok, true);
assert.equal(response.answer, "NEW ANSWER"); // never use the old response
assert.equal(success.sent, true);
assert.equal(success.editorText, "What is CSS?");
assert.equal(success.suppressed.has("What is CSS?"), true); // no duplicate child

const draft = harness({ draft: "Important unsent message" });
const rejected = await draft.ask("What is CSS?");
assert.equal(rejected.ok, false);
assert.match(rejected.error, /unfinished draft/);
assert.equal(draft.sent, false);
assert.equal(draft.editorText, "Important unsent message");
assert.equal(draft.suppressed.size, 0);

const timeout = harness({ noReply: true });
const failed = await timeout.ask("What is RAM?");
assert.equal(failed.ok, false);
assert.match(failed.error, /did not finish/);
console.log("PASS: existing ChatGPT tab ask, new-answer detection, draft safety, suppression, and timeout");
