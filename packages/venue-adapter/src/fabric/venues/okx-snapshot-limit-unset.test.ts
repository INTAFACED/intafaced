/**
 * Unit card — OKX snapshotBook refuse when limit unpublished
 *
 * 1. Promise: omitted / null / undefined / 0 / NaN limit →
 *    venue.snapshot_book.limit_unset (no invented 100).
 *    Owner-explicit 100 is a published number, not a git default.
 *    Venue 400 is a cap, not a default.
 * 2. Break: snapshotBook treating missing limit as 100 lets blank look published.
 * 3. Done bar: snapshotBook refuses before any REST fetch; source has no default 100.
 * 4. Class M
 * 5. Paths: okx-spot.ts snapshotBook
 * 6. RED: unset snapshot succeeds or source git-defaults 100
 */
import { describe, expect, it } from 'vitest';
import { OkxSpotMarketData } from './okx-spot.js';
import { AsyncFrameQueue, type HttpPort, type HttpResponse, type StreamHandle, type StreamPort } from '../transport.js';

const SNAPSHOT_BOOK_LIMIT_UNSET = 'venue.snapshot_book.limit_unset';

class FakeHttp implements HttpPort {
  readonly requests: string[] = [];
  #responses: HttpResponse[] = [];

  queue(body: unknown, status = 200, headers: Record<string, string> = {}): this {
    this.#responses.push({
      status,
      body,
      header: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    });
    return this;
  }

  async get(url: string): Promise<HttpResponse> {
    this.requests.push(url);
    const next = this.#responses.shift();
    if (!next) throw new Error(`FakeHttp had no queued response for ${url}`);
    return next;
  }
}

class FakeStream implements StreamPort {
  async open(): Promise<StreamHandle> {
    const queue = new AsyncFrameQueue<unknown>();
    return { messages: queue, close: async () => queue.close() };
  }
}

function md(http: FakeHttp): OkxSpotMarketData {
  return new OkxSpotMarketData({
    http,
    stream: new FakeStream(),
    clock: () => 0,
    restBase: 'https://rest.test',
    heartbeatMs: 0,
  });
}

const depth = {
  code: '0',
  msg: '',
  data: [
    {
      asks: [['30002.10', '1.5', '0', '1']],
      bids: [['30000.00', '2.0', '0', '1']],
      ts: '1',
      seqId: 1,
    },
  ],
};

describe('OkxSpotMarketData.snapshotBook limit unpublished', () => {
  it('omitted / null / undefined limit refuses (does not invent 100)', async () => {
    const http = new FakeHttp().queue(depth);
    const adapter = md(http);
    await expect(adapter.snapshotBook('BTC/USDT')).rejects.toMatchObject({
      name: 'SnapshotBookLimitUnsetError',
      code: SNAPSHOT_BOOK_LIMIT_UNSET,
    });
    await expect(adapter.snapshotBook('BTC/USDT', undefined)).rejects.toMatchObject({
      code: SNAPSHOT_BOOK_LIMIT_UNSET,
    });
    await expect(adapter.snapshotBook('BTC/USDT', null)).rejects.toMatchObject({
      code: SNAPSHOT_BOOK_LIMIT_UNSET,
    });
    expect(http.requests).toHaveLength(0);
  });

  it('NaN / 0 limit refuses (does not invent 100)', async () => {
    const http = new FakeHttp().queue(depth);
    const adapter = md(http);
    await expect(adapter.snapshotBook('BTC/USDT', Number.NaN)).rejects.toMatchObject({
      code: SNAPSHOT_BOOK_LIMIT_UNSET,
    });
    await expect(adapter.snapshotBook('BTC/USDT', 0)).rejects.toMatchObject({
      code: SNAPSHOT_BOOK_LIMIT_UNSET,
    });
    expect(http.requests).toHaveLength(0);
  });

  it('owner-explicit 100 snapshots (cap 400 still applies)', async () => {
    const http = new FakeHttp().queue(depth).queue(depth);
    const adapter = md(http);
    const snapshot = await adapter.snapshotBook('BTC/USDT', 100);
    expect(snapshot.sequence).toBe(1);
    expect(http.requests[0]).toBe('https://rest.test/api/v5/market/books?instId=BTC-USDT&sz=100');
    await adapter.snapshotBook('BTC/USDT', 999_999);
    expect(http.requests[1]).toContain('sz=400');
  });
});
