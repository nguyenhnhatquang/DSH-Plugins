/**
 * The assertion engine behind `browser_assert`.
 *
 * Assertions are the difference between "the agent clicked around" and "the
 * agent verified the UI". Two rules shape this module:
 *
 * 1. A failing check never aborts the run. Every check is evaluated and
 *    reported, so one call tells the agent *everything* that is wrong instead
 *    of one item per round trip.
 * 2. A check waits. UI settles asynchronously, and a zero-tolerance immediate
 *    read reports flaky failures that a human would never see.
 *
 * @module dsh-plugin-browserkit/assertions
 */

import { describeTarget, resolveLocator } from './snapshot.js';
import { clampText, firstLine } from './util.js';

/** Every supported check kind, with the argument it requires. */
export const CHECK_KINDS = [
  'visible',
  'hidden',
  'text',
  'value',
  'attribute',
  'count',
  'enabled',
  'disabled',
  'checked',
  'focused',
  'url',
  'title',
  'no_console_errors',
  'no_failed_requests',
];

/** Bounded wait between polls. Short enough to feel immediate, long enough to avoid a busy loop. */
const POLL_INTERVAL_MS = 100;

/**
 * Sleep that observes cancellation.
 *
 * @param {number} ms - milliseconds.
 * @param {AbortSignal} [signal] - the tool call's signal.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll one observation until it satisfies `accept`, the deadline passes, or the
 * call is cancelled.
 *
 * @param {() => Promise<unknown>} observe - the observation to repeat.
 * @param {(value: unknown) => boolean} accept - the success predicate.
 * @param {number} timeoutMs - budget for the wait.
 * @param {AbortSignal} [signal] - the tool call's signal.
 * @returns {Promise<{ ok: boolean, actual: unknown, error?: string }>} the last observation and whether it passed.
 */
async function pollUntil(observe, accept, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let actual;
  let error;
  for (;;) {
    error = undefined;
    try {
      actual = await observe();
    } catch (caught) {
      actual = undefined;
      error = firstLine(caught);
    }
    if (error === undefined && accept(actual)) return { ok: true, actual };
    if (Date.now() >= deadline) return { ok: false, actual, ...error === undefined ? {} : { error } };
    await sleep(POLL_INTERVAL_MS, signal);
  }
}

/**
 * Compare an observed string against an expected one.
 *
 * @param {string} actual - the observed value.
 * @param {string} expected - the expected value.
 * @param {string} mode - `contains` (default), `equals`, `regex` or `not_contains`.
 * @returns {{ ok: boolean, detail?: string }} the comparison, with a note when a regex was invalid.
 */
export function compare(actual, expected, mode = 'contains') {
  switch (mode) {
    case 'equals':
      return { ok: actual === expected };
    case 'regex':
      try {
        return { ok: new RegExp(expected, 'su').test(actual) };
      } catch (error) {
        return { ok: false, detail: `invalid regex: ${firstLine(error)}` };
      }
    case 'not_contains':
      return { ok: !actual.includes(expected) };
    default:
      return { ok: actual.includes(expected) };
  }
}

/** How long the page must stay quiet before a negative check reads the logs. */
const QUIET_WINDOW_MS = 250;

/**
 * Wait until the session's console and network activity has been quiet for a
 * short window.
 *
 * "Nothing failed" cannot be polled for—absence is immediate—so reading the log
 * right after an action races the request that action started and reports a
 * false pass. `page.waitForLoadState('networkidle')` does not help here: the
 * lifecycle event already fired during the earlier load, so it resolves
 * immediately. Watching the session's own activity clock is what actually waits
 * for the request. The wait is bounded and never throws: a page with a chatty
 * open connection is still worth asserting about.
 *
 * @param {import('./browser.js').BrowserSession} session - the session whose activity to watch.
 * @param {number} budgetMs - upper bound on the settle wait.
 * @param {AbortSignal} [signal] - the tool call's signal.
 * @returns {Promise<void>} resolves when the session is quiet or the budget elapses.
 */
