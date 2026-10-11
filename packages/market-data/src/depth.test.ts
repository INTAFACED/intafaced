import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client/money';
import { CaptureLog } from '@intafaced/connect-data-lake';
import {
  applyDelta,
  bookFromSnapshot,
  bookTop,
  diffDepth,
  emptyBook,
  ingestVenueDepthDelta,
  ingestVenueDepthSnapshot,
  ladder,
  type DepthBook,
  type DepthDelta,
  type DepthSnapshot,
  type InvalidQtyRefusal,
  type SnapshotBookResult,
  type WireLevel,
} from './depth.js';

const MARKET = 'BTC-USDT';

function snapshot(sequence: number, bids: WireLevel[], asks: WireLevel[]): DepthSnapshot {
  return { type: 'snapshot', marketId: MARKET, sequence, bids, asks };
}

function book(sequence: number, bids: WireLevel[], asks: WireLevel[]): DepthBook {
  return bookFromSnapshot(snapshot(sequence, bids, asks));
}

/** Hub reads `.bids` / `.asks` on the result with no refusal check. */
function callerResting(s: DepthSnapshot): boolean {
  const book = bookFromSnapshot(s);
  return book.bids.size > 0 || book.asks.size > 0;
}

/** Sequenced-book `#bookFrom` returns the snapshot straight into a `DepthBook`. */
function callerBookFrom(sequence: number, bids: readonly WireLevel[], asks: readonly WireLevel[]): DepthBook {
  return bookFromSnapshot({
    type: 'snapshot',
    marketId: MARKET,
    sequence,
    bids: bids.map(([price, qty]) => [price, qty] as WireLevel),
    asks: asks.map(([price, qty]) => [price, qty] as WireLevel),
  });
}

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type NegSnap = {
  readonly type: 'snapshot';
  readonly marketId: string;
  readonly sequence: number;
  readonly bids: readonly [readonly ['100', '-1']];
  readonly asks: readonly [];
};
type ValidSnap = {
  readonly type: 'snapshot';
  readonly marketId: string;
  readonly sequence: number;
  readonly bids: readonly [readonly ['100', '1']];
  readonly asks: readonly [];
};

function negCall() {
  return bookFromSnapshot({
    type: 'snapshot',
    marketId: MARKET,
    sequence: 1,
    bids: [['100', '-1']],
    asks: [],
  } as const);
}
function validCall() {
  return bookFromSnapshot({
    type: 'snapshot',
    marketId: MARKET,
    sequence: 1,
    bids: [['100', '1']],
    asks: [],
  } as const);
}
function negativeZeroCall() {
  return bookFromSnapshot({
    type: 'snapshot',
    marketId: MARKET,
    sequence: 1,
    bids: [['100', '-0']],
    asks: [],
  } as const);
}
function negativeFractionalZeroCall() {
  return bookFromSnapshot({
    type: 'snapshot',
    marketId: MARKET,
    sequence: 1,
    bids: [['100', '-0.000']],
    asks: [],
  } as const);
}
function negativeFullPrecisionZeroCall() {
  return bookFromSnapshot({
    type: 'snapshot',
    marketId: MARKET,
    sequence: 1,
    bids: [['100', '-0.000000000000000000']],
    asks: [],
  } as const);
}
function wideCall(snapshot: DepthSnapshot) {
  return bookFromSnapshot(snapshot);
}

function caught(s: DepthSnapshot): unknown {
  try {
    return bookFromSnapshot(s);
  } catch (err) {
    return err;
  }
}

const _callerIsBook: Same<ReturnType<typeof wideCall>, DepthBook> = true;
const _validIsBook: Same<ReturnType<typeof validCall>, DepthBook> = true;
const _negIsRefusal: Same<ReturnType<typeof negCall>, InvalidQtyRefusal> = true;
const _negNotBook: ReturnType<typeof negCall> extends DepthBook ? never : true = true;
const _negativeZeroIsBook: Same<ReturnType<typeof negativeZeroCall>, DepthBook> = true;
const _negativeFractionalZeroIsBook: Same<ReturnType<typeof negativeFractionalZeroCall>, DepthBook> = true;
const _negativeFullPrecisionZeroIsBook: Same<ReturnType<typeof negativeFullPrecisionZeroCall>, DepthBook> = true;
const _aliasNeg: Same<SnapshotBookResult<NegSnap>, InvalidQtyRefusal> = true;
const _aliasValid: Same<SnapshotBookResult<ValidSnap>, DepthBook> = true;

