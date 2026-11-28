import { describe, expect, it } from 'vitest';
import { compare, parseAmount } from '@intafaced/ledger-client/money';
import { PERP_MAX_DECIMALS, priceProblem, SPOT_MAX_DECIMALS, unit } from '@intafaced/venue-hyperliquid';
import { venueBoundPrice } from './venue-price.js';

const a = parseAmount;

// The venue adapter's own check (the one that answered the beta "price 62744.2 has 6 significant figures") takes
// every worst price svc-trade computes, on every market shape, and each stays beyond the price it was computed from.
describe('venueBoundPrice: every computed worst price is one the venue takes', () => {
  it('BTC-PERP (szDecimals 5, tick 0.1) at the beta’s refused price', () => {
    const tick = unit(PERP_MAX_DECIMALS - 5);
    expect(priceProblem(a('62744.2'), 5, 'perpetual')).toMatch(/6 significant figures/);
    const bound = venueBoundPrice('buy', { moved: a('62744.16'), reference: a('62432'), tick });
    expect(bound).toBe(a('62744'));
    expect(priceProblem(bound, 5, 'perpetual')).toBeNull();
  });

  it('across perp and spot markets of every size precision, caps from 1 to 500 bps, both sides', () => {
    for (const kind of ['perpetual', 'spot'] as const) {
      for (let sz = 0; sz <= 5; sz += 1) {
        const tick = unit((kind === 'spot' ? SPOT_MAX_DECIMALS : PERP_MAX_DECIMALS) - sz);
        for (const ref of ['62432', '3012.34', '10', '1.2345', '0.012345', '99999', '123456']) {
          if (a(ref) % tick !== 0n) continue; // a best price is always on its own market's tick
          for (const bps of [1n, 5n, 50n, 500n]) {
            for (const side of ['buy', 'sell'] as const) {
              const reference = a(ref);
              const one = a('10000');
              const ratio = a(bps.toString());
              const moved = side === 'buy' ? (reference * (one + ratio)) / one : (reference * (one - ratio)) / one;
              const out = venueBoundPrice(side, { moved, reference, tick });
              const label = `${kind} sz ${sz} ${ref} ${bps}bps ${side} → ${out}`;
              expect(priceProblem(out, sz, kind), label).toBeNull();
              // Beyond the reference, so the order has room; at most one price step past the cap.
              expect(compare(out, reference) * (side === 'buy' ? 1 : -1), label).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });
});
