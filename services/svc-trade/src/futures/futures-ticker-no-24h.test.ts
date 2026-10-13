/**
 * Unit card — GET ticker does not invent 24h rollups
 * 1. Promise: presentTicker's high/low/vwap/volume/open/change/percentage come only
 *    from real 24 h fill stats; with no stats they are null, never the last print
 * 2. Break: fill high from last print or invent a 24h window
 * 3. Done bar: no stats → those fields are null; last/close may be the print
 * 4. Class N
 * 5. Paths: svc-trade/src/public-rest.ts, svc-trade/src/spot/ticker-stats.ts
 * 6. RED: high: lastPrice
 * 7. Collision: none — public-rest.test.ts covers the stats-present path at runtime
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { presentTicker } from '../public-rest.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public-rest.ts'), 'utf8');

const print = {
  id: 'p1',
  side: 'buy' as const,
  price: parseAmount('100.5'),
  qty: parseAmount('1'),
  quoteAmount: parseAmount('100.5'),
  sequence: 1,
  ts: new Date(1_700_000_000_000),
};

describe('presentTicker does not invent 24h rollups', () => {
  it('with no 24 h stats, high, low, vwap, open, volumes, change and percentage are null', () => {
    for (const stats of [undefined, null]) {
      const wire = presentTicker('BTC/USDT', { bids: [], asks: [], sequence: 0 }, print, 1_700_000_000_000, stats);
      expect(wire.last).toBe('100.5');
      for (const field of ['high', 'low', 'vwap', 'open', 'baseVolume', 'quoteVolume', 'change', 'percentage', 'average'] as const) {
        expect(wire[field]).toBeNull();
      }
    }
  });

  it('does not copy last print into high/low', () => {
    expect(src).not.toMatch(/high:\s*lastPrice/);
    expect(src).not.toMatch(/low:\s*lastPrice/);
  });
});
