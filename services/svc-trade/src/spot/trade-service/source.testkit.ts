import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The area files that hold `TradeService`'s moved code, as paths: `trade-service/<area>.ts`. */
export function tradeServiceAreaFiles(): string[] {
  return readdirSync(here)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.testkit.ts'))
    .sort()
    .map((f) => join(here, f));
}

/**
 * `TradeService`'s whole source for source-text checks: `trade-service.ts` plus its area files in
 * `trade-service/`, so a check of "the trade service" still sees code that the split by area moved.
 */
export function tradeServiceSource(): string {
  return [join(here, '..', 'trade-service.ts'), ...tradeServiceAreaFiles()].map((f) => readFileSync(f, 'utf8')).join('\n');
}

/** One area file's source, for checks on code that lives in that area: `area` is its name without `.ts`. */
export function tradeServiceArea(area: string): string {
  return readFileSync(join(here, `${area}.ts`), 'utf8');
}
