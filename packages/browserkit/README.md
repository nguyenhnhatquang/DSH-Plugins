# dsh-plugin-browserkit

Browser tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) agents: a real browser an agent can **drive** and **verify**.

Agents are good at reading source code and bad at guessing what a page actually does. This plugin gives a team of agents a real browser each — read the page, act on it, and check the outcome, with a screenshot when the failure is visual. It serves two jobs from one surface:

- **UI testing** — the read → act → assert loop, with a report that names every check that failed.
- **Automation** — tabs, dialogs, saved logins, uploads, and attaching to a browser that is already running.

Only `browser_assert` is test-specific; the other eighteen tools are general browser automation.

```
npm:    dsh-plugin-browserkit
plugin: browserkit
tools:  19 × browser_*
```

**1.0.0** means the tool names, the assertion check kinds, and the documented config fields are a contract: they will not change incompatibly within 1.x. The Known Limitations at the end are real gaps, not a roadmap promise.

---

## What makes it usable for a team of coding agents

**One browser per agent.** Sessions are keyed by the calling agent, so five teammates can test five flows at once without sharing cookies, storage or navigation state. Nothing to configure.

**Refs, not brittle selectors.** `browser_snapshot` returns the accessibility tree for understanding plus a numbered inventory of actionable elements. Each row carries a short ref (`e1`, `e2`) and the most stable selector available — `data-testid`, then `id`, then `name`, then `aria-label`, then a structural path. Interact with the ref; do not re-derive a CSS path on every call.

**Assertions that report everything.** `browser_assert` takes a list of checks and never stops at the first failure — one call tells the agent every check that failed, with the actual value it observed. Assertions wait for their condition, so UI tests do not need fixed sleeps.

**No false passes.** The `no_console_errors` and `no_failed_requests` checks wait for page activity to settle before reading the log. Without that, an assertion run right after a click races the request that click started and reports success on a page that is about to fail.

**Honest screenshots.** A screenshot is always written to a file. It is *additionally* placed in model context only after exact positive proof that the active model route accepts image input, so a text-only route gets a path and a reason instead of a silently dropped image.

**Sessions that clean up.** Every browser is released when the plugin unloads, when a session is evicted by the `maxSessions` cap, or after `closeIdleMs` of inactivity.

---

## It is also an automation engine

Only `browser_assert` is test-specific. The other eighteen tools are a general browser-automation surface, and five capabilities exist purely because **unattended** automation cannot tolerate what a watched test run can:

| Capability | Why a watched run does not need it | What this plugin does |
|---|---|---|
| **Tabs and popups** | A human notices the OAuth window behind the main one. | A click that opens a tab reports it (`openedTabs`) without stealing the active tab. `browser_tabs` lists, selects, opens and closes. |
| **Dialogs** | Playwright's default silently dismisses `confirm()`. A person sees which branch was taken. | `dialogPolicy: manual` leaves the dialog open, the action result names it, and every blocking-prone tool fails fast with the one instruction that unblocks it. |
| **Login persistence** | A person logs in once per session. | `browser_storage_state` saves cookies and web storage to a file; `storageStatePath` starts a later session already logged in. |
| **File upload** | A person drags the file in. | `browser_upload` attaches files, but only from the artifacts directory or a configured `uploadRoots` entry — see the security note below. |
| **Attach to a running browser** | — | `cdpEndpoint` drives a browser this plugin did not start, so a logged-in or anti-detect profile can be used instead of a fresh throwaway one. Closing the session **disconnects** and leaves that browser running. |

### Automation example

```jsonc
// 1. log in once, in a session you keep
{ "session": "work", "url": "https://app.example.com/login" }
// …browser_type / browser_click through the form, then persist the login:
{ "action": "save", "path": "work-login", "session": "work" }

// 2. every later run starts authenticated
{ "session": "work", "url": "https://app.example.com/dashboard", "storageStatePath": "<artifactsDir>/work-login.json" }

// 3. drive an existing browser instead of launching one
{ "session": "attached", "cdpEndpoint": "http://127.0.0.1:9222" }
```

---

