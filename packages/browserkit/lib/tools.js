/**
 * The model-facing tools.
 *
 * Definitions are raw JSON-Schema `ToolDefinition`s registered through
 * `ctx.tools.register()`. That is the same shape the harness accepts for
 * MCP-sourced tools, and it means this module needs no `@deepseek-ai/dsh-tools`
 * import: the wrapper `defineTool` would only add typed sugar around exactly
 * this object.
 *
 * Conventions shared by every tool:
 *
 * - The canonical value is structured facts, never prose. `output.render` turns
 *   those facts into the text the model reads.
 * - The canonical value includes `text` only where the payload genuinely *is*
 *   text (snapshots, console and network dumps).
 * - Failures throw; a successful domain outcome stays in the value even when it
 *   reports something the caller will not like (a failed assertion, a 404).
 * - `exec.signal` is forwarded into every Playwright wait and into the polling
 *   loops, which is what declaring `timeoutMs` promises.
 *
 * @module dsh-plugin-browserkit/tools
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { admitImage, imageFallbackText } from './attachments.js';
import { CHECK_KINDS, formatReport, runChecks } from './assertions.js';
import { describeTarget, readSnapshot, resolveLocator } from './snapshot.js';
import { clampText, describeValue, isJsonSafe, withTimeout } from './util.js';

/** JSON-Schema fragment for the optional `ref`/`selector` target pair. */
const TARGET_PROPERTIES = {
  ref: {
    type: 'string',
    description: 'Element ref from the latest browser_snapshot (for example "e3"). Preferred over selector.',
  },
  selector: {
    type: 'string',
    description: 'Playwright selector, for example "text=Sign in", "#submit", "[data-testid=row]".',
  },
  session: { type: 'string', description: 'Session name. Omit to use this agent\'s own session.' },
  timeoutMs: { type: 'number', description: 'Override the configured timeout for this call.' },
};

/** The `session` argument, repeated on every tool. */
const SESSION_PROPERTY = {
  session: { type: 'string', description: 'Session name. Omit to use this agent\'s own session.' },
};

/**
 * Assign a stable session key per calling agent.
 *
 * Isolation is per agent, not per call: two teammates testing at the same time
 * must not share cookies or navigate each other's page. A `WeakMap` keyed by the
 * agent object keeps the identity alive exactly as long as the agent is.
 */
const agentKeys = new WeakMap();
let nextAgentKey = 0;

/**
 * Resolve the session key for one call.
 *
 * @param {object} exec - the tool execution.
 * @param {string} [explicit] - an explicit `session` argument.
 * @returns {string} the session key.
 */
function sessionKeyFor(exec, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return `named:${explicit.trim()}`;
  const agent = exec?.agent;
  if (agent !== null && (typeof agent === 'object' || typeof agent === 'function')) {
    let key = agentKeys.get(agent);
    if (key === undefined) {
      key = `agent:${++nextAgentKey}`;
      agentKeys.set(agent, key);
    }
    return key;
  }
  return 'default';
}

/**
 * Acquire the session a call targets.
 *
 * A manual dialog blocks the renderer, so almost every tool would hang until its
 * own timeout and then report a timeout that says nothing about the cause. The
 * handful of tools that can still work while the page is blocked — answering the
 * dialog, listing tabs, closing the session — pass `allowBlocked`; everything
 * else fails immediately with the one instruction that resolves the situation.
 *
 * @param {object} ctx - plugin context (unused, kept for symmetry with other helpers).
 * @param {import('./browser.js').SessionManager} manager - session manager.
 * @param {object} exec - the tool execution.
 * @param {Record<string, unknown>} args - tool arguments.
 * @param {{ allowBlocked?: boolean }} [options] - bypass the blocking-dialog guard.
 * @returns {Promise<import('./browser.js').BrowserSession>} the session.
 * @throws {Error} when a manual dialog is blocking the page.
 */
async function sessionFor(_ctx, manager, exec, args, options = {}) {
  const key = sessionKeyFor(exec, /** @type {string | undefined} */ (args.session));
  const session = await manager.acquire(key);
  if (options.allowBlocked !== true && session.pendingDialogs.length > 0) {
    const pending = session.pendingDialogs[0];
    throw new Error(
      `a ${pending.type} dialog is blocking the page: ${JSON.stringify(clampText(pending.message, 200))}. `
        + 'The page cannot respond until it is answered; call browser_dialog with action "accept" or "dismiss" first.',
    );
  }
  return session;
}

/**
 * Paths an artifact may be written to, confined to one directory.
 *
 * The harness sandboxes its own file tools; this plugin writes with `node:fs`
 * and therefore sits outside that fence. Honoring an arbitrary absolute path
 * here would be a sandbox escape, so an artifact can only ever land inside the
 * configured directory.
 *
 * @param {string} dir - the artifacts directory.
 * @param {string | undefined} requested - the caller's relative name.
 * @param {string} extension - the extension to append when the name has none.
 * @param {string} [prefix] - name prefix used when the caller omits a name.
 * @returns {string} the absolute destination path.
 * @throws {Error} when the name is absolute or escapes the directory.
 */
export function resolveArtifactPath(dir, requested, extension, prefix = 'artifact') {
  const trimmed = typeof requested === 'string' ? requested.trim() : '';
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  let name = trimmed === '' ? `${prefix}-${stamp}.${extension}` : trimmed;
  if (path.isAbsolute(name)) {
    throw new Error('path must be relative: plugin artifacts are confined to the artifacts directory');
  }
  if (path.extname(name) === '') name = `${name}.${extension}`;
  const resolved = path.resolve(dir, name);
  const relative = path.relative(dir, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('path escapes the artifacts directory');
  }
  return resolved;
}

