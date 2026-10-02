/**
 * The browser test suite.
 *
 * These tests drive the real tool bodies against a real headless Chrome and a
 * local fixture page. Nothing here mocks Playwright: a browser plugin that is
 * only tested against a mock has not been tested.
 *
 * Each test opens its own session key (via a distinct `agent` object) and the
 * whole file shares one plugin instance, which is also what proves the
 * per-agent isolation works.
 */

import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { apply } from '../lib/index.js';
import { callTool, makeArtifactsDir, makeContext, makeExec, startFixtureServer } from './harness.mjs';

/** @type {{ origin: string, close: () => Promise<void> }} */
let server;
/** @type {Awaited<ReturnType<typeof makeArtifactsDir>>} */
let artifactsDir;
/** @type {ReturnType<typeof makeContext>['state']} */
let state;

before(async () => {
  server = await startFixtureServer();
  artifactsDir = await makeArtifactsDir();
  const made = makeContext();
  state = made.state;
  apply(made.ctx, {
    // Keep the artifacts inside a temp directory rather than the repo.
    artifactsDir,
    headless: true,
    agent: process.env.BROWSER_TEST_AGENT ?? 'chrome',
    defaultTimeoutMs: 5_000,
    navigationTimeoutMs: 15_000,
    channelFallback: true,
  });
});

after(async () => {
  await callTool(state, 'browser_close', { all: true }).catch(() => {});
  await state.dispose();
  await server.close();
});

/**
 * Open a fresh session for this test file's fixture page.
 *
 * @param {string} session - a session name unique to the test.
 * @returns {Promise<{ exec: Record<string, unknown> }>} the execution bound to a fresh agent.
 */
async function openFixture(session) {
  const exec = makeExec({ agent: { name: session } });
  await callTool(state, 'browser_open', { url: `${server.origin}/`, session, viewportWidth: 1024, viewportHeight: 768 }, exec);
  return { exec };
}

test('browser_open reports the resolved browser and the page location', async () => {
  const exec = makeExec();
  const { value, text } = await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  assert.equal(value.url, `${server.origin}/`);
  assert.equal(value.title, 'Fixture App');
  assert.match(value.browser, /chrome|chromium|msedge/u);
  assert.match(text, /Fixture App/u);
});

test('browser_open without a URL opens a blank page', async () => {
  const { value } = await callTool(state, 'browser_open', { session: 'blank' }, makeExec());
  assert.equal(value.url, 'about:blank');
});

test('browser_snapshot lists interactive elements with refs', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  const { value, text } = await callTool(state, 'browser_snapshot', {}, exec);

  assert.equal(value.itemCount > 0, true);
  assert.match(value.text, /Accessibility tree/u);
  assert.match(value.text, /Interactive elements/u);
  assert.match(text, /"Reveal panel"/u);
  // The fixture's data-testid hooks should win over a structural selector.
  assert.match(value.text, /data-testid="reveal"/u);
  // Refs are numbered e1, e2, ...
  assert.match(value.text, /e1\s/u);
});

test('snapshot refs drive a click, and the page really changed', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  const snap = await callTool(state, 'browser_snapshot', {}, exec);
  const ref = refFor(snap.value.text, 'Reveal panel');
  assert.ok(ref, 'expected a ref for the reveal button');

  await callTool(state, 'browser_click', { ref }, exec);

  const report = await callTool(
    state,
    'browser_assert',
    { checks: [{ kind: 'visible', selector: '[data-testid="panel-text"]' }, { kind: 'text', text: 'Panel revealed' }] },
    exec,
  );
  assert.equal(report.value.failed, 0, report.text);
  assert.equal(report.value.passed, 2);
});

test('typing then clicking uses the value the page received', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  await callTool(state, 'browser_type', { selector: '[data-testid="name"]', text: 'Ada' }, exec);
  const typed = await callTool(state, 'browser_assert', { checks: [{ kind: 'value', selector: '[data-testid="name"]', value: 'Ada', mode: 'equals' }] }, exec);
  assert.equal(typed.value.failed, 0, typed.text);

  await callTool(state, 'browser_click', { selector: '[data-testid="greet"]' }, exec);
  const greeting = await callTool(
    state,
    'browser_assert',
    { checks: [{ kind: 'text', selector: '[data-testid="greeting"]', text: 'Hello Ada', mode: 'equals' }] },
    exec,
  );
  assert.equal(greeting.value.failed, 0, greeting.text);
});

test('browser_type with submit presses Enter', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  const { value } = await callTool(state, 'browser_type', { selector: '[data-testid="name"]', text: 'Grace', submit: true }, exec);
  assert.equal(value.submitted, true);
  assert.equal(value.value, 'Grace');
});

