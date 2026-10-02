/**
 * Image-admission tests, with stubbed optional services.
 *
 * The screenshot tool has two jobs and only one of them is unconditional: the
 * file is always written, the image reaches model context only after exact
 * positive proof that the route accepts image input. A silent image to a
 * text-only route is the failure this guards, so every refusal path is pinned
 * here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { admitImage, imageFallbackText } from '../lib/attachments.js';

/**
 * Build a plugin context whose optional services behave as described.
 *
 * @param {{ attachments?: unknown, llm?: unknown }} services - the services to mount.
 * @returns {object} a `ctx`-shaped object.
 */
function contextWith(services) {
  const mounted = new Map(Object.entries(services).filter(([, value]) => value !== undefined));
  return { get: (serviceName) => mounted.get(serviceName) };
}

/**
 * A model route that reports the given input modalities.
 *
 * @param {string[] | undefined} modalities - declared input modalities.
 * @returns {object} an `llm` service stub.
 */
function llmDeclaring(modalities) {
  return {
    resolveModelInfo: async () => ({ inputModalities: modalities }),
  };
}

/** An execution whose agent reports a resolvable route. */
const routedExec = {
  agent: {
    options: { provider: 'test-provider', model: 'test-model' },
    session: { requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }) },
  },
  signal: new AbortController().signal,
};

const png = Buffer.from('89504e470d0a1a0a', 'hex');

test('an image is admitted when the route declares image input', async () => {
  const saved = [];
  const ctx = contextWith({
    attachments: { saveImages: async (images) => images.map((image) => ({ id: saved.push(image) })) },
    llm: llmDeclaring(['text', 'image']),
  });
  const result = await admitImage(ctx, routedExec, png, 'image/png');
  assert.equal(result.ok, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mediaType, 'image/png');
  assert.ok(Buffer.isBuffer(saved[0].data));
});

test('a text-only route is refused, and the reason names the model', async () => {
  let saveCalled = false;
  const ctx = contextWith({
    attachments: { saveImages: async () => { saveCalled = true; return []; } },
    llm: llmDeclaring(['text']),
  });
  const result = await admitImage(ctx, routedExec, png, 'image/png');
  assert.equal(result.ok, false);
  assert.match(result.reason, /model "test-model" does not declare image input/u);
  assert.equal(saveCalled, false, 'nothing may be stored for a route that cannot receive it');
});

test('a route with no declared modalities is refused', async () => {
  const ctx = contextWith({
    attachments: { saveImages: async () => [] },
    llm: llmDeclaring(undefined),
  });
  assert.equal((await admitImage(ctx, routedExec, png, 'image/png')).ok, false);
});

test('a missing attachment store is refused', async () => {
  const result = await admitImage(contextWith({ llm: llmDeclaring(['image']) }), routedExec, png, 'image/png');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no attachment store is mounted');
});

test('an unresolvable route is refused rather than assumed capable', async () => {
  const ctx = contextWith({ attachments: { saveImages: async () => [] }, llm: llmDeclaring(['image']) });
  const result = await admitImage(ctx, { agent: {}, signal: new AbortController().signal }, png, 'image/png');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'the current model route could not be resolved');
});

test('a route that cannot be verified is refused', async () => {
  const ctx = contextWith({
    attachments: { saveImages: async () => [] },
    llm: { resolveModelInfo: async () => { throw new Error('provider unreachable'); } },
  });
  const result = await admitImage(ctx, routedExec, png, 'image/png');
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be verified/u);
});

test('a store that rejects the image is reported, not swallowed', async () => {
  const ctx = contextWith({
    attachments: { saveImages: async () => { throw new Error('too large'); } },
    llm: llmDeclaring(['image']),
  });
  const result = await admitImage(ctx, routedExec, png, 'image/png');
  assert.equal(result.ok, false);
  assert.match(result.reason, /durable image storage rejected the screenshot: too large/u);
});

test('an already-cancelled call does not store an image', async () => {
  const controller = new AbortController();
  controller.abort();
  let saveCalled = false;
  const ctx = contextWith({
    attachments: { saveImages: async () => { saveCalled = true; return []; } },
    llm: llmDeclaring(['image']),
  });
  const result = await admitImage(ctx, { ...routedExec, signal: controller.signal }, png, 'image/png');
  assert.equal(result.ok, false);
  assert.match(result.reason, /canceled before image storage/u);
  assert.equal(saveCalled, false);
});

test('a store returning nothing is treated as a refusal', async () => {
  const ctx = contextWith({
    attachments: { saveImages: async () => [] },
    llm: llmDeclaring(['image']),
  });
  const result = await admitImage(ctx, routedExec, png, 'image/png');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'the attachment store returned no reference');
});

test('the fallback text keeps the artifact path and the reason', () => {
  const text = imageFallbackText('/tmp/shot.png', 'the model is text only');
  assert.match(text, /shot\.png/u);
  assert.match(text, /the model is text only/u);
  assert.match(text, /not placed in model context/u);
});
