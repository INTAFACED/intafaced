import { describe, expect, it, vi } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { VenueBookSnapshot } from '@intafaced/venue-contracts';
import { createOtcMidSourceFromConfig, createVenueOtcMidSource } from './venue-mid-source.js';

const NOW = new Date('2026-08-14T12:00:00.000Z');

function venueBook(input: {
  bid?: readonly [string, string] | null;
  ask?: readonly [string, string] | null;
  observedAt?: Date;
}): VenueBookSnapshot {
  const side = (l: readonly [string, string] | null | undefined) =>
    l ? ([[parseAmount(l[0]), parseAmount(l[1])]] as [bigint, bigint][]) : ([] as [bigint, bigint][]);
  return {
    venueId: 'test-venue',
    symbol: 'BTC/USDT',
    bids: side(input.bid),
    asks: side(input.ask),
    sequence: 1,
    sequenced: true,
    observedAt: input.observedAt ?? new Date(NOW.getTime() - 1_000),
  };
}

const healthyBook = () => venueBook({ bid: ['100', '5'], ask: ['102', '5'] });

describe('createVenueOtcMidSource', () => {
  it('returns mid + venue observedAt; null when unmapped or one-sided', async () => {
    const observedAt = new Date(NOW.getTime() - 2_000);
    const adapter = { snapshotBook: vi.fn(async () => venueBook({ bid: ['100', '5'], ask: ['102', '5'], observedAt })) };
    const src = createVenueOtcMidSource({
      adapter,
      resolveSymbol: (pair) => (pair === 'BTC/USDT' ? 'BTC/USDT' : null),
    });
    expect(await src('BTC/USDT')).toEqual({ mid: '101', asOf: observedAt });
    expect(await src('ETH/USDT')).toBeNull();
    expect(adapter.snapshotBook).toHaveBeenCalledTimes(1);

    const empty = createVenueOtcMidSource({
      adapter: { snapshotBook: async () => venueBook({ bid: ['100', '5'], ask: null }) },
      resolveSymbol: () => 'BTC/USDT',
    });
    expect(await empty('BTC/USDT')).toBeNull();
  });

  it('refuses a snapshot with no observedAt rather than stamping the read clock', async () => {
    const { observedAt: _dropped, ...rest } = healthyBook();
    const adapter = { snapshotBook: async () => rest as VenueBookSnapshot };
    const src = createVenueOtcMidSource({ adapter, resolveSymbol: () => 'BTC/USDT' });
    expect(await src('BTC/USDT')).toBeNull();
  });

  it('venue error → null (never invent)', async () => {
    const src = createVenueOtcMidSource({
      adapter: {
        snapshotBook: async () => {
          throw new Error('rate-limit');
        },
      },
      resolveSymbol: () => 'BTC/USDT',
    });
    expect(await src('BTC/USDT')).toBeNull();
  });
});

describe('createVenueOtcMidSource from MaintainedBook port', () => {
  const twoSided = {
    bestBid: parseAmount('100'),
    bestAsk: parseAmount('102'),
    bestBidQty: parseAmount('5'),
    bestAskQty: parseAmount('5'),
    spread: parseAmount('2'),
    mid: parseAmount('101'),
  };
  const observedAt = new Date(NOW.getTime() - 2_000);

  it('mids a servable sequenced top and does not poll snapshotBook', async () => {
    const snapshotBook = vi.fn(async () => healthyBook());
    const src = createVenueOtcMidSource({
      adapter: { snapshotBook },
      resolveSymbol: () => 'BTC/USDT',
      bookForSymbol: () => ({
        servable: true,
        top: () => twoSided,
        observedAt: () => observedAt,
      }),
    });
    expect(await src('BTC/USDT')).toEqual({ mid: '101', asOf: observedAt });
    expect(snapshotBook).not.toHaveBeenCalled();
  });

  it('withholds while the feed is desynced — never invents an OTC mid from a gap', async () => {
    const src = createVenueOtcMidSource({
      adapter: { snapshotBook: vi.fn(async () => healthyBook()) },
      resolveSymbol: () => 'BTC/USDT',
      bookForSymbol: () => ({
        servable: false,
        top: () => twoSided,
        observedAt: () => observedAt,
      }),
    });
    expect(await src('BTC/USDT')).toBeNull();
  });
});

describe('createOtcMidSourceFromConfig', () => {
  it('flag off or no adapter → boot map, not live', async () => {
    const boot = createOtcMidSourceFromConfig({
      midsEnv: 'BTC/USDT:65000',
      midFromVenue: false,
      venueAdapter: { snapshotBook: vi.fn() },
      venueSymbols: 'BTC/USDT:BTC/USDT',
    });
    expect(boot.liveObservationFeed).toBe(false);
    const quoted = await boot.source('BTC/USDT');
    expect(quoted?.mid).toBe('65000');

    const noAdapter = createOtcMidSourceFromConfig({
      midsEnv: 'BTC/USDT:65000',
      midFromVenue: true,
      venueAdapter: null,
      venueSymbols: 'BTC/USDT:BTC/USDT',
    });
    expect(noAdapter.liveObservationFeed).toBe(false);
  });

  it('flag on + adapter → live feed; empty symbol map never invents; boot map is not a fallback', async () => {
    const adapter = { snapshotBook: vi.fn(async () => healthyBook()) };
    const live = createOtcMidSourceFromConfig({
      midsEnv: 'BTC/USDT:1',
      midFromVenue: true,
      venueAdapter: adapter,
      venueSymbols: 'BTC/USDT:BTC/USDT',
    });
    expect(live.liveObservationFeed).toBe(true);
    const quoted = await live.source('BTC/USDT');
    expect(quoted?.mid).toBe('101');
    expect(quoted?.asOf).toEqual(healthyBook().observedAt);

    const unmapped = createOtcMidSourceFromConfig({
      midsEnv: 'ETH/USDT:3000',
      midFromVenue: true,
      venueAdapter: adapter,
      venueSymbols: '',
    });
    expect(await unmapped.source('ETH/USDT')).toBeNull();
  });
});
