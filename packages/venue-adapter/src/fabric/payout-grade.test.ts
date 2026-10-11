import { describe, expect, it } from 'vitest';
import { MoneyError, parseAmount } from '@intafaced/ledger-client/money';
import { VenueUnavailableError, type VenueBookSnapshot } from '@intafaced/venue-contracts';
import {
  DEFAULT_MIN_BEST_LEVEL_NOTIONAL,
  assertPayoutGradeBook,
  bestLevelMeetsPayoutFloor,
  isPayoutGradeBook,
  levelNotional,
  minBestLevelNotional,
} from './payout-grade.js';

const SCALE = 10n ** 18n;
const FLOOR_100 = { minBestLevelNotional: '100' } as const;

function level(price: string, qty: string): readonly [bigint, bigint] {
  return [parseAmount(price), parseAmount(qty)] as const;
}

function snapshot(
  over: {
    bids?: VenueBookSnapshot['bids'];
    asks?: VenueBookSnapshot['asks'];
  } = {},
): VenueBookSnapshot {
  return {
    venueId: 'binance-spot',
    symbol: 'BTC/USDT',
    bids: over.bids ?? [level('30000', '2')],
    asks: over.asks ?? [level('30002', '1')],
    sequence: 1,
    sequenced: true,
    observedAt: new Date(0),
  };
}

describe('DEFAULT_MIN_BEST_LEVEL_NOTIONAL — one number with mark-from-depth', () => {
  it('is the DIRECTION §8 absolute floor string, not a second ruling', () => {
    // Must stay equal to services/svc-trade/.../mark-from-depth.ts.
    expect(DEFAULT_MIN_BEST_LEVEL_NOTIONAL).toBe('100');
  });

  it('refuses an omitted or nullish floor instead of applying the stand-in', () => {
    expect(() => minBestLevelNotional()).toThrow(MoneyError);
    expect(() => minBestLevelNotional({})).toThrow(MoneyError);
    expect(() => minBestLevelNotional({ minBestLevelNotional: null })).toThrow(MoneyError);
    expect(() => bestLevelMeetsPayoutFloor(level('100', '1'))).toThrow(MoneyError);
    expect(() => assertPayoutGradeBook(snapshot())).toThrow(MoneyError);
  });

  it('refuses an unreadable floor and keeps an explicit decimal', () => {
    expect(() => minBestLevelNotional({ minBestLevelNotional: 'not-a-decimal' })).toThrow(MoneyError);
    expect(minBestLevelNotional({ minBestLevelNotional: '100' })).toBe(parseAmount('100'));
    expect(minBestLevelNotional({ minBestLevelNotional: '250' })).toBe(parseAmount('250'));
  });
});

describe('levelNotional / bestLevelMeetsPayoutFloor', () => {
  it('computes quote notional without floats', () => {
    // 30000 × 0.01 = 300
    expect(levelNotional(parseAmount('30000'), parseAmount('0.01'))).toBe(parseAmount('300'));
  });

  it('refuses dust that is fifteen orders of magnitude under the floor', () => {
    // Two 1-wei notionals — the measured exploit shape.
    const dust = [1n, 1n] as const;
    expect(levelNotional(dust[0], dust[1])).toBe(0n); // (1*1)/1e18 truncates to 0
    expect(bestLevelMeetsPayoutFloor(dust, FLOOR_100)).toBe(false);
  });

  it('accepts a level exactly at the floor', () => {
    // price 100, qty 1 → notional 100
    expect(bestLevelMeetsPayoutFloor(level('100', '1'), FLOOR_100)).toBe(true);
    // just under
    expect(bestLevelMeetsPayoutFloor([(100n * SCALE) / 2n, 1n], FLOOR_100)).toBe(false);
  });
});

describe('assertPayoutGradeBook', () => {
  it('passes a thick two-sided book through unchanged', () => {
    const snap = snapshot();
    expect(assertPayoutGradeBook(snap, FLOOR_100)).toBe(snap);
    expect(isPayoutGradeBook(snap, FLOOR_100)).toBe(true);
  });

  it('passes an EMPTY book through — absence is a fact, not a dust quote', () => {
    const snap = snapshot({ bids: [], asks: [] });
    expect(assertPayoutGradeBook(snap)).toBe(snap);
    expect(isPayoutGradeBook(snap)).toBe(false);
  });

  it('passes a ONE-SIDED book through — caller refuses the mid, adapter does not invent', () => {
    const snap = snapshot({ asks: [] });
    expect(assertPayoutGradeBook(snap)).toBe(snap);
    expect(isPayoutGradeBook(snap)).toBe(false);
  });

  it('REFUSES a two-sided dust book rather than serving a mid-able quote', () => {
    const snap = snapshot({
      bids: [[1n, 1n]],
      asks: [[2n, 1n]],
    });
    expect(isPayoutGradeBook(snap, FLOOR_100)).toBe(false);
    try {
      assertPayoutGradeBook(snap, FLOOR_100);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      expect((error as VenueUnavailableError).reason).toBe('no_depth');
      expect((error as VenueUnavailableError).message).toMatch(/not payout-grade/);
      expect((error as VenueUnavailableError).message).toMatch(/D26-P1-T8/);
    }
  });

  it('REFUSES when only one side is below the floor', () => {
    const snap = snapshot({
      bids: [level('30000', '2')], // thick
      asks: [level('30002', '0.000001')], // ~0.03 quote — under 100
    });
    try {
      assertPayoutGradeBook(snap, FLOOR_100);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      expect((error as VenueUnavailableError).reason).toBe('no_depth');
    }
  });

  it('honours an explicit higher floor without inventing a second default constant', () => {
    const snap = snapshot({
      bids: [level('100', '1')], // notional 100
      asks: [level('100', '1')],
    });
    expect(assertPayoutGradeBook(snap, FLOOR_100)).toBe(snap);
    expect(() => assertPayoutGradeBook(snap, { minBestLevelNotional: '101' })).toThrow(/not payout-grade/);
  });
});