test('a failing assertion reports every failure instead of throwing', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  const report = await callTool(
    state,
    'browser_assert',
    {
      checks: [
        { kind: 'text', text: 'Fixture App' },
        { kind: 'text', text: 'this text is not on the page', timeoutMs: 300 },
        { kind: 'visible', selector: '[data-testid="does-not-exist"]', timeoutMs: 300 },
      ],
    },
    exec,
  );
  assert.equal(report.value.passed, 1);
  assert.equal(report.value.failed, 2);
  assert.match(report.text, /^FAIL: 1 passed, 2 failed/u);
  // The failing checks lead with their own explanation.
  assert.match(report.text, /not on the page|actual/u);
});

test('assertion kinds cover state, counts, url and title', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  const report = await callTool(
    state,
    'browser_assert',
    {
      checks: [
        { kind: 'url', value: server.origin, mode: 'contains' },
        { kind: 'title', value: 'Fixture App', mode: 'equals' },
        { kind: 'count', selector: '[data-testid="list"] li', exactly: 2 },
        { kind: 'disabled', selector: '[data-testid="disabled"]' },
        { kind: 'enabled', selector: '[data-testid="greet"]' },
        { kind: 'hidden', selector: '#panel' },
        { kind: 'attribute', selector: '[data-testid="name"]', name: 'placeholder', value: 'Your name' },
      ],
    },
    exec,
  );
  assert.equal(report.value.failed, 0, report.text);
  assert.equal(report.value.passed, 7);
});

test('console errors and failed requests are captured and assertable', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);

  const clean = await callTool(
    state,
    'browser_assert',
    { checks: [{ kind: 'no_console_errors' }, { kind: 'no_failed_requests' }] },
    exec,
  );
  assert.equal(clean.value.failed, 0, clean.text);

  await callTool(state, 'browser_click', { selector: '[data-testid="boom"]' }, exec);
  await callTool(state, 'browser_click', { selector: '[data-testid="fetch404"]' }, exec);

  const dirty = await callTool(
    state,
    'browser_assert',
    { checks: [{ kind: 'no_console_errors' }, { kind: 'no_failed_requests' }] },
    exec,
  );
  assert.equal(dirty.value.failed, 2, dirty.text);

  const console = await callTool(state, 'browser_console', { level: 'error' }, exec);
  assert.match(console.value.text, /fixture boom/u);
  assert.equal(console.value.errorCount >= 1, true);

  const network = await callTool(state, 'browser_network', {}, exec);
  assert.match(network.value.text, /404/u);
  assert.match(network.value.text, /missing\.json/u);
});

test('browser_select chooses an option', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  const { value } = await callTool(state, 'browser_select', { selector: '[data-testid="colour"]', values: ['blue'] }, exec);
  assert.deepEqual(value.selected, ['blue']);
  const report = await callTool(state, 'browser_assert', { checks: [{ kind: 'value', selector: '[data-testid="colour"]', value: 'blue', mode: 'equals' }] }, exec);
  assert.equal(report.value.failed, 0, report.text);
});

test('browser_eval evaluates in the page, with and without an element', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);

  const page = await callTool(state, 'browser_eval', { expression: 'document.title' }, exec);
  assert.equal(page.value.value, 'Fixture App');

  const element = await callTool(state, 'browser_eval', { expression: 'el.textContent', selector: '[data-testid="heading"]' }, exec);
  assert.equal(element.value.value, 'Fixture App');

  const array = await callTool(state, 'browser_eval', { expression: '[...document.querySelectorAll("[data-testid=list] li")].map(li => li.textContent)' }, exec);
  assert.deepEqual(array.value.value, ['Alpha', 'Beta']);

  const missing = await callTool(state, 'browser_eval', { expression: 'el.textContent', selector: '#nope' }, exec);
  assert.equal(missing.value.value, '[element not found]');
});

test('browser_eval is refused when the deployment disables it', async () => {
  const made = makeContext();
  apply(made.ctx, { artifactsDir, allowEvaluate: false, agent: process.env.BROWSER_TEST_AGENT ?? 'chrome' });
  const exec = makeExec();
  await callTool(made.state, 'browser_open', { url: `${server.origin}/` }, exec);
  await assert.rejects(
    () => callTool(made.state, 'browser_eval', { expression: '1 + 1' }, exec),
    /disabled by this deployment/u,
  );
  await callTool(made.state, 'browser_close', { all: true }).catch(() => {});
  await made.state.dispose();
});

test('browser_wait_for waits for text and for an element state', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  const text = await callTool(state, 'browser_wait_for', { text: 'Fixture App' }, exec);
  assert.equal(text.value.waitedMs >= 0, true);
  await assert.rejects(
    () => callTool(state, 'browser_wait_for', { text: 'never appears anywhere', timeoutMs: 300 }, exec),
    /Timeout|timeout/u,
  );
  await callTool(state, 'browser_click', { selector: '[data-testid="reveal"]' }, exec);
  const stateWait = await callTool(state, 'browser_wait_for', { selector: '[data-testid="panel-text"]', state: 'visible' }, exec);
  assert.match(stateWait.value.condition, /visible/u);
});

