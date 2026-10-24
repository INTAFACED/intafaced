import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The area files that hold `PayService`'s moved code, as paths: `payment-service/<area>.ts`. */
export function payServiceAreaFiles(): string[] {
  return readdirSync(here)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.testkit.ts'))
    .sort()
    .map((f) => join(here, f));
}

/**
 * `PayService`'s whole source for source-text checks: `payment-service.ts` plus its area files in
 * `payment-service/`, so a check of "the payment service" still sees code that the split by area moved.
 */
export function payServiceSource(): string {
  return [join(here, '..', 'payment-service.ts'), ...payServiceAreaFiles()].map((f) => readFileSync(f, 'utf8')).join('\n');
}
