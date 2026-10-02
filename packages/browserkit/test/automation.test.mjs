/**
 * Automation tests: the capabilities that only matter when nobody is watching.
 *
 * A test run can survive a popup that stole focus and a `confirm()` that was
 * silently dismissed, because a person or an assertion notices. Unattended
 * automation cannot, so each of these is pinned against a real browser.
 *
 * The attached-browser test spawns a second Chrome with a debugging port. It is
 * the only honest way to verify the CDP path, and it is skipped rather than
 * faked when Chrome cannot start.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { apply } from '../lib/index.js';
import { callTool, makeArtifactsDir, makeContext, makeExec, startFixtureServer } from './harness.mjs';

/** @type {{ origin: string, close: () => Promise<void> }} */
let server;
/** @type {string} */
let artifactsDir;
/** @type {ReturnType<typeof makeContext>['state']} */
let state;

before(async () => {
  server = await startFixtureServer();
  artifactsDir = await makeArtifactsDir();
  const made = makeContext();
  state = made.state;
  apply(made.ctx, {
    artifactsDir,
    headless: true,
    agent: process.env.BROWSER_TEST_AGENT ?? 'chrome',
    defaultTimeoutMs: 5_000,
    navigationTimeoutMs: 15_000,
    channelFallback: true,
    // Keep the default policies under test: `report` popups and `manual`
    // dialogs are the behaviours an unattended run depends on.
  });
});

after(async () => {
  await callTool(state, 'browser_close', { all: true }).catch(() => {});
  await state.dispose();
  await server.close();
});

/**
 * Open a session on the fixture page.
 *
 * @param {string} session - a session name unique to the test.
 * @param {Record<string, unknown>} [extra] - extra browser_open arguments.
 * @returns {Promise<Record<string, unknown>>} the execution bound to that session.
 */
async function openFixture(session, extra = {}) {
  const exec = makeExec({ agent: { name: session } });
  await callTool(state, 'browser_open', { url: `${server.origin}/`, session, ...extra }, exec);
  return exec;
}

test('a popup is reported, not silently followed', async () => {
  const exec = await openFixture('popup');
  const before = await callTool(state, 'browser_tabs', { session: 'popup' }, exec);
  assert.equal(before.value.count, 1);
  assert.equal(before.value.active, 1);

  const clicked = await callTool(state, 'browser_click', { selector: '[data-testid="popup"]', session: 'popup' }, exec);
  assert.equal(clicked.value.openedTabs.length, 1, clicked.text);
  assert.match(clicked.text, /Opened 1 new tab/u);

  const listed = await callTool(state, 'browser_tabs', { session: 'popup' }, exec);
  assert.equal(listed.value.count, 2);
  // The active tab must NOT have moved: following an ad popup would be worse
  // than reporting it, and the caller can switch in one step.
  assert.equal(listed.value.active, 1, listed.text);
  assert.match(listed.text, /opened by the page/u);
  await callTool(state, 'browser_close', { session: 'popup' }, exec);
});

test('tabs can be opened, selected and closed', async () => {
  const exec = await openFixture('tabs');
  const opened = await callTool(state, 'browser_tabs', { action: 'open', url: `${server.origin}/index.html`, session: 'tabs' }, exec);
  assert.equal(opened.value.count, 2);
  assert.equal(opened.value.active, 2, 'an explicitly opened tab becomes active');

  const selected = await callTool(state, 'browser_tabs', { action: 'select', index: 1, session: 'tabs' }, exec);
  assert.equal(selected.value.active, 1);

  const closed = await callTool(state, 'browser_tabs', { action: 'close', index: 2, session: 'tabs' }, exec);
  assert.equal(closed.value.count, 1);

  await assert.rejects(
    () => callTool(state, 'browser_tabs', { action: 'close', index: 1, session: 'tabs' }, exec),
    /last remaining tab cannot be closed/u,
  );
  await assert.rejects(
    () => callTool(state, 'browser_tabs', { action: 'select', index: 9, session: 'tabs' }, exec),
    /no open tab 9/u,
  );
  await assert.rejects(
    () => callTool(state, 'browser_tabs', { action: 'close', session: 'tabs' }, exec),
    /"index" is required/u,
  );
  await callTool(state, 'browser_close', { session: 'tabs' }, exec);
});

