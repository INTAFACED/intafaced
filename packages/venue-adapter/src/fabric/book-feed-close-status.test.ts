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
const SUBSCRIPTION_CLOSED = `${VENUE_ID}:${SYMBOL} subscription closed`;
const STREAM_ENDED = `${VENUE_ID}:${SYMBOL} stream ended`;

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

function heldSnapshots(): {
  snapshotBook: MarketDataAdapter['snapshotBook'];
  deliver(call: number, snapshot: VenueBookSnapshot): void;
} {
  const waiting: Array<(snapshot: VenueBookSnapshot) => void> = [];
  let calls = 0;
  return {
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

describe('MaintainedBook.close — a closed feed reports stopped', () => {
  it('close() while live reports stopped, not live', async () => {
    const { subscription } = quietStream('end');
    const book = new MaintainedBook(fakeAdapter(async () => absentSnapshot(4), subscription), SYMBOL);

    const pending = statusOrHang(book);
    await flush();
    expect(book.status).toEqual({ kind: 'live', sequence: 4 });
    expect(book.servable).toBe(true);

    await book.close();
    const status = await pending;

    expect(status).toEqual({ kind: 'stopped', reason: SUBSCRIPTION_CLOSED });
    expect(status.kind).not.toBe('live');
    expect(book.status).toEqual(status);
    expect(book.servable).toBe(false);
  });

  it('close() while starting reports stopped, not starting', async () => {
    const held = heldSnapshots();
    const { subscription } = quietStream('end');
    const book = new MaintainedBook(fakeAdapter(held.snapshotBook, subscription), SYMBOL);

    const pending = statusOrHang(book);
    await flush();
    expect(book.status).toEqual({ kind: 'starting' });

    await book.close();
    const status = await pending;

    expect(status).toEqual({ kind: 'stopped', reason: SUBSCRIPTION_CLOSED });
    expect(status.kind).not.toBe('starting');
    expect(book.status).toEqual(status);
    expect(book.servable).toBe(false);

    held.deliver(0, absentSnapshot(4));
    await flush();
    expect(book.status).toEqual(status);
    expect(book.servable).toBe(false);
  });

  it('close() during resyncing reports stopped, not resyncing', async () => {
    const held = heldSnapshots();
    const { queue, subscription } = quietStream('end');
    const book = new MaintainedBook(fakeAdapter(held.snapshotBook, subscription), SYMBOL);
    book.tracker.onSnapshot(absentSnapshot(4));

    const pending = statusOrHang(book);
    try {
      await flush();
      queue.push(emptyDelta(10, 10));
      await flush();
      expect(book.status.kind).toBe('resyncing');

      await book.close();
      const status = await pending;

      expect(status).toEqual({ kind: 'stopped', reason: SUBSCRIPTION_CLOSED });
      expect(status.kind).not.toBe('resyncing');
      expect(book.status).toEqual(status);
      expect(book.servable).toBe(false);

      held.deliver(0, absentSnapshot(4));
      held.deliver(1, absentSnapshot(10));
      await flush();
      expect(book.status).toEqual(status);
      expect(book.servable).toBe(false);
    } finally {
      queue.close();
      await book.close();
      await pending.catch(() => undefined);
    }
  });

  it('close() does not replace a snapshot-fetch stop', async () => {
    const { subscription } = quietStream('end');
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
    expect(status.reason).not.toContain('subscription closed');
    expect(status.reason).not.toContain('stream ended');

    await book.close();
    expect(book.status).toEqual(status);
    expect(book.servable).toBe(false);
  });

  it('queue.close() without book.close() still returns stream ended', async () => {
    const { queue, subscription } = quietStream('end');
    const book = new MaintainedBook(fakeAdapter(async () => absentSnapshot(4), subscription), SYMBOL);

    const pending = statusOrHang(book);
    await flush();
    expect(book.status).toEqual({ kind: 'live', sequence: 4 });

    queue.close();
    const status = await pending;

    expect(status).toEqual({ kind: 'stopped', reason: STREAM_ENDED });
    expect(book.servable).toBe(false);
  });
});
