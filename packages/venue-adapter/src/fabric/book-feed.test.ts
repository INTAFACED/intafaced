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
    const book = new MaintainedBook(fakeAdapter(async () => absentSnapshot(4), subscription), SYMBOL);

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
    const book = new MaintainedBook(fakeAdapter(async () => absentSnapshot(4), subscription), SYMBOL);

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
