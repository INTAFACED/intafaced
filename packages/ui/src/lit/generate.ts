/**
 * Writes lit.css from tokens.ts, formatted with the repo's prettier settings.
 * Run from packages/ui: `pnpm exec tsx src/lit/generate.ts`
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formattedLitCss } from './format.js';

const target = fileURLToPath(new URL('./lit.css', import.meta.url));
writeFileSync(target, await formattedLitCss(target));
console.log(`wrote ${target}`);