async function settleNetwork(session, budgetMs, signal) {
  const deadline = Date.now() + Math.max(QUIET_WINDOW_MS, Math.min(budgetMs, 3_000));
  for (;;) {
    const quietFor = Date.now() - session.lastActivityAt;
    if (quietFor >= QUIET_WINDOW_MS) return;
    if (Date.now() >= deadline || signal?.aborted) return;
    await sleep(Math.min(QUIET_WINDOW_MS - quietFor, 50), signal).catch(() => {});
  }
}

/** Bound on the sample appended to a negative check's detail. */
const SAMPLE_BUDGET_CHARS = 400;

/** Bound on one URL inside a sample. Tracking URLs routinely exceed 300 characters. */
const SAMPLE_URL_CHARS = 90;

/**
 * Shorten a URL so a sample line stays readable.
 *
 * Real pages fire hundreds of character-long analytics and ad URLs; pasting
 * them whole turns one assertion result into thousands of tokens of noise. The
 * origin and the start of the path are what identify the request.
 *
 * @param {string} url - the full URL.
 * @returns {string} a shortened form.
 */
export function shortenUrl(url) {
  if (url.length <= SAMPLE_URL_CHARS) return url;
  return `${url.slice(0, SAMPLE_URL_CHARS)}…`;
}

/**
 * Build the bounded `; first: ...` suffix for a negative check.
 *
 * The whole suffix is capped, not just each entry: five long entries joined
 * still produce a result far larger than the check it explains.
 *
 * @param {string[]} entries - the candidate descriptions, most relevant first.
 * @returns {string} the suffix, or an empty string when there is nothing to show.
 */
function boundedSample(entries) {
  if (entries.length === 0) return '';
  const shown = entries.slice(0, 3).map((entry) => clampText(entry, 200));
  return `; first: ${clampText(shown.join(' | '), SAMPLE_BUDGET_CHARS)}`;
}

/**
 * Run one check.
 *
 * @param {import('playwright-core').Page} page - the session page.
 * @param {import('./browser.js').BrowserSession} session - the session holding the ref table.
 * @param {Record<string, unknown>} check - the check descriptor.
 * @param {Record<string, unknown>} config - resolved plugin config.
 * @param {AbortSignal} [signal] - the tool call's signal.
 * @returns {Promise<Record<string, unknown>>} the check result.
 */