const sideOf = (b: DepthBook, side: 'bids' | 'asks') => Object.fromEntries([...b[side].entries()].map(([p, q]) => [p, formatAmount(q)]));

describe('canonical price keys', () => {
  it('collapses a snapshot of [["100","1"],["100.0","1"]] to one level', () => {
    const b = book(
      1,
      [
        ['100', '1'],
        ['100.0', '1'],
      ],
      [],
    );
    expect(b.bids.size).toBe(1);
    expect(formatAmount(b.bids.get('100')!)).toBe('1');
    expect(b.bids.has('100.0')).toBe(false);
  });

  it('applies a delta at "100.0" onto the "100" rest', () => {
    const start = book(1, [['100', '1']], []);
    const result = applyDelta(start, {
      type: 'delta',
      marketId: MARKET,
      fromSequence: 1,
      sequence: 2,
      bids: [['100.0', '3']],
      asks: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.book.bids.size).toBe(1);
    expect(formatAmount(result.book.bids.get('100')!)).toBe('3');
  });
});

describe('snapshot is a full replace — prior book is discarded', () => {
  it('a later snapshot that omits a prior price does not keep that rest', () => {
    const prior = book(
      1,
      [
        ['100', '1'],
        ['99', '2'],
      ],
      [],
    );
    expect(prior.bids.has('100')).toBe(true);

    const next = book(2, [['99', '2']], []);
    expect(next.bids.has('100')).toBe(false);
    expect(formatAmount(next.bids.get('99')!)).toBe('2');
  });

  it('a later snapshot that lists a prior price at qty 0 does not keep that rest', () => {
    const prior = book(1, [['100', '1']], []);
    expect(prior.bids.has('100')).toBe(true);

    const next = book(2, [['100', '0']], []);
    expect(next.bids.has('100')).toBe(false);
    expect(next.bids.size).toBe(0);
  });
});

describe('snapshot last-write at the same canonical price', () => {
  it('qty 0 retracts the earlier rest at "100" / "100.0"', () => {
    const b = book(
      1,
      [
        ['100', '1'],
        ['100.0', '0'],
      ],
      [],
    );
    expect(b.bids.has('100')).toBe(false);
    expect(b.bids.has('100.0')).toBe(false);
    expect(b.bids.size).toBe(0);
  });
});

describe('negative quantity must not rest', () => {
  it.each(['-0', '-0.000', '-0.000000000000000000'] as const)('treats qty "%s" as a valid zero delete', (qty) => {
    const result = bookFromSnapshot(snapshot(1, [['100', qty]], []));
    expect(result).toMatchObject({ marketId: MARKET, sequence: 1 });
    expect(result.bids.size).toBe(0);
  });

  it('callers that take a DepthBook do not receive one for qty "-1"', () => {
    expect(callerResting(snapshot(1, [['100', '1']], [['101', '2']]))).toBe(true);
    const good = callerBookFrom(1, [['100', '1']], [['101', '2']]);
    expect(good.sequence).toBe(1);
    expect(good.bids.size).toBe(1);
    expect(good.asks.size).toBe(1);

    let thrown: unknown;
    try {
      callerBookFrom(1, [['100', '-1']], []);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toEqual({ ok: false, reason: 'invalid-qty', expected: 1, got: 1 });
    expect(thrown).not.toHaveProperty('bids');
    expect(thrown).not.toHaveProperty('asks');
    expect(thrown).not.toHaveProperty('book');

    expect(() => callerResting(snapshot(1, [['100', '-1']], []))).toThrow();
  });

  it('refuses a snapshot qty "-1" with invalid-qty instead of a quiet book', () => {
    const refused = caught(snapshot(1, [['100', '-1']], []));
    expect(refused).toEqual({ ok: false, reason: 'invalid-qty', expected: 1, got: 1 });
    expect(refused).not.toHaveProperty('bids');
    expect(refused).not.toHaveProperty('asks');
    expect(refused).not.toHaveProperty('book');

    const partial = caught(
      snapshot(
        1,
        [
          ['100', '5'],
          ['99', '-1'],
        ],
        [],
      ),
    );
    expect(partial).toEqual({ ok: false, reason: 'invalid-qty', expected: 1, got: 1 });
    expect(partial).not.toHaveProperty('bids');

    const ask = caught(snapshot(1, [], [['100', '-1']]));
    expect(ask).toEqual({ ok: false, reason: 'invalid-qty', expected: 1, got: 1 });
  });

  it('refuses a delta qty "-1" and does not advance sequence', () => {
    const start = book(1, [['100', '1']], []);
    const result = applyDelta(start, {
      type: 'delta',
      marketId: MARKET,
      fromSequence: 1,
      sequence: 2,
      bids: [['100', '-1']],
      asks: [],
    });

    expect(result).toEqual({ ok: false, reason: 'invalid-qty', expected: 1, got: 2 });
    expect(result).not.toHaveProperty('book');
    expect(start.sequence).toBe(1);
    expect(sideOf(start, 'bids')).toEqual({ '100': '1' });
  });

  it('refuses the whole delta when one level is negative, even if others are valid', () => {
    const start = book(1, [['100', '5']], []);
    const result = applyDelta(start, {
      type: 'delta',
      marketId: MARKET,
      fromSequence: 1,
      sequence: 2,
      bids: [
        ['100', '9'],
        ['99', '-1'],
      ],
      asks: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-qty');
    expect(result.expected).toBe(1);
    expect(result.got).toBe(2);
    expect(result).not.toHaveProperty('book');
    expect(start.sequence).toBe(1);
    expect(sideOf(start, 'bids')).toEqual({ '100': '5' });
  });

  it('still deletes on qty 0 — zero is removal, not garbage', () => {
    const start = book(1, [['100', '5']], []);
    const result = applyDelta(start, {
      type: 'delta',
      marketId: MARKET,
      fromSequence: 1,
      sequence: 2,
      bids: [['100', '0']],
      asks: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.book.sequence).toBe(2);
    expect(result.book.bids.has('100')).toBe(false);
  });
});

describe('applying a delta', () => {
  it('updates, adds and removes levels in one message', () => {
    const start = book(10, [['100', '5']], [['101', '3']]);
    const delta: DepthDelta = {
      type: 'delta',
      marketId: MARKET,
      fromSequence: 10,
      sequence: 11,
      bids: [
        ['100', '7'], // update
        ['99', '2'], // add
      ],
      asks: [['101', '0']], // remove
    };

    const result = applyDelta(start, delta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(sideOf(result.book, 'bids')).toEqual({ '100': '7', '99': '2' });
    expect(sideOf(result.book, 'asks')).toEqual({});
    expect(result.book.sequence).toBe(11);
  });

  it('leaves an absent price UNCHANGED — absent is not removal', () => {
    // The distinction that grows phantom liquidity when it is lost.
    const start = book(
      1,
      [
        ['100', '5'],
        ['99', '4'],
      ],
      [],
    );
    const result = applyDelta(start, {
      type: 'delta',
      marketId: MARKET,
      fromSequence: 1,
      sequence: 2,
      bids: [['100', '6']],
      asks: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sideOf(result.book, 'bids')).toEqual({ '100': '6', '99': '4' });
  });

  it('does not mutate the book it was given', () => {
    // The book is handed to React state; mutating in place would render stale.
    const start = book(1, [['100', '5']], []);
    const before = sideOf(start, 'bids');

    applyDelta(start, { type: 'delta', marketId: MARKET, fromSequence: 1, sequence: 2, bids: [['100', '0']], asks: [] });

    expect(sideOf(start, 'bids')).toEqual(before);
    expect(start.sequence).toBe(1);
  });
});

describe('the sequence check — what stops a book drifting', () => {
  it('REFUSES a delta that skips a sequence, and says to resnapshot', () => {
    const start = book(10, [['100', '5']], []);
    const result = applyDelta(start, {
      type: 'delta',
      marketId: MARKET,
      fromSequence: 12, // 11 was lost
      sequence: 13,
      bids: [['100', '999']],
      asks: [],
    });

    expect(result).toEqual({ ok: false, reason: 'gap', expected: 10, got: 12 });
  });

  it('hands back NO book on a gap, so a caller cannot accidentally use one', () => {
    // The first version of this test asserted the input was unmutated, which
    // `applyDelta` guarantees anyway — so it passed with the gap check deleted.
    // What matters is that the failure path yields nothing applicable.
    const start = book(10, [['100', '5']], []);
    const result = applyDelta(start, {
      type: 'delta',
      marketId: MARKET,
      fromSequence: 12,
      sequence: 13,
      bids: [['100', '999']],
      asks: [],
    });

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('book');
    expect(sideOf(start, 'bids')).toEqual({ '100': '5' });
  });

  it('refuses every gap size, not just an off-by-one', () => {
    const start = book(10, [['100', '5']], []);
    for (const from of [11, 12, 50, 1_000_000]) {
      expect(
        applyDelta(start, { type: 'delta', marketId: MARKET, fromSequence: from, sequence: from + 1, bids: [], asks: [] }),
      ).toMatchObject({ ok: false, reason: 'gap' });
    }
  });

  it('treats a re-delivered delta as stale, not as a gap', () => {
    // A reconnect replays. Answering "gap" would send the client into a
    // resnapshot loop against a stream that is behaving correctly.
    const start = book(10, [['100', '5']], []);
    const result = applyDelta(start, {
      type: 'delta',
      marketId: MARKET,
      fromSequence: 9,
      sequence: 10,
      bids: [['100', '1']],
      asks: [],
    });

    expect(result).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('refuses a delta for a different market', () => {
    const start = book(1, [['100', '5']], []);
    const result = applyDelta(start, {
      type: 'delta',
      marketId: 'ETH-USDT',
      fromSequence: 1,
      sequence: 2,
      bids: [['100', '0']],
      asks: [],
    });

    expect(result).toMatchObject({ ok: false, reason: 'wrong-market' });
  });

  it('accepts the first delta after a snapshot', () => {
    const fresh = book(42, [['100', '1']], []);
    const result = applyDelta(fresh, { type: 'delta', marketId: MARKET, fromSequence: 42, sequence: 43, bids: [['100', '2']], asks: [] });

    expect(result.ok).toBe(true);
  });
});

describe('diff → apply round trip', () => {
  it('reproduces the target book exactly', () => {
    const prev = book(
      1,
      [
        ['100', '5'],
        ['99', '3'],
      ],
      [['101', '2']],
    );
    const next = book(
      2,
      [
        ['100', '7'],
        ['98', '1'],
      ],
      [
        ['101', '2'],
        ['102', '4'],
      ],
    );

    const result = applyDelta(prev, diffDepth(prev, next));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(sideOf(result.book, 'bids')).toEqual(sideOf(next, 'bids'));
    expect(sideOf(result.book, 'asks')).toEqual(sideOf(next, 'asks'));
    expect(result.book.sequence).toBe(next.sequence);
  });

  /**
   * The property, over generated books rather than examples.
   *
   * Hand-written cases test the transitions someone thought of. This tests the
   * ones nobody did — which is where an incremental book actually breaks.
   */
  it('holds over 300 randomised book transitions', () => {
    let seed = 42;
    const rand = (n: number) => {
      // Deterministic LCG: a property test that fails only on some CI runs is
      // worse than no property test, because nobody can reproduce it.
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const randomSide = (): WireLevel[] => Array.from({ length: rand(8) }, () => [String(100 + rand(20)), String(1 + rand(9))] as WireLevel);

    for (let i = 0; i < 300; i++) {
      const prev = book(i, randomSide(), randomSide());
      const next = book(i + 1, randomSide(), randomSide());

      const result = applyDelta(prev, diffDepth(prev, next));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(sideOf(result.book, 'bids')).toEqual(sideOf(next, 'bids'));
      expect(sideOf(result.book, 'asks')).toEqual(sideOf(next, 'asks'));
    }
  });

  it('emits nothing but a sequence bump when nothing changed', () => {
    const prev = book(1, [['100', '5']], [['101', '3']]);
    const next = book(2, [['100', '5']], [['101', '3']]);
    const delta = diffDepth(prev, next);

    expect(delta.bids).toEqual([]);
    expect(delta.asks).toEqual([]);
    expect(delta.sequence).toBe(2);
  });

  it('applying the same delta twice is harmless — levels are absolute', () => {
    // The belt, for when the sequence braces have already failed. Absolute
    // levels make a double-apply idempotent; relative ones would corrupt.
    const prev = book(1, [['100', '5']], []);
    const next = book(2, [['100', '9']], []);
    const delta = diffDepth(prev, next);

    const once = applyDelta(prev, delta);
    expect(once.ok).toBe(true);
    if (!once.ok) return;

    const twice = applyDelta({ ...once.book, sequence: 1 }, delta);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;

    expect(sideOf(twice.book, 'bids')).toEqual(sideOf(once.book, 'bids'));
  });
});

describe('precision — where a float terminal is wrong', () => {
  it('carries 18 decimal places through a diff and an apply', () => {
    const dust = '0.000000000000000001';
    const prev = book(1, [['100', '1']], []);
    const next = book(2, [['100', dust]], []);

    const result = applyDelta(prev, diffDepth(prev, next));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(formatAmount(result.book.bids.get('100')!)).toBe(dust);
  });

  it('sums a cumulative column exactly, where floats would drift', () => {
    // 0.1 + 0.2 + 0.3 is the canonical float failure. Three rows is enough.
    const b = book(
      1,
      [
        ['100', '0.1'],
        ['99', '0.2'],
        ['98', '0.3'],
      ],
      [],
    );
    const rows = ladder(b, 'bids');

    expect(formatAmount(rows[2]!.cumulative)).toBe('0.6');
  });

  it('handles a quantity beyond what a double can represent', () => {
    const huge = '9007199254740993.000000000000000001';
    const b = book(1, [['100', huge]], []);

    expect(formatAmount(ladder(b, 'bids')[0]!.quantity)).toBe(huge);
  });
});

describe('book top', () => {
  it('finds best bid and best ask by price, not by insertion order', () => {
    const b = book(
      1,
      [
        ['99', '1'],
        ['101', '2'],
        ['100', '3'],
      ],
      [
        ['105', '1'],
        ['103', '2'],
      ],
    );
    const top = bookTop(b);

    expect(formatAmount(top.bestBid!)).toBe('101');
    expect(formatAmount(top.bestAsk!)).toBe('103');
    expect(formatAmount(top.bestBidQty!)).toBe('2');
    expect(formatAmount(top.spread!)).toBe('2');
  });

  it('reports no spread for a one-sided book rather than a misleading zero', () => {
    expect(bookTop(book(1, [['100', '1']], [])).spread).toBeNull();
    expect(bookTop(emptyBook(MARKET)).bestBid).toBeNull();
  });
});

describe('ladder ordering', () => {
  it('sorts bids down and asks up — both away from the spread', () => {
    const b = book(
      1,
      [
        ['98', '1'],
        ['100', '1'],
        ['99', '1'],
      ],
      [
        ['103', '1'],
        ['101', '1'],
        ['102', '1'],
      ],
    );

    expect(ladder(b, 'bids').map((r) => formatAmount(r.price))).toEqual(['100', '99', '98']);
    expect(ladder(b, 'asks').map((r) => formatAmount(r.price))).toEqual(['101', '102', '103']);
  });

  it('accumulates from the top of the book down', () => {
    const b = book(
      1,
      [
        ['100', '1'],
        ['99', '2'],
        ['98', '3'],
      ],
      [],
    );
    expect(ladder(b, 'bids').map((r) => formatAmount(r.cumulative))).toEqual(['1', '3', '6']);
  });

  it('respects the limit without disturbing the ordering', () => {
    const b = book(
      1,
      [
        ['98', '1'],
        ['100', '1'],
        ['99', '1'],
      ],
      [],
    );
    expect(ladder(b, 'bids', 2).map((r) => formatAmount(r.price))).toEqual(['100', '99']);
  });

  it('sorts numerically, not lexicographically', () => {
    // '9' > '100' as strings. A book that sorted as text would put a 9-dollar
    // bid above a 100-dollar one, at the top of the ladder, in production.
    const b = book(
      1,
      [
        ['9', '1'],
        ['100', '1'],
        ['1000', '1'],
      ],
      [],
    );
    expect(ladder(b, 'bids').map((r) => formatAmount(r.price))).toEqual(['1000', '100', '9']);
  });
});

describe('ingestVenueDepthSnapshot — absent vs measured', () => {
  it('returns no book and venue_not_connected when the venue is unwired', () => {
    const lake = new CaptureLog({ now: () => new Date('2026-08-16T13:00:00.000Z') });
    const result = ingestVenueDepthSnapshot(lake, {
      venueId: 'unwired-venue',
      marketId: MARKET,
      connection: 'not_connected',
      snapshot: snapshot(1, [], []),
    });

    expect(result.book).toBeNull();
    expect(result.record).toMatchObject({ status: 'absent', reason: 'venue_not_connected', kind: 'book' });
    expect(result.record).not.toHaveProperty('bids');
  });

  it('does not serve emptyBook as connected silence', () => {
    const lake = new CaptureLog({ now: () => new Date('2026-08-16T13:00:01.000Z') });
    const result = ingestVenueDepthSnapshot(lake, {
      venueId: 'unwired-venue',
      marketId: MARKET,
      connection: 'not_connected',
    });
    expect(result.book).toBeNull();
    expect(result.book).not.toEqual(emptyBook(MARKET));
  });

  it('does not publish a book when a connected snapshot qty is negative', () => {
    const lake = new CaptureLog({ now: () => new Date('2026-08-16T13:00:04.000Z') });
    const result = ingestVenueDepthSnapshot(lake, {
      venueId: 'binance-spot',
      marketId: MARKET,
      connection: 'connected',
      snapshot: snapshot(4, [['100', '-1']], [['101', '2']]),
    });
    expect(result.book).toBeNull();
  });

  it('builds a measured empty DepthBook only when the adapter said connected', () => {
    const lake = new CaptureLog({ now: () => new Date('2026-08-16T13:00:02.000Z') });
    const result = ingestVenueDepthSnapshot(lake, {
      venueId: 'binance-spot',
      marketId: MARKET,
      connection: 'connected',
      snapshot: snapshot(4, [], []),
    });
    expect(result.record).toMatchObject({ status: 'measured', occupancy: 'empty' });
    expect(result.book).not.toBeNull();
    expect(result.book?.bids.size).toBe(0);
    expect(result.book?.asks.size).toBe(0);
  });
});

describe('ingestVenueDepthDelta — missing book is absent', () => {
  it('refuses to apply a delta onto a missing venue book', () => {
    const lake = new CaptureLog({ now: () => new Date('2026-08-16T13:00:03.000Z') });
    const result = ingestVenueDepthDelta(lake, {
      venueId: 'binance-spot',
      marketId: MARKET,
      connection: 'connected',
      book: null,
      delta: { type: 'delta', marketId: MARKET, fromSequence: 1, sequence: 2, bids: [], asks: [] },
    });
    expect(result.apply).toEqual({ ok: false, reason: 'absent' });
    expect(result.record.status).toBe('absent');
  });
});
