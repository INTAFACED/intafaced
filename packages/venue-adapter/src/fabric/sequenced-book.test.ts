import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import type { VenueBookDelta, VenueBookSnapshot } from '@intafaced/venue-contracts';
import { SequencedBookTracker } from './sequenced-book.js';

const VENUE = 'binance-spot';
const SYMBOL = 'BTC/USDT';
const AT = new Date('2026-07-30T12:00:00Z');

function snapshot(sequence: number, overrides: Partial<VenueBookSnapshot> = {}): VenueBookSnapshot {
  return {
    venueId: VENUE,
    symbol: SYMBOL,
    bids: [
      [parseAmount('30000'), parseAmount('2')],
      [parseAmount('29999'), parseAmount('5')],
    ],
    asks: [
      [parseAmount('30002'), parseAmount('1')],
      [parseAmount('30003'), parseAmount('4')],
    ],
    sequence,
    sequenced: true,
    observedAt: AT,
    ...overrides,
  };
}

function delta(
  firstSequence: number,
  lastSequence: number,
  levels: { bids?: [string, string][]; asks?: [string, string][] } = {},
): VenueBookDelta {
  return {
    venueId: VENUE,
    symbol: SYMBOL,
    sequence: { firstSequence, lastSequence },
    bids: levels.bids ?? [],
    asks: levels.asks ?? [],
    observedAt: AT,
  };
}