## Tool surface

| Tool | Purpose |
|---|---|
| `browser_open` | Open a session (optionally with a URL), or attach to a running browser with `cdpEndpoint`. Per-session `headless`/`agent`/viewport/`storageStatePath` overrides. |
| `browser_navigate` | `goto`, `back`, `forward`, `reload`. |
| `browser_snapshot` | Accessibility tree + numbered interactive-element inventory with refs. |
| `browser_click` | Click by ref or selector, with button/double-click/force options. Reports any tab it opened. |
| `browser_type` | Type into an input, textarea or contenteditable; optional clear and submit. |
| `browser_press` | Press a key or chord (`Enter`, `Control+A`), on the page or on an element. |
| `browser_select` | Choose options in a native `<select>`. |
| `browser_hover` | Reveal hover-only menus and tooltips. |
| `browser_wait_for` | Wait for text or for an element state. |
| `browser_eval` | Evaluate page JavaScript (gated by `allowEvaluate`). |
| `browser_screenshot` | Capture to a file, and into model context when the model can see images. |
| `browser_assert` | Run a batch of UI checks and return a pass/fail report. |
| `browser_console` | Read console messages and uncaught page errors. |
| `browser_network` | Read transport failures and 4xx/5xx responses. |
| `browser_tabs` | List, select, open and close tabs. |
| `browser_dialog` | List and answer `alert`/`confirm`/`prompt`. |
| `browser_storage_state` | Inspect, save or clear cookies and web storage. |
| `browser_upload` | Attach local files to a file input. |
| `browser_close` | Close one session, or all of them. |

### Assertion check kinds

`visible`, `hidden`, `enabled`, `disabled`, `focused`, `checked`, `text`, `value`, `attribute`, `count`, `url`, `title`, `no_console_errors`, `no_failed_requests`.

```jsonc
{
  "checks": [
    { "kind": "visible", "selector": "[data-testid=panel]" },
    { "kind": "text", "text": "Welcome back" },
    { "kind": "count", "selector": "tbody tr", "exactly": 3 },
    { "kind": "url", "value": "/dashboard", "mode": "contains" },
    { "kind": "no_console_errors" }
  ]
}
```

---

## Install

### Into a profile (the normal path)

```sh
# from a tarball built by this repo
dsh plugin --profile <profile> add ./dsh-plugin-browserkit-1.0.0.tgz

# or from a checkout by absolute path
dsh plugin --profile <profile> add D:\path\to\DSH-Plugins\packages\browserkit
```

The package declares `dsh.bundle.patch`, so `dsh` appends it to the profile's `dsh.profile.bundles`. Verify:

```sh
dsh --profile <profile> --dump-config          # the browserkit row should appear
dsh --profile <profile> --dump-config-schema   # exits 0 and shows the config fields
```

### Into the Desktop app

The `desktop` profile is Electron-owned, so the CLI refuses `dsh plugin --profile desktop …`. Use either:

1. **The GUI Plugins page** (sidebar → Plugins → install from a path, git URL or npm name). This is the supported path.
2. **A patch overlay** for development, which also works for any profile:

   ```sh
   node scripts/dev-overlay.mjs            # in this repo; writes .dev/overlay.cordis.patch.yml
   ```

   Then add the same `- insert:` block to `%USERPROFILE%\.dsh\cordis.patch.yml` (the home layer applies to *every* profile, including `desktop`) with an absolute path to `packages/browserkit/lib/index.js`.

### Browser requirement

The plugin uses `playwright-core` and, by default, launches the **Google Chrome already installed on the machine** (`agent: chrome`). Nothing is downloaded. If Chrome is missing it falls back to Edge, then to a Playwright-managed Chromium — which requires:

```sh
npx playwright install chromium
```

Set `channelFallback: false` to fail instead of falling back.

---

## Configuration

All fields are optional; the defaults below are complete. Unknown keys are rejected at load, so a typo fails loudly rather than silently keeping a default.

