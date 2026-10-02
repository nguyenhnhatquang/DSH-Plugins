/**
 * Browser UI testing tools for DeepSeek Harness agents.
 *
 * The plugin gives a team of agents a real browser each: read the page, act on
 * it, and *verify* it. Its runtime dependencies are `playwright-core` and
 * `@deepseek-ai/schemastery`, and nothing else: tool definitions are registered
 * as raw JSON-Schema `ToolDefinition`s (the same shape MCP-sourced tools use),
 * so no `@deepseek-ai/dsh-tools` import is needed. That keeps the plugin
 * loadable from an absolute path during development and testable against a fake
 * context with no harness present.
 *
 * Exports follow the harness's function-plugin contract: named exports only, no
 * default export. A default export would make the Loader discard `inject`.
 *
 * @module dsh-plugin-browserkit
 */

import path from 'node:path';
import { SessionManager } from './browser.js';
import { Config, describeConfigFields, resolveConfig } from './config.js';
import { createTools } from './tools.js';

export { Config };

/** Cordis plugin name, used by Loader diagnostics and plugin-metadata fallback. */
export const name = 'browserkit';

/** Required service: the tool registry. Everything else is read optionally. */
export const inject = ['tools'];

/** Documentation aid: the config field table, used to generate the README table. */
export const configFields = describeConfigFields();

/**
 * Standing guidance for the agent.
 *
 * A browser tool surface is easy to misuse as a click-randomly-until-it-works
 * loop. The prompt teaches the read → act → verify cycle and, more importantly,
 * tells the agent to report what it actually observed rather than concluding a
 * feature works because nothing crashed.
 */
const GUIDANCE = `You have a real browser available through the browser_* tools. Use them to verify UI behaviour instead of reasoning about it from source code.

The loop that works:
1. browser_open (with the URL) or browser_navigate to get to the page.
2. browser_snapshot to read the accessibility tree and the numbered element inventory. Interact only with refs from the latest snapshot, or with a selector you have verified.
3. Act: browser_click, browser_type, browser_press, browser_select, browser_hover.
4. browser_snapshot again after anything that changes the page. Refs are cleared on navigation.
5. browser_assert to verify the outcome — visible text, element state, counts, URL, console errors, failed requests. Assertions wait for the condition, so do not add fixed sleeps.
6. browser_close when the flow is finished.

Rules:
- Verify, do not assume. State which assertion passed, or report the exact failure text. Never claim a UI works because no error was thrown.
- Prefer browser_assert over browser_eval for verification; browser_eval is for inspecting state the accessibility tree does not expose.
- Use browser_screenshot when the failure is visual (layout, overlap, styling) — a picture is the only honest evidence there.
- If a check fails, read browser_console and browser_network before retrying; the cause is usually reported there.
- A click that opens a tab does not switch to it. If a result reports a new tab, follow it with browser_tabs when that was the point; otherwise ignore it.
- If a tool reports that a dialog is blocking the page, answer it with browser_dialog before anything else. Nothing else can run until you do.
- To keep a login between runs, save it with browser_storage_state and pass the saved file as storageStatePath to browser_open.
- One agent owns one session. Do not rely on another agent's page state.`;

/** Fallback prompt-section order, used when the harness does not name the slot. */
const COMPUTER_USE_ORDER_FALLBACK = 3_000;

/**
 * Resolve the artifacts directory. An empty config value means "inside the
 * workspace", which is what a test run wants by default.
 *
 * @param {string} configured - the configured value.
 * @returns {string} an absolute directory.
 */
function resolveArtifactsDir(configured) {
  return configured.trim() === '' ? path.join(process.cwd(), '.browserkit') : path.resolve(configured);
}

/**
 * Activate the plugin.
 *
 * @param {object} ctx - the Cordis context.
 * @param {Record<string, unknown>} [config] - the deployment config. Cordis runs the `Config` schema
 *   before `apply`, but the schema is applied again here so the plugin behaves identically when it is
 *   invoked directly (tests, embeddings) and so a missing `config` still yields every default.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const effective = { ...resolved, artifactsDir: resolveArtifactsDir(String(resolved.artifactsDir)) };

  const log = ctx.logger ?? { warn: console.warn, info: () => {}, error: console.error };
  const manager = new SessionManager(effective, log);

  // Registration is fiber-scoped: `ctx.tools` is a shadows of the shared tools
  // service bound to this scope, and `register` installs an effect on it, so a
  // reload, a disable or shutdown unregisters every tool. That is why the
  // returned disposers are not collected here.
  for (const definition of createTools({ config: effective, manager, ctx, log })) {
    ctx.tools.register(definition);
  }

  // Session cleanup is an effect: reload, disable and shutdown all release the
  // browser processes through this one path. The disposer returns its promise so
  // a graceful shutdown actually waits for the browsers to exit instead of
  // racing the process teardown.
  ctx.effect(() => () => manager.closeAll());

  if (effective.closeIdleMs > 0) {
    ctx.effect(() => {
      const period = Math.max(1_000, Math.min(effective.closeIdleMs, 60_000));
      const timer = setInterval(() => {
        void manager.closeAll({ idleMs: effective.closeIdleMs }).then((closed) => {
          if (closed.length > 0) log.info?.(`browserkit: closed ${closed.length} idle session(s)`);
        });
      }, period);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  }

  registerGuidance(ctx);
}

/**
 * Register the prompt section when the deployment mounts a system prompt and
 * the browser tools are actually visible in the calling scope.
 *
 * The section renders empty when the tools are hidden, so a deployment that
 * never enables this plugin does not pay for its guidance.
 *
 * @param {object} ctx - the Cordis context.
 */
function registerGuidance(ctx) {
  const systemPrompt = ctx.get?.('systemPrompt');
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return;
  // `TOOL_COMPUTER_USE` is the harness's slot for browser/desktop control. Read
  // it by name so a future reordering moves this section with it, and fall back
  // to the current numeric value if the name ever disappears.
  const order = typeof systemPrompt.getSectionOrder === 'function'
    ? systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') ?? COMPUTER_USE_ORDER_FALLBACK
    : COMPUTER_USE_ORDER_FALLBACK;
  systemPrompt.section({
    name: 'tool:browserkit',
    order,
    text: ({ scope }) => (ctx.tools.get('browser_open', scope) === undefined ? '' : GUIDANCE),
  });
}
