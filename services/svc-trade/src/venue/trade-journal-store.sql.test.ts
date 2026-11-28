import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { JournalTradeFigures } from '@intafaced/contracts/trade-journal-procedures';
import { SqlTradeJournalStore } from './trade-journal-store.js';

// trade.user_venue_journal_trades (trade-journal.ts, J-portfolio-18 #7): a kept trade round-trips exactly, is written
// once per account and first fill, is completed once when it was kept with its candles missing, and is listed newest
// closed first within one account only.

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The trade journal store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const BOOK = { venueId: 'test-venue-sim', owner: '0x00000000000000000000000000000000000000d3', subAccount: null };
const OTHER = { ...BOOK, subAccount: 'sub-1' };

function trade(tradeId: string, closedAt: string, complete: boolean): JournalTradeFigures {
  const excursion = { price: '98', perUnit: '3', usd: '6', pct: '2.97' };
  return {
    tradeId,
    symbol: 'XJRN-PERP',
    side: 'long',
    openedAt: '2026-11-28T10:00:00.000Z',
    closedAt,
    entryPrice: '101',
    exitPrice: '110',
    size: '2',
    fills: [
      {
        fillId: tradeId,
        filledAt: '2026-11-28T10:00:00.000Z',
        side: 'buy',
        price: '101',
        amount: '2',
        venueFee: '0.1',
        builderFee: '0.01',
        feeAsset: 'USDC',
        opening: true,
        split: false,
      },
      {
        fillId: `${tradeId}-x`,
        filledAt: closedAt,
        side: 'sell',
        price: '110',
        amount: '2',
        venueFee: '0.1',
        builderFee: '0',
        feeAsset: 'USDC',
        opening: false,
        split: false,
      },
    ],
    feeAsset: 'USDC',
    realisedPnl: '18',
    venueFees: '0.2',
    builderFees: '0.01',
    funding: '-0.000125',
    fundingPayments: 1,
    netPnl: '17.789875',
    plannedStop: '96',
    plannedTarget: null,
    risk: '10',
    rMultiple: '1.779',
    rMissing: null,
    excursion: { interval: '1m', complete, mae: complete ? excursion : null, mfe: complete ? excursion : null },
    disciplined: { exit: 'unresolved', exitPrice: null, netPnl: null },
    rules: { verdict: 'no_stop', netPnl: '17.789875', oneR: null, widenedStop: null, dailyLoss: null },
    fillIds: [tradeId, `${tradeId}-x`],
  };
}

describe('SqlTradeJournalStore on Postgres (trade.user_venue_journal_trades)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('keeps each trade once, completes one kept incomplete, and lists one account newest closed first', async () => {
    const store = new SqlTradeJournalStore(db!.sql);
    const t0 = new Date('2026-11-28T10:10:00Z');
    const t1 = new Date('2026-11-28T10:20:00Z');
    const t2 = new Date('2026-11-28T10:30:00Z');
    const a = trade('fill-a', '2026-11-28T10:05:00.000Z', true);
    const b = trade('fill-b', '2026-11-28T10:06:00.000Z', false);
    await store.keep(BOOK, [a, b], t0);
    await store.keep(OTHER, [trade('fill-c', '2026-11-28T10:07:00.000Z', true)], t0);
    expect(await store.list(BOOK, new Date('2026-11-28T00:00:00Z'), 10)).toEqual([
      { trade: b, storedAt: t0 },
      { trade: a, storedAt: t0 },
    ]);

    // A second read: the complete one never changes; the incomplete one is completed once, then stays.
    const b2 = trade('fill-b', '2026-11-28T10:06:00.000Z', true);
    await store.keep(BOOK, [{ ...a, netPnl: '1' }, b2], t1);
    await store.keep(BOOK, [{ ...b2, netPnl: '2' }], t2);
    expect(await store.list(BOOK, new Date('2026-11-28T00:00:00Z'), 10)).toEqual([
      { trade: b2, storedAt: t1 },
      { trade: a, storedAt: t0 },
    ]);
    expect((await store.list(BOOK, new Date('2026-11-28T10:05:30Z'), 10)).map((r) => r.trade.tradeId)).toEqual(['fill-b']);
    expect((await store.list(BOOK, new Date('2026-11-28T00:00:00Z'), 1)).map((r) => r.trade.tradeId)).toEqual(['fill-b']);
    expect((await store.list(OTHER, new Date('2026-11-28T00:00:00Z'), 10)).map((r) => r.trade.tradeId)).toEqual(['fill-c']);
  });

  // trade.user_venue_journal_replays (J-charts-desk-20 #3): a kept replay round-trips exactly, once per account and
  // trade, and one kept with its candles missing is replaced once by a complete one.
  it("keeps each trade's replay once, completes one kept incomplete, and reads it for its own account only", async () => {
    const store = new SqlTradeJournalStore(db!.sql);
    const t0 = new Date('2026-11-28T10:10:00Z');
    const t1 = new Date('2026-11-28T10:20:00Z');
    const bar = (hhmm: string) => ({
      openAt: `2026-11-28T${hhmm}:00.000Z`,
      openPrice: '100',
      highPrice: '101',
      lowPrice: '99.5',
      closePrice: '100.25',
      baseVolume: '0.5',
    });
    const stops = [
      { price: '95', placedAt: '2026-11-28T10:00:20.000Z' },
      { price: '90', placedAt: '2026-11-28T10:01:30.000Z' },
    ];
    const full = { tradeId: 'fill-r', complete: true, interval: '1m', bars: [bar('09:50'), bar('10:00')], stops };
    const part = { tradeId: 'fill-s', complete: false, interval: '1m', bars: [], stops: [] };
    await store.keepReplays(BOOK, [full, part], t0);
    expect(await store.replayOf(BOOK, 'fill-r')).toEqual({ ...full, storedAt: t0 });
    expect(await store.replayOf(BOOK, 'fill-s')).toEqual({ ...part, storedAt: t0 });
    expect(await store.replayOf(OTHER, 'fill-r')).toBeNull();
    expect(await store.replayOf(BOOK, 'fill-none')).toBeNull();

    // A second read: the complete one never changes; the incomplete one is completed once, then stays.
    const done = { ...part, complete: true, bars: [bar('10:00')] };
    await store.keepReplays(BOOK, [{ ...full, bars: [] }, done], t1);
    await store.keepReplays(BOOK, [{ ...done, bars: [] }], new Date('2026-11-28T10:30:00Z'));
    expect(await store.replayOf(BOOK, 'fill-r')).toEqual({ ...full, storedAt: t0 });
    expect(await store.replayOf(BOOK, 'fill-s')).toEqual({ ...done, storedAt: t1 });
  });
});
