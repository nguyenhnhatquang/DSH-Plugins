/**
 * Durable image admission for screenshots.
 *
 * A screenshot has two jobs: leave a file a human can open, and (when the
 * active model can actually see it) reach model context as a real image. The
 * file always happens. The image only happens after exact positive proof that
 * the current model route accepts image input, because silently sending an
 * image to a text-only route is the failure mode this guard exists to prevent.
 *
 * This mirrors the admission sequence `@deepseek-ai/dsh-mcp-client` uses for
 * MCP image results. Every service is read through `ctx.get` because the plugin
 * declares only `tools` as a required service.
 *
 * @module dsh-plugin-browserkit/attachments
 */

/**
 * Whether a value is a function on the candidate service.
 *
 * @param {unknown} service - the candidate service.
 * @param {string} method - method name.
 * @returns {boolean} whether the method is callable.
 */
function hasMethod(service, method) {
  return typeof (/** @type {Record<string, unknown>} */ (service)?.[method]) === 'function';
}

/**
 * Resolve the active model route from a tool execution.
 *
 * @param {object} exec - the tool execution.
 * @returns {{ provider?: string, model?: string }} the routed provider and model, when resolvable.
 */
function currentRoute(exec) {
  try {
    const routed = exec?.agent?.session?.requestHeader?.()?.config;
    return {
      provider: routed?.provider ?? exec?.agent?.options?.provider,
      model: routed?.model ?? exec?.agent?.options?.model,
    };
  } catch {
    return { provider: exec?.agent?.options?.provider, model: exec?.agent?.options?.model };
  }
}

/**
 * Try to admit one image into durable model context.
 *
 * @param {object} ctx - the Cordis plugin context.
 * @param {object} exec - the tool execution carrying the agent and signal.
 * @param {Buffer} data - the encoded image bytes.
 * @param {string} mediaType - `image/png` or `image/jpeg`.
 * @returns {Promise<{ ok: true, ref: unknown } | { ok: false, reason: string }>} the admitted reference or the reason it was not admitted.
 */
export async function admitImage(ctx, exec, data, mediaType) {
  const attachments = ctx.get?.('attachments');
  if (!hasMethod(attachments, 'saveImages')) {
    return { ok: false, reason: 'no attachment store is mounted' };
  }
  const llm = ctx.get?.('llm');
  const { provider, model } = currentRoute(exec);
  if (!provider || !model || !hasMethod(llm, 'resolveModelInfo')) {
    return { ok: false, reason: 'the current model route could not be resolved' };
  }
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, exec?.signal);
  } catch {
    return { ok: false, reason: `the route for model "${model}" could not be verified` };
  }
  const modalities = info?.inputModalities;
  if (!Array.isArray(modalities) || !modalities.includes('image')) {
    return { ok: false, reason: `model "${model}" does not declare image input` };
  }
  if (exec?.signal?.aborted) return { ok: false, reason: 'the tool call was canceled before image storage' };
  try {
    const refs = await /** @type {{ saveImages: (images: Array<{ data: Buffer, mediaType: string }>) => Promise<unknown[]> }} */ (
      attachments
    ).saveImages([{ data, mediaType }]);
    if (!Array.isArray(refs) || refs.length === 0) {
      return { ok: false, reason: 'the attachment store returned no reference' };
    }
    return { ok: true, ref: refs[0] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `durable image storage rejected the screenshot: ${message}` };
  }
}

/**
 * Text shown in place of an image that was not admitted.
 *
 * @param {string} path - the artifact path that was still written.
 * @param {string} reason - why admission failed.
 * @returns {string} one diagnostic sentence.
 */
export function imageFallbackText(path, reason) {
  return `[screenshot not placed in model context: ${reason}; the image is available at ${JSON.stringify(path)}]`;
}
