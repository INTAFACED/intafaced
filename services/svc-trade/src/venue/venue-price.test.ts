import { describe, expect, it } from 'vitest';
import { compare, parseAmount } from '@intafaced/ledger-client/money';
import { PERP_MAX_DECIMALS, priceProblem, SPOT_MAX_DECIMALS, unit } from '@intafaced/venue-hyperliquid';
import { venuePrice } from './venue-price.js';

// The venue adapter's own check (the one that answered the beta "price 62744.2 has 6 significant figures")
// takes every price svc-trade computes, on every market shape, and the rounding never moves past the price it was given.
describe('venuePrice: every computed price is one the venue takes', () => {
  it('BTC-PERP (szDecimals 5, tick 0.1) at the beta’s refused price', () => {
    const tick = unit(PERP_MAX_DECIMALS - 5);
    expect(priceProblem(parseAmount('62744.2'), 5, 'perpetual')).toMatch(/6 significant figures/);
    expect(venuePrice(parseAmount('62744.16'), tick, 'down')).toBe(parseAmount('62744'));
    expect(priceProblem(venuePrice(parseAmount('62744.16'), tick, 'down'), 5, 'perpetual')).toBeNull();
  });

  it('across perp and spot markets of every size precision, both directions', () => {
    for (const kind of ['perpetual', 'spot'] as const) {
      for (let sz = 0; sz <= 5; sz += 1) {
        const tick = unit((kind === 'spot' ? SPOT_MAX_DECIMALS : PERP_MAX_DECIMALS) - sz);
        for (const raw of ['62744.16', '62110.885', '3012.34567', '1.2469056', '0.0123456789', '99999.95', '123456.78', '0.000012345678']) {
          const price = parseAmount(raw);
          for (const toward of ['up', 'down'] as const) {
            const out = venuePrice(price, tick, toward);
            if (out === 0n) continue; // finer than the market's tick: the caller's "no price" answer
            expect(priceProblem(out, sz, kind), `${kind} sz ${sz} ${raw} ${toward}`).toBeNull();
            expect(compare(out, price) * (toward === 'up' ? 1 : -1)).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });
});
