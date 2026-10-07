/**
 * Unit card — Bybit snapshotBook refuse when limit unpublished
 *
 * 1. Promise: omitted / null / undefined / 0 / NaN limit →
 *    venue.snapshot_book.limit_unset (no invented 200).
 *    Owner-explicit 200 is a published number, not a git default.
 *    Venue 1000 is a cap, not a default.
 * 2. Break: snapshotBook treating missing limit as 200 lets blank look published.
 * 3. Done bar: snapshotBook refuses before any REST fetch; source has no default 200.
 * 4. Class M
 * 5. Paths: bybit-spot.ts snapshotBook
 * 6. RED: unset snapshot succeeds or source git-defaults 200
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BybitSpotMarketData } from './bybit-spot.js';
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

function md(http: FakeHttp): BybitSpotMarketData {
  return new BybitSpotMarketData({
    http,
    stream: new FakeStream(),
    clock: () => 0,
    restBase: 'https://rest.test',
    heartbeatMs: 0,
  });
}

const depth = {
  retCode: 0,
  retMsg: 'OK',
  result: {
    s: 'BTCUSDT',
    b: [['30000.00', '2.00']],
    a: [['30002.00', '1.00']],
    ts: 1,
    u: 1,
    seq: 9,
    cts: 1,
  },
  retExtInfo: {},
  time: 1,
};

describe('BybitSpotMarketData.snapshotBook limit unpublished', () => {
  it('bybit-spot.ts does not git-default 200', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'bybit-spot.ts'), 'utf8');
    expect(src).toMatch(/venue\.snapshot_book\.limit_unset/);
    expect(src).not.toMatch(/limit\s*=\s*DEFAULT_DEPTH_LIMIT/);
    expect(src).not.toMatch(/const DEFAULT_DEPTH_LIMIT/);
    expect(src).toMatch(/Never invent 200/);
  });

  it('omitted / null / undefined limit refuses (does not invent 200)', async () => {
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

  it('NaN / 0 limit refuses (does not invent 200)', async () => {
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

  it('owner-explicit 200 snapshots (cap 1000 still applies)', async () => {
    const http = new FakeHttp().queue(depth).queue(depth);
    const adapter = md(http);
    const snapshot = await adapter.snapshotBook('BTC/USDT', 200);
    // Fixture `u` is 1. The join sequence is `seq`.
    expect(snapshot.sequence).toBe(9);
    expect(http.requests[0]).toBe('https://rest.test/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=200');
    await adapter.snapshotBook('BTC/USDT', 999_999);
    expect(http.requests[1]).toContain('limit=1000');
  });
});
