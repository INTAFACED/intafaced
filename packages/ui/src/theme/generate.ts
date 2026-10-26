/**
 * Writes tokens.css and customer-legacy.css from tokens.ts.
 * Run from packages/ui: `pnpm exec tsx src/theme/generate.ts`
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderLegacyCss, renderTokensCss } from './tokens.js';

for (const [name, render] of [
  ['./tokens.css', renderTokensCss],
  ['./customer-legacy.css', renderLegacyCss],
] as const) {
  const target = fileURLToPath(new URL(name, import.meta.url));
  writeFileSync(target, render());
  console.log(`wrote ${target}`);
}