test('a confirm is left open for the caller instead of being silently dismissed', async () => {
  const exec = await openFixture('dialogs');

  // The click resolves and NAMES the dialog. Waiting for the action itself would
  // report a bare action timeout, because a modal dialog blocks the renderer.
  const clicked = await callTool(state, 'browser_click', { selector: '[data-testid="confirm"]', session: 'dialogs' }, exec);
  assert.match(clicked.value.dialogMessage, /fixture confirm/u, clicked.text);
  assert.match(clicked.text, /dialog is waiting/u);

  const pending = await callTool(state, 'browser_dialog', { session: 'dialogs' }, exec);
  assert.equal(pending.value.pending, 1, pending.text);
  assert.match(pending.text, /\[confirm\] fixture confirm/u);

  // Everything that needs the renderer must fail fast with the one instruction
  // that unblocks it, rather than hanging until its own timeout.
  await assert.rejects(
    () => callTool(state, 'browser_snapshot', { mode: 'aria', session: 'dialogs' }, exec),
    /dialog is blocking the page[\s\S]*browser_dialog/u,
  );
  await assert.rejects(
    () => callTool(state, 'browser_assert', { checks: [{ kind: 'text', text: 'Fixture App' }], session: 'dialogs' }, exec),
    /dialog is blocking the page/u,
  );
  // Reading our own buffers stays available while the page is blocked.
  const console = await callTool(state, 'browser_console', { session: 'dialogs' }, exec);
  assert.equal(typeof console.value.text, 'string');

  const answered = await callTool(state, 'browser_dialog', { action: 'accept', session: 'dialogs' }, exec);
  assert.equal(answered.value.answered, 'confirm');
  assert.equal(answered.value.pending, 0);

  // Accepting must actually reach the page, not just clear our own queue.
  const recorded = await callTool(state, 'browser_eval', { expression: 'document.body.dataset.confirmed', session: 'dialogs' }, exec);
  assert.equal(recorded.value.value, 'yes');

  await assert.rejects(
    () => callTool(state, 'browser_dialog', { action: 'dismiss', session: 'dialogs' }, exec),
    /no dialog waiting to dismiss/u,
  );
  await callTool(state, 'browser_close', { session: 'dialogs' }, exec);
});

test('dismissing a confirm takes the other branch, visibly', async () => {
  const exec = await openFixture('dialogs2');
  await callTool(state, 'browser_click', { selector: '[data-testid="confirm"]', session: 'dialogs2' }, exec);
  await callTool(state, 'browser_dialog', { action: 'dismiss', session: 'dialogs2' }, exec);
  const recorded = await callTool(state, 'browser_eval', { expression: 'document.body.dataset.confirmed', session: 'dialogs2' }, exec);
  assert.equal(recorded.value.value, 'no');
  await callTool(state, 'browser_close', { session: 'dialogs2' }, exec);
});

test('accepting a prompt types the supplied text', async () => {
  const exec = await openFixture('prompt');
  await callTool(state, 'browser_click', { selector: '[data-testid="prompt"]', session: 'prompt' }, exec);
  const listed = await callTool(state, 'browser_dialog', { session: 'prompt' }, exec);
  assert.match(listed.text, /\[prompt\] fixture prompt default="prefilled"/u);
  await callTool(state, 'browser_dialog', { action: 'accept', promptText: 'typed value', session: 'prompt' }, exec);
  const recorded = await callTool(state, 'browser_eval', { expression: 'document.body.dataset.prompt', session: 'prompt' }, exec);
  assert.equal(recorded.value.value, 'typed value');
  await callTool(state, 'browser_close', { session: 'prompt' }, exec);
});

