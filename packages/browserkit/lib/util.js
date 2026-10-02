/**
 * Small shared helpers. Kept in one module so error text and truncation behave
 * identically across tools.
 *
 * @module dsh-plugin-browserkit/util
 */

/**
 * First line of an error message.
 *
 * Playwright puts the actionable sentence first and a multi-frame call log
 * after it; keeping only line one keeps tool results reviewable.
 *
 * @param {unknown} error - the thrown value.
 * @returns {string} one trimmed line.
 */
export function firstLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n', 1)[0].trim();
}

/**
 * Await a promise, falling back when it takes too long.
 *
 * A modal dialog blocks the renderer, so a read that normally answers instantly
 * (`page.title()`, for example) simply never settles. Teardown and the tab
 * listing must survive that, so they bound the wait instead of hanging on it.
 *
 * @template T
 * @param {Promise<T>} promise - the operation to bound.
 * @param {number} ms - how long to wait.
 * @param {T} fallback - the value to use when the wait runs out or the promise rejects.
 * @returns {Promise<T>} the result or the fallback.
 */
export async function withTimeout(promise, ms, fallback) {
  const settled = promise.then((value) => value, () => fallback);
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([settled, guard]);
    return result === undefined ? fallback : result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Truncate text with an explicit, honest notice.
 *
 * @param {string} text - the text to bound.
 * @param {number} limit - maximum characters.
 * @param {string} [what] - noun for the notice.
 * @returns {string} the bounded text.
 */
export function clampText(text, limit, what = 'content') {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n(${what} truncated at ${limit} characters; ${text.length - limit} more omitted.)`;
}

/**
 * Whether a value survives a JSON round trip.
 *
 * `browser_eval` runs arbitrary page code, which can return DOM nodes,
 * functions, symbols or cyclic objects. Tool output must be lossless JSON, so
 * anything else is converted to a description instead of breaking the call.
 *
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether `JSON.stringify` is faithful.
 */
export function isJsonSafe(value) {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Describe an unserializable value without throwing.
 *
 * @param {unknown} value - the value to describe.
 * @returns {string} a short description.
 */
export function describeValue(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type !== 'object') return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return `${tag || 'Object'}`;
}
