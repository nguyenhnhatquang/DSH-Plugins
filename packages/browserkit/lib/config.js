/**
 * Plugin configuration schema.
 *
 * This is a **native Schemastery schema**, not merely something that satisfies
 * the Standard Schema interface. Cordis only needs `~standard.validate` to run
 * the plugin, but the harness also introspects plugin configs to generate JSON
 * Schema (`dsh --dump-config-schema`) and to render configuration forms — and
 * that path requires a real Schemastery schema. Exporting a hand-rolled
 * validator makes the plugin load but fails the schema dump with
 * `Config is not a native Schemastery schema`.
 *
 * Schemastery's object mode passes unknown keys through, so `assertKnownKeys`
 * closes that gap explicitly: a typo'd tunable must fail at load rather than
 * silently keep its default.
 *
 * @module dsh-plugin-browserkit/config
 */

import z from '@deepseek-ai/schemastery';

/** Preferred browser. `auto` tries chrome, then msedge, then chromium. */
export const BROWSER_AGENTS = ['chrome', 'msedge', 'chromium', 'auto'];

/** Image formats the screenshot tool can write. */
export const SCREENSHOT_TYPES = ['png', 'jpeg'];

/** Upper bound shared by every millisecond field; a longer budget reads as a hang. */
const MAX_TIMER_MS = 3_600_000;

/** Default cooperative tool timeout, sized for a browser launch plus a page load. */
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export const Config = z.object({
  headless: z.boolean().default(true)
    .description('Run the browser headless. Set false to watch a failing test.'),

  agent: z.union([...BROWSER_AGENTS]).default('chrome')
    .description('Preferred browser. `chrome`/`msedge` use the installed stable build; `chromium` uses the Playwright-managed build.'),

  channelFallback: z.boolean().default(true)
    .description('When the preferred browser is not installed, fall back through the remaining agents instead of failing.'),

  executablePath: z.string().default('')
    .description('Explicit browser executable. Wins over `agent`; set it to smoke-test one specific build.'),

  launchArgs: z.array(z.string()).default([])
    .description('Extra Chromium command-line switches (for example --disable-dev-shm-usage in a small container).'),

  viewportWidth: z.number().step(1).min(200).max(10_000).default(1280)
    .description('Default viewport width in CSS pixels.'),

  viewportHeight: z.number().step(1).min(200).max(10_000).default(720)
    .description('Default viewport height in CSS pixels.'),

  locale: z.string().default('')
    .description('Browser locale such as `vi-VN`. Empty leaves the browser default.'),

  timezoneId: z.string().default('')
    .description('Browser timezone such as `Asia/Ho_Chi_Minh`. Empty leaves the browser default.'),

  ignoreHTTPSErrors: z.boolean().default(false)
    .description('Accept invalid TLS certificates. Needed for a local self-signed dev server.'),

  defaultTimeoutMs: z.number().step(1).min(250).max(600_000).default(15_000)
    .description('Default per-action timeout for element waits, clicks and typing.'),

  navigationTimeoutMs: z.number().step(1).min(250).max(600_000).default(30_000)
    .description('Timeout for page navigations and reloads.'),

  toolTimeoutMs: z.number().step(1).min(1_000).max(MAX_TIMER_MS).default(DEFAULT_TOOL_TIMEOUT_MS)
    .description('Cooperative budget declared as each tool `timeoutMs` and enforced by the harness timeout policy.'),

  maxSnapshotChars: z.number().step(1).min(1_000).max(500_000).default(40_000)
    .description('Cap on one snapshot result. Truncation is always stated explicitly.'),

  maxInventoryItems: z.number().step(1).min(1).max(2_000).default(120)
    .description('Cap on interactive elements listed by one snapshot.'),

  artifactsDir: z.string().default('')
    .description('Where screenshots and saved storage state are written. Empty resolves to `<workspace>/.browserkit` at load time; artifact paths can never leave this directory.'),

  screenshotType: z.union([...SCREENSHOT_TYPES]).default('png')
    .description('Image format for screenshot artifacts.'),

  attachImagesToContext: z.boolean().default(true)
    .description('Also place screenshots in model context when the active model accepts image input. The file is always written.'),

  allowEvaluate: z.boolean().default(true)
    .description('Allow `browser_eval`. Page JavaScript can read page secrets, so a hardened deployment sets this false.'),

  maxSessions: z.number().step(1).min(1).max(64).default(8)
    .description('Concurrent browser sessions. A new session beyond this cap closes the least recently used one.'),

  closeIdleMs: z.number().step(1).min(0).max(86_400_000).default(0)
    .description('Close a session after this long without a call. 0 disables idle reaping.'),

  newTabPolicy: z.union(['report', 'focus']).default('report')
    .description('What a popup or target=_blank does to the active tab. `report` keeps the current tab and names the new one in the result; `focus` switches to it.'),

  newTabWaitMs: z.number().step(1).min(0).max(5_000).default(250)
    .description('How long a click waits to see whether it opened a tab. Zero removes the delay but a popup is then only reported by the next browser_tabs call, not by the click result.'),

  dialogPolicy: z.union(['manual', 'accept', 'dismiss']).default('manual')
    .description('How to answer alert/confirm/prompt. `manual` leaves the dialog open for browser_dialog, so an unattended run cannot silently take the wrong branch; `accept`/`dismiss` answer it automatically.'),

  maxTabs: z.number().step(1).min(1).max(64).default(12)
    .description('Tabs allowed per session. Newly opened popups beyond this are closed, so an ad that spawns windows cannot grow the session without bound.'),

  cdpEndpoint: z.string().default('')
    .description('Attach to an already-running browser over CDP instead of launching one, for example `http://127.0.0.1:9222`. Use it to drive a logged-in or anti-detect profile.'),

  cdpUseExistingContext: z.boolean().default(true)
    .description('When attaching over CDP, drive the browser\'s existing context and tabs. Set false to open an isolated context in the attached browser instead.'),

  storageStatePath: z.string().default('')
    .description('Default storage state (cookies and web storage) every session starts from, so an automation run begins logged in. browser_open can override it per session.'),

  uploadRoots: z.array(z.string()).default([])
    .description('Extra directories that browser_upload may read files from. The artifacts directory is always allowed; nothing else is, because uploading a local file to a page is a read primitive the harness file sandbox does not cover.'),
});

