// Automated tests for the shared capture engine (chrome-extension/content/capture-core.js).
//
// Runs in plain Node (node:test) inside a vm sandbox with a fake clock, fake
// DOM observer and fake chrome.* APIs — no browser or extension host needed.
// Focus: baseline (first Q+A vs. history), streaming settle, transient retry,
// dedupe, and exact payload text.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const CORE_SRC = fs.readFileSync(
  new URL('../chrome-extension/content/capture-core.js', import.meta.url),
  'utf8'
);

function createHarness({ settings = {}, messages = [], convId = '' } = {}) {
  const clock = { now: 1_700_000_000_000 };
  const timers = new Map();
  let seq = 1;

  function addTimer(fn, ms, every) {
    const id = seq++;
    timers.set(id, { at: clock.now + Math.max(0, Number(ms) || 0), fn, every: every || 0 });
    return id;
  }

  function advance(ms) {
    const target = clock.now + ms;
    for (;;) {
      let pick = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
      }
      if (!pick) break;
      const [id, t] = pick;
      if (t.every) t.at += t.every;
      else timers.delete(id);
      clock.now = t.at;
      t.fn();
    }
    clock.now = target;
  }

  const sent = [];
  let responder = () => ({ accepted: true });
  const runtime = { lastError: undefined };
  const chrome = {
    runtime: Object.assign(runtime, {
      sendMessage: (msg, cb) => {
        sent.push(msg);
        const res = responder(msg);
        if (cb) addTimer(() => cb(res), 0);
      },
    }),
    storage: {
      local: {
        _data: { tfSeen: [] },
        get(keys, cb) {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = this._data[k];
          cb(out);
        },
        set(obj, cb) {
          Object.assign(this._data, obj);
          if (cb) cb();
        },
      },
      sync: {
        get(defaults, cb) {
          cb({ ...defaults, ...settings });
        },
        set(_obj, cb) {
          if (cb) cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  let observerCb = null;
  const sandbox = {
    chrome,
    location: { hostname: 'chatgpt.com', pathname: '/', search: '' },
    document: { documentElement: {} },
    MutationObserver: class {
      constructor(cb) {
        observerCb = cb;
      }
      observe() {}
    },
    Date: { now: () => clock.now },
    setTimeout: (fn, ms) => addTimer(fn, ms, 0),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => addTimer(fn, ms, Math.max(1, Number(ms) || 1)),
    clearInterval: (id) => timers.delete(id),
    console: { info() {}, warn() {}, error() {}, log() {} },
    TFDebug: { log() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CORE_SRC, sandbox, { filename: 'capture-core.js' });

  const state = { convId, streaming: false, enabled: true };
  const selectors = {
    platform: 'chatgpt',
    label: 'ChatGPT (test)',
    isSupportedPage: () => true,
    getConversationId: () => state.convId,
    collectMessages: () =>
      messages.map((m, i) => ({ role: m.role, text: m.text, id: m.id ?? `m${i}` })),
    isStreaming: () => state.streaming,
    probeStrategy: () => 'test',
  };

  return {
    chrome,
    sent,
    state,
    selectors,
    messages,
    advance,
    setResponder(fn) {
      responder = fn;
    },
    start() {
      sandbox.TFCapture.start(selectors);
    },
    // Simulate a DOM mutation (ChatGPT renders something) + debounce tick.
    scan() {
      assert.ok(observerCb, 'observer registered');
      observerCb();
      advance(400);
    },
  };
}

const pair = (q, a, n = '') => [
  { role: 'user', text: q, id: `q${n}` },
  { role: 'assistant', text: a, id: `a${n}` },
];

test('captures the FIRST Q+A of a brand-new conversation (blank baseline)', () => {
  const h = createHarness();
  h.start(); // empty conversation → baseline completes with zero pairs
  h.advance(10);
  assert.equal(h.sent.length, 0);

  // ChatGPT flips the URL to /c/<id> exactly when the first answer starts.
  h.messages.push(...pair('What is a PC?', 'A PC is a personal computer.\nFast.', '1'));
  h.state.convId = 'conv-1';
  h.scan();
  h.advance(5000);

  assert.equal(h.sent.length, 1, 'first pair must be captured');
  const payload = h.sent[0].payload;
  assert.equal(h.sent[0].type, 'TF_TRY_SEND');
  assert.equal(payload.question, 'What is a PC?');
  assert.equal(payload.answer, 'A PC is a personal computer.\nFast.');
  assert.equal(payload.conversationId, 'conv-1');
  assert.equal(payload.source, 'chatgpt');
  assert.deepEqual(Array.from(payload.messageIds), ['q1', 'a1']);
  assert.ok(payload.fingerprint, 'fingerprint included for website dedupe');
});

test('captures a first answer that is still streaming when the URL flips', () => {
  const h = createHarness();
  h.start();
  h.advance(10);

  h.state.streaming = true;
  h.messages.push(...pair('Explain streams', 'partial', '1'));
  h.state.convId = 'conv-s';
  h.scan();
  h.advance(1200);
  assert.equal(h.sent.length, 0, 'streaming answer must not be captured early');

  h.messages[1].text = 'partial then complete';
  h.scan();
  h.advance(8000);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].payload.answer, 'partial then complete');
});

test('never retro-captures a conversation that was already on screen at load', () => {
  const h = createHarness({
    messages: [...pair('Old Q1', 'Old A1', '1'), ...pair('Old Q2', 'Old A2', '2')],
    convId: 'hist',
  });
  h.start();
  h.advance(12000);
  assert.equal(h.sent.length, 0, 'history must not be captured on load');

  // A genuinely new pair in that conversation IS captured.
  h.messages.push(...pair('New Q3', 'New A3', '3'));
  h.scan();
  h.advance(6000);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].payload.question, 'New Q3');
});