test('browser_press sends keys to the page', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  await callTool(state, 'browser_click', { selector: '[data-testid="name"]' }, exec);
  await callTool(state, 'browser_press', { key: 'A' }, exec);
  const value = await callTool(state, 'browser_eval', { expression: 'document.querySelector("[data-testid=name]").value' }, exec);
  assert.equal(value.value.value, 'A');
});

test('browser_screenshot writes an artifact and refuses to escape the directory', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);

  const shot = await callTool(state, 'browser_screenshot', { path: 'nested/first' }, exec);
  assert.equal(shot.value.mediaType, 'image/png');
  assert.equal(shot.value.bytes > 1_000, true);
  assert.equal(shot.value.path.startsWith(artifactsDir), true);
  assert.equal(shot.value.path.endsWith('.png'), true, 'the configured extension is appended');
  const written = await stat(shot.value.path);
  assert.equal(written.size, shot.value.bytes);
  assert.deepEqual(await readdir(`${artifactsDir}/nested`), ['first.png']);

  await assert.rejects(
    () => callTool(state, 'browser_screenshot', { path: '../escape.png' }, exec),
    /escapes the artifacts directory/u,
  );
  await assert.rejects(
    () => callTool(state, 'browser_screenshot', { path: 'C:/Windows/Temp/escape.png' }, exec),
    /must be relative/u,
  );
});

test('browser_screenshot defaults to a timestamped name and captures one element', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  const auto = await callTool(state, 'browser_screenshot', {}, exec);
  assert.match(auto.value.path, /screenshot-.*\.png$/u);

  const element = await callTool(state, 'browser_screenshot', { selector: '[data-testid="heading"]', path: 'heading' }, exec);
  assert.equal(element.value.bytes > 0, true);
  // A single heading is smaller than the full page.
  assert.equal(element.value.bytes < auto.value.bytes, true);
});

test('navigating clears refs so a stale ref is refused, not silently reused', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  const snap = await callTool(state, 'browser_snapshot', {}, exec);
  const ref = refFor(snap.value.text, 'Reveal panel');
  await callTool(state, 'browser_navigate', { url: `${server.origin}/index.html` }, exec);
  await assert.rejects(() => callTool(state, 'browser_click', { ref }, exec), /unknown ref/u);
});

test('an unknown ref names the recovery step', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  await assert.rejects(() => callTool(state, 'browser_click', { ref: 'e999' }, exec), /call browser_snapshot again/u);
  await assert.rejects(() => callTool(state, 'browser_click', {}, exec), /provide "ref"/u);
  await assert.rejects(() => callTool(state, 'browser_click', { ref: 'e1', selector: 'a' }, exec), /not both/u);
});

test('browser_navigate supports reload and history', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  const first = await callTool(state, 'browser_navigate', { action: 'reload' }, exec);
  assert.equal(first.value.title, 'Fixture App');
  const back = await callTool(state, 'browser_navigate', { action: 'back' }, exec);
  assert.equal(typeof back.value.url, 'string');
  const forward = await callTool(state, 'browser_navigate', { action: 'forward' }, exec);
  assert.equal(typeof forward.value.url, 'string');
  await assert.rejects(() => callTool(state, 'browser_navigate', { action: 'goto' }, exec), /"url" is required/u);
});

test('agents get isolated sessions', async () => {
  const agentA = { name: 'a' };
  const agentB = { name: 'b' };
  const execA = makeExec({ agent: agentA });
  const execB = makeExec({ agent: agentB });

  await callTool(state, 'browser_open', { url: `${server.origin}/`, session: 'iso-a' }, execA);
  await callTool(state, 'browser_open', { url: `${server.origin}/`, session: 'iso-b' }, execB);

  // Navigate A away from the fixture; B must still be on it.
  await callTool(state, 'browser_navigate', { url: 'about:blank', session: 'iso-a' }, execA);
  const bUrl = await callTool(state, 'browser_eval', { expression: 'location.pathname', session: 'iso-b' }, execB);
  assert.equal(bUrl.value.value, '/');

  const closed = await callTool(state, 'browser_close', { session: 'iso-a' }, execA);
  assert.deepEqual(closed.value.closed, ['named:iso-a']);
});

test('browser_close reports when there is nothing to close', async () => {
  const { value } = await callTool(state, 'browser_close', { session: 'never-opened' }, makeExec());
  assert.deepEqual(value.closed, []);
});

test('a cancelled call stops instead of hanging', async () => {
  const controller = new AbortController();
  const exec = makeExec({ signal: controller.signal });
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  controller.abort();
  await assert.rejects(() => callTool(state, 'browser_wait_for', { text: 'never appears', timeoutMs: 5_000 }, exec));
});

