import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..');

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return productionFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.testkit.ts') ? [path] : [];
  });
}

describe('TradeService internals stay inside the class and its area files', () => {
  it('only spot/trade-service.ts and spot/trade-service/ import internal.ts or TradeServiceInternal', () => {
    const allowed = (rel: string) => rel === 'spot/trade-service.ts' || rel.startsWith('spot/trade-service/');
    const offenders = productionFiles(src)
      .map((file) => ({ rel: relative(src, file).split('\\').join('/'), text: readFileSync(file, 'utf8') }))
      .filter(({ rel, text }) => !allowed(rel) && /trade-service\/internal(?:\.js)?'|\bTradeServiceInternal\b/.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
