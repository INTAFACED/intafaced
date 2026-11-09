import { describe, expect, it } from 'vitest';
import { fakeMarket, presentCcxtMarket } from '../public-rest.js';
import { assertOpeningWindow } from './risk.js';
import { TradeError } from './types.js';

// J-cex-spot-14 #7: inside a new market's opening window a market order is refused with the window's reason, a limit
// order is accepted, and the public row names the window's end while it lasts.
describe('opening window', () => {
  const ends = new Date('2026-11-16T00:00:00.000Z');
  const inside = new Date('2026-11-09T00:00:00.000Z');
  const market = fakeMarket({ symbol: 'TOPEN/USDC', openingWindowEndsAt: ends });

  const code = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (err) {
      if (err instanceof TradeError) return err.code;
      throw err;
    }
  };

  it('refuses a market order inside the window with its reason, and accepts a limit', () => {
    expect(code(() => assertOpeningWindow(market, 'market', inside))).toBe('trade.opening_window');
    expect(() => assertOpeningWindow(market, 'market', inside)).toThrow(/opening window until 2026-11-16T00:00:00.000Z/);
    expect(code(() => assertOpeningWindow(market, 'limit', inside))).toBeNull();
  });

  it('admits a market order once the window has ended, and on a market with no window', () => {
    expect(code(() => assertOpeningWindow(market, 'market', ends))).toBeNull();
    expect(code(() => assertOpeningWindow(fakeMarket({ symbol: 'BTC/USDT' }), 'market', inside))).toBeNull();
    expect(code(() => assertOpeningWindow(fakeMarket({ openingWindowEndsAt: new Date('nope') }), 'market', inside))).toBeNull();
  });

  it('publishes the window end only while it lasts, and only on an open listing', () => {
    expect(presentCcxtMarket(market, inside.getTime()).openingWindowEndsAt).toBe('2026-11-16T00:00:00.000Z');
    expect(presentCcxtMarket(market, ends.getTime()).openingWindowEndsAt).toBeNull();
    expect(
      presentCcxtMarket(fakeMarket({ status: 'pending', openingWindowEndsAt: ends }), inside.getTime()).openingWindowEndsAt,
    ).toBeNull();
  });
});
