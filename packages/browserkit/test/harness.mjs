/**
 * Test harness: a fake Cordis context plus a local fixture server.
 *
 * The plugin is written to import nothing from `@deepseek-ai/*` precisely so it
 * can be driven like this: `apply()` against a stub context, then each tool's
 * `execute()` called directly with a fabricated execution. That exercises the
 * real tool bodies and a real browser without needing a model, a session or an
 * API key.
 *
 * @module dsh-plugin-browserkit/test/harness
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A minimal stand-in for the parts of `ctx` the plugin touches.
 *
 * `tools.register` collects definitions so tests can invoke them; the same
 * object satisfies the `ctx.tools.get(name, scope)` visibility probe the
 * prompt-section callback uses.
 */
export class FakeContext {
  /** @type {Map<string, Record<string, unknown>>} */
  definitions = new Map();
  /** @type {Array<() => unknown>} */
  disposers = [];
  /** @type {Array<string>} */
  warnings = [];
  /** @type {Map<string, unknown>} */
  services = new Map();

  constructor() {
    this.logger = {
      warn: (message) => this.warnings.push(String(message)),
      info: () => {},
      error: (message) => this.warnings.push(String(message)),
    };
    this.toolsService = {
      register: (definition) => {
        this.definitions.set(definition.name, definition);
        return () => this.definitions.delete(definition.name);
      },
      // The registry returns nothing for a tool the caller's scope cannot see;
      // the stub mirrors that with an explicit `hidden` scope.
      get: (toolName, scope) => (scope?.hidden === true ? undefined : this.definitions.get(toolName)),
    };
  }

  /** Optional-service lookup, mirroring `ctx.get(name)`. */
  get(name) {
    return this.services.get(name);
  }

  /** Effect registration; returns nothing, as Cordis does. */
  effect(fn) {
    const disposer = fn();
    if (typeof disposer === 'function') this.disposers.push(disposer);
  }

  /** Run every registered disposer, as unmounting the plugin would. */
  async dispose() {
    for (const disposer of this.disposers.splice(0)) await disposer();
  }
}

/**
 * Build the `ctx` object the plugin's `apply` receives.
 *
 * Written out longhand rather than reusing `FakeContext` directly so the
 * property names (`ctx.tools`, `ctx.effect`, `ctx.get`) match what the plugin
 * actually reads — a stub that lies about the interface tests nothing.
 *
 * @returns {{ ctx: Record<string, unknown>, state: FakeContext }} the context and its recorded state.
 */
export function makeContext() {
  const state = new FakeContext();
  const ctx = {
    tools: state.toolsService,
    logger: state.logger,
    effect: (fn) => state.effect(fn),
    get: (serviceName) => state.services.get(serviceName),
  };
  return { ctx, state };
}

/**
 * Fabricate a tool execution.
 *
 * `agent` is a fresh object per call unless one is supplied, which is how
 * session isolation is tested.
 *
 * @param {{ agent?: object, signal?: AbortSignal }} [options] - execution overrides.
 * @returns {Record<string, unknown>} the execution.
 */
export function makeExec(options = {}) {
  return {
    agent: options.agent ?? {},
    signal: options.signal ?? new AbortController().signal,
    callId: 'test-call',
    name: 'test',
    arguments: {},
  };
}

/**
 * Invoke one registered tool by name through the same path the registry uses:
 * `execute(args, exec)`, then `output.render(args, value)`.
 *
 * @param {FakeContext} state - the context state holding the definitions.
 * @param {string} toolName - the tool to call.
 * @param {Record<string, unknown>} args - tool arguments.
 * @param {Record<string, unknown>} [exec] - the execution.
 * @returns {Promise<{ value: Record<string, unknown>, text: string }>} the canonical value and rendered text.
 */
export async function callTool(state, toolName, args, exec) {
  const definition = state.definitions.get(toolName);
  if (!definition) throw new Error(`tool ${toolName} is not registered`);
  const execution = exec ?? makeExec();
  const value = await definition.execute(args, execution);
  const blocks = definition.output.render(args, value);
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return { value, text, blocks };
}

/**
 * Start the fixture HTTP server on an ephemeral port.
 *
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>} the server handle.
 */
export async function startFixtureServer() {
  const html = await readFile(path.join(here, 'fixtures', 'app.html'), 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    // Chrome requests a favicon on its own; answering it keeps the fixture's
    // console clean so the "no console errors" assertions test the fixture's
    // own behaviour rather than the browser's ambient traffic.
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = /** @type {{ port: number }} */ (server.address());
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * A throwaway artifacts directory for the test run.
 *
 * @returns {Promise<string>} the directory path.
 */
export async function makeArtifactsDir() {
  return mkdtemp(path.join(tmpdir(), 'dsh-browserkit-'));
}