test('an automatic dialog policy answers without a caller', async () => {
  const made = makeContext();
  apply(made.ctx, { artifactsDir, headless: true, agent: process.env.BROWSER_TEST_AGENT ?? 'chrome', dialogPolicy: 'accept' });
  const exec = makeExec();
  await callTool(made.state, 'browser_open', { url: `${server.origin}/` }, exec);
  await callTool(made.state, 'browser_click', { selector: '[data-testid="confirm"]' }, exec);
  const recorded = await callTool(made.state, 'browser_eval', { expression: 'document.body.dataset.confirmed' }, exec);
  assert.equal(recorded.value.value, 'yes');
  const listed = await callTool(made.state, 'browser_dialog', {}, exec);
  assert.equal(listed.value.pending, 0);
  assert.match(listed.text, /accepted \[confirm\]/u);
  await callTool(made.state, 'browser_close', { all: true }).catch(() => {});
  await made.state.dispose();
});

test('storage state is saved without leaking cookie values', async () => {
  const exec = await openFixture('storage');
  await callTool(state, 'browser_click', { selector: '[data-testid="seed"]', session: 'storage' }, exec);

  const status = await callTool(state, 'browser_storage_state', { session: 'storage' }, exec);
  assert.equal(status.value.cookies >= 1, true, status.text);
  assert.match(status.text, /fixture/u);
  assert.ok(!status.text.includes('fixture=1'), 'the cookie value must not appear in model-facing text');

  const saved = await callTool(state, 'browser_storage_state', { action: 'save', path: 'login', session: 'storage' }, exec);
  assert.equal(saved.value.path, path.join(artifactsDir, 'login.json'));
  assert.equal(existsSync(saved.value.path), true);
  const parsed = JSON.parse(await readFile(saved.value.path, 'utf8'));
  assert.ok(Array.isArray(parsed.cookies) && parsed.cookies.length >= 1);
  assert.ok(Array.isArray(parsed.origins));
  assert.match(saved.text, /live session credentials/u);

  const cleared = await callTool(state, 'browser_storage_state', { action: 'clear', session: 'storage' }, exec);
  assert.match(cleared.text, /Cleared/u);
  const after = await callTool(state, 'browser_storage_state', { session: 'storage' }, exec);
  assert.equal(after.value.cookies, 0);
  await callTool(state, 'browser_close', { session: 'storage' }, exec);
});

test('a saved storage state restores a login into a new session', async () => {
  const first = await openFixture('persist-a');
  await callTool(state, 'browser_click', { selector: '[data-testid="seed"]', session: 'persist-a' }, first);
  const saved = await callTool(state, 'browser_storage_state', { action: 'save', path: 'persist', session: 'persist-a' }, first);
  await callTool(state, 'browser_close', { session: 'persist-a' }, first);

  const second = makeExec({ agent: { name: 'persist-b' } });
  await callTool(
    state,
    'browser_open',
    { url: `${server.origin}/`, session: 'persist-b', storageStatePath: saved.value.path },
    second,
  );
  const cookie = await callTool(state, 'browser_eval', { expression: 'document.cookie', session: 'persist-b' }, second);
  assert.match(String(cookie.value.value), /fixture=1/u);
  await callTool(state, 'browser_close', { session: 'persist-b' }, second);
});

