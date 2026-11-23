/**
 * Connect residual public door — CaptureLake honesty through the package
 * surface (`@intafaced/venue-adapter` fabric exports), not module-private only.
 *
 * Promise (§27:762 / D-S-18): a missing / failed capture is a typed hole;
 * `bookFromCapture(hole)` is null; quiet empty books only come from a connected
 * adapter. Never substitute empty depth for absence.
 *
 * Break: fabric unit tests pass while package index omits CaptureLake, or a
 * hole collapses into `isQuietMarketBook === true`.
 *
 * Leverage: existing CaptureLake (Phase A — extend fabric, no TSDB / CCXT /
 * invented mids).
 */
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueUnavailableError, type MarketDataAdapter, type VenueBookSnapshot, type VenueDescriptor } from '@intafaced/venue-contracts';
import * as pkg from '../index.js';
import { CaptureLake, bookFromCapture, isCaptureHole, isQuietMarketBook, midFromCapture } from './capture-lake.js';
import * as fabric from './index.js';

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
    venueId: VENUE.id,
    symbol: 'BTC/USDT',
    bids: over.bids ?? [level('30000', '1')],
    asks: over.asks ?? [level('30002', '1')],
    sequence: over.sequence ?? 7,
    sequenced: over.sequenced ?? true,
    observedAt: over.observedAt ?? new Date('2026-08-12T00:00:00.000Z'),
  };
}

function adapter(snapshotBook: MarketDataAdapter['snapshotBook']): Pick<MarketDataAdapter, 'venue' | 'snapshotBook'> {
  return { venue: VENUE, snapshotBook };
}

describe('Connect CaptureLake public door — package export honesty', () => {
  it('exports CaptureLake + hole readers on the package index', () => {
    expect(typeof CaptureLake).toBe('function');
    expect(typeof bookFromCapture).toBe('function');
    expect(typeof isCaptureHole).toBe('function');
    expect(typeof isQuietMarketBook).toBe('function');
    expect(typeof midFromCapture).toBe('function');
  });

  it('null adapter → hole on the package surface; bookFromCapture is null (not quiet)', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T15:00:00.000Z') });
    const record = await lake.captureBook(null, 'binance-spot', 'BTC/USDT');

    expect(isCaptureHole(record)).toBe(true);
    expect(bookFromCapture(record)).toBeNull();
    expect(isQuietMarketBook(record)).toBe(false);
    expect(midFromCapture(record)).toBeNull();
    expect(lake.holes()).toHaveLength(1);
  });

  it('connected empty book is quiet-market BOOK — distinct from absence', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T15:00:01.000Z') });
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

  it('VenueUnavailableError → typed hole, never synthetic empty depth', async () => {
    const lake = new CaptureLake({ now: () => new Date('2026-08-12T15:00:02.000Z') });
    const record = await lake.captureBook(
      adapter(async () => {
        throw new VenueUnavailableError('binance-spot', 'unreachable', 'socket closed — public door');
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
});

describe('Connect CaptureLake � package index export seal', () => {
  it('fabric/index and the package entry export capture-lake itself (public door)', async () => {
    for (const door of [fabric, pkg]) {
      expect(door.CaptureLake).toBe(CaptureLake);
      expect(door.bookFromCapture).toBe(bookFromCapture);
      expect(door.isCaptureHole).toBe(isCaptureHole);
      expect(door.isQuietMarketBook).toBe(isQuietMarketBook);
      expect(door.midFromCapture).toBe(midFromCapture);
    }
    const lake = new pkg.CaptureLake({ now: () => new Date('2026-08-12T15:00:03.000Z') });
    const record = await lake.captureBook(null, 'binance-spot', 'BTC/USDT');
    expect(pkg.isCaptureHole(record)).toBe(true);
    expect(pkg.bookFromCapture(record)).toBeNull();
  });
});