async function runCheck(page, session, check, config, signal) {
  const kind = String(check.kind ?? '');
  const timeoutMs = Number.isInteger(check.timeoutMs) ? /** @type {number} */ (check.timeoutMs) : config.defaultTimeoutMs;
  const base = { kind, passed: false };
  const target = check.ref !== undefined || check.selector !== undefined ? describeTarget(check) : undefined;
  if (target !== undefined) base.target = target;

  /** Resolve a locator, or record the failure this check should report. */
  const locatorFor = (toolName, options) => resolveLocator(page, session, check, toolName, options);

  const finish = (passed, detail, extra = {}) => ({
    ...base,
    ...extra,
    passed,
    detail,
  });

  switch (kind) {
    case 'visible':
    case 'hidden':
    case 'enabled':
    case 'disabled':
    case 'focused': {
      const locator = locatorFor(`browser_assert(${kind})`);
      const expected = kind === 'hidden' ? false : true;
      const observe = async () => {
        switch (kind) {
          case 'visible':
          case 'hidden':
            return locator.isVisible();
          case 'enabled':
            return locator.isEnabled();
          case 'disabled':
            return !(await locator.isEnabled());
          case 'focused':
            return locator.evaluate((el) => el === document.activeElement);
          default:
            return false;
        }
      };
      const outcome = await pollUntil(observe, (value) => value === expected, timeoutMs, signal);
      return finish(
        outcome.ok,
        outcome.ok ? `element is ${kind}` : `element is not ${kind} after ${timeoutMs}ms${outcome.error ? ` (${outcome.error})` : ''}`,
      );
    }

    case 'text':
    case 'value': {
      const expected = typeof check.text === 'string' ? check.text : typeof check.value === 'string' ? check.value : undefined;
      if (expected === undefined) return finish(false, `${kind} check requires a string ${kind === 'text' ? '"text"' : '"value"'}`);
      const mode = typeof check.mode === 'string' ? check.mode : 'contains';
      const hasTarget = check.ref !== undefined || check.selector !== undefined;
      const observe = async () => {
        if (!hasTarget) return (await page.locator('body').innerText()).trim();
        if (kind === 'value') return locatorFor('browser_assert(value)').inputValue();
        return (await locatorFor('browser_assert(text)').innerText()).trim();
      };
      const outcome = await pollUntil(observe, (value) => compare(String(value ?? ''), expected, mode).ok, timeoutMs, signal);
      const actual = String(outcome.actual ?? '');
      const comparison = compare(actual, expected, mode);
      // `text` and `value` poll because their target is optional (no target
      // means "the whole page"), so a bad ref surfaces here rather than at
      // resolution. Report the cause, not the empty observation it produced:
      // "unknown ref e1" is actionable, `actual ""` is not.
      const detail = outcome.error !== undefined
        ? `${kind} check could not be observed: ${outcome.error}`
        : comparison.detail
          ? `${kind} check could not be evaluated: ${comparison.detail}`
          : `${kind} ${mode} ${JSON.stringify(expected)}: actual ${JSON.stringify(clampText(actual, 400))}`;
      return finish(outcome.ok, detail, { expected, actual: clampText(actual, 400) });
    }

    case 'attribute': {
      const name = typeof check.name === 'string' ? check.name : undefined;
      if (!name) return finish(false, 'attribute check requires "name"');
      const expected = typeof check.value === 'string' ? check.value : undefined;
      const mode = typeof check.mode === 'string' ? check.mode : 'equals';
      const locator = locatorFor('browser_assert(attribute)');
      const observe = () => locator.getAttribute(name);
      const accept = expected === undefined ? (value) => value !== null : (value) => value !== null && compare(value, expected, mode).ok;
      const outcome = await pollUntil(observe, accept, timeoutMs, signal);
      return finish(
        outcome.ok,
        expected === undefined
          ? `attribute ${name} is ${JSON.stringify(outcome.actual)}`
          : `attribute ${name} ${mode} ${JSON.stringify(expected)}: actual ${JSON.stringify(outcome.actual)}`,
        { expected: expected ?? null, actual: outcome.actual ?? null },
      );
    }

    case 'count': {
      // Validate the arguments before resolving anything, so a malformed check
      // gets its own message rather than a locator error.
      const exactly = Number.isInteger(check.exactly) ? /** @type {number} */ (check.exactly) : undefined;
      const min = Number.isInteger(check.min) ? /** @type {number} */ (check.min) : undefined;
      const max = Number.isInteger(check.max) ? /** @type {number} */ (check.max) : undefined;
      if (exactly === undefined && min === undefined && max === undefined) {
        return finish(false, 'count check requires one of "exactly", "min" or "max"');
      }
      // Counting needs the whole match set, so this is the one check that does
      // not collapse to `.first()`.
      const locator = locatorFor('browser_assert(count)', { first: false });
      const accept = (value) => (exactly === undefined || value === exactly)
        && (min === undefined || value >= min)
        && (max === undefined || value <= max);
      const outcome = await pollUntil(() => locator.count(), accept, timeoutMs, signal);
      const expected = { ...exactly === undefined ? {} : { exactly }, ...min === undefined ? {} : { min }, ...max === undefined ? {} : { max } };
      return finish(outcome.ok, `element count is ${outcome.actual}, expected ${JSON.stringify(expected)}`, {
        expected,
        actual: outcome.actual ?? null,
      });
    }

    case 'checked': {
      const expected = check.checked === undefined ? true : check.checked === true;
      const locator = locatorFor('browser_assert(checked)');
      const observe = () => locator.isChecked();
      const outcome = await pollUntil(observe, (value) => value === expected, timeoutMs, signal);
      return finish(outcome.ok, `element checked is ${outcome.actual}, expected ${expected}`, { expected, actual: outcome.actual ?? null });
    }

    case 'url':
    case 'title': {
      const expected = typeof check.value === 'string' ? check.value : typeof check.text === 'string' ? check.text : undefined;
      if (expected === undefined) return finish(false, `${kind} check requires "value"`);
      const mode = typeof check.mode === 'string' ? check.mode : 'contains';
      if (kind === 'url') {
        const url = page.url();
        const comparison = compare(url, expected, mode);
        return finish(comparison.ok, `url ${mode} ${JSON.stringify(expected)}: actual ${JSON.stringify(url)}`, { expected, actual: url });
      }
      const outcome = await pollUntil(
        () => page.title(),
        (value) => compare(String(value), expected, mode).ok,
        timeoutMs,
        signal,
      );
      return finish(outcome.ok, `title ${mode} ${JSON.stringify(expected)}: actual ${JSON.stringify(outcome.actual)}`, {
        expected,
        actual: outcome.actual ?? null,
      });
    }

    case 'no_console_errors': {
      await settleNetwork(session, timeoutMs, signal);
      const errors = session.consoleMessages.filter((entry) => entry.level === 'error');
      const allow = Number.isInteger(check.max) ? /** @type {number} */ (check.max) : 0;
      const sample = boundedSample(errors.map((entry) => entry.text));
      return finish(errors.length <= allow, `console errors: ${errors.length} (allowed ${allow})${sample}`, {
        expected: allow,
        actual: errors.length,
      });
    }

    case 'no_failed_requests': {
      await settleNetwork(session, timeoutMs, signal);
      const failures = session.network.filter((entry) => entry.failure !== undefined || (entry.status ?? 0) >= 400);
      const allow = Number.isInteger(check.max) ? /** @type {number} */ (check.max) : 0;
      const sample = boundedSample(failures.map((entry) => `${entry.status ?? entry.failure} ${shortenUrl(entry.url)}`));
      return finish(failures.length <= allow, `failed requests: ${failures.length} (allowed ${allow})${sample}`, {
        expected: allow,
        actual: failures.length,
      });
    }

    default:
      return finish(false, `unsupported check kind ${JSON.stringify(kind)}; supported: ${CHECK_KINDS.join(', ')}`);
  }
}

