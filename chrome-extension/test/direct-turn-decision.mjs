// Regression: direct delivery must not create a second node for a turn whose
// answer finished streaming after the first capture — and must never overwrite
// a note the user edited.
//   node chrome-extension/test/direct-turn-decision.mjs
import assert from "node:assert/strict";
import {
  buildCaptureNoteHtml,
  decideDirectCapture,
  loadDirectTurnLedger,
  saveDirectTurnLedger,
} from "../../src/utils/aiCapture.js";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
};

const question = "Explain closures";
const partial = "A closure captures its scope.";
const full = "A closure captures its scope.\n\nfunction f() { return 1; }";

// First delivery → create.
assert.deepEqual(
  decideDirectCapture({ question, answer: partial, ledgerEntry: null, nodeNotes: null }),
  { action: "create" }
);

// Same delivery retried after a lost ack → duplicate (no second node).
assert.deepEqual(
  decideDirectCapture({
    question,
    answer: partial,
    ledgerEntry: { nodeId: "n1", question, answer: partial },
    nodeNotes: buildCaptureNoteHtml({ question, answer: partial }),
  }),
  { action: "duplicate" }
);

// Answer grew while streaming and the note is untouched → update in place.
assert.deepEqual(
  decideDirectCapture({
    question,
    answer: full,
    ledgerEntry: { nodeId: "n1", question, answer: partial },
    nodeNotes: buildCaptureNoteHtml({ question, answer: partial }),
  }),
  { action: "update" }
);

// The user edited the note → leave their text alone.
assert.deepEqual(
  decideDirectCapture({
    question,
    answer: full,
    ledgerEntry: { nodeId: "n1", question, answer: partial },
    nodeNotes: "<p>my own notes</p>",
  }),
  { action: "duplicate" }
);

// Node no longer exists (board switched / deleted) → create again.
assert.deepEqual(
  decideDirectCapture({
    question,
    answer: partial,
    ledgerEntry: { nodeId: "gone", question, answer: partial },
    nodeNotes: null,
  }),
  { action: "create" }
);

// Ledger persists per fingerprint and survives a reload.
const fp = "direct-abc";
saveDirectTurnLedger({ [fp]: { nodeId: "n1", question, answer: partial } });
const reloaded = loadDirectTurnLedger();
assert.deepEqual(reloaded[fp], { nodeId: "n1", question, answer: partial });

console.log("PASS direct capture creates once, updates grown answers, respects edited notes");
