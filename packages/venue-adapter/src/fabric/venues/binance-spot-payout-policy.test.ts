/**
 * Unit card — Binance snapshotBook payout policy is the caller's
 *
 * 1. Promise: omitted / null / nullish floor on a two-sided book throws
 *    MoneyError 'payout floor is missing'. An explicit decimal floor returns a
 *    thick book and refuses dust with VenueUnavailableError no_depth.
 *    Empty and one-sided books return without a floor.
 * 2. Break: snapshotBook applying a hidden floor, or dropping the caller's floor.
 * 3. Done bar: the policy argument is passed through. No production floor is applied here.
 * 4. Class M
 * 5. Paths: binance-spot.ts snapshotBook
 * 6. RED: two-sided snapshot with no policy returns a book, or an explicit floor is ignored.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MoneyError, parseAmount } from '@intafaced/ledger-client/money';
import { VenueUnavailableError, type MarketDataAdapter } from '@intafaced/venue-contracts';
import { BinanceSpotMarketData } from './binance-spot.js';
import type { PayoutGradePolicy } from '../payout-grade.js';
import { AsyncFrameQueue, type HttpPort, type HttpResponse, type StreamHandle, type StreamPort } from '../transport.js';

/** Fixture floor. Not a production magnitude. */
const FIXTURE_FLOOR = '250';

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

function md(body: unknown): BinanceSpotMarketData {
  const http = new FakeHttp().queue(body);
  return new BinanceSpotMarketData({
    http,
    stream: new FakeStream(),
    clock: () => 0,
    restBase: 'https://rest.test',
  });
}

const thick = {
  lastUpdateId: 7,
  bids: [['30000.00', '2.00']],
  asks: [['30002.00', '1.00']],
};

const dust = {
  lastUpdateId: 8,
  bids: [['1.00', '1.00']],
  asks: [['1.01', '1.00']],
};

const atHundred = {
  lastUpdateId: 11,
  bids: [['100.00', '1.00']],
  asks: [['100.00', '1.00']],
};

const empty = {
  lastUpdateId: 9,
  bids: [] as string[][],
  asks: [] as string[][],
};

const bidsOnly = {
  lastUpdateId: 10,
  bids: [['30000.00', '2.00']],
  asks: [] as string[][],
};

const missingFloor = {
  name: 'MoneyError',
  message: 'payout floor is missing',
} satisfies Partial<MoneyError>;

describe('BinanceSpotMarketData.snapshotBook payout policy', () => {
  it('does not install a floor inside snapshotBook', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'binance-spot.ts'), 'utf8');
    const start = src.indexOf('async snapshotBook(');
    const end = src.indexOf('async streamBook(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).not.toContain('DEFAULT_MIN_BEST_LEVEL_NOTIONAL');
    expect(body).not.toMatch(/minBestLevelNotional:\s*['"]\d/);
    expect(body).toMatch(/assertPayoutGradeBook\(\s*\{[\s\S]*?\},\s*policy,\s*\)/);
  });

  it('refuses a two-sided book when the floor is omitted, null, or nullish', async () => {
    const omitted: MarketDataAdapter = md(thick);
    await expect(omitted.snapshotBook('BTC/USDT', 5)).rejects.toMatchObject(missingFloor);
    await expect(md(thick).snapshotBook('BTC/USDT', 5, undefined)).rejects.toMatchObject(missingFloor);
    await expect(md(thick).snapshotBook('BTC/USDT', 5, null)).rejects.toMatchObject(missingFloor);
    await expect(md(thick).snapshotBook('BTC/USDT', 5, {})).rejects.toMatchObject(missingFloor);
    await expect(md(thick).snapshotBook('BTC/USDT', 5, { minBestLevelNotional: null })).rejects.toMatchObject(missingFloor);
    await expect(md(thick).snapshotBook('BTC/USDT', 5, { minBestLevelNotional: undefined })).rejects.toMatchObject(
      missingFloor,
    );
  });

  it('returns an empty or one-sided book without a floor', async () => {
    const absent = await md(empty).snapshotBook('BTC/USDT', 5);
    expect(absent.bids).toEqual([]);
    expect(absent.asks).toEqual([]);
    expect(absent.sequence).toBe(9);

    const oneSided = await md(bidsOnly).snapshotBook('BTC/USDT', 5, null);
    expect(oneSided.bids).toEqual([[parseAmount('30000.00'), parseAmount('2.00')]]);
    expect(oneSided.asks).toEqual([]);

    const nullish: PayoutGradePolicy = { minBestLevelNotional: null };
    const stillEmpty = await md(empty).snapshotBook('BTC/USDT', 5, nullish);
    expect(stillEmpty.bids).toEqual([]);
    expect(stillEmpty.asks).toEqual([]);
  });

  it('returns a thick two-sided book when the caller passes an explicit floor', async () => {
    const snapshot = await md(thick).snapshotBook('BTC/USDT', 5, { minBestLevelNotional: FIXTURE_FLOOR });
    expect(snapshot.venueId).toBe('binance-spot');
    expect(snapshot.symbol).toBe('BTC/USDT');
    expect(snapshot.sequence).toBe(7);
    expect(snapshot.sequenced).toBe(true);
    expect(snapshot.bids).toEqual([[parseAmount('30000.00'), parseAmount('2.00')]]);
    expect(snapshot.asks).toEqual([[parseAmount('30002.00'), parseAmount('1.00')]]);
    expect(typeof snapshot.bids[0]?.[0]).toBe('bigint');
    expect(typeof snapshot.bids[0]?.[1]).toBe('bigint');
  });

  it('refuses a dust two-sided book under an explicit floor with no_depth', async () => {
    await expect(md(dust).snapshotBook('BTC/USDT', 5, { minBestLevelNotional: FIXTURE_FLOOR })).rejects.toBeInstanceOf(
      VenueUnavailableError,
    );
    await expect(md(dust).snapshotBook('BTC/USDT', 5, { minBestLevelNotional: FIXTURE_FLOOR })).rejects.toMatchObject({
      reason: 'no_depth',
    });
    // Notional 100 clears a floor of 100 and fails this fixture. The passed string is the floor.
    await expect(md(atHundred).snapshotBook('BTC/USDT', 5, { minBestLevelNotional: FIXTURE_FLOOR })).rejects.toMatchObject({
      reason: 'no_depth',
    });
  });

  it('still returns an empty book when an explicit floor is passed', async () => {
    const snapshot = await md(empty).snapshotBook('BTC/USDT', 5, { minBestLevelNotional: FIXTURE_FLOOR });
    expect(snapshot.bids).toEqual([]);
    expect(snapshot.asks).toEqual([]);
    expect(snapshot.sequence).toBe(9);
  });
});
