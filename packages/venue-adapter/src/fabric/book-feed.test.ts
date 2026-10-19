import { describe, expect, it } from 'vitest';
import type { BookSubscription, MarketDataAdapter, VenueBookDelta, VenueBookSnapshot } from '@intafaced/venue-contracts';
import { AsyncFrameQueue } from './transport.js';
import { MaintainedBook, type BookFeedStatus } from './book-feed.js';

/**
 * Fake venue. No prices, no levels, no book — empty sides are absence.
 * Nothing here opens a socket.
 */

const VENUE_ID = 'fake-venue';
const SYMBOL = 'BTC/USDT';
const OBSERVED_AT = new Date('2026-10-07T00:00:00.000Z');
const HANG_MS = 250;

function absentSnapshot(sequence: number, symbol = SYMBOL): VenueBookSnapshot {
  return {
    venueId: VENUE_ID,
    symbol,
    bids: [],
    asks: [],
    sequence,
    sequenced: true,
    observedAt: OBSERVED_AT,
  };
}

function emptyDelta(firstSequence: number, lastSequence: number): VenueBookDelta {
  return {
    venueId: VENUE_ID,
    symbol: SYMBOL,
    sequence: { firstSequence, lastSequence },
    bids: [],
    asks: [],
    observedAt: OBSERVED_AT,
  };
}

function quietStream(onClose: 'end' | 'fail'): {
  queue: AsyncFrameQueue<VenueBookDelta>;
  subscription: BookSubscription;
} {
  const queue = new AsyncFrameQueue<VenueBookDelta>();
  return {
    queue,
    subscription: {
      deltas: queue,
      close: async () => {
        if (onClose === 'fail') {
          queue.fail(new Error('socket closed'));
          return;
        }
        queue.close();
      },
    },
  };
}

function fakeAdapter(snapshotBook: MarketDataAdapter['snapshotBook'], stream: BookSubscription): MarketDataAdapter {
  return {
    venue: {
      id: VENUE_ID,
      displayName: 'Fake',
      kind: 'external-cex',
      sequencedDepth: true,
    },
    markets: async () => [],
    snapshotBook,
    streamBook: async () => stream,
  };
}

/** A hang is a failed assertion, not an open wait. */
async function statusOrHang(book: MaintainedBook): Promise<BookFeedStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      book.run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`run() hung after ${HANG_MS}ms: stopped status never arrived`));
        }, HANG_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('MaintainedBook.run — a failed seed completes on a quiet stream', () => {
  it('returns the snapshot-failure status before any delta', async () => {
    const { subscription } = quietStream('fail');
    const book = new MaintainedBook(
      fakeAdapter(async () => {
        throw new Error('rest down');
      }, subscription),
      SYMBOL,
      { maxSnapshotAttempts: 2 },
    );

    const status = await statusOrHang(book);

    expect(status.kind).toBe('stopped');
    if (status.kind !== 'stopped') return;
    expect(status.reason).toContain('could not fetch a snapshot');
    expect(status.reason).toContain('rest down');
    expect(status.reason).not.toContain('stream failed');
    expect(status.reason).not.toContain('stream ended');
    expect(book.servable).toBe(false);
    expect(book.top()).toBeNull();
    expect(book.levels('bids')).toEqual([]);
    expect(book.levels('asks')).toEqual([]);
  });

  it('returns the refused-snapshot status before any delta', async () => {
    const { subscription } = quietStream('end');
    const book = new MaintainedBook(
      fakeAdapter(async () => absentSnapshot(1, 'OTHER/USDT'), subscription),
      SYMBOL,
    );

    const status = await statusOrHang(book);

    expect(status.kind).toBe('stopped');
    if (status.kind !== 'stopped') return;
    expect(status.reason).toContain('snapshot refused');
    expect(status.reason).not.toContain('stream failed');
    expect(status.reason).not.toContain('stream ended');
  });

  it('returns the exhausted stale-snapshot status without another delta', async () => {
    const { queue, subscription } = quietStream('end');
    const book = new MaintainedBook(
      fakeAdapter(async () => absentSnapshot(1), subscription),
      SYMBOL,
      { maxSnapshotAttempts: 2 },
    );

    const pending = statusOrHang(book);
    queue.push(emptyDelta(10, 10));
    const status = await pending;

    expect(status.kind).toBe('stopped');
    if (status.kind !== 'stopped') return;
    expect(status.reason).toContain('could not join the stream after 2 snapshots');
    expect(status.reason).toContain('lagging its own websocket');
    expect(status.reason).not.toContain('stream failed');
    expect(status.reason).not.toContain('stream ended');
    expect(book.servable).toBe(false);
  });

  it('stays live after a seed and keeps reading until the stream ends', async () => {
    const { queue, subscription } = quietStream('end');
    const book = new MaintainedBook(
      fakeAdapter(async () => absentSnapshot(4), subscription),
      SYMBOL,
    );

    let settled = false;
    const running = book.run().then((status) => {
      settled = true;
      return status;
    });

    await flush();
    expect(book.status).toEqual({ kind: 'live', sequence: 4 });
    expect(book.servable).toBe(true);
    expect(settled).toBe(false);
    expect(book.top()?.bestBid ?? null).toBeNull();
    expect(book.top()?.bestAsk ?? null).toBeNull();

    queue.push(emptyDelta(5, 5));
    await flush();
    expect(book.status).toEqual({ kind: 'live', sequence: 5 });
    expect(settled).toBe(false);

    queue.close();
    const status = await running;
    expect(status).toEqual({ kind: 'stopped', reason: `${VENUE_ID}:${SYMBOL} stream ended` });
  });

  it('stays live after a seed until close() is called', async () => {
    const { subscription } = quietStream('end');
    const book = new MaintainedBook(
      fakeAdapter(async () => absentSnapshot(4), subscription),
      SYMBOL,
    );

    let settled = false;
    const running = book.run().then((status) => {
      settled = true;
      return status;
    });

    await flush();
    expect(book.status).toEqual({ kind: 'live', sequence: 4 });
    expect(settled).toBe(false);

    await book.close();
    const status = await running;
    expect(settled).toBe(true);
    expect(status).toEqual({ kind: 'live', sequence: 4 });
    expect(book.servable).toBe(false);
  });
});

