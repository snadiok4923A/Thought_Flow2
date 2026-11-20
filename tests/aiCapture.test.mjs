// Tests for the website-side dedupe ledger key and Q+A note formatting.
// These are the two pure pieces that decide "is this a duplicate?" and
// "is the captured text exact?" in src/App.jsx.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureContentHash,
  captureDedupeKey,
  buildCaptureNoteHtml,
  shortenQuestionTitle,
  normalizeCaptureDirection,
  toTreeDirection,
} from '../src/utils/aiCapture.js';

test('buildCaptureNoteHtml preserves the exact question and answer text', () => {
  const question = 'Line one\nLine two & <tags>';
  const answer = '  3 < 4 && 5 > 2\n• bullet  ';
  const html = buildCaptureNoteHtml({ source: 'chatgpt', question, answer });

  assert.match(html, /<p><strong>User:<\/strong><\/p>/);
  assert.match(html, /<p><strong>ChatGPT:<\/strong><\/p>/);
  assert.ok(html.includes('Line one<br>Line two &amp; &lt;tags&gt;'));
  assert.ok(html.includes('3 &lt; 4 &amp;&amp; 5 &gt; 2<br>• bullet'));
  // No double-escaping of the stored text.
  assert.ok(!html.includes('&amp;amp;'));
});

test('captureDedupeKey is stable across retries of the same delivery', () => {
  const payload = {
    source: 'chatgpt',
    conversationId: 'abc',
    question: 'Q',
    answer: 'A',
    fingerprint: 'fp-123',
  };
  assert.equal(captureDedupeKey(payload), captureDedupeKey({ ...payload }));
  assert.equal(captureDedupeKey(payload), 'direct:chatgpt:abc:fp-123');
});

test('captureDedupeKey separates different conversations, answers and sources', () => {
  const base = { source: 'chatgpt', conversationId: 'c1', question: 'Q', answer: 'A' };
  const keys = new Set([
    captureDedupeKey(base),
    captureDedupeKey({ ...base, conversationId: 'c2' }),
    captureDedupeKey({ ...base, answer: 'A2' }),
    captureDedupeKey({ ...base, source: 'gemini' }),
  ]);
  assert.equal(keys.size, 4, 'unique conversations must never collide');
});

test('captureDedupeKey does not collide on long shared prefixes', () => {
  // The old key truncated question/answer to 80 chars, so two different long
  // answers with the same prefix were treated as duplicates.
  const prefix = 'x'.repeat(200);
  const a = captureDedupeKey({ question: prefix + ' first', answer: prefix + ' answer one' });
  const b = captureDedupeKey({ question: prefix + ' first', answer: prefix + ' answer two' });
  assert.notEqual(a, b);
});

test('captureContentHash ignores only whitespace differences', () => {
  assert.equal(captureContentHash('Q  one', 'A\n\ntwo'), captureContentHash('Q one', 'A two'));
  assert.notEqual(captureContentHash('Q one', 'A two'), captureContentHash('Q one', 'A three'));
});

test('shortenQuestionTitle keeps short questions intact and trims long ones', () => {
  assert.equal(shortenQuestionTitle('Short question'), 'Short question');
  const long = 'y'.repeat(120);
  const short = shortenQuestionTitle(long);
  assert.equal(short.length, 80);
  assert.ok(short.endsWith('…'));
});

test('capture direction vocabulary maps between panel and tree layers', () => {
  assert.equal(normalizeCaptureDirection('below'), 'below');
  assert.equal(normalizeCaptureDirection('down'), 'below');
  assert.equal(normalizeCaptureDirection('right'), 'right');
  assert.equal(normalizeCaptureDirection(undefined), 'right');
  assert.equal(toTreeDirection('below'), 'down');
  assert.equal(toTreeDirection('right'), 'right');
});