| Field | Default | Type | Description |
|---|---|---|---|
| `headless` | `true` | boolean | Run the browser headless. Set false to watch a failing test. |
| `agent` | `"chrome"` | "chrome" \| "msedge" \| "chromium" \| "auto" | Preferred browser. `chrome`/`msedge` use the installed stable build; `chromium` uses the Playwright-managed build. |
| `channelFallback` | `true` | boolean | When the preferred browser is not installed, fall back through the remaining agents instead of failing. |
| `executablePath` | `""` | string | Explicit browser executable. Wins over `agent`; set it to smoke-test one specific build. |
| `launchArgs` | `[]` | string[] | Extra Chromium command-line switches (for example `--disable-dev-shm-usage` in a small container). |
| `viewportWidth` | `1280` | integer (>= 200, <= 10000) | Default viewport width in CSS pixels. |
| `viewportHeight` | `720` | integer (>= 200, <= 10000) | Default viewport height in CSS pixels. |
| `locale` | `""` | string | Browser locale such as `vi-VN`. Empty leaves the browser default. |
| `timezoneId` | `""` | string | Browser timezone such as `Asia/Ho_Chi_Minh`. Empty leaves the browser default. |
| `ignoreHTTPSErrors` | `false` | boolean | Accept invalid TLS certificates. Needed for a local self-signed dev server. |
| `defaultTimeoutMs` | `15000` | integer (>= 250, <= 600000) | Default per-action timeout for element waits, clicks and typing. |
| `navigationTimeoutMs` | `30000` | integer (>= 250, <= 600000) | Timeout for page navigations and reloads. |
| `toolTimeoutMs` | `120000` | integer (>= 1000, <= 3600000) | Cooperative budget declared as each tool `timeoutMs` and enforced by the harness timeout policy. |
| `maxSnapshotChars` | `40000` | integer (>= 1000, <= 500000) | Cap on one snapshot result. Truncation is always stated explicitly. |
| `maxInventoryItems` | `120` | integer (>= 1, <= 2000) | Cap on interactive elements listed by one snapshot. |
| `artifactsDir` | `""` | string | Where screenshots and saved storage state are written. Empty resolves to `<workspace>/.browserkit` at load time; artifact paths can never leave this directory. |
| `screenshotType` | `"png"` | "png" \| "jpeg" | Image format for screenshot artifacts. |
| `attachImagesToContext` | `true` | boolean | Also place screenshots in model context when the active model accepts image input. The file is always written. |
| `allowEvaluate` | `true` | boolean | Allow `browser_eval`. Page JavaScript can read page secrets, so a hardened deployment sets this false. |
| `maxSessions` | `8` | integer (>= 1, <= 64) | Concurrent browser sessions. A new session beyond this cap closes the least recently used one. |
| `closeIdleMs` | `0` | integer (>= 0, <= 86400000) | Close a session after this long without a call. 0 disables idle reaping. |
| `newTabPolicy` | `"report"` | "report" \| "focus" | What a popup or `target=_blank` does to the active tab. `report` keeps the current tab and names the new one in the result; `focus` switches to it. |
| `newTabWaitMs` | `250` | integer (>= 0, <= 5000) | How long a click waits to see whether it opened a tab. Zero removes the delay but a popup is then only reported by the next `browser_tabs` call, not by the click result. |
| `dialogPolicy` | `"manual"` | "manual" \| "accept" \| "dismiss" | How to answer `alert`/`confirm`/`prompt`. `manual` leaves the dialog open for `browser_dialog`, so an unattended run cannot silently take the wrong branch; `accept`/`dismiss` answer it automatically. |
| `maxTabs` | `12` | integer (>= 1, <= 64) | Tabs allowed per session. Newly opened popups beyond this are closed, so an ad that spawns windows cannot grow the session without bound. |
| `cdpEndpoint` | `""` | string | Attach to an already-running browser over CDP instead of launching one, for example `http://127.0.0.1:9222`. Use it to drive a logged-in or anti-detect profile. |
| `cdpUseExistingContext` | `true` | boolean | When attaching over CDP, drive the browser's existing context and tabs. Set false to open an isolated context in the attached browser instead. |
| `storageStatePath` | `""` | string | Default storage state (cookies and web storage) every session starts from, so an automation run begins logged in. `browser_open` can override it per session. |
| `uploadRoots` | `[]` | string[] | Extra directories that `browser_upload` may read files from. The artifacts directory is always allowed; nothing else is, because uploading a local file to a page is a read primitive the harness file sandbox does not cover. |

