import { describe, expect, it } from 'vitest';
import {
  buildLadder,
  createPriceWalk,
  crossingSide,
  tapeWindow as historyTimes,
  TEST_PRICES,
} from '../../../../tooling/scripts/local-test-market.mjs';
import { MAX_AGE_HOURS } from '../../../../tooling/scripts/local-test-snapshot.mjs';
import { RESAMPLE_WINDOW_MINUTES, roundTrips } from './resample-window.mjs';

// J-algo-dev-16 #3's window against the TEST chart history a shard's stack holds, with no live trade at all (the market
// held still): the window must hold the 3 round trips #3 waits for however old the stack's seeding is. Flaky issues
// #10475, #10498 and #10607: a 60-minute window held none of the history once the stack was over an hour old.

const MINUTE = 60_000;
const SCALE = 100_000_000n;
const scaled = (s) => {
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * SCALE + BigInt((frac + '00000000').slice(0, 8));
};
// What `history` writes by default (local-test-market.mjs parseArgs): seed 1013, 210 bars of 15 minutes, 2 trades each.
const SEED = '1013';
const BARS = 210;
const STEP_MS = 15 * MINUTE;
const PER_BAR = 2;
// The oldest seeding a step can see: a snapshot up to MAX_AGE_HOURS old when the build job takes it, then the shard's
// setup and its journeys (the shard's hour, JOURNEY_GLOBAL_TIMEOUT_MS in real-app-journeys.yml), with room.
const OLDEST_MINUTES = MAX_AGE_HOURS * 60 + 120;
// The maker may walk some steps before `history` runs (the walk file carries them), so the history may start further on.
const WALK_OFFSETS = 200;

/** The prices of BTC/USDT's history trades, in order, as `history` places them: the maker's quote the taker crosses. */
function historyPrices({ offset, tick }) {
  const walk = createPriceWalk({ seed: SEED, symbol: 'BTC/USDT', startScaled: scaled(TEST_PRICES['BTC/USDT'].start), tickScaled: tick });
  walk.advance(offset);
  const prices = [];
  for (let n = 1; n <= BARS * PER_BAR; n += 1) {
    const maker = crossingSide(n) === 'buy' ? 'sell' : 'buy';
    const [level] = buildLadder({
      mid: walk.next(),
      tick,
      lot: scaled('0.00001'),
      minAmount: scaled('0.00001'),
      minCost: scaled('1'),
      levels: 1,
      halfSpreadBps: 6n,
      stepBps: 9n,
      levelNotional: scaled(TEST_PRICES['BTC/USDT'].notional),
    }).filter((q) => q.side === maker);
    prices.push(level.price);
  }
  return prices;
}

/** The 1m bars those trades make once retimed into the past of a stack seeded at `seededAt`: one trade, one bar. */
function historyBars(prices, seededAt) {
  const { startMs, stepMs } = historyTimes({ nowMs: seededAt, trades: prices.length, stepMs: STEP_MS, perBar: PER_BAR });
  return prices.map((price, i) => [startMs + i * stepMs, price, price, price, price, '0']);
}

describe('J-algo-dev-16 #3 window', () => {
  it('holds 3 round trips of the history alone, for every stack age a step can see', () => {
    // A step at a whole minute; the window is [now - minutes, now), closed bars only (tape.mjs tapeWindow).
    const now = Date.parse('2026-11-24T03:55:00Z');
    let fewest = { trips: Infinity };
    for (const tick of [scaled('0.01'), scaled('1')]) {
      for (let offset = 0; offset <= WALK_OFFSETS; offset += 1) {
        const prices = historyPrices({ offset, tick });
        for (let age = 0; age <= OLDEST_MINUTES; age += 1) {
          const bars = historyBars(prices, now - age * MINUTE);
          const inWindow = bars.filter(([at]) => at >= now - RESAMPLE_WINDOW_MINUTES * MINUTE && at + MINUTE <= now);
          const trips = roundTrips(inWindow);
          if (trips < fewest.trips) fewest = { trips, age, offset, tick: String(tick), bars: inWindow.length };
        }
      }
    }
    expect(fewest.trips, JSON.stringify(fewest)).toBeGreaterThanOrEqual(3);
  });
});
