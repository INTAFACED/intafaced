import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueUnavailableError, type MarketDataAdapter, type VenueBookSnapshot, type VenueDescriptor } from '@intafaced/venue-contracts';
import { CaptureLake, bookFromCapture, isCaptureHole, isQuietMarketBook, midFromCapture } from './capture-lake.js';

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

describe('CaptureLake — hole vs quiet market (D-S-18 / connect.data-lake)', () => {
  it('null adapter records a not_connected hole, never an empty book', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:00:00.000Z') });
    const record = await lake.captureBook(null, 'binance-spot', 'BTC/USDT');

    expect(isCaptureHole(record)).toBe(true);
    if (!isCaptureHole(record)) return;
    expect(record.reason).toBe('not_connected');
    expect(record.detail).toMatch(/absent in capture/);
    expect(bookFromCapture(record)).toBeNull();
    expect(isQuietMarketBook(record)).toBe(false);
    expect(midFromCapture(record)).toBeNull();
    expect(lake.holes()).toHaveLength(1);
  });

  it('connected empty book is a quiet-market BOOK fact, not a hole', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:00:01.000Z') });
    const empty = snapshot({ bids: [], asks: [] });
    const record = await lake.captureBook(
      adapter(async () => empty),
      'binance-spot',
      'BTC/USDT',
    );

    expect(record.kind).toBe('book');
    expect(isQuietMarketBook(record)).toBe(true);
    expect(bookFromCapture(record)).toEqual(empty);
    expect(midFromCapture(record)).toBeNull();
    expect(lake.holes()).toHaveLength(0);
  });

  it('VenueUnavailableError becomes a typed hole (unreachable), not empty depth', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:00:02.000Z') });
    const record = await lake.captureBook(
      adapter(async () => {
        throw new VenueUnavailableError('binance-spot', 'unreachable', 'socket closed');
      }),
      'binance-spot',
      'BTC/USDT',
    );

    expect(isCaptureHole(record)).toBe(true);
    if (!isCaptureHole(record)) return;
    expect(record.reason).toBe('unreachable');
    expect(bookFromCapture(record)).toBeNull();
    expect(isQuietMarketBook(record)).toBe(false);
  });

  it('no_depth (dust refuse) is a hole — still not a synthetic empty book', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:00:03.000Z') });
    const record = await lake.captureBook(
      adapter(async () => {
        throw new VenueUnavailableError('binance-spot', 'no_depth', 'binance-spot BTC/USDT: book is not payout-grade');
      }),
      'binance-spot',
      'BTC/USDT',
    );

    expect(isCaptureHole(record)).toBe(true);
    if (!isCaptureHole(record)) return;
    expect(record.reason).toBe('no_depth');
    expect(bookFromCapture(record)).toBeNull();
  });

  it('unexpected throw is capture_failed hole (named), never empty book', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:00:04.000Z') });
    const record = await lake.captureBook(
      adapter(async () => {
        throw new Error('boom');
      }),
      'binance-spot',
      'BTC/USDT',
    );

    expect(isCaptureHole(record)).toBe(true);
    if (!isCaptureHole(record)) return;
    expect(record.reason).toBe('capture_failed');
    expect(record.detail).toBe('boom');
  });

  it('adapter venue id mismatch is not_connected — refuses wrong stamp', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:00:05.000Z') });
    const record = await lake.captureBook(
      adapter(async () => snapshot(), { ...VENUE, id: 'bybit-spot', displayName: 'Bybit Spot' }),
      'binance-spot',
      'BTC/USDT',
    );

    expect(isCaptureHole(record)).toBe(true);
    if (!isCaptureHole(record)) return;
    expect(record.reason).toBe('not_connected');
    expect(record.detail).toMatch(/adapter venue is bybit-spot/);
  });

  it('successful two-sided book is recorded as book and readable as such', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:00:06.000Z') });
    const live = snapshot();
    const record = await lake.captureBook(
      adapter(async () => live),
      'binance-spot',
      'BTC/USDT',
    );

    expect(record.kind).toBe('book');
    expect(bookFromCapture(record)).toBe(live);
    expect(isQuietMarketBook(record)).toBe(false);
  });

  it('holes stay in the log — omission would look like a quiet window', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:00:07.000Z') });
    await lake.captureBook(null, 'binance-spot', 'ETH/USDT');
    await lake.captureBook(
      adapter(async () => snapshot({ symbol: 'ETH/USDT', bids: [], asks: [] })),
      'binance-spot',
      'ETH/USDT',
    );

    const all = lake.records();
    expect(all).toHaveLength(2);
    expect(all[0]!.kind).toBe('hole');
    expect(all[1]!.kind).toBe('book');
    expect(isQuietMarketBook(all[1]!)).toBe(true);
    // A reader that ignored holes would see only the empty book and invent continuity.
    expect(lake.holes()).toHaveLength(1);
  });

  it('recordHole is explicit and bookFromCapture never synthesises depth', () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T12:00:08.000Z') });
    const hole = lake.recordHole('bybit-spot', 'BTC/USDT', 'rate_limited', 'governor held');
    expect(hole.kind).toBe('hole');
    expect(bookFromCapture(hole)).toBeNull();
    expect(isQuietMarketBook(hole)).toBe(false);
  });
});