test('switching from a blank chat to a saved thread does not capture its history', () => {
  const h = createHarness();
  h.start();
  h.advance(10);

  h.messages.push(
    ...pair('Saved Q1', 'Saved A1', '1'),
    ...pair('Saved Q2', 'Saved A2', '2'),
    ...pair('Saved Q3', 'Saved A3', '3')
  );
  h.state.convId = 'saved-thread';
  h.scan();
  h.advance(12000);
  assert.equal(h.sent.length, 0, 'opening a saved thread is history, not capture');
});

test('each subsequent question creates exactly one send, with no duplicates', () => {
  const h = createHarness();
  h.start();
  h.advance(10);

  h.messages.push(...pair('Q1', 'A1', '1'));
  h.state.convId = 'c';
  h.scan();
  h.advance(4000);
  assert.equal(h.sent.length, 1);

  h.messages.push(...pair('Q2', 'A2', '2'));
  h.scan();
  h.advance(4000);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].payload.question, 'Q2');

  // Nothing is re-sent while the pairs stay settled on screen.
  h.scan();
  h.advance(20000);
  assert.equal(h.sent.length, 2, 'accepted pairs are never re-sent');
});

test('a transient drop is retried with the same content and never duplicated', () => {
  const h = createHarness({ settings: { retryCooldownMs: 1000 } });
  h.start();
  h.advance(10);

  let attempts = 0;
  h.setResponder(() => {
    attempts += 1;
    return attempts === 1
      ? { drop: true, reason: 'website-off' }
      : { accepted: true };
  });

  h.messages.push(...pair('Q retry', 'A retry', '1'));
  h.state.convId = 'c';
  h.scan();
  h.advance(9000);

  assert.equal(h.sent.length, 2, 'one drop + one successful retry');
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.sent[0].payload)),
    JSON.parse(JSON.stringify(h.sent[1].payload)),
    'retry sends identical content'
  );

  h.advance(20000);
  assert.equal(h.sent.length, 2, 'no third attempt after acceptance');
});

test('a permanent drop is never retried', () => {
  const h = createHarness();
  h.start();
  h.advance(10);
  h.setResponder(() => ({ drop: true, reason: 'invalid' }));

  h.messages.push(...pair('Q bad', 'A bad', '1'));
  h.state.convId = 'c';
  h.scan();
  h.advance(30000);
  assert.equal(h.sent.length, 1);
});

test('two identical questions are captured once per conversation, twice across conversations', () => {
  const h = createHarness();
  h.start();
  h.advance(10);

  h.messages.push(...pair('Repeat?', 'Same answer', '1'));
  h.state.convId = 'c1';
  h.scan();
  h.advance(5000);
  assert.equal(h.sent.length, 1);

  // Real flow: the user starts a new chat (blank conversation), then asks the
  // same question again. Same wording + same answer in a DIFFERENT conversation
  // is a new node, never "duplicate".
  h.state.convId = '';
  h.messages.length = 0;
  h.scan();
  h.advance(1000);

  h.messages.push(...pair('Repeat?', 'Same answer', '9'));
  h.state.convId = 'c2';
  h.scan();
  h.advance(5000);
  assert.equal(h.sent.length, 2, 'unique conversations are never treated as duplicates');
});
