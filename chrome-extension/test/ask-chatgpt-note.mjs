// No real ChatGPT account needed. Exercises the fast-ack + separate-reply
// messaging protocol in the actual content script.
// Run: node chrome-extension/test/ask-chatgpt-note.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../content/chatgpt-ask.js", import.meta.url), "utf8");

function harness({ draft = "", reply = "NEW ANSWER", noReply = false, navigate = false } = {}) {
  const listeners = [];
  let now = 10000;
  let sent = false;
  const sentResults = [];
  const editor = { tagName: "DIV", innerText: draft, focus() {} };
  const messages = [{ role: "assistant", text: "OLD ANSWER" }];
  const send = {
    disabled: false,
    click() {
      sent = true;
      if (navigate) {
        context.location.pathname = "/c/newly-created-chat";
        messages.length = 0;
      }
      messages.push({ role: "user", text: editor.innerText });
      if (!noReply) messages.push({ role: "assistant", text: reply });
    },
  };
  const context = {
    console,
    chrome: {
      runtime: {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        sendMessage: async (msg) => {
          sentResults.push(msg);
          return { ok: true, delivered: true };
        },
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
    location: { pathname: "/" },
    Date: { now: () => now },
    setTimeout(fn, ms) { now += ms; queueMicrotask(fn); return 1; },
  };
  context.globalThis = context;
  context.TF_SELECTORS = {
    collectMessages: () => messages,
    isStreaming: () => false,
  };
  vm.runInNewContext(code, context, { filename: "chatgpt-ask.js" });
  assert.equal(listeners.length, 2);

  return {
    start(question, requestId = "tf-notes-123-test") {
      return new Promise((resolve) => {
        const handler = listeners[0];
        handler({ type: "TF_CHATGPT_ASK_START", requestId, question }, {}, resolve);
      });
    },
    resume(requestId, questionKey) {
      return new Promise((resolve) => {
        listeners[1]({ type: "TF_CHATGPT_ASK_RESUME", requestId, questionKey }, {}, resolve);
      });
    },
    get messages() { return messages; },
    async waitForResult() {
      for (let i = 0; i < 400 && sentResults.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(sentResults.length, "Separate completion event was not dispatched");
      return sentResults[0];
    },
    get sent() { return sent; },
    get editorText() { return editor.innerText; },
    get suppressed() { return context.__tfOutboundQuestions || new Set(); },
  };
}

const success = harness();
const ack = await success.start("What is CSS?");
assert.equal(ack.ok, true);
assert.equal(ack.started, true); // Acknowledges before the answer is completed.
const delivered = await success.waitForResult();
assert.equal(delivered.type, "TF_CHATGPT_ASK_RESULT");
assert.equal(delivered.requestId, "tf-notes-123-test");
assert.equal(delivered.result.ok, true);
assert.equal(delivered.result.answer, "NEW ANSWER"); // not the old answer
assert.equal(success.sent, true);
assert.equal(success.editorText, "What is CSS?");
assert.equal(success.suppressed.has("What is CSS?"), true);

// ChatGPT's new-chat navigation must not discard the exact user's answer.
const navigate = harness({ navigate: true });
const navAck = await navigate.start("What is your name?", "tf-notes-123-nav");
assert.equal(navAck.started, true);
const navReply = await navigate.waitForResult();
assert.equal(navReply.result.ok, true);
assert.equal(navReply.result.answer, "NEW ANSWER");

const draft = harness({ draft: "Important unsent message" });
const draftAck = await draft.start("What is CSS?");
assert.equal(draftAck.started, true);
const draftReply = await draft.waitForResult();
assert.equal(draftReply.result.ok, false);
assert.match(draftReply.result.error, /unfinished draft/);
assert.equal(draft.sent, false);
assert.equal(draft.editorText, "Important unsent message");
assert.equal(draft.suppressed.size, 0);

const timeout = harness({ noReply: true });
assert.equal((await timeout.start("What is RAM?")).started, true);
const timeoutReply = await timeout.waitForResult();
assert.equal(timeoutReply.result.ok, false);
assert.match(timeoutReply.result.error, /was not detected/);

const badId = harness();
const rejected = await badId.start("test", "bogus-request-id");
assert.equal(rejected.ok, false);
assert.match(rejected.error, /Invalid Notes request ID/);
assert.equal(badId.sent, false);
console.log("PASS: immediate ack, navigation, separate completion, new answer, draft safety, timeout, validation");
