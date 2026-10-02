/**
 * Print the browserkit config field table as markdown, for the README.
 *
 * Generated from the schema rather than written by hand, so the documented
 * defaults, bounds and descriptions cannot drift from the code.
 *
 * Usage: node scripts/print-config-table.mjs
 *
 * @module dsh-plugins/scripts/print-config-table
 */

import { describeConfigFields } from '../packages/browserkit/lib/config.js';

for (const field of describeConfigFields()) {
  const fallback = field.default === undefined ? '—' : JSON.stringify(field.default);
  const description = field.describe.replace(/\|/gu, '\\|');
  console.log(`| \`${field.name}\` | \`${fallback}\` | ${field.expectation} | ${description} |`);
}