describe('MaintainedBook.run — a stale seed cannot revive or tear down the feed', () => {
  function heldSnapshots(): {
    snapshotBook: MarketDataAdapter['snapshotBook'];
    calls: () => number;
    deliver(call: number, snapshot: VenueBookSnapshot): void;
  } {
    const waiting: Array<(snapshot: VenueBookSnapshot) => void> = [];
    let calls = 0;
    return {
      calls: () => calls,
      deliver(call, snapshot) {
        const resolve = waiting[call];
        if (!resolve) throw new Error(`snapshot call ${call} is not in flight`);
        resolve(snapshot);
      },
      snapshotBook: () => {
        const call = calls;
        calls += 1;
        return new Promise((resolve) => {
          waiting[call] = resolve;
        });
      },
    };
  }

  it('does not let an older refused snapshot stop a book a newer seed already joined', async () => {
    const held = heldSnapshots();
    const { queue, subscription } = quietStream('end');
    const book = new MaintainedBook(fakeAdapter(held.snapshotBook, subscription), SYMBOL);
    // Already live, so a gap starts a second seed while the first snapshot is still outstanding.
    book.tracker.onSnapshot(absentSnapshot(4));

    let settled = false;
    const pending = statusOrHang(book).then((status) => {
      settled = true;
      return status;
    });

    try {
      await flush();
      expect(held.calls()).toBe(1);

      queue.push(emptyDelta(10, 10));
      await flush();
      expect(held.calls()).toBe(2);
      expect(book.status.kind).toBe('resyncing');

      held.deliver(1, absentSnapshot(10));
      await flush();
      expect(book.status).toEqual({ kind: 'live', sequence: 10 });
      expect(book.servable).toBe(true);
      expect(settled).toBe(false);

      held.deliver(0, absentSnapshot(1, 'OTHER/USDT'));
      await flush();
      expect(settled).toBe(false);
      expect(book.status).toEqual({ kind: 'live', sequence: 10 });
      expect(book.servable).toBe(true);
      expect(book.top()?.bestBid ?? null).toBeNull();
      expect(book.top()?.bestAsk ?? null).toBeNull();

      queue.close();
      const status = await pending;
      expect(status).toEqual({ kind: 'stopped', reason: `${VENUE_ID}:${SYMBOL} stream ended` });
    } finally {
      queue.close();
      await book.close();
      await pending.catch(() => undefined);
    }
  });

  it('does not let an older snapshot replace a book a newer seed already joined', async () => {
    const held = heldSnapshots();
    const { queue, subscription } = quietStream('end');
    const book = new MaintainedBook(fakeAdapter(held.snapshotBook, subscription), SYMBOL);
    book.tracker.onSnapshot(absentSnapshot(4));

    const pending = statusOrHang(book);

    try {
      await flush();
      queue.push(emptyDelta(10, 10));
      await flush();

      held.deliver(1, absentSnapshot(10));
      await flush();
      expect(book.status).toEqual({ kind: 'live', sequence: 10 });

      held.deliver(0, absentSnapshot(3));
      await flush();
      expect(book.status).toEqual({ kind: 'live', sequence: 10 });
      expect(book.servable).toBe(true);
      expect(book.tracker.sequence).toBe(10);

      queue.close();
      const status = await pending;
      expect(status).toEqual({ kind: 'stopped', reason: `${VENUE_ID}:${SYMBOL} stream ended` });
    } finally {
      queue.close();
      await book.close();
      await pending.catch(() => undefined);
    }
  });

  it('does not let a late snapshot revive a feed that already stopped', async () => {
    let release: ((snapshot: VenueBookSnapshot) => void) | undefined;
    const { queue, subscription } = quietStream('end');
    const book = new MaintainedBook(
      fakeAdapter(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        subscription,
      ),
      SYMBOL,
    );

    const pending = statusOrHang(book);
    await flush();
    queue.close();
    const status = await pending;

    expect(status).toEqual({ kind: 'stopped', reason: `${VENUE_ID}:${SYMBOL} stream ended` });

    if (!release) throw new Error('snapshot was not requested');
    release(absentSnapshot(4));
    await flush();

    expect(book.status).toEqual(status);
    expect(book.servable).toBe(false);
    expect(book.top()).toBeNull();
    expect(book.levels('bids')).toEqual([]);
    expect(book.levels('asks')).toEqual([]);
  });
});
