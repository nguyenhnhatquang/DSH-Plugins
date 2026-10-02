/**
 * Tool-definition contract tests. Pure: `apply()` registers definitions without
 * launching a browser, so these run in milliseconds.
 *
 * The schema-subset check is the important one. `ToolRuntime.register()` runs
 * `assertSupportedJsonSchema()` on `output.schema` and rejects the whole plugin
 * entry when a keyword is outside the harness's subset — which is a startup
 * failure, not a runtime one. A regression here would break every deployment,
 * so it is pinned here rather than discovered in production.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CHECK_KINDS } from '../lib/assertions.js';
import { apply, configFields, inject, name as pluginName } from '../lib/index.js';
import { makeContext } from './harness.mjs';

/**
 * Apply the plugin to a throwaway context and return the registered definitions.
 *
 * @returns {Map<string, Record<string, unknown>>} tool name to definition.
 */
function registeredTools() {
  const { ctx, state } = makeContext();
  apply(ctx, { artifactsDir: '/tmp/dsh-browserkit-schemas' });
  return state.definitions;
}

/** Keywords and node types the harness's JSON-Schema validator accepts. */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);

/** The primitive types the harness accepts (note: no `json` on a raw schema). */
const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** Keywords that only make sense beside a `type`, and the type each needs. */
const TYPE_BOUND_KEYWORDS = {
  properties: 'object',
  required: 'object',
  additionalProperties: 'object',
  items: 'array',
};

/**
 * Walk one raw schema tree and collect contract violations.
 *
 * @param {unknown} schema - the raw JSON Schema node.
 * @param {string} path - dotted path for error messages.
 * @param {string[]} violations - accumulator.
 */
function collectViolations(schema, path, violations) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    violations.push(`${path} must be a schema object`);
    return;
  }
  const node = /** @type {Record<string, unknown>} */ (schema);
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) violations.push(`${path}.${key} is not a supported keyword`);
  }
  const type = node.type;
  if (type !== undefined && (typeof type !== 'string' || !ALLOWED_TYPES.has(type))) {
    violations.push(`${path}.type is ${JSON.stringify(type)}, which the harness does not accept`);
  }
  if (type === undefined && node.oneOf === undefined) {
    // An annotation-only node is legal, but it may not carry type-bound keywords.
    for (const key of Object.keys(TYPE_BOUND_KEYWORDS)) {
      if (key in node) violations.push(`${path}.${key} requires type or oneOf`);
    }
    return;
  }
  for (const [key, requiredType] of Object.entries(TYPE_BOUND_KEYWORDS)) {
    if (key in node && type !== requiredType) {
      violations.push(`${path}.${key} requires type "${requiredType}"`);
    }
  }
  if (type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties must be an explicit boolean on an object`);
    }
    const properties = /** @type {Record<string, unknown>} */ (node.properties ?? {});
    for (const key of /** @type {string[]} */ (node.required ?? [])) {
      if (!Object.hasOwn(properties, key)) violations.push(`${path}.required names "${key}", which is not declared`);
    }
    for (const [key, child] of Object.entries(properties)) {
      collectViolations(child, `${path}.properties.${key}`, violations);
    }
  }
  if (type === 'array' && node.items !== undefined) {
    collectViolations(node.items, `${path}.items`, violations);
  }
  if (node.enum !== undefined) {
    if (!['string', 'number', 'integer', 'boolean', 'null'].includes(/** @type {string} */ (type))) {
      violations.push(`${path}.enum is only supported on a scalar type`);
    }
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      violations.push(`${path}.enum must be a non-empty array`);
    }
  }
  if (Array.isArray(node.oneOf)) {
    if (node.oneOf.length < 2) violations.push(`${path}.oneOf needs at least two members`);
    node.oneOf.forEach((member, index) => collectViolations(member, `${path}.oneOf[${index}]`, violations));
  }
}

test('every tool output schema stays inside the harness JSON-Schema subset', () => {
  const violations = [];
  for (const definition of registeredTools().values()) {
    collectViolations(
      /** @type {Record<string, unknown>} */ (definition).output?.schema,
      `${definition.name}.output.schema`,
      violations,
    );
  }
  assert.deepEqual(violations, [], `unsupported schema constructs:\n${violations.join('\n')}`);
});

test('every tool parameter schema stays inside the harness JSON-Schema subset', () => {
  // `register()` does not check `parameters`, so an unsupported keyword there
  // fails silently instead of loudly. This test is the only guard.
  const violations = [];
  for (const definition of registeredTools().values()) {
    collectViolations(/** @type {Record<string, unknown>} */ (definition).parameters, `${definition.name}.parameters`, violations);
  }
  assert.deepEqual(violations, [], `unsupported schema constructs:\n${violations.join('\n')}`);
});

test('every tool satisfies the model-facing function-name and definition contract', () => {
  const definitions = registeredTools();
  assert.equal(definitions.size, 19);
  for (const [toolName, definition] of definitions) {
    assert.match(toolName, /^[A-Za-z0-9_-]{1,64}$/u, `${toolName} is not a valid model-facing tool name`);
    assert.equal(typeof definition.description, 'string');
    assert.ok(/** @type {string} */ (definition.description).length > 20, `${toolName} needs an instructive description`);
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.timeoutMs, 'number');
    assert.ok(/** @type {number} */ (definition.timeoutMs) > 0);
    // The presentation hooks are optional, but if present they must be pure
    // functions that a replay can call with args alone.
    if (definition.presentCall !== undefined) assert.equal(typeof definition.presentCall, 'function');
  }
});

test('every tool declares itself exclusive, never concurrency-safe', () => {
  // Every tool mutates or reads one shared page, so two sibling calls must not
  // interleave. Opting into concurrency is what would break that.
  for (const [toolName, definition] of registeredTools()) {
    assert.equal(definition.isConcurrencySafe, undefined, `${toolName} must not opt into concurrency`);
  }
});

test('the assertion description lists every supported check kind', () => {
  // The model can only use a check kind it is told about, so the description is
  // part of the contract rather than documentation.
  const definitions = registeredTools();
  const description = /** @type {string} */ (definitions.get('browser_assert').description);
  for (const kind of CHECK_KINDS) {
    assert.match(description, new RegExp(`\\b${kind}\\b`, 'u'), `browser_assert must mention the "${kind}" check`);
  }
  assert.match(/** @type {string} */ (definitions.get('browser_click').description), /browser_snapshot/u);
});

test('the plugin exports its metadata', () => {
  assert.equal(pluginName, 'browserkit');
  assert.deepEqual(inject, ['tools']);
  assert.ok(configFields.length >= 20);
});
