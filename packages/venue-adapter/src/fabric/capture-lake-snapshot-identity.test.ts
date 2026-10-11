import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { type MarketDataAdapter, type VenueBookSnapshot, type VenueDescriptor } from '@intafaced/venue-contracts';
import { CaptureLake, bookFromCapture, isCaptureBook, isCaptureHole, isQuietMarketBook } from './capture-lake.js';

const VENUE: VenueDescriptor = {
  id: 'binance-spot',
  displayName: 'Binance Spot',
  kind: 'external-cex',
  sequencedDepth: true,
};

function level(price: string, qty: string): readonly [bigint, bigint] {
  return [parseAmount(price), parseAmount(qty)] as const;
}

function snapshot(over: Partial<VenueBookSnapshot> = {}): VenueBookSnapshot {
  return {
    venueId: over.venueId ?? VENUE.id,
    symbol: over.symbol ?? 'BTC/USDT',
    bids: over.bids ?? [level('30000', '1')],
    asks: over.asks ?? [level('30002', '1')],
    sequence: over.sequence ?? 7,
    sequenced: over.sequenced ?? true,
    observedAt: over.observedAt ?? new Date('2026-08-12T00:00:00.000Z'),
  };
}

function adapter(
  snapshotBook: MarketDataAdapter['snapshotBook'],
  venue: VenueDescriptor = VENUE,
): Pick<MarketDataAdapter, 'venue' | 'snapshotBook'> {
  return { venue, snapshotBook };
}

describe('CaptureLake — snapshot instrument must match the request (L1359)', () => {
  it('snapshot symbol differs: one not_connected hole for the request, no book', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:10:00.000Z') });
    const foreign = snapshot({ symbol: 'ETH/USDT' });
    const record = await lake.captureBook(adapter(async () => foreign), 'binance-spot', 'BTC/USDT');

    expect(isCaptureHole(record)).toBe(true);
    if (!isCaptureHole(record)) return;
    expect(record.venueId).toBe('binance-spot');
    expect(record.symbol).toBe('BTC/USDT');
    expect(record.reason).toBe('not_connected');
    expect(record.detail).toBe(
      'binance-spot BTC/USDT: snapshot is binance-spot ETH/USDT — requested instrument was not stored as a book',
    );
    expect(bookFromCapture(record)).toBeNull();
    expect(foreign.symbol).toBe('ETH/USDT');
    expect(lake.records()).toEqual([record]);
    expect(lake.records().some(isCaptureBook)).toBe(false);
    expect(lake.holes()).toHaveLength(1);
  });

  it('snapshot venueId differs: one not_connected hole for the request, no book', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:10:01.000Z') });
    const foreign = snapshot({ venueId: 'bybit-spot' });
    const record = await lake.captureBook(adapter(async () => foreign), 'binance-spot', 'BTC/USDT');

    expect(isCaptureHole(record)).toBe(true);
    if (!isCaptureHole(record)) return;
    expect(record.venueId).toBe('binance-spot');
    expect(record.symbol).toBe('BTC/USDT');
    expect(record.reason).toBe('not_connected');
    expect(record.detail).toBe(
      'binance-spot BTC/USDT: snapshot is bybit-spot BTC/USDT — requested instrument was not stored as a book',
    );
    expect(lake.records()).toEqual([record]);
    expect(lake.records().some(isCaptureBook)).toBe(false);
  });

  it('matching venue and symbol still records a book', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:10:02.000Z') });
    const live = snapshot();
    const record = await lake.captureBook(adapter(async () => live), ' binance-spot ', ' BTC/USDT ');

    expect(record.kind).toBe('book');
    if (record.kind !== 'book') return;
    expect(record.snapshot).toBe(live);
    expect(record.venueId).toBe('binance-spot');
    expect(record.symbol).toBe('BTC/USDT');
    expect(live.venueId).toBe('binance-spot');
    expect(live.symbol).toBe('BTC/USDT');
    expect(lake.holes()).toHaveLength(0);
    expect(lake.records().filter(isCaptureBook)).toHaveLength(1);
  });

  it('a matching empty book still records kind book', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:10:03.000Z') });
    const empty = snapshot({ bids: [], asks: [] });
    const record = await lake.captureBook(adapter(async () => empty), 'binance-spot', 'BTC/USDT');

    expect(record.kind).toBe('book');
    expect(isQuietMarketBook(record)).toBe(true);
    expect(isCaptureHole(record)).toBe(false);
    if (record.kind !== 'book') return;
    expect(record.snapshot).toBe(empty);
    expect(record.snapshot.bids).toEqual([]);
    expect(record.snapshot.asks).toEqual([]);
    expect(lake.holes()).toHaveLength(0);
  });
});