test('upload accepts a permitted file and refuses one outside the roots', async () => {
  const exec = await openFixture('upload');
  const permitted = path.join(artifactsDir, 'payload.txt');
  await writeFile(permitted, 'fixture payload', 'utf8');

  const uploaded = await callTool(
    state,
    'browser_upload',
    { selector: '[data-testid="file"]', files: [permitted], session: 'upload' },
    exec,
  );
  assert.deepEqual(uploaded.value.files, [permitted]);
  const names = await callTool(
    state,
    'browser_eval',
    { expression: '[...document.querySelector("[data-testid=file]").files].map(f => f.name)', session: 'upload' },
    exec,
  );
  assert.deepEqual(names.value.value, ['payload.txt']);

  // A path outside every root is the sandbox-escape case this guards.
  const outside = path.join(tmpdir(), 'not-permitted.txt');
  await writeFile(outside, 'nope', 'utf8');
  await assert.rejects(
    () => callTool(state, 'browser_upload', { selector: '[data-testid="file"]', files: [outside], session: 'upload' }, exec),
    /outside the permitted roots/u,
  );
  await assert.rejects(
    () => callTool(state, 'browser_upload', { selector: '[data-testid="file"]', files: ['relative.txt'], session: 'upload' }, exec),
    /must be absolute/u,
  );
  await callTool(state, 'browser_close', { session: 'upload' }, exec);
});

test('a configured uploadRoots entry widens what may be attached', async () => {
  const sharedDir = await mkdtemp(path.join(tmpdir(), 'dsh-upload-root-'));
  const sharedFile = path.join(sharedDir, 'shared.txt');
  await writeFile(sharedFile, 'shared payload', 'utf8');

  const made = makeContext();
  apply(made.ctx, {
    artifactsDir,
    uploadRoots: [sharedDir],
    headless: true,
    agent: process.env.BROWSER_TEST_AGENT ?? 'chrome',
  });
  const exec = makeExec();
  await callTool(made.state, 'browser_open', { url: `${server.origin}/` }, exec);
  const uploaded = await callTool(made.state, 'browser_upload', { selector: '[data-testid="file"]', files: [sharedFile] }, exec);
  assert.deepEqual(uploaded.value.files, [sharedFile]);
  await callTool(made.state, 'browser_close', { all: true }).catch(() => {});
  await made.state.dispose();
});

test('a session can attach to a browser it did not start, and leaves it running', async (context) => {
  const chrome = findChrome();
  if (chrome === undefined) {
    context.skip('no Chrome or Edge binary available to start an attachable browser');
    return;
  }
  const port = 9333;
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'dsh-cdp-profile-'));
  const child = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  try {
    const ready = await waitForEndpoint(`http://127.0.0.1:${port}/json/version`, 20_000);
    if (!ready) {
      context.skip(`the attachable browser did not open port ${port} in time`);
      return;
    }

    const exec = makeExec({ agent: { name: 'cdp' } });
    const opened = await callTool(state, 'browser_open', { cdpEndpoint: `http://127.0.0.1:${port}`, session: 'cdp' }, exec);
    assert.equal(opened.value.attached, true, opened.text);
    assert.match(opened.value.browser, /^cdp:/u);

    const navigated = await callTool(state, 'browser_navigate', { url: `${server.origin}/`, session: 'cdp' }, exec);
    assert.equal(navigated.value.title, 'Fixture App');
    const asserted = await callTool(
      state,
      'browser_assert',
      { checks: [{ kind: 'text', text: 'Fixture App' }], session: 'cdp' },
      exec,
    );
    assert.equal(asserted.value.failed, 0, asserted.text);

    await callTool(state, 'browser_close', { session: 'cdp' }, exec);
    // Closing must disconnect, not kill the browser somebody else owns.
    assert.equal(child.exitCode, null, 'the attached browser must survive browser_close');
    assert.equal(await waitForEndpoint(`http://127.0.0.1:${port}/json/version`, 5_000), true);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

/**
 * Locate an installed Chromium-family browser.
 *
 * @returns {string | undefined} the executable path.
 */
function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Poll an endpoint until it answers or the budget runs out.
 *
 * @param {string} url - the endpoint.
 * @param {number} budgetMs - how long to wait.
 * @returns {Promise<boolean>} whether it answered.
 */
async function waitForEndpoint(url, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
