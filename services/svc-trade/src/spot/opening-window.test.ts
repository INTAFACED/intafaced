import { describe, expect, it } from 'vitest';
import { assertOutsideOpeningWindow } from './risk.js';
import { TradeError } from './types.js';
import { fakeMarket, openingWindowEndsAtOf, presentCcxtMarket } from '../public-rest.js';

// J-cex-spot-14 #7 (SP-markets-data-02): a new listing inside its opening window takes limit orders only.
describe('opening window', () => {
  const ends = new Date('2026-12-01T00:00:00.000Z');
  const inside = new Date('2026-11-20T00:00:00.000Z');
  const market = { symbol: 'TWIN/USDC', openingWindowEndsAt: ends };

  const refusal = (type: string, at: Date, m: Parameters<typeof assertOutsideOpeningWindow>[0] = market) => {
    try {
      assertOutsideOpeningWindow(m, type, at);
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(TradeError);
      return (error as TradeError).code;
    }
  };

  it('refuses a market order and either stop inside the window, before any hold, and takes a limit', () => {
    expect(refusal('market', inside)).toBe('trade.opening_window');
    expect(refusal('stop_limit', inside)).toBe('trade.opening_window');
    expect(refusal('stop', inside)).toBe('trade.opening_window');
    expect(refusal('limit', inside)).toBeNull();
  });

  it('restricts nothing once the window has ended, at its last instant too, or when there is none', () => {
    expect(refusal('market', ends)).toBeNull();
    expect(refusal('market', new Date(ends.getTime() + 1))).toBeNull();
    expect(refusal('market', new Date(ends.getTime() - 1))).toBe('trade.opening_window');
    expect(refusal('market', inside, { symbol: 'BTC/USDT', openingWindowEndsAt: null })).toBeNull();
    expect(refusal('market', inside, { symbol: 'BTC/USDT' })).toBeNull();
    expect(refusal('market', inside, { symbol: 'BTC/USDT', openingWindowEndsAt: new Date('not a date') })).toBeNull();
  });

  it('publishes the end of the window only while it is ahead', () => {
    expect(openingWindowEndsAtOf(market, inside.getTime())).toBe(ends.toISOString());
    expect(openingWindowEndsAtOf(market, ends.getTime())).toBeNull();
    expect(openingWindowEndsAtOf({ openingWindowEndsAt: null }, inside.getTime())).toBeNull();
    const row = presentCcxtMarket(fakeMarket({ symbol: 'TWIN/USDC', openingWindowEndsAt: ends }), inside.getTime());
    expect(row.openingWindowEndsAt).toBe(ends.toISOString());
    expect(presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT' }), inside.getTime()).openingWindowEndsAt).toBeNull();
  });
});
