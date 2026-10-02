/**
 * Page reading: an accessibility-tree snapshot for understanding, plus a
 * numbered inventory of actionable elements whose refs the interaction tools
 * accept.
 *
 * The two views answer different questions. The ARIA snapshot says what the
 * page *is* (roles, names, structure) which is what a model reasons over; the
 * inventory says what can be *acted on* and gives each element a short ref, so
 * a test script does not have to carry long CSS selectors through every call.
 *
 * @module dsh-plugin-browserkit/snapshot
 */

import { firstLine } from './util.js';

/**
 * Browser-side collector. Runs in the page, so it must stay dependency-free and
 * serializable: it returns plain data and never a DOM node.
 *
 * Kept as a single function body because `page.evaluate` serializes it.
 *
 * @param {{ maxItems: number, selector: string | null }} options - collection bounds and optional root.
 * @returns {{ items: Array<Record<string, unknown>>, total: number, truncated: boolean, rootMissing: boolean }} inventory.
 */
function collectInventory(options) {
  const { maxItems, selector } = options;
  const root = selector ? document.querySelector(selector) : document;
  if (!root) return { items: [], total: 0, truncated: false, rootMissing: true };

  const INTERACTIVE = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="option"]',
    '[role="searchbox"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="switch"]',
    '[role="textbox"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const ROLE_BY_TAG = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    summary: 'button',
    option: 'option',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
    img: 'img',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    form: 'form',
    table: 'table',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
  };

  /** Implicit ARIA role for an element, honoring an explicit `role` attribute. */
  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return ROLE_BY_TAG[tag] || tag;
  }

  /** Whether the element participates in layout and is not visually suppressed. */
  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number(style.opacity) === 0) return false;
    return el.getClientRects().length > 0;
  }

  const collapse = (value) => (value || '').replace(/\s+/g, ' ').trim();

  /** Best-effort accessible name, mirroring the common ARIA precedence rules. */
  function nameOf(el) {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const parts = labelled
        .split(/\s+/)
        .map((id) => {
          const target = document.getElementById(id);
          return target ? collapse(target.textContent) : '';
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
    }
    const ariaLabel = collapse(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      const id = el.getAttribute('id');
      if (id) {
        const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (label) {
          const text = collapse(label.textContent);
          if (text) return text;
        }
      }
      const wrapping = el.closest('label');
      if (wrapping) {
        const text = collapse(wrapping.textContent);
        if (text) return text;
      }
      const placeholder = collapse(el.getAttribute('placeholder'));
      if (placeholder) return placeholder;
      const title = collapse(el.getAttribute('title'));
      if (title) return title;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if ((type === 'submit' || type === 'button' || type === 'reset') && el.value) return collapse(el.value);
      return '';
    }
    const alt = collapse(el.getAttribute('alt'));
    if (alt) return alt;
    const title = collapse(el.getAttribute('title'));
    if (title) return title;
    const text = collapse(el.textContent);
    return text.length > 120 ? text.slice(0, 117) + '...' : text;
  }

  /**
   * A selector likely to survive unrelated DOM edits. A test-oriented plugin
   * should prefer the hooks a team actually writes (`data-testid`, `id`,
   * `name`) over a structural path that breaks on the next layout change.
   */
  function stableSelector(el) {
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    if (testId) {
      const candidate = '[data-testid="' + CSS.escape(testId) + '"]';
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    if (el.id) {
      const candidate = '#' + CSS.escape(el.id);
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    const name = el.getAttribute('name');
    if (name) {
      const candidate = el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      const candidate = el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(ariaLabel) + '"]';
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (parts.length >= 6) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  const found = Array.prototype.slice.call(root.querySelectorAll(INTERACTIVE));
  const visible = [];
  const seen = new Set();
  for (const el of found) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisible(el)) continue;
    visible.push(el);
  }

  const items = [];
  for (const el of visible.slice(0, maxItems)) {
    const item = {
      role: roleOf(el),
      name: nameOf(el),
      tag: el.tagName.toLowerCase(),
      selector: stableSelector(el),
    };
    const type = el.getAttribute('type');
    if (type) item.type = type.toLowerCase();
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (el.getAttribute('aria-expanded') !== null) item.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.checked === true) item.checked = true;
    if (el.getAttribute('aria-checked') !== null) item.checked = el.getAttribute('aria-checked') === 'true';
    if (el.required === true) item.required = true;
    if (typeof el.value === 'string' && el.value !== '') item.value = el.value.slice(0, 120);
    if (el.tagName === 'A') {
      const href = el.getAttribute('href');
      if (href) item.href = href.slice(0, 200);
    }
    items.push(item);
  }

  return { items, total: visible.length, truncated: visible.length > items.length, rootMissing: false };
}

/**
 * Read the page into the model-facing snapshot text.
 *
 * @param {import('playwright-core').Page} page - the page to read.
 * @param {Record<string, unknown>} config - resolved plugin config.
 * @param {{ mode?: string, selector?: string | null, session: import('./browser.js').BrowserSession }} options - read options.
 * @returns {Promise<{ text: string, itemCount: number, truncated: boolean, consoleErrors: number }>} the snapshot and its summary.
 */
export async function readSnapshot(page, config, options) {
  const mode = options.mode ?? 'both';
  const selector = options.selector ?? null;
  const url = page.url();
  const title = await page.title().catch(() => '');

  const sections = [`URL: ${url}`, `Title: ${title || '(empty)'}`];
  let itemCount = 0;
  let truncated = false;

  if (mode === 'aria' || mode === 'both') {
    try {
      const aria = await page.locator(selector ?? 'body').ariaSnapshot({ timeout: config.defaultTimeoutMs });
      sections.push('--- Accessibility tree ---', aria.trim() || '(empty)');
    } catch (error) {
      sections.push('--- Accessibility tree ---', `(unavailable: ${firstLine(error)})`);
    }
  }

  if (mode === 'inventory' || mode === 'both') {
    const inventory = await page.evaluate(collectInventory, {
      maxItems: config.maxInventoryItems,
      selector,
    });
    if (inventory.rootMissing) {
      sections.push('--- Interactive elements ---', `(no element matches ${JSON.stringify(selector)})`);
    } else {
      options.session.invalidateRefs();
      const lines = [];
      inventory.items.forEach((item, index) => {
        const ref = `e${index + 1}`;
        options.session.refs.set(ref, { selector: item.selector, role: item.role, name: item.name });
        const states = [];
        if (item.disabled) states.push('disabled');
        if (item.checked !== undefined) states.push(item.checked ? 'checked' : 'unchecked');
        if (item.expanded !== undefined) states.push(item.expanded ? 'expanded' : 'collapsed');
        if (item.required) states.push('required');
        const value = item.value === undefined ? '' : ` value=${JSON.stringify(item.value)}`;
        const meta = states.length > 0 ? ` {${states.join(', ')}}` : '';
        lines.push(`  ${ref}  ${item.role} "${item.name}"${value}${meta}\n       selector: ${item.selector}`);
      });
      itemCount = inventory.items.length;
      truncated = inventory.truncated;
      const header = `--- Interactive elements (${itemCount} of ${inventory.total}${inventory.truncated ? ', truncated' : ''}) ---`;
      sections.push(header, lines.length > 0 ? lines.join('\n') : '  (none)');
      if (inventory.truncated) {
        sections.push(
          `(Only the first ${config.maxInventoryItems} of ${inventory.total} interactive elements are listed. `
            + 'Read a subtree with `browser_snapshot` and a `selector` to see the rest.)',
        );
      }
    }
  }

  sections.push(
    truncated ? '(Snapshot truncated.)' : '',
    'Use `ref` values (e0, e1, ...) with the interaction tools; they are only valid for this snapshot.',
  );

  let text = sections.filter((section) => section !== '').join('\n');
  if (text.length > config.maxSnapshotChars) {
    text = `${text.slice(0, config.maxSnapshotChars)}\n\n(Snapshot truncated at ${config.maxSnapshotChars} characters. Read a narrower subtree with a "selector".)`;
    truncated = true;
  }

  return {
    text,
    itemCount,
    truncated,
    consoleErrors: options.session.consoleMessages.filter((entry) => entry.level === 'error').length,
  };
}

/**
 * Resolve a tool's target to a Playwright locator.
 *
 * `first` matters: Playwright's *action* APIs are strict and throw when a
 * selector matches several elements, so actions and state probes take
 * `.first()` — "click the button named Save" should not fail because a page
 * happens to render two. Counting is the exception: it needs the whole match
 * set, and `.first()` would always report 1.
 *
 * @param {import('playwright-core').Page} page - the session page.
 * @param {import('./browser.js').BrowserSession} session - the session holding the ref table.
 * @param {{ ref?: string, selector?: string }} args - the tool's target arguments.
 * @param {string} toolName - tool name used in the error message.
 * @param {{ first?: boolean }} [options] - `first: false` keeps every match.
 * @returns {import('playwright-core').Locator} the locator.
 */
export function resolveLocator(page, session, args, toolName, options = {}) {
  const ref = typeof args.ref === 'string' && args.ref.trim() !== '' ? args.ref.trim() : undefined;
  const selector = typeof args.selector === 'string' && args.selector.trim() !== '' ? args.selector.trim() : undefined;
  if (ref && selector) {
    throw new Error(`${toolName}: pass either "ref" or "selector", not both`);
  }
  const first = options.first !== false;
  if (ref) {
    const entry = session.refs.get(ref);
    if (!entry) {
      throw new Error(
        `${toolName}: unknown ref ${JSON.stringify(ref)}. Refs come from the latest browser_snapshot and are cleared on navigation; call browser_snapshot again.`,
      );
    }
    const locator = page.locator(entry.selector);
    return first ? locator.first() : locator;
  }
  if (selector) {
    const locator = page.locator(selector);
    return first ? locator.first() : locator;
  }
  throw new Error(`${toolName}: provide "ref" (from browser_snapshot) or "selector"`);
}

/**
 * Describe a locator target for result messages.
 *
 * @param {{ ref?: string, selector?: string }} args - the tool's target arguments.
 * @returns {string} a short human-readable target.
 */
export function describeTarget(args) {
  if (args.ref) return args.ref;
  if (args.selector) return args.selector;
  return '(no target)';
}
