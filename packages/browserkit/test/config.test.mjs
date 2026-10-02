/**
 * Config schema tests. No browser needed: this file pins the contract that a
 * deployment typo fails loud at load instead of silently keeping a default, and
 * that the exported `Config` stays a native Schemastery schema.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONFIG_KEYS, Config, describeConfigFields, resolveConfig } from '../lib/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('an empty config resolves to every default', () => {
  const resolved = resolveConfig({});
  for (const key of CONFIG_KEYS) {
    assert.ok(Object.hasOwn(resolved, key), `${key} missing from the resolved config`);
  }
  assert.equal(resolved.headless, true);
  assert.equal(resolved.agent, 'chrome');
  assert.equal(resolved.screenshotType, 'png');
  assert.deepEqual(resolved.launchArgs, []);
});

test('an absent config resolves to the same defaults', () => {
  assert.deepEqual(resolveConfig(undefined), resolveConfig({}));
  assert.deepEqual(resolveConfig(null), resolveConfig({}));
});

test('a valid partial config keeps the given value and fills the rest', () => {
  const resolved = resolveConfig({ headless: false, agent: 'msedge' });
  assert.equal(resolved.headless, false);
  assert.equal(resolved.agent, 'msedge');
  assert.equal(resolved.defaultTimeoutMs, 15_000);
});

test('an unknown key is rejected rather than silently ignored', () => {
  assert.throws(() => resolveConfig({ headles: true }), /unknown config key\(s\) "headles"/u);
});

test('every unknown key is named in one error', () => {
  assert.throws(() => resolveConfig({ nope: 1, alsoNope: 2 }), /"nope", "alsoNope"/u);
});

test('a wrong type is rejected with the schema path', () => {
  assert.throws(() => resolveConfig({ headless: 'yes' }), /\$\.headless expected boolean/u);
});

test('a bad enum value lists the accepted values', () => {
  assert.throws(() => resolveConfig({ agent: 'firefox' }), /\$\.agent expected "chrome" \| "msedge" \| "chromium" \| "auto"/u);
});

test('out-of-range integers are rejected at both bounds', () => {
  for (const [key, value] of [['defaultTimeoutMs', 1], ['defaultTimeoutMs', 10_000_000], ['maxSessions', 0], ['viewportWidth', 10]]) {
    assert.throws(() => resolveConfig({ [key]: value }), new RegExp(`\\$\\.${key} expected number`, 'u'), `${key}=${value} should be rejected`);
  }
});

test('a non-integer viewport is rejected by the step constraint', () => {
  assert.throws(() => resolveConfig({ viewportWidth: 1024.5 }), /\$\.viewportWidth/u);
});

test('launchArgs must be an array of strings', () => {
  const resolved = resolveConfig({ launchArgs: ['--disable-gpu'] });
  assert.deepEqual(resolved.launchArgs, ['--disable-gpu']);
  assert.throws(() => resolveConfig({ launchArgs: [1] }), /\$\.launchArgs/u);
});

test('Config is a native Schemastery schema, not a hand-rolled validator', () => {
  // The harness's `--dump-config-schema` introspects the plugin's Config and
  // rejects anything that is not native Schemastery, so this is a load-bearing
  // property rather than an implementation detail.
  assert.equal(typeof Config, 'function');
  assert.equal(typeof Config.toJSON, 'function');
  assert.equal(typeof Config.dict, 'object');
  assert.equal(typeof Config['~standard']?.validate, 'function');
  const json = Config.toJSON();
  // Schemastery's JSON form is a `refs` table addressed by `uid`.
  assert.equal(typeof json.uid, 'number');
  const root = json.refs[json.uid];
  assert.equal(root?.type, 'object', 'the root node must be a Schemastery object');
  assert.ok(Object.keys(root.dict ?? {}).length > 0, 'the root object must declare its fields');
});

test('the schema carries descriptions for every field', () => {
  for (const field of describeConfigFields()) {
    assert.ok(field.describe.length > 10, `${field.name} needs a real description`);
    assert.ok(field.expectation.length > 0, `${field.name} needs a type description`);
  }
});

test('every schema key is documented and every documented key exists', () => {
  assert.deepEqual(describeConfigFields().map((field) => field.name).sort(), [...CONFIG_KEYS].sort());
});

test('the bundle patch row matches the package manifest', async () => {
  const manifest = JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8'));
  const patch = await readFile(path.join(here, '..', 'cordis.patch.yml'), 'utf8');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.match(patch, new RegExp(`name: '${manifest.name}'`, 'u'), 'the patch row must name the package');
});

test('the plugin entry exports the function-plugin contract with no default export', async () => {
  const module = await import('../lib/index.js');
  assert.equal(typeof module.name, 'string');
  assert.deepEqual(module.inject, ['tools']);
  assert.equal(typeof module.apply, 'function');
  assert.ok('Config' in module);
  assert.equal(module.default, undefined, 'a default export makes the Loader discard inject');
});

test('an invalid config makes apply throw, so misconfiguration fails at load', async () => {
  const { apply } = await import('../lib/index.js');
  const ctx = { tools: { register: () => {} }, effect: () => {}, get: () => undefined, logger: console };
  assert.throws(() => apply(ctx, { agent: 'firefox' }), /\$\.agent/u);
  assert.throws(() => apply(ctx, { typo: 1 }), /unknown config key/u);
});
