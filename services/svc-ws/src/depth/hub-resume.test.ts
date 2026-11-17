import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  bookFromSnapshot,
  type DepthBook,
  type DepthMessage,
  type DepthSnapshot,
  type WireLevel,
} from '@intafaced/market-data';
import { DepthHub, type DepthSink } from './hub.js';
import type { DepthSource } from './source.js';

// J-cex-spot-14 #8: a client that reconnects with the sequence it holds is sent only what it missed, in order, when the
// hub can prove every delta in between; anything else gets the snapshot, as a fresh connection does.

const MARKET = 'BTC-USDT';
const snap = (sequence: number, bid: string, bids: WireLevel[] = [[bid, '1']]): DepthSnapshot => ({
  type: 'snapshot',
  marketId: MARKET,
  sequence,
  bids,
  asks: [['200', '1']],
});

class Sink implements DepthSink {
  readonly frames: DepthMessage[] = [];
  bufferedBytes = 0;
  closed: number | null = null;
  send(frame: string): void {
    this.frames.push(JSON.parse(frame) as DepthMessage);
  }
  close(code: number): void {
    this.closed ??= code;
  }
}

class Source implements DepthSource {
  current = snap(10, '100');
  async markets(): Promise<readonly string[]> {
    return [MARKET];
  }
  async snapshot(): Promise<DepthSnapshot> {
    return this.current;
  }
  trading(): null {
    return null;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const hubFor = (source: Source, maxPendingDeltas = 512) =>
  new DepthHub(source, {
    depthLimit: 50,
    highWaterBytes: 1_000,
    maxLagTicks: 3,
    maxConnections: 100,
    marketsRefreshMs: 0,
    maxPendingDeltas,
  });

/** The client's book: `start` (the book it held), then every frame, refusing any delta that does not continue. */
function rebuild(start: DepthBook | null, frames: readonly DepthMessage[]): DepthBook {
  let book = start;
  for (const frame of frames) {
    if (frame.type === 'snapshot') {
      book = bookFromSnapshot(frame);
      continue;
    }
    if (!book) throw new Error('a delta before any book');
    const result = applyDelta(book, frame);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    book = result.book;
  }
  if (!book) throw new Error('no book');
  return book;
}

async function watching() {
  const source = new Source();
  const hub = hubFor(source);
  const watcher = new Sink();
  hub.attach(MARKET, watcher);
  await settle();
  return { source, hub, watcher };
}

describe('resume from the last sequence', () => {
  it('sends a reconnect that names its sequence only the deltas it missed, and they continue its book', async () => {
    const { source, hub, watcher } = await watching();
    const first = new Sink();
    const detach = hub.attach(MARKET, first);
    await settle();
    hub.ingest((source.current = snap(11, '101')));
    const held = rebuild(null, first.frames);
    expect(held.sequence).toBe(11);
    detach!();
    // While it is away the book moves twice.
    hub.ingest((source.current = snap(12, '102')));
    hub.ingest((source.current = snap(13, '103')));
    const again = new Sink();
    hub.attach(MARKET, again, { since: 11 });
    await settle();
    expect(again.frames.map((f) => f.type)).toEqual(['delta', 'delta']);
    expect(again.frames[0]).toMatchObject({ fromSequence: 11, sequence: 12 });
    const resumed = rebuild(held, again.frames);
    expect(resumed.sequence).toBe(13);
    expect(resumed).toEqual(rebuild(null, watcher.frames));
    expect(hub.stats.resumes).toBe(1);
  });

  it('sends nothing to replay when the reconnect already holds the latest sequence, then live deltas', async () => {
    const { source, hub } = await watching();
    const again = new Sink();
    hub.attach(MARKET, again, { since: 10 });
    await settle();
    expect(again.frames).toEqual([]);
    hub.ingest((source.current = snap(11, '101')));
    expect(again.frames).toEqual([expect.objectContaining({ type: 'delta', fromSequence: 10, sequence: 11 })]);
  });

  it('sends the snapshot when the sequence is ahead of the book, older than it keeps, or across a repair', async () => {
    const { source, hub } = await watching();
    const ahead = new Sink();
    hub.attach(MARKET, ahead, { since: 99 });
    await settle();
    expect(ahead.frames.map((f) => f.type)).toEqual(['snapshot']);

    const small = hubFor(source, 1);
    small.attach(MARKET, new Sink());
    await settle();
    small.ingest((source.current = snap(11, '101')));
    small.ingest((source.current = snap(12, '102')));
    const old = new Sink();
    small.attach(MARKET, old, { since: 10 });
    await settle();
    expect(old.frames.map((f) => f.type)).toEqual(['snapshot']);

    // A repair (the same sequence with other levels) breaks the chain: nothing before it can be proven.
    hub.ingest((source.current = snap(11, '101')));
    hub.ingest((source.current = snap(11, '95')));
    const across = new Sink();
    hub.attach(MARKET, across, { since: 10 });
    await settle();
    expect(across.frames).toEqual([expect.objectContaining({ type: 'snapshot', sequence: 11 })]);
  });

  it('treats a missing or malformed sequence as a fresh connection', async () => {
    const { hub } = await watching();
    for (const since of [undefined, null, -1, 1.5, Number.NaN]) {
      const sink = new Sink();
      hub.attach(MARKET, sink, { since: since as number | null | undefined });
      await settle();
      expect(sink.frames.map((f) => f.type)).toEqual(['snapshot']);
    }
  });
});