/**
 * Run every check and summarize.
 *
 * Each check is isolated: a check that throws — a malformed descriptor, a
 * target that resolves nowhere, an invalid regex — becomes one failed result
 * rather than aborting the batch. The whole point of this tool is that one call
 * reports everything wrong, and that promise has to survive a badly written
 * check as well as a failing one.
 *
 * @param {import('playwright-core').Page} page - the session page.
 * @param {import('./browser.js').BrowserSession} session - the session holding the ref table.
 * @param {Array<Record<string, unknown>>} checks - the check descriptors.
 * @param {Record<string, unknown>} config - resolved plugin config.
 * @param {AbortSignal} [signal] - the tool call's signal.
 * @returns {Promise<{ passed: number, failed: number, results: Array<Record<string, unknown>> }>} the report.
 */
export async function runChecks(page, session, checks, config, signal) {
  const results = [];
  for (const check of checks) {
    try {
      results.push(await runCheck(page, session, check, config, signal));
    } catch (error) {
      results.push({
        kind: typeof check?.kind === 'string' ? check.kind : 'unknown',
        passed: false,
        detail: `check could not be evaluated: ${firstLine(error)}`,
      });
    }
  }
  const passed = results.filter((result) => result.passed).length;
  return { passed, failed: results.length - passed, results };
}

/**
 * Render an assertion report as model-facing text.
 *
 * The summary line comes first so a passing run costs one line of context and a
 * failing run still leads with the count.
 *
 * @param {{ passed: number, failed: number, results: Array<Record<string, unknown>> }} report - the report.
 * @returns {string} markdown text.
 */
export function formatReport(report) {
  const verdict = report.failed === 0 ? 'PASS' : 'FAIL';
  const lines = [`${verdict}: ${report.passed} passed, ${report.failed} failed`];
  for (const result of report.results) {
    const mark = result.passed ? 'ok  ' : 'FAIL';
    const where = result.target === undefined ? '' : ` [${result.target}]`;
    lines.push(`  ${mark} ${result.kind}${where}: ${result.detail}`);
  }
  return lines.join('\n');
}