Example row:

```yaml
- id: browserkit
  name: 'dsh-plugin-browserkit'
  config:
    headless: false
    defaultTimeoutMs: 20000
    artifactsDir: ./test-artifacts
    allowEvaluate: false
```

---

## Design notes

**Raw `ToolDefinition`s instead of `defineTool`.** The harness accepts plain JSON-Schema tool definitions — that is how MCP-sourced tools arrive. Registering that shape directly means the plugin never imports `@deepseek-ai/dsh-tools`, so it loads from any path and its tests need no harness. The cost is hand-written schemas and hand-checked cross-field constraints; the harness's supported keyword subset (`type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` plus annotations) is pinned by a test so a regression cannot reach a deployment.

**A native Schemastery `Config`.** Cordis only needs `~standard.validate` to run a plugin, but the harness also introspects configs to generate JSON Schema (`dsh --dump-config-schema`) and to render configuration forms. A hand-rolled Standard-Schema validator loads fine and then fails the dump with `Config is not a native Schemastery schema`. This plugin therefore exports a real `z.object({...})` and adds an explicit unknown-key check, because Schemastery's object mode passes unknown keys through.

**Screenshot paths are confined.** The harness sandboxes its own file tools; this plugin writes with `node:fs` and so sits outside that fence. Honoring an arbitrary absolute `path` argument would be a sandbox escape, so a screenshot can only land inside `artifactsDir`, and `..` escapes are rejected.

**Uploads are an explicit capability grant.** Uploading a local file to a page moves host bytes into a page the model may not control, which is a *read* primitive the file sandbox does not cover. So `browser_upload` only reads from `artifactsDir` plus the directories a deployment names in `uploadRoots`. Long-lived credentials saved by `browser_storage_state` are treated the same way: the file stays inside `artifactsDir`, and `browser_storage_state` reports cookie *names* but never values, because a value would be a live session credential pasted into the transcript.

**A manual dialog blocks the renderer, so it is reported instead of waited on.** With `dialogPolicy: manual`, an action that opens a `confirm()` never settles — Playwright's actionability machinery waits out its own timeout and then reports `locator.click: Timeout exceeded`, which says nothing about the dialog. That message sends an unattended run into a retry loop. So an action is raced against the dialog signal: the dialog wins, the action is abandoned (not cancelled — the click did happen), and the result names what to answer. While such a dialog is open, the tools that need the renderer fail immediately with the same instruction; `browser_dialog`, `browser_tabs`, `browser_console`, `browser_network` and `browser_close` keep working.

**No `isConcurrencySafe`.** Every tool touches one shared page, so sibling calls must not interleave. A test asserts none of them opts into concurrency.

**Playwright API choices that matter.** Action and state checks resolve `.first()` because Playwright's action APIs are strict and a page with two matching elements should not break "click the button named Save". `count` is the exception: it needs the whole match set, and `.first()` would always report `1`.

**Popup detection pays a bounded window.** Whether a click opened a tab cannot be answered without observing for a moment: the browser creates the page after the click resolves, and both the `page` event and `context.pages()` lag it. `newTabWaitMs` bounds that observation (250 ms by default); setting it to `0` removes the delay and accepts that a popup is then only reported by the next `browser_tabs` call.

---

## Development

```sh
pnpm install
pnpm test                 # 81 tests; 46 of them drive real headless Chrome
```

The suite runs against real Chrome and a local fixture server — nothing mocks Playwright, because a browser plugin tested only against a mock has not been tested. Config and tool-schema tests are pure and run in milliseconds.

`test/automation.test.mjs` spawns a second Chrome with `--remote-debugging-port` to verify the CDP attach path for real, and skips that one test rather than faking it when no Chromium-family binary is available.

