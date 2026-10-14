/**
 * Writes tokens.css from tokens.ts.
 * Run from packages/ui: `pnpm exec tsx src/theme/generate.ts`
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from './tokens.js';

const target = fileURLToPath(new URL('./tokens.css', import.meta.url));
writeFileSync(target, renderTokensCss());
console.log(`wrote ${target}`);
