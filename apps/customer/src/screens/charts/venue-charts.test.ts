import { describe, expect, it } from 'vitest';
import type { VenueChartMarket } from '@intafaced/contracts/trade-venue-door';
import type { Candle } from '../../data/types';
import { toVenueDeskMarket, venueLifecycleState, venueStatusInputs } from './venue-charts';
import { intervalFromSearch, unofferedInterval } from './workbench';

const market = (overrides: Partial<VenueChartMarket> = {}): VenueChartMarket => ({
  symbol: 'BTC-USDC',
  kind: 'spot',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  tickSize: '1',
  lotSize: '0.0001',
  minOrderNotional: '10',
  status: 'trading',
  listing: { routing: 'show' },
  ...overrides,
});

describe('venue charts helpers (J-charts-desk-01)', () => {
  it('maps venue market status and listing routing into DeskMarket rules', () => {
    expect(toVenueDeskMarket(market())).toMatchObject({
      symbol: 'BTC-USDC',
      base: 'BTC',
      quote: 'USDC',
      tickSize: '1',
      lotSize: '0.0001',
      minCost: '10',
      open: true,
      state: 'OPEN',
    });
    expect(venueLifecycleState(market({ status: 'halted' }))).toBe('HALTED');
    expect(venueLifecycleState(market({ listing: { routing: 'stop' } }))).toBe('HALTED');
    expect(venueLifecycleState(market({ status: 'cancel_only' }))).toBe('CANCEL_ONLY');
    expect(venueLifecycleState(market({ listing: { routing: 'close_only' } }))).toBe('REDUCE_ONLY');
    expect(venueLifecycleState(market({ listing: { routing: 'show', delisted: true } }))).toBe('DELISTED');
    expect(toVenueDeskMarket(market({ status: 'halted' })).open).toBe(false);
  });

  it('builds status inputs from venue state and newest non-filled candle without engine calls', () => {
    const bars: Candle[] = [
      { t: 1_000, o: '60000', h: '60100', l: '59900', c: '60050', v: '1', filled: false },
      { t: 61_000, o: '60050', h: '60050', l: '60050', c: '60050', v: '0', filled: true },
    ];
    const inputs = venueStatusInputs(
      {
        kind: 'venue',
        venueId: 'test-venue-sim',
        venueName: 'TEST venue simulator',
        test: true,
        intervals: ['1m', '15m', '1h'],
        asOf: 100_000,
        markets: [market()],
      },
      'BTC-USDC',
      { status: 'ready', data: bars, asOf: 100_000 },
      100_000,
    );
    expect(inputs.lifecycle).toMatchObject({ status: 'ready', data: { state: 'OPEN', evidenceRefs: ['local-test:venue:test-venue-sim'] } });
    expect(inputs.bookHalt).toMatchObject({ status: 'ready', data: { halted: false, venueHalted: false } });
    expect(inputs.lastTrade).toMatchObject({ status: 'ready', data: 1_000 });
  });

  it('refuses an interval the venue feed does not offer', () => {
    expect(intervalFromSearch('?interval=1h', ['1m', '15m'])).toBeUndefined();
    expect(unofferedInterval('?interval=1h', ['1m', '15m'])).toBe('1h');
    expect(unofferedInterval('?interval=3d', ['1m', '15m', '1h'])).toBe('3d');
    expect(intervalFromSearch('?interval=15m', ['1m', '15m'])).toBe('15m');
    expect(unofferedInterval('?interval=15m', ['1m', '15m'])).toBeUndefined();
  });
});