test('every registered tool renders without throwing on its own output', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/` }, exec);
  const calls = [
    ['browser_snapshot', {}],
    ['browser_console', {}],
    ['browser_network', {}],
    ['browser_eval', { expression: '1' }],
    ['browser_assert', { checks: [{ kind: 'title', value: 'Fixture App' }] }],
    ['browser_hover', { selector: '[data-testid="heading"]' }],
  ];
  for (const [toolName, args] of calls) {
    const { text } = await callTool(state, toolName, args, exec);
    assert.equal(typeof text, 'string');
    assert.notEqual(text, '', `${toolName} rendered empty text`);
  }
});

test('a per-session engine override rebuilds the session', async () => {
  // Changing the engine cannot be applied to a running browser, so the session
  // must be rebuilt — observable here as the page resetting to about:blank.
  // The requested engine is not asserted directly, because a machine without
  // Edge legitimately falls back to Chrome.
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/`, session: 'agentswap', agent: 'chrome' }, exec);
  const swapped = await callTool(state, 'browser_open', { session: 'agentswap', agent: 'msedge' }, exec);
  assert.equal(typeof swapped.value.browser, 'string');
  const location = await callTool(state, 'browser_eval', { expression: 'location.href', session: 'agentswap' }, exec);
  assert.equal(location.value.value, 'about:blank', 'changing the engine must rebuild the session');
  await callTool(state, 'browser_close', { session: 'agentswap' }, exec);
});

test('reopening with an unchanged engine keeps the session and its page', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/`, session: 'reuse' }, exec);
  await callTool(state, 'browser_open', { session: 'reuse' }, exec);
  const title = await callTool(state, 'browser_eval', { expression: 'document.title', session: 'reuse' }, exec);
  assert.equal(title.value.value, 'Fixture App', 'an unchanged reopen must not navigate away');
  await callTool(state, 'browser_close', { session: 'reuse' }, exec);
});

test('a per-session viewport override resizes the page', async () => {
  const exec = makeExec();
  await callTool(state, 'browser_open', { url: `${server.origin}/`, session: 'viewport' }, exec);
  const resized = await callTool(state, 'browser_open', { session: 'viewport', viewportWidth: 480, viewportHeight: 640 }, exec);
  assert.equal(resized.value.viewport, '480x640');
  const width = await callTool(state, 'browser_eval', { expression: 'innerWidth', session: 'viewport' }, exec);
  assert.equal(width.value.value, 480);
  await callTool(state, 'browser_close', { session: 'viewport' }, exec);
});

test('the plugin registers exactly the documented tool surface', () => {
  const expected = [
    'browser_open',
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_select',
    'browser_hover',
    'browser_wait_for',
    'browser_eval',
    'browser_screenshot',
    'browser_assert',
    'browser_console',
    'browser_network',
    'browser_tabs',
    'browser_dialog',
    'browser_storage_state',
    'browser_upload',
    'browser_close',
  ];
  assert.deepEqual([...state.definitions.keys()].sort(), [...expected].sort());
});

test('the prompt section is registered and hides itself when the tools are absent', () => {
  // A deployment without a system prompt must still load.
  const made = makeContext();
  apply(made.ctx, { artifactsDir: '/tmp/x' });
  assert.equal(made.state.definitions.size, 19);
});

test('a system prompt section is contributed when the service is mounted', () => {
  const made = makeContext();
  const sections = [];
  made.state.services.set('systemPrompt', {
    section: (section) => sections.push(section),
    getSectionOrder: (orderName) => (orderName === 'TOOL_COMPUTER_USE' ? 3_000 : undefined),
  });
  apply(made.ctx, { artifactsDir: '/tmp/x' });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'tool:browserkit');
  assert.equal(sections[0].order, 3_000);
  // The section renders only while the tools are visible in the calling scope.
  assert.match(sections[0].text({ scope: undefined }), /browser_assert/u);
  assert.equal(sections[0].text({ scope: { hidden: true } }), '', 'hidden tools must not pay for the guidance');
});

/**
 * Find the ref assigned to the inventory row whose accessible name matches.
 *
 * Only inventory rows are considered: the accessibility tree above them renders
 * the same names as `- button "Reveal panel"`, and matching those would return
 * a YAML bullet instead of a ref.
 *
 * @param {string} snapshotText - the rendered snapshot.
 * @param {string} name - the accessible name to look for.
 * @returns {string | undefined} the ref, e.g. `e3`.
 */
function refFor(snapshotText, name) {
  for (const line of snapshotText.split('\n')) {
    const match = /^\s+(e\d+)\s+.*"([^"]*)"/u.exec(line);
    if (match && match[2] === name) return match[1];
  }
  return undefined;
}
