import { describe, expect, it } from 'vitest';
import { planOmsArbAtomicLegs } from './oms-arb-plan-legs.js';

describe('planOmsArbAtomicLegs', () => {
  it('plans buy+sell legs when both venues are pre-positioned', () => {
    expect(
      planOmsArbAtomicLegs({
        symbol: 'BTC/USDT',
        amount: '1',
        buyVenueId: 'binance',
        sellVenueId: 'bybit',
        inventory: { prePositionedByVenue: { binance: true, bybit: true } },
      }),
    ).toMatchObject({
      ok: true,
      atomic: false,
      legs: [
        { side: 'buy', venueId: 'binance' },
        { side: 'sell', venueId: 'bybit' },
      ],
    });
  });

  it('refuses when inventory is missing on either leg', () => {
    expect(
      planOmsArbAtomicLegs({
        symbol: 'BTC/USDT',
        amount: '1',
        buyVenueId: 'binance',
        sellVenueId: 'bybit',
        inventory: { prePositionedByVenue: { binance: true, bybit: false } },
      }),
    ).toMatchObject({ ok: false, reason: 'inventory_missing' });
  });

  it('refuses a blank, non-numeric, or non-positive amount instead of copying it onto the legs', () => {
    for (const amount of ['', '   ', 'not-a-number', '0', '-1']) {
      expect(
        planOmsArbAtomicLegs({
          symbol: 'BTC/USDT',
          amount,
          buyVenueId: 'binance',
          sellVenueId: 'bybit',
          inventory: { prePositionedByVenue: { binance: true, bybit: true } },
        }),
      ).toMatchObject({ ok: false, reason: 'invalid_amount' });
    }
  });
});