/**
 * Paths a browser may read a file from.
 *
 * Uploading a local file to a page is a *read* primitive: it moves host bytes
 * into a page the model may not control. The harness sandboxes its own file
 * tools, and this plugin sits outside that fence, so an upload path has to be
 * explicitly permitted rather than merely well-formed. The artifacts directory
 * is always permitted; `uploadRoots` adds more.
 *
 * @param {string[]} roots - the permitted absolute directories.
 * @param {string | undefined} requested - the caller's path.
 * @returns {string} the resolved absolute path.
 * @throws {Error} when the path is missing, relative, or outside every root.
 */
export function resolveReadablePath(roots, requested) {
  const trimmed = typeof requested === 'string' ? requested.trim() : '';
  if (trimmed === '') throw new Error('files must name at least one file');
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`upload paths must be absolute; got ${JSON.stringify(trimmed)}`);
  }
  const resolved = path.resolve(trimmed);
  const normalise = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const permitted = roots.some((root) => {
    const relative = path.relative(normalise(path.resolve(root)), normalise(resolved));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (!permitted) {
    throw new Error(
      `upload path ${JSON.stringify(resolved)} is outside the permitted roots (${roots.join(', ')}). `
        + 'Add its directory to the `uploadRoots` config to permit it.',
    );
  }
  return resolved;
}

/**
 * Describe tabs a call opened, for the result of an action that can trigger one.
 *
 * @param {import('./browser.js').BrowserSession} session - the session.
 * @param {number} before - `session.popups.length` before the action.
 * @returns {{ opened: Array<{ url: string }>, active: boolean }} the new tabs and whether focus moved.
 */
function popupsSince(session, before) {
  const opened = session.popups.slice(before).map((popup) => ({ url: popup.url }));
  return { opened, active: session.config.newTabPolicy === 'focus' && opened.length > 0 };
}

/**
 * Name a dialog that is blocking the page, or return an empty string.
 *
 * A blocked page and a page that quietly took the wrong branch look identical in
 * a tool result unless the dialog is named, so this is appended wherever a
 * dialog can stall.
 *
 * `render` has no access to the session, so the message travels through the
 * canonical value and the formatting happens here.
 *
 * @param {string} message - the pending dialog's message, empty when none.
 * @returns {string} one sentence, or an empty string.
 */
function dialogWarning(message) {
  if (message === '') return '';
  return `\nA dialog is waiting and is blocking the page: ${JSON.stringify(clampText(message, 200))}. `
    + 'Answer it with browser_dialog (action "accept" or "dismiss").';
}

/**
 * The pending dialog's message, or an empty string.
 *
 * @param {import('./browser.js').BrowserSession} session - the session.
 * @returns {string} the message.
 */
function pendingDialogMessage(session) {
  return session.pendingDialogs[0]?.message ?? '';
}

/**
 * Render the tab listing, fetching each title.
 *
 * Titles need an async read, so they cannot live on the synchronous `tabs()`.
 *
 * @param {import('./browser.js').BrowserSession} session - the session.
 * @returns {Promise<{ text: string, active: number, count: number }>} the listing.
 */
async function tabsSummary(session) {
  const tabs = session.tabs();
  const lines = [];
  for (const tab of tabs) {
    // A blocked renderer never answers a title read, and listing tabs has to keep
    // working while a dialog is open, so the read is bounded.
    const title = await withTimeout(session.tabAt(tab.index).title().catch(() => ''), 1_000, '');
    const marker = tab.active ? '*' : ' ';
    lines.push(`${marker} ${tab.index}  ${tab.url}${title === '' ? '' : `\n     ${clampText(title, 120)}`}${tab.popup ? '  (opened by the page)' : ''}`);
  }
  const active = tabs.find((tab) => tab.active)?.index ?? 0;
  return {
    text: `${tabs.length} tab(s); * marks the active one:\n${lines.join('\n')}`,
    active,
    count: tabs.length,
  };
}

/**
 * Render pending and recent dialogs.
 *
 * @param {import('./browser.js').BrowserSession} session - the session.
 * @returns {{ text: string, pending: number }} the summary.
 */
function dialogsSummary(session) {
  const lines = [];
  if (session.pendingDialogs.length === 0) {
    lines.push('No dialog is waiting.');
  } else {
    lines.push(`${session.pendingDialogs.length} dialog(s) waiting and blocking the page:`);
    for (const entry of session.pendingDialogs) {
      lines.push(`  [${entry.type}] ${clampText(entry.message, 300)}${entry.defaultValue === '' ? '' : ` default=${JSON.stringify(entry.defaultValue)}`}`);
    }
  }
  const recent = session.dialogs.slice(-5);
  if (recent.length > 0) {
    lines.push('Recent dialogs:');
    for (const record of recent) lines.push(`  ${record.answer} [${record.type}] ${clampText(record.message, 200)}`);
  }
  return { text: lines.join('\n'), pending: session.pendingDialogs.length };
}

/**
 * Run a page action that may be stopped dead by a dialog.
 *
 * With `dialogPolicy: manual`, an action that opens a `confirm()` never settles:
 * the renderer is blocked, so Playwright's action-ability machinery waits until
 * its own timeout and then reports `locator.click: Timeout ... exceeded`, which
 * says nothing about the dialog that caused it. That message sends an
 * unattended run into a retry loop.
 *
 * So the action is raced against the dialog signal. If a dialog wins, the action
 * is abandoned — not cancelled, because the click did happen and the browser is
 * simply waiting for an answer — and the caller is told what to answer. The
 * abandoned promise keeps its rejection handler, so it cannot surface as an
 * unhandled rejection later.
 *
 * @param {import('./browser.js').BrowserSession} session - the session.
 * @param {() => Promise<unknown>} action - the page action to attempt.
 * @returns {Promise<string>} the pending dialog's message, or an empty string.
 * @throws {Error} the action's own error, when it failed for a real reason.
 */
async function guardedAction(session, action) {
  const outcome = action().then(() => ({ failed: false }), (error) => ({ failed: true, error }));
  if (session.config.dialogPolicy !== 'manual') {
    const settled = await outcome;
    if (settled.failed) throw settled.error;
    return '';
  }
  const winner = await Promise.race([outcome, session.waitForDialog().then(() => 'dialog')]);
  if (winner === 'dialog') return pendingDialogMessage(session);
  if (winner.failed) throw winner.error;
  return '';
}

/**
 * Navigate and describe the outcome.
 *
 * @param {import('playwright-core').Page} page - the page.
 * @param {string} url - the destination.
 * @param {string} waitUntil - one of load/domcontentloaded/networkidle/commit.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ url: string, title: string }>} the settled location.
 */
async function goto(page, url, waitUntil, signal) {
  await page.goto(url, { waitUntil, signal });
  return { url: page.url(), title: await page.title().catch(() => '') };
}

/** Text output helper: one text block built from the canonical value. */
function asText(fn) {
  return (_args, value) => [{ type: 'text', text: fn(value) }];
}

/** Convenience: a `{ type: 'object' }` output schema closed to extra keys. */
function objectSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Shared summary header for a page-level result. */
function locationLine(value) {
  return `URL: ${value.url}${value.title ? `\nTitle: ${value.title}` : ''}`;
}

/**
 * Build every tool definition.
 *
 * @param {object} options - build options.
 * @param {Record<string, unknown>} options.config - resolved plugin config.
 * @param {import('./browser.js').SessionManager} options.manager - session manager.
 * @param {object} options.ctx - plugin context, used for optional services.
 * @param {{ warn: (message: string) => void }} options.log - diagnostic sink.
 * @returns {Array<Record<string, unknown>>} registry-ready tool definitions.
 */
export function createTools({ config, manager, ctx, log }) {
  /** Per-execution image projections for `browser_screenshot`. */
  const projections = new WeakMap();
  const timeoutMs = config.toolTimeoutMs;

  return [
    {
      name: 'browser_open',
      description:
        'Open a browser session and optionally navigate to a URL. Sessions are isolated per agent, so parallel agents never share cookies or page state. Returns the session, the resolved browser and the page location. Set storageStatePath to start from a saved login; set cdpEndpoint to drive a browser that is already running.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open. Omit to open a blank page.' },
          session: SESSION_PROPERTY.session,
          headless: { type: 'boolean', description: 'Override the configured headless mode for this session.' },
          agent: { type: 'string', enum: ['chrome', 'msedge', 'chromium', 'auto'], description: 'Override the browser for this session.' },
          viewportWidth: { type: 'number', description: 'Viewport width in CSS pixels.' },
          viewportHeight: { type: 'number', description: 'Viewport height in CSS pixels.' },
          storageStatePath: {
            type: 'string',
            description: 'Absolute path to a saved storage state (cookies and localStorage) to start from. Rebuilds the session.',
          },
          cdpEndpoint: {
            type: 'string',
            description: 'Attach to a running browser over CDP, for example "http://127.0.0.1:9222". Rebuilds the session.',
          },
          waitUntil: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
            description: 'Navigation readiness to wait for. Defaults to load.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          {
            session: { type: 'string' },
            browser: { type: 'string' },
            url: { type: 'string' },
            title: { type: 'string' },
            viewport: { type: 'string' },
            tabs: { type: 'integer' },
            attached: { type: 'boolean' },
          },
          ['session', 'browser', 'url', 'title', 'viewport', 'tabs', 'attached'],
        ),
        render: asText(
          (value) =>
            `Opened a ${value.browser} session "${value.session}" at ${value.viewport}`
            + `${value.attached ? ' (attached to a browser this session did not start)' : ''}, ${value.tabs} tab(s).\n${locationLine(value)}`,
        ),
      },
      timeoutMs,
      async execute(args, exec) {
        const overrides = {
          ...args.agent === undefined ? {} : { agent: args.agent },
          ...args.headless === undefined ? {} : { headless: args.headless },
          ...args.viewportWidth === undefined ? {} : { viewportWidth: args.viewportWidth },
          ...args.viewportHeight === undefined ? {} : { viewportHeight: args.viewportHeight },
          ...args.storageStatePath === undefined ? {} : { storageStatePath: args.storageStatePath },
          ...args.cdpEndpoint === undefined ? {} : { cdpEndpoint: args.cdpEndpoint },
        };
        const key = sessionKeyFor(exec, /** @type {string | undefined} */ (args.session));
        // The manager applies the overrides, including resizing a reused session.
        const session = await manager.acquire(key, overrides);
        const page = await session.page();
        let location = { url: page.url(), title: await page.title().catch(() => '') };
        if (typeof args.url === 'string' && args.url.trim() !== '') {
          location = await goto(page, args.url.trim(), /** @type {string} */ (args.waitUntil ?? 'load'), exec.signal);
          session.invalidateRefs();
        }
        return {
          session: key,
          browser: session.agent,
          url: location.url,
          title: location.title,
          viewport: `${session.viewport.width}x${session.viewport.height}`,
          tabs: session.tabs().length,
          attached: session.attached,
        };
      },
    },

    {
      name: 'browser_navigate',
      description: 'Navigate the session page: go to a URL, or go back, forward or reload. Clears the element ref inventory.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Destination URL. Required when action is "goto".' },
          action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload'], description: 'Defaults to goto.' },
          waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'commit'] },
          session: SESSION_PROPERTY.session,
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema({ url: { type: 'string' }, title: { type: 'string' } }, ['url', 'title']),
        render: asText((value) => `Navigated.\n${locationLine(value)}`),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        const page = await session.page();
        const action = /** @type {string} */ (args.action ?? 'goto');
        const waitUntil = /** @type {string} */ (args.waitUntil ?? 'load');
        let location;
        if (action === 'goto') {
          if (typeof args.url !== 'string' || args.url.trim() === '') throw new Error('browser_navigate: "url" is required when action is "goto"');
          location = await goto(page, args.url.trim(), waitUntil, exec.signal);
        } else if (action === 'back') {
          await page.goBack({ waitUntil, signal: exec.signal });
          location = { url: page.url(), title: await page.title().catch(() => '') };
        } else if (action === 'forward') {
          await page.goForward({ waitUntil, signal: exec.signal });
          location = { url: page.url(), title: await page.title().catch(() => '') };
        } else {
          await page.reload({ waitUntil, signal: exec.signal });
          location = { url: page.url(), title: await page.title().catch(() => '') };
        }
        session.invalidateRefs();
        return location;
      },
    },

    {
      name: 'browser_snapshot',
      description:
        'Read the page: the accessibility tree for structure, plus a numbered inventory of visible interactive elements with refs. Call this before interacting, and again after anything that changes the page.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['aria', 'inventory', 'both'], description: 'Defaults to both.' },
          selector: { type: 'string', description: 'Scope the read to one subtree.' },
          session: SESSION_PROPERTY.session,
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          {
            text: { type: 'string' },
            url: { type: 'string' },
            itemCount: { type: 'integer' },
            truncated: { type: 'boolean' },
            consoleErrors: { type: 'integer' },
          },
          ['text', 'url', 'itemCount', 'truncated', 'consoleErrors'],
        ),
        render: asText((value) => value.text),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        const page = await session.page();
        const snapshot = await readSnapshot(page, session.config, {
          ...args.mode === undefined ? {} : { mode: args.mode },
          ...args.selector === undefined ? {} : { selector: args.selector },
          session,
        });
        // A page blocked by a dialog looks like an ordinary page until it is
        // named, so the warning rides along with the read the agent will make
        // when something appears not to have happened.
        const dialogMessage = pendingDialogMessage(session);
        return {
          ...snapshot,
          text: `${snapshot.text}${dialogWarning(dialogMessage)}`,
          url: page.url(),
        };
      },
    },

    {
      name: 'browser_click',
      description:
        'Click an element, by ref from browser_snapshot or by selector. Waits for the element to be actionable first. A click that opens a popup or a new tab reports the new tab in the result instead of switching to it, unless the deployment sets newTabPolicy to focus.',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPERTIES,
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Defaults to left.' },
          clickCount: { type: 'number', description: '1 for a click, 2 for a double click.' },
          force: { type: 'boolean', description: 'Skip actionability checks. Use only for elements a human would still be able to click.' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          {
            target: { type: 'string' },
            url: { type: 'string' },
            title: { type: 'string' },
            navigated: { type: 'boolean' },
            openedTabs: { type: 'array', items: { type: 'string' } },
            dialogMessage: { type: 'string' },
          },
          ['target', 'url', 'title', 'navigated', 'openedTabs', 'dialogMessage'],
        ),
        render: asText((value) => `Clicked ${value.target}.`
          + (value.navigated ? ' Page navigated.' : '')
          + (value.openedTabs.length > 0
            ? ` Opened ${value.openedTabs.length} new tab: ${value.openedTabs.join(', ')}. Use browser_tabs to list or select it.`
            : '')
          + `${locationLine(value)}${dialogWarning(value.dialogMessage)}`),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        const page = await session.page();
        const before = page.url();
        const popupsBefore = session.popups.length;
        const dialogMessage = await guardedAction(session, () => resolveLocator(page, session, args, 'browser_click').click({
          button: /** @type {'left' | 'right' | 'middle'} */ (args.button ?? 'left'),
          clickCount: Number.isInteger(args.clickCount) ? /** @type {number} */ (args.clickCount) : 1,
          force: args.force === true,
          timeout: Number.isInteger(args.timeoutMs) ? /** @type {number} */ (args.timeoutMs) : session.config.defaultTimeoutMs,
          signal: exec.signal,
        }));
        // A tab opened by this click appears a moment after the click resolves,
        // so watch briefly before diffing. Bounded and configurable.
        await session.waitForNewTab(/** @type {number} */ (session.config.newTabWaitMs));
        const opened = popupsSince(session, popupsBefore);
        // Only follow the popup when the deployment asked for it; otherwise the
        // result names it and the caller decides.
        const active = opened.active ? await session.page() : page;
        const title = dialogMessage === '' ? await active.title().catch(() => '') : '';
        const navigated = active.url() !== before;
        if (navigated) session.invalidateRefs();
        return {
          target: describeTarget(args),
          url: active.url(),
          title,
          navigated,
          openedTabs: opened.opened.map((popup) => popup.url),
          dialogMessage,
        };
      },
    },

    {
      name: 'browser_type',
      description:
        'Type text into an input, textarea or contenteditable element. Clears the field first by default; set clear to false to append. Set submit to true to press Enter afterwards.',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPERTIES,
          text: { type: 'string', description: 'The text to type.' },
          clear: { type: 'boolean', description: 'Clear the field before typing. Defaults to true.' },
          submit: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' },
          delayMs: { type: 'number', description: 'Delay between keystrokes, for inputs that need human-like timing.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          {
            target: { type: 'string' },
            value: { type: 'string' },
            submitted: { type: 'boolean' },
            url: { type: 'string' },
            title: { type: 'string' },
            dialogMessage: { type: 'string' },
          },
          ['target', 'value', 'submitted', 'url', 'title', 'dialogMessage'],
        ),
        render: asText(
          (value) =>
            `Typed into ${value.target}${value.submitted ? ' and pressed Enter' : ''}. Now ${JSON.stringify(clampText(value.value, 200))}.`
            + `${locationLine(value)}${dialogWarning(value.dialogMessage)}`,
        ),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        const page = await session.page();
        const locator = resolveLocator(page, session, args, 'browser_type');
        const timeout = Number.isInteger(args.timeoutMs) ? /** @type {number} */ (args.timeoutMs) : session.config.defaultTimeoutMs;
        const submitted = args.submit === true;
        // Enter can open a confirm just as easily as a click can.
        const dialogMessage = await guardedAction(session, async () => {
          if (args.clear !== false) await locator.fill('', { timeout, signal: exec.signal });
          await locator.pressSequentially(String(args.text), {
            ...Number.isInteger(args.delayMs) ? { delay: /** @type {number} */ (args.delayMs) } : {},
            timeout,
            signal: exec.signal,
          });
          if (submitted) await locator.press('Enter', { timeout, signal: exec.signal });
        });
        // Reading value or title would hang on a blocked renderer.
        let value = String(args.text);
        if (dialogMessage === '') {
          try {
            value = await locator.inputValue({ timeout });
          } catch {
            value = String(args.text);
          }
        }
        return {
          target: describeTarget(args),
          value,
          submitted,
          url: page.url(),
          title: dialogMessage === '' ? await page.title().catch(() => '') : '',
          dialogMessage,
        };
      },
    },

    {
      name: 'browser_press',
      description: 'Press a key or key combination, for example "Enter", "Escape", "Tab" or "Control+A". Targets the page unless a ref or selector is given.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Playwright key name, for example "Enter" or "Control+A".' },
          ...TARGET_PROPERTIES,
        },
        required: ['key'],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          { key: { type: 'string' }, target: { type: 'string' }, dialogMessage: { type: 'string' } },
          ['key', 'target', 'dialogMessage'],
        ),
        render: asText((value) => `Pressed ${value.key} on ${value.target}.${dialogWarning(value.dialogMessage)}`),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        const page = await session.page();
        const key = String(args.key);
        const hasTarget = args.ref !== undefined || args.selector !== undefined;
        const dialogMessage = await guardedAction(session, async () => {
          if (hasTarget) await resolveLocator(page, session, args, 'browser_press').press(key, { signal: exec.signal });
          else await page.keyboard.press(key, { signal: exec.signal });
        });
        return { key, target: hasTarget ? describeTarget(args) : 'page', dialogMessage };
      },
    },

    {
      name: 'browser_select',
      description: 'Choose one or more options in a native <select> element, by value, label or index.',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPERTIES,
          values: { type: 'array', items: { type: 'string' }, description: 'Option values or labels to select.' },
        },
        required: ['values'],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          { target: { type: 'string' }, selected: { type: 'array', items: { type: 'string' } }, dialogMessage: { type: 'string' } },
          ['target', 'selected', 'dialogMessage'],
        ),
        render: asText((value) => `Selected ${JSON.stringify(value.selected)} in ${value.target}.${dialogWarning(value.dialogMessage)}`),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        const page = await session.page();
        const locator = resolveLocator(page, session, args, 'browser_select');
        const requested = /** @type {string[]} */ (args.values).map(String);
        // An onchange handler can open a confirm just as a click can.
        const dialogMessage = await guardedAction(session, () => locator.selectOption(requested, { signal: exec.signal }));
        return { target: describeTarget(args), selected: requested, dialogMessage };
      },
    },

    {
      name: 'browser_hover',
      description: 'Move the mouse over an element, for menus and tooltips that only appear on hover.',
      parameters: {
        type: 'object',
        properties: { ...TARGET_PROPERTIES },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema({ target: { type: 'string' } }, ['target']),
        render: asText((value) => `Hovered ${value.target}.`),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        const page = await session.page();
        await resolveLocator(page, session, args, 'browser_hover').hover({ signal: exec.signal });
        return { target: describeTarget(args) };
      },
    },

    {
      name: 'browser_wait_for',
      description:
        'Wait for an element state or for text to appear. Prefer this over a fixed delay: waiting on the actual condition is what keeps a UI test from being flaky.',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPERTIES,
          state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'], description: 'Element state to wait for. Defaults to visible.' },
          text: { type: 'string', description: 'Wait until the page text contains this string.' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          { condition: { type: 'string' }, waitedMs: { type: 'integer' } },
          ['condition', 'waitedMs'],
        ),
        render: asText((value) => `Waited ${value.waitedMs}ms for ${value.condition}.`),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        const page = await session.page();
        const timeout = Number.isInteger(args.timeoutMs) ? /** @type {number} */ (args.timeoutMs) : session.config.defaultTimeoutMs;
        const started = Date.now();
        const hasTarget = args.ref !== undefined || args.selector !== undefined;
        let condition;
        if (typeof args.text === 'string' && args.text !== '') {
          const wanted = args.text;
          condition = `text ${JSON.stringify(clampText(wanted, 80))} to appear`;
          await page.waitForFunction(
            (needle) => (document.body?.innerText ?? '').includes(needle),
            wanted,
            { timeout, signal: exec.signal },
          );
        } else if (hasTarget) {
          const state = /** @type {'visible' | 'hidden' | 'attached' | 'detached'} */ (args.state ?? 'visible');
          condition = `${describeTarget(args)} to be ${state}`;
          await resolveLocator(page, session, args, 'browser_wait_for').waitFor({ state, timeout, signal: exec.signal });
        } else {
          throw new Error('browser_wait_for: provide "text", or a "ref"/"selector" to wait on');
        }
        return { condition, waitedMs: Date.now() - started };
      },
    },

    {
      name: 'browser_eval',
      description:
        'Evaluate a JavaScript expression in the page and return its JSON value. With a ref or selector, the element is available as `el` inside the expression. Use it to inspect state the accessibility tree does not expose; prefer snapshot plus assertions for verification.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript expression. With a target, `el` refers to the element.' },
          ...TARGET_PROPERTIES,
        },
        required: ['expression'],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          { value: {}, target: { type: 'string' } },
          ['value', 'target'],
        ),
        render: asText((value) => `Evaluated on ${value.target}:\n${JSON.stringify(value.value, null, 2)}`),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        if (session.config.allowEvaluate !== true) {
          throw new Error('browser_eval is disabled by this deployment (allowEvaluate: false)');
        }
        const page = await session.page();
        const expression = String(args.expression);
        const hasTarget = args.ref !== undefined || args.selector !== undefined;
        // The element selector is inlined as a literal rather than stashed on
        // `window`, so the expression cannot leak state into the page and no
        // `eval`/`new Function` (which a strict CSP would block) is needed.
        const selectorLiteral = hasTarget
          ? JSON.stringify(storedSelector(session, args, 'browser_eval'))
          : 'null';
        const wrapped = `(() => {
  const el = ${hasTarget ? `document.querySelector(${selectorLiteral})` : 'null'};
  ${hasTarget ? 'if (el === null) return { __dsh: "missing" };' : ''}
  const value = (${expression});
  if (value === undefined) return { __dsh: 'undefined' };
  if (value === null) return null;
  if (typeof value === 'function') return { __dsh: 'function', name: value.name || '' };
  if (typeof value === 'bigint') return { __dsh: 'bigint', text: String(value) };
  if (typeof Node !== 'undefined' && value instanceof Node) {
    return { __dsh: 'node', text: value.nodeName ? value.nodeName.toLowerCase() : 'node' };
  }
  return value;
})()`;
        const raw = await page.evaluate(wrapped);
        return { value: normalizeEvalResult(raw), target: hasTarget ? describeTarget(args) : 'page' };
      },
    },

    {
      name: 'browser_screenshot',
      description:
        'Capture a screenshot to a file under the artifacts directory. When the active model accepts image input the image is also placed in context, so you can see the UI. Use fullPage for the whole scrollable page, or a ref/selector for one element.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file name inside the artifacts directory. Defaults to a timestamped name.' },
          fullPage: { type: 'boolean', description: 'Capture the whole scrollable page. Defaults to false.' },
          ...TARGET_PROPERTIES,
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          {
            path: { type: 'string' },
            bytes: { type: 'integer' },
            mediaType: { type: 'string' },
            inModelContext: { type: 'boolean' },
            note: { type: 'string' },
          },
          ['path', 'bytes', 'mediaType', 'inModelContext'],
        ),
        render: asText((value) => `Screenshot saved to ${value.path} (${value.bytes} bytes, ${value.mediaType}).`
          + (value.note === undefined ? '' : ` ${value.note}`)),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        const page = await session.page();
        const type = /** @type {'png' | 'jpeg'} */ (session.config.screenshotType);
        const destination = resolveArtifactPath(/** @type {string} */ (session.config.artifactsDir), /** @type {string | undefined} */ (args.path), type, 'screenshot');
        await mkdir(path.dirname(destination), { recursive: true });
        const hasTarget = args.ref !== undefined || args.selector !== undefined;
        const buffer = hasTarget
          ? await resolveLocator(page, session, args, 'browser_screenshot').screenshot({ type, signal: exec.signal })
          : await page.screenshot({ type, fullPage: args.fullPage === true, signal: exec.signal });
        await writeFile(destination, buffer);
        const mediaType = type === 'jpeg' ? 'image/jpeg' : 'image/png';
        let inModelContext = false;
        let note;
        if (session.config.attachImagesToContext === true) {
          const admitted = await admitImage(ctx, exec, buffer, mediaType);
          if (admitted.ok) {
            inModelContext = true;
            projections.set(exec, [
              { type: 'text', text: `Screenshot of ${page.url()} saved to ${destination}.` },
              { type: 'image', attachment: admitted.ref },
            ]);
          } else {
            note = imageFallbackText(destination, admitted.reason);
          }
        }
        return {
          path: destination,
          bytes: buffer.length,
          mediaType,
          inModelContext,
          ...note === undefined ? {} : { note },
        };
      },
      projectContent(exec, result) {
        const projection = projections.get(exec);
        projections.delete(exec);
        if (projection === undefined || result.isError === true) return undefined;
        return projection;
      },
    },

    {
      name: 'browser_assert',
      description:
        `Verify UI state and return a pass/fail report. Checks are evaluated independently and never stop at the first failure, so one call reports everything wrong. Supported kinds: ${CHECK_KINDS.join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          session: SESSION_PROPERTY.session,
          checks: {
            type: 'array',
            description: 'One or more checks; each object needs a "kind" plus its arguments.',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: CHECK_KINDS },
                ref: { type: 'string' },
                selector: { type: 'string' },
                text: { type: 'string', description: 'Expected text for a text check.' },
                value: { type: 'string', description: 'Expected value for value/url/title/attribute checks.' },
                name: { type: 'string', description: 'Attribute name for an attribute check.' },
                mode: {
                  type: 'string',
                  enum: ['contains', 'equals', 'regex', 'not_contains'],
                  description: 'Comparison mode. Defaults to contains (equals for attribute).',
                },
                exactly: { type: 'number' },
                min: { type: 'number' },
                max: { type: 'number' },
                checked: { type: 'boolean' },
                timeoutMs: { type: 'number' },
              },
              required: ['kind'],
              additionalProperties: false,
            },
          },
        },
        required: ['checks'],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          {
            passed: { type: 'integer' },
            failed: { type: 'integer' },
            results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          ['passed', 'failed', 'results'],
        ),
        render: asText((value) => formatReport(value)),
      },
      timeoutMs,
      async execute(args, exec) {
        const raw = args.checks;
        if (!Array.isArray(raw) || raw.length === 0) throw new Error('browser_assert: "checks" must contain at least one check');
        const session = await sessionFor(ctx, manager, exec, args);
        const page = await session.page();
        const report = await runChecks(page, session, /** @type {Array<Record<string, unknown>>} */ (raw), session.config, exec.signal);
        return { passed: report.passed, failed: report.failed, results: report.results };
      },
    },

    {
      name: 'browser_console',
      description: 'Read console messages and uncaught page errors captured for the session. Defaults to warnings and errors only.',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['error', 'warning', 'all'], description: 'Defaults to warning (warnings and errors).' },
          limit: { type: 'number', description: 'Maximum entries to return, most recent last. Defaults to 50.' },
          clear: { type: 'boolean', description: 'Clear the buffer after reading.' },
          session: SESSION_PROPERTY.session,
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          {
            text: { type: 'string' },
            total: { type: 'integer' },
            errorCount: { type: 'integer' },
          },
          ['text', 'total', 'errorCount'],
        ),
        render: asText((value) => value.text),
      },
      timeoutMs,
      async execute(args, exec) {
        // Console reads only touch this plugin's own buffer, so they stay useful
        // while a dialog has the page blocked.
        const session = await sessionFor(ctx, manager, exec, args, { allowBlocked: true });
        await session.page();
        const level = /** @type {string} */ (args.level ?? 'warning');
        const limit = Number.isInteger(args.limit) ? /** @type {number} */ (args.limit) : 50;
        const wanted = session.consoleMessages.filter((entry) => {
          if (level === 'all') return true;
          if (level === 'error') return entry.level === 'error';
          return entry.level === 'error' || entry.level === 'warning';
        });
        const shown = wanted.slice(-limit);
        const errorCount = session.consoleMessages.filter((entry) => entry.level === 'error').length;
        const total = session.consoleMessages.length;
        const text = shown.length === 0
          ? `No console messages at level "${level}". (${total} total captured.)`
          : `${shown.length} of ${wanted.length} console messages:\n${shown.map((entry) => `  [${entry.level}] ${clampText(entry.text, 500)}`).join('\n')}`;
        if (args.clear === true) session.consoleMessages.length = 0;
        return { text, total, errorCount };
      },
    },

    {
      name: 'browser_network',
      description: 'Read network failures and error responses (status 400 and above) captured for the session. Use it to explain a UI that did not update.',
      parameters: {
        type: 'object',
        properties: {
          onlyFailed: { type: 'boolean', description: 'Only transport-level failures, ignoring 4xx/5xx responses. Defaults to false.' },
          limit: { type: 'number', description: 'Maximum entries to return. Defaults to 50.' },
          clear: { type: 'boolean', description: 'Clear the buffer after reading.' },
          session: SESSION_PROPERTY.session,
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema({ text: { type: 'string' }, total: { type: 'integer' } }, ['text', 'total']),
        render: asText((value) => value.text),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args, { allowBlocked: true });
        await session.page();
        const limit = Number.isInteger(args.limit) ? /** @type {number} */ (args.limit) : 50;
        const entries = args.onlyFailed === true
          ? session.network.filter((entry) => entry.failure !== undefined)
          : session.network;
        const shown = entries.slice(-limit);
        const total = session.network.length;
        const text = shown.length === 0
          ? 'No failed requests or error responses captured.'
          : `${shown.length} of ${entries.length} entries:\n${shown
              .map((entry) => `  ${entry.status ?? `FAILED (${entry.failure})`} ${entry.method} ${clampText(entry.url, 300)}`)
              .join('\n')}`;
        if (args.clear === true) session.network.length = 0;
        return { text, total };
      },
    },

    {
      name: 'browser_tabs',
      description:
        'List, select, open or close tabs in the session. A click that opens a popup does not switch to it by default, so this is how a popup or OAuth window is followed. Tab numbers are stable for the life of the tab, unlike snapshot refs.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'select', 'open', 'close'], description: 'Defaults to list.' },
          index: { type: 'number', description: 'Tab number from action "list". Required by select and close.' },
          url: { type: 'string', description: 'URL to open when action is "open".' },
          session: SESSION_PROPERTY.session,
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          {
            text: { type: 'string' },
            active: { type: 'integer' },
            count: { type: 'integer' },
          },
          ['text', 'active', 'count'],
        ),
        render: asText((value) => value.text),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args, { allowBlocked: true });
        // Pick up tabs opened outside this plugin, so an attached browser's own
        // new windows are listable.
        await session.reconcileTabs();
        const action = /** @type {string} */ (args.action ?? 'list');
        if (action === 'select') {
          if (!Number.isInteger(args.index)) throw new Error('browser_tabs: "index" is required when action is "select"');
          await session.selectTab(/** @type {number} */ (args.index));
        } else if (action === 'open') {
          await session.openTab(typeof args.url === 'string' ? args.url : undefined, exec.signal);
        } else if (action === 'close') {
          if (!Number.isInteger(args.index)) throw new Error('browser_tabs: "index" is required when action is "close"');
          const closed = await session.closeTab(/** @type {number} */ (args.index));
          if (!closed) throw new Error('browser_tabs: the last remaining tab cannot be closed');
        } else if (action !== 'list') {
          throw new Error(`browser_tabs: unsupported action ${JSON.stringify(action)}; use list, select, open or close`);
        }
        return tabsSummary(session);
      },
    },

    {
      name: 'browser_dialog',
      description:
        'List and answer alert, confirm and prompt dialogs. A dialog blocks the page until it is answered, so read it before deciding; a confirm that nobody answers is better than a confirm that was silently dismissed.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'accept', 'dismiss'], description: 'Defaults to list.' },
          promptText: { type: 'string', description: 'Text to enter when accepting a prompt dialog.' },
          session: SESSION_PROPERTY.session,
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          {
            text: { type: 'string' },
            pending: { type: 'integer' },
            answered: { type: 'string' },
          },
          ['text', 'pending', 'answered'],
        ),
        render: asText((value) => value.text),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args, { allowBlocked: true });
        await session.page();
        const action = /** @type {string} */ (args.action ?? 'list');
        let answered = '';
        if (action === 'accept' || action === 'dismiss') {
          const result = await session.answerDialog(
            action,
            action === 'accept' && typeof args.promptText === 'string' ? args.promptText : undefined,
          );
          if (result === undefined) throw new Error(`browser_dialog: there is no dialog waiting to ${action}`);
          answered = result.type;
        } else if (action !== 'list') {
          throw new Error(`browser_dialog: unsupported action ${JSON.stringify(action)}; use list, accept or dismiss`);
        }
        return { ...dialogsSummary(session), answered };
      },
    },

    {
      name: 'browser_storage_state',
      description:
        'Inspect, save or clear the session\'s cookies and web storage. Use it to keep a login between runs: save the state to a file, then pass that file as storageStatePath to browser_open. Cookie values are never returned, only names.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'save', 'clear'], description: 'Defaults to status.' },
          path: {
            type: 'string',
            description: 'Relative file name inside the artifacts directory for action "save". Defaults to a timestamped name.',
          },
          session: SESSION_PROPERTY.session,
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          {
            action: { type: 'string' },
            cookies: { type: 'integer' },
            origins: { type: 'array', items: { type: 'string' } },
            path: { type: 'string' },
            text: { type: 'string' },
          },
          ['action', 'cookies', 'origins', 'text'],
        ),
        render: asText((value) => value.text),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        const action = /** @type {string} */ (args.action ?? 'status');
        if (action === 'save') {
          const destination = resolveArtifactPath(
            /** @type {string} */ (session.config.artifactsDir),
            typeof args.path === 'string' && args.path.trim() !== ''
              ? args.path
              : `storage-state-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`,
            'json',
          );
          await mkdir(path.dirname(destination), { recursive: true });
          const saved = await session.saveStorageState(destination);
          return {
            action,
            cookies: saved.cookies,
            origins: [],
            path: saved.path,
            text: `Saved ${saved.cookies} cookie(s) and ${saved.origins} origin(s) to ${saved.path}.\n`
              + 'Pass this path as storageStatePath to browser_open to start a later session logged in. '
              + 'The file holds live session credentials: treat it like a password.',
          };
        }
        if (action === 'clear') {
          await session.clearStorageState();
          return { action, cookies: 0, origins: [], text: 'Cleared cookies, localStorage and sessionStorage for the session.' };
        }
        if (action !== 'status') {
          throw new Error(`browser_storage_state: unsupported action ${JSON.stringify(action)}; use status, save or clear`);
        }
        const summary = await session.storageSummary();
        return {
          action,
          cookies: summary.cookies,
          origins: summary.origins,
          text: `${summary.cookies} cookie(s): ${summary.cookieNames.join(', ') || '(none)'}\n`
            + `localStorage origins: ${summary.origins.join(', ') || '(none)'}`,
        };
      },
    },

    {
      name: 'browser_upload',
      description:
        'Attach one or more local files to a file input. Paths must be inside the artifacts directory or a configured uploadRoots entry, because uploading a file to a page reads host bytes the harness file sandbox does not otherwise expose.',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPERTIES,
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files to attach.' },
        },
        required: ['files'],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema(
          { target: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
          ['target', 'files'],
        ),
        render: asText((value) => `Attached ${value.files.length} file(s) to ${value.target}: ${value.files.join(', ')}`),
      },
      timeoutMs,
      async execute(args, exec) {
        const session = await sessionFor(ctx, manager, exec, args);
        const page = await session.page();
        const roots = [/** @type {string} */ (session.config.artifactsDir), .../** @type {string[]} */ (session.config.uploadRoots ?? [])];
        const requested = /** @type {string[]} */ (args.files).map(String);
        const files = requested.map((entry) => resolveReadablePath(roots, entry));
        await resolveLocator(page, session, args, 'browser_upload').setInputFiles(files, { signal: exec.signal });
        return { target: describeTarget(args), files };
      },
    },

    {
      name: 'browser_close',
      description: 'Close the session browser and release its process. Closing is also automatic when the plugin unloads.',
      parameters: {
        type: 'object',
        properties: {
          session: SESSION_PROPERTY.session,
          all: { type: 'boolean', description: 'Close every session in this process, not just this agent\'s.' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema({ closed: { type: 'array', items: { type: 'string' } } }, ['closed']),
        render: asText((value) => (value.closed.length === 0 ? 'No open session to close.' : `Closed ${value.closed.join(', ')}.`)),
      },
      timeoutMs,
      async execute(args, exec) {
        if (args.all === true) {
          return { closed: await manager.closeAll() };
        }
        const key = sessionKeyFor(exec, /** @type {string | undefined} */ (args.session));
        const closed = (await manager.close(key)) ? [key] : [];
        return { closed };
      },
    },
  ];
}

/**
 * Look up the stored selector for a ref target.
 *
 * @param {import('./browser.js').BrowserSession} session - the session.
 * @param {{ ref?: string, selector?: string }} args - target arguments.
 * @param {string} toolName - tool name for the error message.
 * @returns {string} a CSS selector.
 */
function storedSelector(session, args, toolName) {
  const hasRef = args.ref !== undefined && String(args.ref).trim() !== '';
  const hasSelector = args.selector !== undefined && String(args.selector).trim() !== '';
  if (hasRef && hasSelector) throw new Error(`${toolName}: pass either "ref" or "selector", not both`);
  if (hasSelector) return String(args.selector).trim();
  const entry = session.refs.get(String(args.ref));
  if (!entry) {
    throw new Error(`${toolName}: unknown ref ${JSON.stringify(args.ref)}; call browser_snapshot first`);
  }
  return entry.selector;
}

/**
 * Turn page-side sentinel markers back into readable values.
 *
 * @param {unknown} raw - the value returned from the page.
 * @returns {unknown} a JSON-safe value describing what was found.
 */
function normalizeEvalResult(raw) {
  if (raw !== null && typeof raw === 'object' && '__dsh' in /** @type {Record<string, unknown>} */ (raw)) {
    const marker = /** @type {Record<string, unknown>} */ (raw);
    switch (marker.__dsh) {
      case 'undefined':
        return null;
      case 'missing':
        return '[element not found]';
      case 'node':
      case 'bigint':
        return String(marker.text);
      case 'function':
        return `[function ${String(marker.name)}]`;
      default:
        return raw;
    }
  }
  if (!isJsonSafe(raw)) return `[unserializable ${describeValue(raw)}]`;
  return raw;
}