```sh
node scripts/dev-overlay.mjs     # from the repo root; writes .dev/overlay.cordis.patch.yml
dsh --profile <profile> --from-default-profile headless \
  --patch ./.dev/overlay.cordis.patch.yml \
  --dump-config-schema
```

Change `chrome` to `msedge` with `BROWSER_TEST_AGENT=msedge pnpm test`.

---

## Model Experience

### System-prompt guidance

#### What the model sees

A `tool:browserkit` prompt section, contributed through `ctx.systemPrompt.section()` when the service is mounted, and rendered empty unless `browser_open` is visible in the calling scope. The section teaches the read → act → verify loop and states four rules: verify rather than assume and quote the assertion that passed; prefer `browser_assert` over `browser_eval`; use a screenshot when the failure is visual; and read console/network before retrying a failed check.

#### Token effect

Roughly 220 tokens, present only while the tools are registered. A deployment without the `systemPrompt` service, or with the tools hidden for the calling scope, pays nothing.

#### KV Cache effect

Prefix-stable while the section's text is unchanged. The section renders empty rather than disappearing, so enabling or hiding the tools changes the prompt text and invalidates reuse from that point.

### Tool declarations

#### What the model sees

19 `browser_*` tool declarations with their parameter JSON Schemas and descriptions. Each description states the interaction model: `browser_click` and friends say the target comes from `browser_snapshot`; `browser_assert` lists every supported check kind; `browser_dialog` explains why a dialog must be read before it is answered.

#### Token effect

The declarations enter every request while the plugin is mounted. `browser_assert`'s description is the largest because it enumerates the 14 check kinds.

#### KV Cache effect

Prefix-stable while the declarations are unchanged. Enabling or disabling the plugin changes the tool set and invalidates reuse from the first changed declaration.

### Tool results

#### What the model sees

Native text results, except `browser_screenshot`, which adds a real image block when — and only when — the active route proves image input. Otherwise the result carries a diagnostic explaining why, plus the file path.

#### Token effect

Snapshots are capped by `maxSnapshotChars`, console and network dumps by `limit`, and every truncation is stated explicitly. A screenshot's image block is subject to the harness's own image budget and compaction policy.

#### KV Cache effect

Append-only. Screenshots reach model context through durable attachments, so the transcript grows with references rather than inline base64.

---

## Known Limitations and Deferred Work

- **No test-script export.** The plugin verifies interactively; it does not record a flow into a replayable Playwright `.spec.ts`. That is the natural next step and is deliberately not half-built here.
- **No visual diffing.** `browser_screenshot` produces the evidence but compares nothing. Baseline management and pixel diffing are unbuilt.
- **Chromium-family only.** Chromium, Chrome and Edge. No Firefox or WebKit — the accessibility-snapshot and ref-inventory approach would need re-verification there.
- **`browser_eval` is a page-secret read primitive.** Page JavaScript can read cookies and tokens the accessibility tree never exposes. Keep `allowEvaluate: false` where that matters.
- **Sessions are per process, not per session-log.** A resumed `dsh` session gets a fresh browser. Refs are also cleared on navigation, so a transcript replayed later cannot re-drive a page. Login survives through `browser_storage_state`, not through the transcript.
- **The ref inventory sees the main frame.** Interactive elements inside cross-origin iframes are not enumerated; target those with an explicit `selector` or Playwright frame selector.
- **`no_console_errors` counts browser-generated resource errors.** A page that 404s an optional asset reports a console error. Allow it with `max` rather than disabling the check.
- **No download handling.** A click that triggers a download leaves the file to the browser; there is no `browser_download` yet.
- **`maxTabs` is not enforced on an attached browser.** Closing the user's own tabs would be destroying their work, so an attached session reports the tab count but never prunes it.
- **Attaching needs a debugging port.** The browser must have been started with `--remote-debugging-port` (or an anti-detect profile must expose a CDP endpoint). A browser already open without one cannot be attached to after the fact.
- **No anti-bot evasion.** A stock Chrome is detectable. For sites that fingerprint automation, drive an anti-detect profile over `cdpEndpoint` instead of relying on this plugin to hide.
