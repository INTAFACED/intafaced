/**
 * Unit card — live host funding quote does not invent an index price
 * 1. Promise: GET funding-rate host sets indexPrice: null; nextFundingTimestamp: null
 * 2. Break: copy mark into indexPrice or derive nextFunding from interval ms
 * 3. Done bar: fundingRateForMarket return has those two hard-nulls
 * 4. Class N
 * 5. Paths: svc-trade/src/index.ts, svc-trade/src/futures/funding-view.ts (the quote is built there since J-derivatives-08;
 *    an S2S-published rate still carries no index and no next funding time, and `funding-view.test.ts` checks it by value)
 * 6. RED: indexPrice: markPrice
 * 7. Collision: none — #1928 pins getOpenMarginCall; this pins the funding quote
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, '..', 'index.ts'), 'utf8');
const viewSource = readFileSync(join(here, 'funding-view.ts'), 'utf8');

describe('live host funding quote does not invent index or next funding time', () => {
  it('hard-nulls indexPrice and nextFundingTimestamp', () => {
    expect(indexSource).toMatch(/fundingRateForMarket:[\s\S]{0,1200}presentFundingRate\(/);
    expect(viewSource).toMatch(/indexPrice:\s*null/);
    expect(viewSource).toMatch(/nextFundingTimestamp:\s*null/);
  });

  it('does not copy markPrice into indexPrice', () => {
    expect(indexSource).not.toMatch(/indexPrice:\s*markPrice/);
    expect(viewSource).not.toMatch(/indexPrice:\s*(input\.)?(liveMark|markPrice)/);
  });
});
