/**
 * Assertion-engine tests that need no browser.
 *
 * `runChecks` only touches the page for locator-backed checks, so the two
 * negative checks (`no_console_errors`, `no_failed_requests`) can be driven with
 * a stub session. Those are also the checks whose output size is a real risk:
 * a production page reports hundreds of character-long analytics URLs, and this
 * suite pins that one failing check cannot balloon into thousands of tokens.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { compare, formatReport, runChecks, shortenUrl } from '../lib/assertions.js';

/** A session stub carrying only what the negative checks and settle logic read. */
function stubSession(overrides = {}) {
  return {
    refs: new Map(),
    consoleMessages: [],
    network: [],
    // Far enough in the past that `settleNetwork` returns immediately.
    lastActivityAt: Date.now() - 10_000,
    config: { defaultTimeoutMs: 500 },
    ...overrides,
  };
}

/** A page stub that must not be touched by the checks under test. */
const unusedPage = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`the page must not be used by this check (touched "${String(property)}")`);
    },
  },
);

test('compare supports every documented mode', () => {
  assert.equal(compare('hello world', 'world').ok, true);
  assert.equal(compare('hello world', 'hello').ok, true);
  assert.equal(compare('hello', 'hello', 'equals').ok, true);
  assert.equal(compare('hello', 'Hello', 'equals').ok, false);
  assert.equal(compare('hello', '^h.*o$', 'regex').ok, true);
  assert.equal(compare('abc', '(', 'regex').ok, false);
  assert.match(compare('abc', '(', 'regex').detail, /invalid regex/u);
  assert.equal(compare('hello', 'world', 'not_contains').ok, true);
  assert.equal(compare('hello', 'ell', 'not_contains').ok, false);
});

test('an empty console and network log passes both negative checks', async () => {
  const report = await runChecks(unusedPage, stubSession(), [{ kind: 'no_console_errors' }, { kind: 'no_failed_requests' }], { defaultTimeoutMs: 500 });
  assert.equal(report.failed, 0);
  assert.equal(report.passed, 2);
  assert.equal(report.results[0].detail, 'console errors: 0 (allowed 0)');
});

test('the max allowance is honoured', async () => {
  const session = stubSession({
    consoleMessages: [{ level: 'error', text: 'a', at: 0 }, { level: 'error', text: 'b', at: 0 }, { level: 'warning', text: 'c', at: 0 }],
    network: [{ method: 'GET', url: 'https://x.test/a', status: 500 }],
  });
  const report = await runChecks(
    unusedPage,
    session,
    [
      { kind: 'no_console_errors', max: 2 },
      { kind: 'no_failed_requests', max: 1 },
    ],
    { defaultTimeoutMs: 500 },
  );
  assert.equal(report.failed, 0, formatReport(report));
  // A warning is not an error.
  assert.equal(report.results[0].actual, 2);
});

test('a negative check result stays bounded even with long URLs and messages', async () => {
  const longUrl = `https://analytics.example.com/collect?${'p='.concat('x'.repeat(400))}`;
  const session = stubSession({
    consoleMessages: Array.from({ length: 12 }, (_, index) => ({ level: 'error', text: `boom ${index} ${'y'.repeat(300)}`, at: 0 })),
    network: Array.from({ length: 12 }, (_, index) => ({ method: 'POST', url: `${longUrl}&n=${index}`, failure: 'net::ERR_ABORTED' })),
  });
  const report = await runChecks(
    unusedPage,
    session,
    [{ kind: 'no_failed_requests' }, { kind: 'no_console_errors' }],
    { defaultTimeoutMs: 500 },
  );
  assert.equal(report.failed, 2);
  assert.equal(report.results[0].actual, 12);
  assert.equal(report.results[1].actual, 12);
  // The whole detail, not just each entry, must stay reviewable.
  assert.ok(report.results[0].detail.length < 600, `network detail was ${report.results[0].detail.length} chars`);
  assert.ok(report.results[1].detail.length < 600, `console detail was ${report.results[1].detail.length} chars`);
  // The identifying part of the URL survives the shortening.
  assert.match(report.results[0].detail, /analytics\.example\.com/u);
});

test('shortenUrl keeps short URLs verbatim and marks truncation', () => {
  assert.equal(shortenUrl('https://a.test/x'), 'https://a.test/x');
  const shortened = shortenUrl(`https://a.test/${'z'.repeat(200)}`);
  assert.ok(shortened.length <= 91, `was ${shortened.length}`);
  assert.match(shortened, /…$/u);
});

test('the report leads with the verdict and one line per check', () => {
  const text = formatReport({
    passed: 1,
    failed: 1,
    results: [
      { kind: 'visible', target: 'h1', passed: true, detail: 'element is visible' },
      { kind: 'text', target: 'h1', passed: false, detail: 'actual "other"' },
    ],
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'FAIL: 1 passed, 1 failed');
  assert.match(lines[1], /^ {2}ok {3}visible \[h1\]/u);
  assert.match(lines[2], /^ {2}FAIL text \[h1\]/u);
});

test('an unsupported check kind fails that check only', async () => {
  const report = await runChecks(
    unusedPage,
    stubSession(),
    [{ kind: 'not_a_real_kind' }, { kind: 'no_console_errors' }],
    { defaultTimeoutMs: 500 },
  );
  assert.equal(report.failed, 1);
  assert.equal(report.passed, 1);
  assert.match(report.results[0].detail, /unsupported check kind "not_a_real_kind"/u);
});

test('a check missing its required argument reports why instead of throwing', async () => {
  const report = await runChecks(unusedPage, stubSession(), [{ kind: 'count' }], { defaultTimeoutMs: 500 });
  assert.equal(report.failed, 1);
  assert.match(report.results[0].detail, /requires one of "exactly", "min" or "max"/u);
});

test('a check that throws becomes one failed result, not a broken batch', async () => {
  // A locator-backed check with no target throws while resolving. That must not
  // cost the caller the results of the checks around it.
  const report = await runChecks(
    unusedPage,
    stubSession(),
    [{ kind: 'visible' }, { kind: 'no_console_errors' }, { kind: 'text', text: 'x', ref: 'e1' }],
    { defaultTimeoutMs: 500 },
  );
  assert.equal(report.results.length, 3, 'every check must produce a result');
  assert.equal(report.passed, 1, 'the negative check still ran');
  assert.equal(report.failed, 2);
  assert.match(report.results[0].detail, /check could not be evaluated: .*provide "ref"/u);
  // A bad ref must report the ref, not the empty observation it produced.
  assert.match(report.results[2].detail, /could not be observed: .*unknown ref "e1"/u);
  assert.match(report.results[1].detail, /console errors: 0/u);
});
