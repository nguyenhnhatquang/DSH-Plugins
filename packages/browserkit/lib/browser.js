/**
 * Browser sessions: launch or attach, per-agent isolation, tab and dialog
 * tracking, console/network capture, and deterministic teardown.
 *
 * One session owns one browser (or one CDP attachment), one context and a set of
 * tabs. Sessions are keyed per calling agent so a team of agents can work
 * concurrently without sharing cookies, storage or navigation state.
 *
 * Two design choices are worth stating because they differ from the obvious
 * implementation:
 *
 * - A popup does **not** silently steal the active tab. A `target=_blank` click
 *   in an OAuth flow wants to be followed; the same click on an ad wants to be
 *   ignored, and the plugin cannot tell them apart. So the active tab stays put
 *   and the new tab is named in the result, which makes both cases recoverable
 *   in one step. `newTabPolicy: focus` opts into following.
 * - Dialogs are **not** auto-dismissed by default. Playwright's own default
 *   (no listener) silently dismisses `confirm()`, which means an unattended run
 *   takes the cancel branch and never says so. `dialogPolicy: manual` leaves the
 *   dialog open for `browser_dialog`, so wrongness is loud instead of quiet.
 *
 * @module dsh-plugin-browserkit/browser
 */

import { chromium } from 'playwright-core';
import { firstLine } from './util.js';

/** Preferred browser first, then the fallbacks tried when it is not installed. */
const AGENT_ORDER = {
  chrome: ['chrome', 'msedge', 'chromium'],
  msedge: ['msedge', 'chrome', 'chromium'],
  chromium: ['chromium', 'chrome', 'msedge'],
  auto: ['chrome', 'msedge', 'chromium'],
};

/** Human-facing name of each selectable browser, used in errors and results. */
const AGENT_LABEL = {
  chrome: 'Google Chrome (installed stable)',
  msedge: 'Microsoft Edge (installed stable)',
  chromium: 'Playwright-managed Chromium',
};

/** Bound on retained network entries per session, so a long run cannot grow unbounded. */
const MAX_NETWORK_ENTRIES = 500;

/** Bound on retained dialog records. */
const MAX_DIALOG_ENTRIES = 50;

/** Bound on retained popup records. */
const MAX_POPUP_ENTRIES = 50;

/**
 * How long teardown waits for a browser to exit.
 *
 * Deliberately not a config field: it is a guard against a wedged browser
 * process, not a behaviour choice. A deployment that raised it to infinity would
 * reintroduce exactly the hang it exists to prevent.
 */
const CLOSE_TIMEOUT_MS = 10_000;

/**
 * Overrides that cannot be applied to a running browser or its context, so they
 * rebuild the session instead.
 */
const MATERIAL_OVERRIDES = [
  'agent',
  'headless',
  'executablePath',
  'launchArgs',
  'cdpEndpoint',
  'cdpUseExistingContext',
  'storageStatePath',
  'ignoreHTTPSErrors',
  'locale',
  'timezoneId',
];

/**
 * Drop `undefined` override values, so a tool argument the model omitted does
 * not shadow the deployment's configured default.
 *
 * @param {Record<string, unknown>} values - the candidate overrides.
 * @returns {Record<string, unknown>} only the defined entries.
 */
