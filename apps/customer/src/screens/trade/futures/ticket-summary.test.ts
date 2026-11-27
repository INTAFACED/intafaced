import { describe, expect, it } from 'vitest';
import type { VenueMarket } from '../../../features/trade/venue-api';
import { ticketSummary } from './ticket-summary';

// Desk A's ticket summary: value, margin, liquidation and the opening fee, from the venue's published rules only.

const MARKET: Pick<VenueMarket, 'marginTiers' | 'maintenanceMarginRate' | 'maxLeverageBps' | 'takerFeeBps'> = {
  maxLeverageBps: 200_000,
  takerFeeBps: { known: true, value: '4.5' },
  maintenanceMarginRate: { known: false },
  marginTiers: { known: true, value: [{ fromNotional: '0', maxLeverageBps: 200_000, maintenanceRate: '0.025' }] },
};
const base = { market: MARKET, side: 'buy' as const, size: '10', entry: '100', builderFeeBps: '0.5' };

describe('ticketSummary', () => {
  it('an isolated 5x long: value, margin, liquidation and one opening fee', () => {
    // 10 @ 100 = 1000; 5x -> 200 margin; maintenance 25 -> cushion 17.5 -> 82.5; fee 1000 * 5 bps = 0.5.
    expect(ticketSummary({ ...base, position: { leverageBps: 50_000, marginMode: 'isolated' } })).toEqual({
      value: '1000',
      leverage: '5',
      margin: '200',
      liquidation: '82.5',
      fee: '0.5',
    });
  });

  it('a cross position: margin from its leverage, liquidation left to the venue (it rests on the whole account)', () => {
    const s = ticketSummary({ ...base, position: { leverageBps: 50_000, marginMode: 'cross' } });
    expect(s).toMatchObject({ margin: '200', liquidation: null });
  });

  it('no position yet: the leverage is not known, so neither margin nor liquidation is shown', () => {
    expect(ticketSummary({ ...base, position: undefined })).toEqual({
      value: '1000',
      leverage: null,
      margin: null,
      liquidation: null,
      fee: '0.5',
    });
  });

  it('no published taker rate: no fee, never a zero', () => {
    const s = ticketSummary({ ...base, market: { ...MARKET, takerFeeBps: { known: false } }, position: undefined });
    expect(s?.fee).toBeNull();
  });

  it('no entry or no size: nothing to sum', () => {
    expect(ticketSummary({ ...base, entry: null, position: undefined })).toBeNull();
    expect(ticketSummary({ ...base, size: '', position: undefined })).toBeNull();
  });
});