/** Every configurable key, read from the schema so the two can never disagree. */
export const CONFIG_KEYS = Object.keys(Config.dict);

/**
 * Reject keys the schema does not declare.
 *
 * Exported for the plugin entry and for tests; call it with the raw deployment
 * object before the schema runs.
 *
 * @param {unknown} value - the raw config.
 * @throws {Error} listing every unknown key.
 */
export function assertKnownKeys(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const unknown = Object.keys(value).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length === 0) return;
  throw new Error(
    `browserkit: unknown config key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}. `
      + `Known keys: ${CONFIG_KEYS.join(', ')}.`,
  );
}

/**
 * Resolve a deployment config to a complete, validated config object.
 *
 * Used by the plugin entry so that `apply` behaves identically whether Cordis
 * pre-validated the row or the plugin was invoked directly (tests, embedding).
 *
 * @param {unknown} value - the raw config, possibly partial or absent.
 * @returns {Record<string, any>} the resolved config with every default applied.
 * @throws {Error} when a value is invalid or a key is unknown.
 */
export function resolveConfig(value) {
  const raw = value ?? {};
  assertKnownKeys(raw);
  return Config(raw);
}

/** Documentation aid: the field table rendered into the README. */
export function describeConfigFields() {
  return CONFIG_KEYS.map((name) => {
    const meta = Config.dict[name]?.meta ?? {};
    return {
      name,
      default: meta.default,
      describe: meta.description ?? '',
      expectation: describeSchema(Config.dict[name]),
    };
  });
}

/**
 * Render one field's expectation for documentation.
 *
 * Schemastery's JSON form is a `{ uid, refs }` table, so the described node has
 * to be looked up by `uid` rather than read off the root.
 *
 * @param {any} schema - the field schema.
 * @returns {string} a short human-readable type.
 */
function describeSchema(schema) {
  const json = schema?.toJSON?.() ?? {};
  const node = json.refs?.[json.uid] ?? json;
  const meta = node.meta ?? {};
  switch (node.type) {
    case 'boolean':
      return 'boolean';
    case 'number': {
      const bounds = [
        meta.min === undefined ? '' : `>= ${meta.min}`,
        meta.max === undefined ? '' : `<= ${meta.max}`,
      ].filter(Boolean);
      return `integer${bounds.length > 0 ? ` (${bounds.join(', ')})` : ''}`;
    }
    case 'union':
      return (node.list ?? [])
        .map((ref) => JSON.stringify((json.refs?.[ref] ?? {}).value))
        .join(' \\| ');
    case 'array':
      return 'string[]';
    default:
      return 'string';
  }
}
