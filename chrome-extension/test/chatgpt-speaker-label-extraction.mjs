// Regression: ChatGPT's hidden speaker heading must never become the answer.
// The reported bug: Notes contained only "another" + "ChatGPT said:".
//   node chrome-extension/test/chatgpt-speaker-label-extraction.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const selectorsSource = fs.readFileSync(
  new URL("../content/selectors-chatgpt.js", import.meta.url),
  "utf8"
);

// ---- Minimal DOM ------------------------------------------------------------
// Only the selector constructs this adapter uses: tag, .class, [attr],
// [attr="v"], [attr*="v"]. No combinators are needed because adapters query
// descendants directly.
let order = 0;
class El {
  constructor(tag, { attrs = {}, text = "", classes = [], children = [] } = {}) {
    this.tag = tag;
    this.attrs = attrs;
    this.ownText = text;
    this.classes = classes;
    this.children = children;
    this.order = ++order;
    children.forEach((c) => { c.parent = this; });
  }
  get innerText() {
    return [this.ownText, ...this.children.map((c) => c.innerText)]
      .filter((part) => part !== "")
      .join("\n");
  }
  get className() { return this.classes.join(" "); }
  get id() { return this.attrs.id || ""; }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null;
  }
  contains(node) {
    let p = node;
    while (p) { if (p === this) return true; p = p.parent; }
    return false;
  }
  querySelectorAll(selector) { return querySelectorAll(this, selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  compareDocumentPosition(other) { return this.order < other.order ? 4 : 2; }
  matches(selector) {
    return String(selector).split(",").some((part) => matchesSimple(this, part));
  }
}

function matchesSimple(el, rawPart) {
  const part = String(rawPart).trim().replace(/'/g, '"');
  if (!part || part.includes(" ")) return false;
  let i = 0;
  const tag = part.match(/^[a-zA-Z][\w-]*/);
  if (tag) {
    if (el.tag.toLowerCase() !== tag[0].toLowerCase()) return false;
    i = tag[0].length;
  }
  while (i < part.length) {
    const ch = part[i];
    if (ch === ".") {
      const m = part.slice(i + 1).match(/^[\w-]+/);
      if (!m || !el.classes.includes(m[0])) return false;
      i += 1 + m[0].length;
    } else if (ch === "#") {
      const m = part.slice(i + 1).match(/^[\w-]+/);
      if (!m || el.id !== m[0]) return false;
      i += 1 + m[0].length;
    } else if (ch === "[") {
      const end = part.indexOf("]", i);
      if (end < 0) return false;
      const am = part.slice(i + 1, end).match(/^([\w-]+)(?:(\*?=)"([^"]*)")?$/);
      if (!am) return false;
      const value = el.getAttribute(am[1]);
      if (value === null) return false;
      if (am[2] === "=" && value !== am[3]) return false;
      if (am[2] === "*=" && !value.includes(am[3])) return false;
      i = end + 1;
    } else {
      return false;
    }
  }
  return true;
}

function walk(root, out) {
  for (const child of root.children) { out.push(child); walk(child, out); }
  return out;
}

let roots = [];
function querySelectorAll(root, selector) {
  return walk(root, []).filter((el) => el.matches(selector));
}

const document = {
  querySelectorAll(selector) {
    return roots.flatMap((root) => querySelectorAll(root, selector));
  },
  querySelector() { return null; },
};

const ctx = {
  document,
  location: { hostname: "chatgpt.com", pathname: "/c/abc123", search: "" },
  Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  URLSearchParams,
};
ctx.globalThis = ctx;
vm.runInNewContext(selectorsSource, ctx);
const selectors = ctx.TF_SELECTORS;

const question = "another";
const answer = [
  "Here is another Python coding question.",
  "",
  "Problem: given a list of integers, find the maximum sum of a contiguous subarray.",
  "",
  "Steps:",
  "1. Track the running sum.",
  "2. Reset it when it drops below the current value.",
  "3. Remember the best sum seen so far.",
  "",
  "Solution:",
  "def max_subarray(nums):",
  "    best = running = nums[0]",
  "    for x in nums[1:]:",
  "        running = max(x, running + x)",
  "        best = max(best, running)",
  "    return best",
].join("\n");

function buildConversation({ markdownText, extraBlocks = [] }) {
  const userMessage = new El("div", {
    attrs: { "data-testid": "user-message" },
    text: "You said:\n" + question,
  });
  const userTurn = new El("article", {
    attrs: { "data-testid": "conversation-turn-user" },
    children: [userMessage],
  });

  const markdown = new El("div", { classes: ["markdown"], text: markdownText });
  const blocks = [markdown, ...extraBlocks];
  const role = new El("div", {
    attrs: { "data-message-author-role": "assistant", "data-message-id": "asst-1" },
    children: [
      // ChatGPT's visually hidden speaker heading, rendered BEFORE the answer.
      new El("h6", { text: "ChatGPT said:" }),
      ...blocks,
    ],
  });
  const assistantTurn = new El("article", {
    attrs: { "data-testid": "conversation-turn-assistant" },
    children: [role],
  });

  roots = [new El("main", { children: [userTurn, assistantTurn] })];
  return { assistantTurn, role, markdown };
}

// ---- A. An assistant turn that has only its speaker heading is NOT an answer.
buildConversation({ markdownText: "" });
let rows = selectors.collectMessages();
assert.equal(rows.filter((r) => r.role === "assistant").length, 0,
  "a label-only assistant container must not be collected as an answer");
assert.equal(rows.length, 1, "only the question exists until the body renders");

// ---- B/C. Full multi-block Python answer, label heading stripped.
const codeBlock = new El("div", {
  classes: ["markdown"],
  text: "Output:\n6",
});
buildConversation({ markdownText: answer, extraBlocks: [codeBlock] });
rows = selectors.collectMessages();
assert.equal(rows.length, 2, "question + answer");
assert.equal(rows[0].role, "user");
assert.equal(rows[0].text, question, "the hidden 'You said:' label is not part of the question");
assert.equal(rows[1].role, "assistant");
assert.ok(rows[1].text.startsWith("Here is another Python coding question."),
  "the answer starts with the real content, not a speaker label");
assert.ok(rows[1].text.includes("def max_subarray(nums):"), "code block preserved");
assert.ok(rows[1].text.includes("running = max(x, running + x)"), "code indentation preserved");
assert.ok(rows[1].text.includes("3. Remember the best sum seen so far."), "lists preserved");
assert.ok(rows[1].text.includes("6"), "a second answer container is merged, not dropped");
assert.doesNotMatch(rows[1].text, /ChatGPT said:/i, "speaker label must never reach Notes");
assert.doesNotMatch(rows[0].text, /You said:/i);

// ---- D. A logical answer that legitimately mentions the phrase mid-sentence
// is still delivered (only whole label lines are removed).
buildConversation({
  markdownText: "Copying the label the UI shows in its header.\nIt reads ChatGPT said: at the top.",
});
rows = selectors.collectMessages();
assert.equal(rows.length, 2);
assert.match(rows[1].text, /It reads ChatGPT said: at the top\./,
  "inline mentions of the phrase are content, not chrome");

// ---- E. Long answer is preserved in full (no truncation at the first block).
const longAnswer = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}: detail.`).join("\n");
buildConversation({ markdownText: longAnswer });
rows = selectors.collectMessages();
assert.equal(rows[1].text, longAnswer, "long answers survive extraction unchanged");

console.log("PASS ChatGPT speaker label stripped, label-only stub rejected, multi-block answer complete");