function definedOnly(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

/** Console levels retained verbatim. Kept small so `browser_console` output stays reviewable. */
const CONSOLE_LEVELS = new Set(['debug', 'info', 'log', 'warning', 'error']);

/**
 * Resolve which browsers to try, in order.
 *
 * @param {Record<string, unknown>} config - resolved plugin config.
 * @returns {string[]} ordered agent names.
 */
export function agentOrder(config) {
  const preferred = AGENT_ORDER[config.agent] ?? AGENT_ORDER.chrome;
  if (config.executablePath) return ['custom'];
  return config.channelFallback ? preferred : preferred.slice(0, 1);
}

/**
 * Launch a browser, degrading through the fallback chain.
 *
 * A missing Google Chrome is an ordinary machine state, not a plugin failure,
 * so each attempt is recorded and the last failure is rethrown only after every
 * permitted candidate is exhausted.
 *
 * @param {Record<string, unknown>} config - resolved plugin config.
 * @param {{ warn: (message: string) => void }} [log] - optional diagnostic sink.
 * @returns {Promise<{ browser: import('playwright-core').Browser, usedAgent: string }>} the browser and the agent that actually launched.
 */
export async function launchBrowser(config, log) {
  const attempts = [];
  for (const agent of agentOrder(config)) {
    const options = {
      headless: config.headless,
      args: config.launchArgs,
      ...config.executablePath && agent === 'custom' ? { executablePath: config.executablePath } : {},
      ...agent !== 'chromium' && agent !== 'custom' ? { channel: agent } : {},
    };
    try {
      const browser = await chromium.launch(options);
      if (attempts.length > 0) {
        log?.warn(`browserkit: launched ${agent} after ${attempts.length} unavailable candidate(s)`);
      }
      return { browser, usedAgent: agent };
    } catch (error) {
      attempts.push(`${AGENT_LABEL[agent] ?? agent}: ${firstLine(error)}`);
    }
  }
  throw new Error(
    `could not launch any browser. Tried:\n${attempts.map((line) => `  - ${line}`).join('\n')}\n`
      + 'Install Google Chrome, or run `npx playwright install chromium` and set agent: chromium, '
      + 'or point `executablePath` at a browser binary. To drive a browser that is already running, '
      + 'set `cdpEndpoint` instead.',
  );
}

/**
 * Attach to an already-running browser over CDP.
 *
 * This is the automation path that matters when the session must be logged in,
 * or must run in a profile the deployment already trusts (an anti-detect
 * browser, for example) rather than a fresh throwaway one.
 *
 * @param {string} endpoint - CDP endpoint, for example `http://127.0.0.1:9222`.
 * @returns {Promise<import('playwright-core').Browser>} the attached browser.
 */
export async function attachBrowser(endpoint) {
  try {
    return await chromium.connectOverCDP(endpoint);
  } catch (error) {
    throw new Error(
      `could not attach to the browser at ${endpoint}: ${firstLine(error)}. `
        + 'Start it with a debugging port (for Chrome: --remote-debugging-port=9222) and check the endpoint.',
    );
  }
}

/**
 * One tab tracked by a session.
 *
 * @typedef {{ id: number, page: import('playwright-core').Page, popup: boolean, openedAt: number }} Tab
 */

/**
 * One isolated browser session.
 */
export class BrowserSession {
  /** @type {string} */
  id;
  /** @type {Record<string, unknown>} */
  config;
  /** @type {{ warn: (message: string) => void } | undefined} */
  #log;
  /** @type {import('playwright-core').Browser | undefined} */
  #browser;
  /** @type {import('playwright-core').BrowserContext | undefined} */
  #context;
  /** @type {Tab[]} */
  #tabs = [];
  /** @type {import('playwright-core').Page | undefined} */
  #current;
  /** @type {number} */
  #nextTabId = 1;
  /** True while the session itself is opening a tab, so the `page` event does not treat it as a popup. */
  #openingTab = false;
  /** True when the browser is attached over CDP rather than launched by us. */
  #attached = false;
  /** Pages already instrumented, so listeners are never attached twice. */
  #instrumented = new WeakSet();
  /** @type {Array<() => void>} Resolvers waiting for the next manual dialog. */
  #dialogWaiters = [];
  /** @type {string} */
  #usedAgent = 'unknown';
  /** @type {Map<string, { selector: string, role: string, name: string }>} */
  refs = new Map();
  /** @type {Array<{ level: string, text: string, at: number }>} */
  consoleMessages = [];
  /** @type {Array<{ method: string, url: string, status?: number, failure?: string }>} */
  network = [];
  /** @type {Array<{ type: string, message: string, defaultValue: string, at: number, answer: string }>} */
  dialogs = [];
  /** @type {Array<{ dialog: import('playwright-core').Dialog, type: string, message: string, defaultValue: string, at: number }>} */
  pendingDialogs = [];
  /** @type {Array<{ url: string, title: string, at: number }>} */
  popups = [];
  /** @type {number} */
  lastUsedAt = Date.now();
  /**
   * When this session last observed console or network activity. Negative
   * assertions read it through `settleNetwork` so "nothing failed" is not
   * decided while the request its action started is still in flight.
   * @type {number}
   */
  lastActivityAt = Date.now();
  /** @type {{ width: number, height: number }} */
  viewport;

  /**
   * @param {string} id - stable session key (agent-derived or explicit).
   * @param {Record<string, unknown>} config - resolved plugin config.
   * @param {{ warn: (message: string) => void } | undefined} log - diagnostic sink.
   */
  constructor(id, config, log) {
    this.id = id;
    this.config = config;
    this.#log = log;
    this.viewport = { width: config.viewportWidth, height: config.viewportHeight };
  }

  /** The browser actually launched or attached, for results and diagnostics. */
  get agent() {
    return this.#usedAgent;
  }

  /** The live browser, when launched or attached. */
  get browser() {
    return this.#browser;
  }

  /** Whether this session drives a browser it did not start. */
  get attached() {
    return this.#attached;
  }

  /**
   * Tabs in a stable listing order, with the active one marked.
   *
   * Tabs are numbered from 1 in the order they were adopted, and a number is
   * stable for the life of the tab — unlike snapshot refs, which are rebuilt
   * every read and therefore cleared on navigation.
   *
   * @returns {Array<{ index: number, id: number, url: string, active: boolean, popup: boolean }>} the listing.
   */
  tabs() {
    return this.#liveTabs().map((tab, index) => ({
      index: index + 1,
      id: tab.id,
      url: tab.page.url(),
      active: tab.page === this.#current,
      popup: tab.popup,
    }));
  }

  /**
   * The tabs that are still open.
   *
   * A closed page is dropped by its `close` event, but that event can lag the
   * close by a tick, so the listing and the index lookup must agree on the same
   * filtered view or a tab number would mean two different tabs.
   *
   * @returns {Tab[]} the live tabs.
   */
  #liveTabs() {
    return this.#tabs.filter((tab) => !tab.page.isClosed());
  }

  /**
   * The page for one tab index from `tabs()`.
   *
   * @param {number} index - 1-based tab index.
   * @returns {import('playwright-core').Page} the page.
   * @throws {Error} when the index names no live tab.
   */
  tabAt(index) {
    const tab = this.#liveTabs()[index - 1];
    if (!tab) {
      throw new Error(`browser_tabs: there is no open tab ${index}. Call browser_tabs with action "list" first.`);
    }
    return tab.page;
  }

  /**
   * Adopt any page the context holds that the session is not yet tracking.
   *
   * The `page` event is the primary adoption path but it is asynchronous: a
   * `target=_blank` click resolves before the event is delivered, so an action
   * result computed straight afterwards would miss the popup it just opened.
   * Reconciling against `context.pages()` reads the truth immediately.
   *
   * Pages found this way are treated as popups, because a tab the session did
   * not open itself is exactly that.
   *
   * @returns {Promise<void>} resolves once every known page is tracked.
   */
  async reconcileTabs() {
    const context = this.#context;
    if (context === undefined) return;
    for (const page of context.pages()) {
      if (this.#tabs.some((tab) => tab.page === page)) continue;
      this.#adopt(page, true);
    }
  }

  /**
   * Wait a bounded moment for the browser to open a tab.
   *
   * Whether a click opened a tab cannot be answered without observing for a
   * moment: the browser creates the page after the click resolves, and both the
   * `page` event and `context.pages()` can be a few milliseconds behind. The
   * window is bounded and configurable (`newTabWaitMs`); setting it to 0 makes
   * the click as fast as Playwright allows and accepts that a popup is then only
   * reported by the next `browser_tabs` call.
   *
   * @param {number} budgetMs - how long to watch.
   * @returns {Promise<boolean>} whether a new tab appeared.
   */
  async waitForNewTab(budgetMs) {
    if (!(budgetMs > 0)) return false;
    const before = this.#liveTabs().length;
    const deadline = Date.now() + budgetMs;
    for (;;) {
      await this.reconcileTabs();
      if (this.#liveTabs().length > before) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 20);
        timer.unref?.();
      });
    }
  }

  /**
   * Make one tab active.
   *
   * @param {number} index - 1-based tab index.
   * @returns {Promise<import('playwright-core').Page>} the now-active page.
   */
  async selectTab(index) {
    const page = this.tabAt(index);
    this.#current = page;
    this.invalidateRefs();
    await page.bringToFront().catch(() => {});
    return page;
  }

  /**
   * Open a new tab and make it active.
   *
   * @param {string} [url] - optional URL to navigate to.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<import('playwright-core').Page>} the new page.
   */
  async openTab(url, signal) {
    // Deliberately not `ensurePage()`: that method calls this one to create the
    // first tab, so routing back through it would recurse forever.
    await this.#ensureBrowser();
    await this.#ensureContext();
    const context = this.#context;
    if (context === undefined) throw new Error('browserkit: the session has no context');
    this.#openingTab = true;
    let page;
    try {
      page = await context.newPage();
    } finally {
      this.#openingTab = false;
    }
    this.#adopt(page, false);
    this.#current = page;
    this.invalidateRefs();
    if (url !== undefined && url !== '') await page.goto(url, { signal });
    return page;
  }

  /**
   * Close one tab. The last remaining tab is kept, because a context with no
   * page is not a usable session and Playwright would reopen one anyway.
   *
   * @param {number} index - 1-based tab index.
   * @returns {Promise<boolean>} whether a tab was closed.
   */
  async closeTab(index) {
    const page = this.tabAt(index);
    const live = this.#tabs.filter((tab) => !tab.page.isClosed());
    if (live.length <= 1) return false;
    await page.close().catch(() => {});
    return true;
  }

  /**
   * Launch or attach the browser and open the first page. Idempotent.
   *
   * @returns {Promise<import('playwright-core').Page>} the active page.
   */
  async ensurePage() {
    this.lastUsedAt = Date.now();
    if (this.#current && !this.#current.isClosed()) return this.#current;
    await this.#ensureBrowser();
    await this.#ensureContext();
    const existing = this.#tabs.find((tab) => !tab.page.isClosed());
    if (existing) {
      this.#current = existing.page;
      return existing.page;
    }
    return this.openTab();
  }

  /**
   * The active page, launching or attaching on demand.
   *
   * @returns {Promise<import('playwright-core').Page>} the active page.
   */
  async page() {
    return this.ensurePage();
  }

  /** Start the browser, or attach to one, exactly once. */
  async #ensureBrowser() {
    if (this.#browser !== undefined) return;
    const endpoint = String(this.config.cdpEndpoint ?? '');
    if (endpoint !== '') {
      this.#browser = await attachBrowser(endpoint);
      this.#attached = true;
      this.#usedAgent = `cdp:${endpoint}`;
      return;
    }
    const { browser, usedAgent } = await launchBrowser(this.config, this.#log);
    this.#browser = browser;
    this.#usedAgent = usedAgent;
  }

  /** Create or adopt the browser context, exactly once. */
  async #ensureContext() {
    if (this.#context !== undefined) return;
    const browser = this.#browser;
    if (browser === undefined) throw new Error('browserkit: no browser to open a context on');
    const options = {
      viewport: this.viewport,
      ignoreHTTPSErrors: this.config.ignoreHTTPSErrors,
      ...this.config.locale ? { locale: this.config.locale } : {},
      ...this.config.timezoneId ? { timezoneId: this.config.timezoneId } : {},
      ...String(this.config.storageStatePath ?? '') !== '' ? { storageState: String(this.config.storageStatePath) } : {},
    };
    const existing = browser.contexts()[0];
    // Attaching means "drive the browser that is already logged in", so the
    // existing context is the point of the feature. A launched browser has no
    // context yet, and an attached one is isolated when asked.
    this.#context = this.#attached && this.config.cdpUseExistingContext && existing !== undefined
      ? existing
      : await browser.newContext(options);
    this.#context.setDefaultTimeout(this.config.defaultTimeoutMs);
    this.#context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    this.#context.on('page', (page) => this.#onPageEvent(page));
    for (const page of this.#context.pages()) this.#adopt(page, false);
    // Keeping a persistent profile alive is the whole point of attaching, so the
    // storage state is only meaningful for a context we created.
    if (String(this.config.storageStatePath ?? '') !== '' && this.#context === existing) {
      this.#log?.warn('browserkit: storageStatePath is ignored when attaching to a browser\'s existing context');
    }
  }

  /**
   * Handle a page the context opened on its own — a popup, `target=_blank`, or a
   * script-opened window.
   *
   * @param {import('playwright-core').Page} page - the new page.
   */
  #onPageEvent(page) {
    if (this.#openingTab) return;
    this.#adopt(page, true);
    if (this.config.newTabPolicy === 'focus') this.#current = page;
  }

  /**
   * Track one page and instrument it once.
   *
   * @param {import('playwright-core').Page} page - the page to adopt.
   * @param {boolean} popup - whether the page opened itself.
   */
  #adopt(page, popup) {
    if (this.#tabs.some((tab) => tab.page === page)) return;
    this.#tabs.push({ id: this.#nextTabId++, page, popup, openedAt: Date.now() });
    if (popup) {
      this.popups.push({ url: page.url(), title: '', at: Date.now() });
      if (this.popups.length > MAX_POPUP_ENTRIES) this.popups.shift();
      // Enforce the cap only on browsers we started. Closing a tab in the user's
      // attached browser would be destroying their work.
      const live = this.#tabs.filter((tab) => !tab.page.isClosed());
      if (!this.#attached && live.length > this.config.maxTabs) {
        const victims = live.slice(0, live.length - this.config.maxTabs);
        for (const victim of victims) {
          this.#log?.warn(`browserkit: closing tab beyond maxTabs (${this.config.maxTabs})`);
          void victim.page.close().catch(() => {});
        }
      }
    }
    page.on('close', () => {
      this.#tabs = this.#tabs.filter((tab) => tab.page !== page);
      this.pendingDialogs = this.pendingDialogs.filter((entry) => !entry.dialog.page()?.isClosed());
      if (this.#current === page) this.#current = this.#tabs.find((tab) => !tab.page.isClosed())?.page;
    });
    this.#instrument(page);
  }

  /**
   * Observe console output, page errors, network failures and dialogs for the
   * whole session. Listeners live on the page, so a navigation keeps them.
   *
   * @param {import('playwright-core').Page} page - the page to instrument.
   */
  #instrument(page) {
    if (this.#instrumented.has(page)) return;
    this.#instrumented.add(page);
    page.on('console', (message) => {
      const level = message.type();
      if (!CONSOLE_LEVELS.has(level)) return;
      this.lastActivityAt = Date.now();
      this.consoleMessages.push({ level, text: message.text(), at: Date.now() });
      if (this.consoleMessages.length > MAX_NETWORK_ENTRIES) this.consoleMessages.shift();
    });
    page.on('pageerror', (error) => {
      this.lastActivityAt = Date.now();
      this.consoleMessages.push({ level: 'error', text: `Uncaught ${firstLine(error)}`, at: Date.now() });
    });
    page.on('requestfailed', (request) => {
      this.#pushNetwork({
        method: request.method(),
        url: request.url(),
        failure: request.failure()?.errorText ?? 'request failed',
      });
    });
    page.on('response', (response) => {
      if (response.status() < 400) return;
      this.#pushNetwork({ method: response.request().method(), url: response.url(), status: response.status() });
    });
    page.on('request', () => {
      this.lastActivityAt = Date.now();
    });
    page.on('dialog', (dialog) => this.#onDialog(dialog));
  }

  /**
   * Record a dialog and answer it according to `dialogPolicy`.
   *
   * With `manual`, the dialog is deliberately left open. Attaching a listener is
   * what stops Playwright from auto-dismissing it, so the run blocks on the
   * dialog until `browser_dialog` answers it — which is the point: a blocked run
   * is visible, an auto-dismissed `confirm()` is not.
   *
   * @param {import('playwright-core').Dialog} dialog - the dialog.
   */
  #onDialog(dialog) {
    const policy = this.config.dialogPolicy;
    const record = {
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue(),
      at: Date.now(),
    };
    if (policy === 'accept') {
      void dialog.accept(record.defaultValue === '' ? undefined : record.defaultValue).catch(() => {});
      this.#recordDialog(record, 'accepted');
      return;
    }
    if (policy === 'dismiss') {
      void dialog.dismiss().catch(() => {});
      this.#recordDialog(record, 'dismissed');
      return;
    }
    this.#recordDialog(record, 'pending');
    this.pendingDialogs.push({ dialog, ...record });
    // An action that opened this dialog is now blocked and will never settle
    // until the dialog is answered, so waiting for it is waiting for a timeout.
    for (const resolve of this.#dialogWaiters.splice(0)) resolve();
  }

  /**
   * Resolve as soon as a manual dialog is captured.
   *
   * Callers race this against a page action so that "a dialog is blocking the
   * page" is reported as the outcome, instead of surfacing as an action timeout
   * that says nothing about the dialog.
   *
   * @returns {Promise<void>} resolves on the next captured dialog.
   */
  waitForDialog() {
    return new Promise((resolve) => {
      this.#dialogWaiters.push(resolve);
    });
  }

  /**
   * Append one dialog record under the retention bound.
   *
   * @param {{ type: string, message: string, defaultValue: string, at: number }} record - the dialog facts.
   * @param {string} answer - what happened to it.
   */
  #recordDialog(record, answer) {
    this.dialogs.push({ ...record, answer });
    if (this.dialogs.length > MAX_DIALOG_ENTRIES) this.dialogs.shift();
  }

  /**
   * Answer the oldest pending dialog.
   *
   * @param {'accept' | 'dismiss'} decision - what to answer.
   * @param {string | undefined} promptText - the value to type into a prompt.
   * @returns {Promise<{ type: string, message: string, answer: string } | undefined>} the answered dialog, when one was pending.
   */
  async answerDialog(decision, promptText) {
    const entry = this.pendingDialogs.shift();
    if (entry === undefined) return undefined;
    if (decision === 'accept') await entry.dialog.accept(promptText);
    else await entry.dialog.dismiss();
    const existing = this.dialogs.findLast((record) => record.at === entry.at && record.type === entry.type);
    if (existing !== undefined) existing.answer = decision === 'accept' ? 'accepted' : 'dismissed';
    return { type: entry.type, message: entry.message, answer: decision };
  }

  /**
   * Append one network record under the retention bound.
   *
   * @param {{ method: string, url: string, status?: number, failure?: string }} entry - the record.
   */
  #pushNetwork(entry) {
    this.lastActivityAt = Date.now();
    this.network.push(entry);
    if (this.network.length > MAX_NETWORK_ENTRIES) this.network.shift();
  }

  /**
   * Resize the viewport. Applies to every tab in the context.
   *
   * @param {number} width - CSS pixels.
   * @param {number} height - CSS pixels.
   */
  async setViewport(width, height) {
    this.viewport = { width, height };
    for (const tab of this.#tabs) {
      if (!tab.page.isClosed()) await tab.page.setViewportSize(this.viewport).catch(() => {});
    }
  }

  /**
   * Write cookies and localStorage to a file.
   *
   * @param {string} absolutePath - destination path, already validated by the caller.
   * @returns {Promise<{ path: string, cookies: number, origins: number }>} what was written.
   */
  async saveStorageState(absolutePath) {
    await this.ensurePage();
    const context = this.#context;
    if (context === undefined) throw new Error('browserkit: the session has no context');
    const state = await context.storageState({ path: absolutePath });
    return { path: absolutePath, cookies: state.cookies.length, origins: state.origins.length };
  }

  /**
   * Summarize the session's stored credentials without exposing their values.
   *
   * Cookie values are session credentials, so only names and counts leave the
   * plugin; a cookie value would be a secret pasted into the transcript.
   *
   * @returns {Promise<{ cookies: number, cookieNames: string[], origins: string[] }>} the summary.
   */
  async storageSummary() {
    await this.ensurePage();
    const context = this.#context;
    if (context === undefined) throw new Error('browserkit: the session has no context');
    const cookies = await context.cookies();
    const origins = await this.#localStorageOrigins();
    return {
      cookies: cookies.length,
      cookieNames: [...new Set(cookies.map((cookie) => cookie.name))].slice(0, 40),
      origins,
    };
  }

  /**
   * Drop cookies and web storage for the session.
   *
   * @returns {Promise<{ cleared: boolean }>} the outcome.
   */
  async clearStorageState() {
    await this.ensurePage();
    const context = this.#context;
    if (context === undefined) throw new Error('browserkit: the session has no context');
    await context.clearCookies();
    for (const tab of this.#tabs) {
      if (tab.page.isClosed()) continue;
      await tab.page
        .evaluate(() => {
          try {
            window.localStorage.clear();
            window.sessionStorage.clear();
          } catch {
            // Opaque origins (data:, about:) throw on storage access.
          }
        })
        .catch(() => {});
    }
    return { cleared: true };
  }

  /**
   * Origins that currently hold localStorage data, read from the open tabs.
   *
   * @returns {Promise<string[]>} origin list.
   */
  async #localStorageOrigins() {
    const origins = new Set();
    for (const tab of this.#tabs) {
      if (tab.page.isClosed()) continue;
      const origin = await tab.page
        .evaluate(() => {
          try {
            return window.localStorage.length > 0 ? location.origin : null;
          } catch {
            return null;
          }
        })
        .catch(() => null);
      if (origin !== null) origins.add(origin);
    }
    return [...origins];
  }

  /** Drop the ref inventory; refs are only valid for the snapshot that produced them. */
  invalidateRefs() {
    this.refs.clear();
  }

  /**
   * Close the session and release every OS resource. Never throws: teardown
   * runs from a plugin disposer, where a throw would mask the real failure.
   *
   * For an attached browser, `browser.close()` disconnects — Playwright only
   * clears contexts the connection created, so the user's own browser and tabs
   * survive.
   *
   * @returns {Promise<void>} resolves once the browser exits or the attempt failed.
   */
  async close() {
    const browser = this.#browser;
    this.#tabs = [];
    this.#current = undefined;
    this.#context = undefined;
    this.#browser = undefined;
    this.invalidateRefs();
    this.pendingDialogs = [];
    if (!browser) return;
    try {
      await Promise.race([
        browser.close(),
        new Promise((resolve) => {
          // `unref` keeps a pending guard from holding the process open by itself.
          const timer = setTimeout(() => {
            this.#log?.warn(`browserkit: session ${this.id} did not close within ${CLOSE_TIMEOUT_MS}ms; abandoning it`);
            resolve(undefined);
          }, CLOSE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      this.#log?.warn(`browserkit: closing session ${this.id} failed: ${firstLine(error)}`);
    }
  }
}

/**
 * Owns every live session and enforces the concurrency cap.
 *
 * The cap exists because each session is a real browser process; an unbounded
 * map turns a runaway loop into an out-of-memory kill of the whole harness.
 */
export class SessionManager {
  /** @type {Map<string, BrowserSession>} */
  #sessions = new Map();
  /** @type {Record<string, unknown>} */
  config;
  /** @type {{ warn: (message: string) => void } | undefined} */
  #log;

  /**
   * @param {Record<string, unknown>} config - resolved plugin config.
   * @param {{ warn: (message: string) => void } | undefined} log - diagnostic sink.
   */
  constructor(config, log) {
    this.config = config;
    this.#log = log;
  }

  /** Live session keys, in insertion order. */
  keys() {
    return [...this.#sessions.keys()];
  }

  /**
   * A session by key, without creating one.
   *
   * @param {string} key - session key.
   * @returns {BrowserSession | undefined} the session when live.
   */
  peek(key) {
    return this.#sessions.get(key);
  }

  /**
   * Get or create the session for `key`, evicting the least recently used
   * session when the cap is reached.
   *
   * `overrides` exist because "run this one check headed" and "drive this one
   * flow in Edge" are ordinary requests. An override that cannot be applied to a
   * live browser (the engine, its executable, or the attached endpoint) forces
   * the session to be rebuilt, which is the honest behavior: a page cannot
   * change its engine.
   *
   * @param {string} key - session key.
   * @param {Record<string, unknown>} [overrides] - per-session config overrides.
   * @returns {Promise<BrowserSession>} a session whose browser is ready.
   */
  async acquire(key, overrides) {
    const effective = overrides === undefined ? this.config : { ...this.config, ...definedOnly(overrides) };
    const existing = this.#sessions.get(key);
    if (existing) {
      const forced = overrides !== undefined && MATERIAL_OVERRIDES.some(
        (name) => overrides[name] !== undefined && overrides[name] !== existing.config[name],
      );
      if (!forced) {
        existing.lastUsedAt = Date.now();
        await existing.ensurePage();
        // Only an explicit override may change a live session. Comparing against
        // the manager's own defaults instead of the session's settings would
        // silently reset a session every time a later call omitted the argument.
        const wantWidth = overrides?.viewportWidth ?? existing.viewport.width;
        const wantHeight = overrides?.viewportHeight ?? existing.viewport.height;
        if (wantWidth !== existing.viewport.width || wantHeight !== existing.viewport.height) {
          await existing.setViewport(wantWidth, wantHeight);
        }
        return existing;
      }
      await this.close(key);
    }
    if (this.#sessions.size >= this.config.maxSessions) {
      const oldest = [...this.#sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (oldest) {
        this.#log?.warn(`browserkit: session cap ${this.config.maxSessions} reached, closing ${oldest.id}`);
        this.#sessions.delete(oldest.id);
        await oldest.close();
      }
    }
    const session = new BrowserSession(key, effective, this.#log);
    this.#sessions.set(key, session);
    try {
      await session.ensurePage();
    } catch (error) {
      this.#sessions.delete(key);
      await session.close();
      throw error;
    }
    return session;
  }

  /**
   * Close one session.
   *
   * @param {string} key - session key.
   * @returns {Promise<boolean>} whether a session was open.
   */
  async close(key) {
    const session = this.#sessions.get(key);
    if (!session) return false;
    this.#sessions.delete(key);
    await session.close();
    return true;
  }

  /**
   * Close every session, optionally only idle ones.
   *
   * @param {{ idleMs?: number, now?: number }} [options] - idle threshold.
   * @returns {Promise<string[]>} the keys that were closed.
   */
  async closeAll(options = {}) {
    const closed = [];
    for (const [key, session] of [...this.#sessions]) {
      if (options.idleMs !== undefined && Date.now() - session.lastUsedAt < options.idleMs) continue;
      this.#sessions.delete(key);
      closed.push(key);
      await session.close();
    }
    return closed;
  }
}