describe('SequencedBookTracker — the book withholds itself rather than lie', () => {
  it('starts awaiting a snapshot and serves nothing', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    expect(tracker.state).toBe('awaiting-snapshot');
    expect(tracker.servable).toBe(false);
    expect(tracker.book()).toBeNull();
    expect(tracker.top()).toBeNull();
    expect(tracker.needsSnapshot()).toBe(true);
    expect(tracker.sequence).toBe(-1);
  });

  it('goes live on a snapshot and reads its top', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    expect(tracker.onSnapshot(snapshot(100)).kind).toBe('applied');
    expect(tracker.servable).toBe(true);
    expect(tracker.sequence).toBe(100);

    const top = tracker.top()!;
    expect(formatAmount(top.bestBid!)).toBe('30000');
    expect(formatAmount(top.bestAsk!)).toBe('30002');
    expect(formatAmount(top.mid!)).toBe('30001');
  });

  it('refuses a sequenced snapshot that is behind the book already held', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    expect(
      tracker.onSnapshot(
        snapshot(200, {
          bids: [[parseAmount('31000'), parseAmount('1')]],
        }),
      ).kind,
    ).toBe('applied');
    expect(tracker.state).toBe('live');
    expect(tracker.sequence).toBe(200);

    const outcome = tracker.onSnapshot(snapshot(100));

    expect(outcome.kind).toBe('snapshot-stale');
    expect(tracker.state).toBe('live');
    expect(tracker.servable).toBe(true);
    expect(tracker.book()).not.toBeNull();
    expect(tracker.sequence).toBe(200);
    expect(formatAmount(tracker.top()!.bestBid!)).toBe('31000');
  });

  it('re-seeds when a sequenced snapshot matches the sequence already held', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));

    const outcome = tracker.onSnapshot(
      snapshot(100, {
        bids: [[parseAmount('31000'), parseAmount('1')]],
      }),
    );

    expect(outcome.kind).toBe('applied');
    expect(tracker.sequence).toBe(100);
    expect(formatAmount(tracker.top()!.bestBid!)).toBe('31000');
  });

  it('applies a contiguous delta and advances the sequence', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));

    const outcome = tracker.onDelta(delta(101, 101, { bids: [['30001', '3']] }));
    expect(outcome).toEqual({ kind: 'applied', state: 'live', sequence: 101 });
    expect(formatAmount(tracker.top()!.bestBid!)).toBe('30001');
  });

  // ── The property the whole file exists for ──────────────────────────────

  it('DESYNCS on a gap and withholds the book — it does not patch over it', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));
    tracker.onDelta(delta(101, 101, { bids: [['30001', '3']] }));

    // 102 never arrives.
    const outcome = tracker.onDelta(delta(103, 103, { bids: [['30005', '9']] }));

    expect(outcome.kind).toBe('desynced');
    expect(outcome.kind === 'desynced' && outcome.reason).toBe('gap');
    expect(tracker.state).toBe('desynced');
    expect(tracker.servable).toBe(false);
    // The book is gone, not stale-but-served. This is the assertion that matters.
    expect(tracker.book()).toBeNull();
    expect(tracker.top()).toBeNull();
    expect(tracker.levels('bids')).toEqual([]);
    expect(tracker.needsSnapshot()).toBe(true);
    expect(tracker.lastDesync?.reason).toBe('gap');
  });

  it('the gapped delta is NOT applied — the missed update cannot leak in', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));
    tracker.onDelta(delta(103, 103, { bids: [['31000', '9']] }));

    // Resnapshot at the same state: if the gapped delta had been applied, the
    // 31000 bid would survive the join.
    tracker.onSnapshot(snapshot(103));
    expect(formatAmount(tracker.top()!.bestBid!)).toBe('30000');
  });

  it('recovers to live on a fresh snapshot after a gap, and counts the resync', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));
    tracker.onDelta(delta(105, 105));
    expect(tracker.state).toBe('desynced');

    expect(tracker.onSnapshot(snapshot(110)).kind).toBe('applied');
    expect(tracker.state).toBe('live');
    expect(tracker.sequence).toBe(110);
    expect(tracker.resyncCount).toBe(1);
  });

  // ── Batched ranges ──────────────────────────────────────────────────────

  it('accepts a BATCHED frame — a venue that coalesces is not a venue that gapped', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));

    // One frame covering 101..107. Treating `u` as the only sequence, or
    // demanding first === last, would call this a gap and resnapshot forever.
    const outcome = tracker.onDelta(delta(101, 107, { bids: [['30001', '1']] }));
    expect(outcome).toEqual({ kind: 'applied', state: 'live', sequence: 107 });
  });

  it('accepts an OVERLAPPING batch — absolute levels make re-application idempotent', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));
    tracker.onDelta(delta(101, 105));

    // Starts before where we are, ends after. Safe: levels are new totals.
    const outcome = tracker.onDelta(delta(103, 108, { bids: [['30001', '7']] }));
    expect(outcome).toEqual({ kind: 'applied', state: 'live', sequence: 108 });
    expect(formatAmount(tracker.levels('bids')[0]![1])).toBe('7');
  });

  it('ignores a re-delivered delta rather than calling it a gap', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));
    tracker.onDelta(delta(101, 105));

    // Normal after a reconnect. A resnapshot loop here would be self-inflicted.
    const outcome = tracker.onDelta(delta(101, 105));
    expect(outcome).toEqual({ kind: 'ignored', reason: 'already-applied', state: 'live' });
    expect(tracker.state).toBe('live');
    expect(tracker.sequence).toBe(105);
  });

  it('ignores a message for another market instead of corrupting this one', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));
    const outcome = tracker.onDelta({ ...delta(101, 101), symbol: 'ETH/USDT' });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'wrong-market', state: 'live' });
  });

  // ── The join ────────────────────────────────────────────────────────────

  describe('the join between snapshot and stream', () => {
    it('buffers deltas that arrive before the snapshot and drains them on join', () => {
      const tracker = new SequencedBookTracker(VENUE, SYMBOL);

      expect(tracker.onDelta(delta(101, 101, { bids: [['30001', '1']] })).kind).toBe('buffered');
      expect(tracker.onDelta(delta(102, 102, { bids: [['30001', '2']] })).kind).toBe('buffered');
      expect(tracker.bufferedCount).toBe(2);

      expect(tracker.onSnapshot(snapshot(100)).kind).toBe('applied');
      expect(tracker.sequence).toBe(102);
      // The last buffered value won, so both were applied in order.
      expect(formatAmount(tracker.levels('bids')[0]![1])).toBe('2');
    });

    it('drops buffered deltas the snapshot already contains', () => {
      const tracker = new SequencedBookTracker(VENUE, SYMBOL);
      tracker.onDelta(delta(50, 50));
      tracker.onDelta(delta(51, 51));
      tracker.onDelta(delta(101, 101));

      expect(tracker.onSnapshot(snapshot(100)).kind).toBe('applied');
      expect(tracker.sequence).toBe(101);
    });

    it('REFUSES to go live when the snapshot predates the buffered stream', () => {
      // The failure a gap detector cannot catch afterwards: joining across a
      // hole leaves a book that is contiguous forever and wrong forever.
      const tracker = new SequencedBookTracker(VENUE, SYMBOL);
      tracker.onDelta(delta(105, 105));

      const outcome = tracker.onSnapshot(snapshot(100));
      expect(outcome.kind).toBe('snapshot-stale');
      expect(outcome.kind === 'snapshot-stale' && outcome.detail).toContain('fetch a newer snapshot');
      expect(tracker.servable).toBe(false);
      expect(tracker.book()).toBeNull();
    });

    it('joins on a newer snapshot after refusing a stale one', () => {
      const tracker = new SequencedBookTracker(VENUE, SYMBOL);
      tracker.onDelta(delta(105, 105));
      expect(tracker.onSnapshot(snapshot(100)).kind).toBe('snapshot-stale');
      expect(tracker.onSnapshot(snapshot(104)).kind).toBe('applied');
      expect(tracker.sequence).toBe(105);
    });

    it('accepts a snapshot that is NEWER than everything buffered', () => {
      const tracker = new SequencedBookTracker(VENUE, SYMBOL);
      tracker.onDelta(delta(101, 101));
      expect(tracker.onSnapshot(snapshot(200)).kind).toBe('applied');
      expect(tracker.sequence).toBe(200);
    });

    it('keeps later buffered deltas when one desyncs during the snapshot drain', () => {
      const tracker = new SequencedBookTracker(VENUE, SYMBOL);
      tracker.onDelta(delta(101, 101, { bids: [['30001', '1']] }));
      tracker.onDelta(delta(103, 103, { bids: [['30001', '8']] }));
      tracker.onDelta(delta(104, 104, { bids: [['30001', '4']] }));

      const outcome = tracker.onSnapshot(snapshot(100));

      expect(outcome.kind).toBe('desynced');
      expect(tracker.servable).toBe(false);
      expect(tracker.book()).toBeNull();
      // 103 desynced the drain. 104 was already pending and must still be buffered.
      expect(tracker.bufferedCount).toBe(2);

      expect(tracker.onSnapshot(snapshot(102)).kind).toBe('applied');
      expect(tracker.sequence).toBe(104);
      expect(formatAmount(tracker.levels('bids')[0]![1])).toBe('4');
    });

    it('does not stay live when the snapshot drain throws, and keeps the rest of pending', () => {
      const tracker = new SequencedBookTracker(VENUE, SYMBOL);
      tracker.onDelta(delta(101, 101, { bids: [['0', '1']] }));
      tracker.onDelta(delta(102, 102, { bids: [['30001', '9']] }));

      expect(() => tracker.onSnapshot(snapshot(100))).toThrow(/non-positive price/);
      expect(tracker.servable).toBe(false);
      expect(tracker.state).not.toBe('live');
      expect(tracker.book()).toBeNull();
      expect(tracker.bufferedCount).toBe(1);

      expect(tracker.onSnapshot(snapshot(101)).kind).toBe('applied');
      expect(tracker.sequence).toBe(102);
      expect(formatAmount(tracker.levels('bids')[0]![1])).toBe('9');
    });
  });

  // ── Bounded buffer ──────────────────────────────────────────────────────

  it('bounds the buffer, and the join check still catches what was dropped', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL, { maxBufferedDeltas: 3 });
    for (let sequence = 101; sequence <= 110; sequence += 1) tracker.onDelta(delta(sequence, sequence));

    expect(tracker.bufferedCount).toBe(3);
    expect(tracker.droppedFromBuffer).toBe(7);

    // The oldest survivor is 108, so a snapshot at 100 is caught as stale rather
    // than joined across the hole the eviction created.
    expect(tracker.onSnapshot(snapshot(100)).kind).toBe('snapshot-stale');
    expect(tracker.onSnapshot(snapshot(107)).kind).toBe('applied');
    expect(tracker.sequence).toBe(110);
  });

  // ── Crossed book ────────────────────────────────────────────────────────

  it('DESYNCS on a crossed book — the check sequence numbers cannot do', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));

    // Perfectly contiguous, and it puts a bid above the best ask. The venue's
    // numbering is fine; the payload is not.
    const outcome = tracker.onDelta(delta(101, 101, { bids: [['30005', '1']] }));
    expect(outcome.kind).toBe('desynced');
    expect(outcome.kind === 'desynced' && outcome.reason).toBe('crossed');
    expect(tracker.book()).toBeNull();
  });

  it('can be told not to reject a crossed book, for a venue where it is legitimate', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL, { rejectCrossedBook: false });
    tracker.onSnapshot(snapshot(100));
    expect(tracker.onDelta(delta(101, 101, { bids: [['30005', '1']] })).kind).toBe('applied');
  });

  // ── Removal encoding ────────────────────────────────────────────────────

  it('quantity zero removes a level; an ABSENT level is unchanged', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));

    tracker.onDelta(delta(101, 101, { bids: [['30000', '0']] }));
    const bids = tracker.levels('bids');
    // 30000 gone, 29999 untouched — it was never mentioned.
    expect(bids.map(([price]) => formatAmount(price))).toEqual(['29999']);
    expect(formatAmount(bids[0]![1])).toBe('5');
  });

  it('does not let "30000" and "30000.0" become two levels at one price', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));
    tracker.onDelta(delta(101, 101, { bids: [['30000.0', '9']] }));

    const bids = tracker.levels('bids');
    expect(bids.filter(([price]) => formatAmount(price) === '30000')).toHaveLength(1);
    expect(formatAmount(bids[0]![1])).toBe('9');
  });

  it('REFUSES a delta whose levels are JSON numbers, at the boundary', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(100));
    const bad = { ...delta(101, 101), bids: [[30001, 1]] } as unknown as VenueBookDelta;
    expect(() => tracker.onDelta(bad)).toThrow(/JSON number/);
  });

  // ── Unsequenced venues ──────────────────────────────────────────────────

  describe('a venue that publishes no sequence at all', () => {
    it('serves its snapshot but says gap detection is unavailable', () => {
      const tracker = new SequencedBookTracker(VENUE, SYMBOL);
      const outcome = tracker.onSnapshot(snapshot(-1, { sequenced: false }));
      expect(outcome.kind).toBe('applied');
      expect(tracker.servable).toBe(true);
      // The honest statement. A consumer that requires gap detection filters here.
      expect(tracker.gapDetectable).toBe(false);
    });

    it('refuses a delta from it rather than inventing a counter to check it with', () => {
      const tracker = new SequencedBookTracker(VENUE, SYMBOL);
      tracker.onSnapshot(snapshot(-1, { sequenced: false }));
      const outcome = tracker.onDelta(delta(1, 1));
      expect(outcome.kind).toBe('refused');
      expect(outcome.kind === 'refused' && outcome.detail).toContain('cannot be gap-checked');
    });
  });

  // ── A long stream, which is where drift would actually show up ──────────

  it('tracks 200 sequential deltas and ends at the right book', () => {
    const tracker = new SequencedBookTracker(VENUE, SYMBOL);
    tracker.onSnapshot(snapshot(0));

    for (let i = 1; i <= 200; i += 1) {
      // Walk one bid level up and down inside the spread, so every step both
      // adds and removes and the final state depends on all 200 being applied.
      const outcome = tracker.onDelta(
        delta(i, i, {
          bids: [
            ['30001', String(i)],
            ['29999', i % 2 === 0 ? '0' : '5'],
          ],
        }),
      );
      expect(outcome.kind).toBe('applied');
    }

    expect(tracker.sequence).toBe(200);
    expect(tracker.resyncCount).toBe(0);
    const bids = tracker.levels('bids');
    expect(formatAmount(bids[0]![0])).toBe('30001');
    expect(formatAmount(bids[0]![1])).toBe('200');
    // 200 is even, so 29999 was removed on the last step.
    expect(bids.map(([price]) => formatAmount(price))).toEqual(['30001', '30000']);
  });
});
