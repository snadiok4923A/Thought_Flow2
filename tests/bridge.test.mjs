// Tests for chrome-extension/content/thoughtflow-bridge.js — the content script
// that forwards extension messages into the ThoughtFlow page and relays the
// page's acknowledgement back. Focus: forwarding, ack relay, no double-ack,
// presence handshake and the timeout that prevents a dead message channel.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const BRIDGE_SRC = fs.readFileSync(
  new URL('../chrome-extension/content/thoughtflow-bridge.js', import.meta.url),
  'utf8'
);

function loadBridge() {
  const posted = [];
  const listeners = [];
  const timers = new Map();
  let seq = 1;
  let now = 1_700_000_000_000;

  function addTimer(fn, ms, every) {
    const id = seq++;
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, every: every || 0 });
    return id;
  }
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let pick = null;
      for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
      if (!pick) break;
      const [id, t] = pick;
      if (t.every) t.at += t.every;
      else timers.delete(id);
      now = t.at;
      t.fn();
    }
    now = target;
  }

  const windowObj = {
    postMessage(msg) {
      posted.push(msg);
    },
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
  };

  let onMessageHandler = null;
  const sandbox = {
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            onMessageHandler = fn;
          },
        },
      },
    },
    window: windowObj,
    Date: { now: () => now },
    setTimeout: (fn, ms) => addTimer(fn, ms, 0),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => addTimer(fn, ms, Math.max(1, Number(ms) || 1)),
    clearInterval: (id) => timers.delete(id),
    console: { info() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_SRC, sandbox, { filename: 'thoughtflow-bridge.js' });

  return {
    posted,
    advance,
    windowObj,
    insert(msg, cb) {
      assert.ok(onMessageHandler, 'bridge registered a runtime.onMessage listener');
      return onMessageHandler(msg, {}, cb);
    },
    pageMessage(data) {
      for (const fn of listeners) fn({ source: windowObj, data });
    },
  };
}

test('announces bridge presence to the page on load', () => {
  const b = loadBridge();
  assert.ok(b.posted.some((m) => m.source === 'thoughtflow-bridge-ready'));
});

test('answers a page ping with a fresh presence announcement', () => {
  const b = loadBridge();
  const before = b.posted.filter((m) => m.source === 'thoughtflow-bridge-ready').length;
  b.pageMessage({ source: 'thoughtflow-bridge-ping' });
  const after = b.posted.filter((m) => m.source === 'thoughtflow-bridge-ready').length;
  assert.equal(after, before + 1);
});

test('forwards TF_CAPTURE_DIRECT to the page and relays the page ack once', () => {
  const b = loadBridge();
  const responses = [];
  const keepOpen = b.insert(
    { type: 'TF_CAPTURE_DIRECT', requestId: 'r1', payload: { question: 'Q', answer: 'A' } },
    (r) => responses.push(r)
  );
  assert.equal(keepOpen, true, 'channel stays open until the page acks');

  const fwd = b.posted.find((m) => m.source === 'thoughtflow-capture-direct');
  assert.ok(fwd, 'pair forwarded into the page');
  assert.equal(fwd.requestId, 'r1');
  assert.equal(fwd.payload.question, 'Q');

  b.pageMessage({
    source: 'thoughtflow-capture-ack',
    requestId: 'r1',
    result: { received: true, created: true, nodeId: 'n1' },
  });
  b.pageMessage({
    source: 'thoughtflow-capture-ack',
    requestId: 'r1',
    result: { received: true, created: true, nodeId: 'n1' },
  });

  assert.deepEqual(responses, [{ received: true, created: true, nodeId: 'n1' }], 'acked exactly once');
});

test('acks a timeout instead of hanging when the page never responds', () => {
  const b = loadBridge();
  const responses = [];
  b.insert({ type: 'TF_CAPTURE_DIRECT', requestId: 'r2', payload: {} }, (r) => responses.push(r));
  assert.equal(responses.length, 0);

  b.advance(8100);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].received, false);
  assert.equal(responses[0].reason, 'timeout');
});

test('panel query and direction changes round-trip through the page', () => {
  const b = loadBridge();
  const panel = [];
  b.insert({ type: 'TF_GET_PANEL_STATE', requestId: 'p1' }, (r) => panel.push(r));
  assert.ok(b.posted.some((m) => m.source === 'thoughtflow-panel-query' && m.requestId === 'p1'));
  b.pageMessage({
    source: 'thoughtflow-capture-ack',
    requestId: 'p1',
    result: { open: true, enabled: true, hasStartNode: true, direction: 'below' },
  });
  assert.equal(panel[0].direction, 'below');

  const dir = [];
  b.insert({ type: 'TF_SET_DIRECTION', requestId: 'd1', direction: 'below' }, (r) => dir.push(r));
  assert.ok(b.posted.some((m) => m.source === 'thoughtflow-set-direction' && m.direction === 'below'));
  b.pageMessage({ source: 'thoughtflow-capture-ack', requestId: 'd1', result: { ok: true } });
  assert.equal(dir[0].ok, true);
});
