import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt, type Amount } from '@intafaced/ledger-client';
import { pnlOverTimeSchema } from '@intafaced/contracts/tax-lot-book';
import {
  TAX_DATA_LAKE_UNAVAILABLE,
  TAX_INDEXER_UNAVAILABLE,
  TAX_PNL_PRICES_UNAVAILABLE,
  TAX_PNL_RANGE_INVALID,
  TAX_PNL_RANGE_TOO_LONG,
} from './codes.js';
import type { TaxLedgerReads } from './ledger-reads.js';
import { TaxService } from './tax-service.js';
import { buildLotBook, type Fill, type Inflow } from './lot-book.js';
import { BookTimeline, HELD_KEY, MOVED_KEY_PREFIX, chooseInterval, closeAt, dayEdges, pnlOverTime, samplesOf } from './pnl-over-time.js';
import type { CloseSeries, CloseSeriesSource } from './prices.js';

// J-portfolio-05 #4 and #5 (PF-performance-03). Every figure is hand-computed TEST data, not a real balance.
const DAY = 86_400_000;
const day = (d: number, hour = 0) => new Date(Date.UTC(2026, 9, d, hour));
const NOW = day(21, 12);

// Day 1 noon: buy 1 BTC for 100 USDT. Day 8 noon: sell 0.5 BTC for 150 USDT after a 1.5 USDT fee (realised 100).
const buy: Fill = {
  txId: 'b1',
  postedAt: day(1, 12),
  received: { assetId: 'BTC', amount: amt('1') },
  paid: { assetId: 'USDT', amount: amt('100') },
  fee: 0n,
};
const sell: Fill = {
  txId: 's1',
  postedAt: day(8, 12),
  received: { assetId: 'USDT', amount: amt('150') },
  paid: { assetId: 'BTC', amount: amt('0.5') },
  fee: amt('1.5'),
};

const bookOf = (fills: readonly Fill[], held: Record<string, string>, extra: Partial<Parameters<typeof buildLotBook>[0]> = {}) =>
  buildLotBook({
    fills,
    held: new Map(Object.entries(held).map(([k, v]) => [k, amt(v)])),
    method: 'FIFO',
    truncated: false,
    inflows: [],
    now: NOW,
    ...extra,
  });

// Daily BTC/USDT candles: the one opening on day d closes at 100 + 10d.
const dailyFrom = (first: number, last = 21): CloseSeries => ({
  market: 'BTC/USDT',
  candles: Array.from({ length: last - first + 1 }, (_, i) => [day(first + i).getTime(), amt(String(100 + 10 * (first + i)))] as const),
});

const run = (over: Partial<Parameters<typeof pnlOverTime>[0]> = {}) =>
  pnlOverTime({
    book: bookOf([buy, sell], { BTC: '0.5', USDT: '150' }),
    from: day(2),
    to: day(20),
    now: NOW,
    interval: '1d',
    utcOffsetMinutes: 0,
    closes: new Map([['BTC', dailyFrom(0)]]),
    ...over,
  });

const sum = (rows: ReadonlyArray<{ usd: string | null }>): Amount => rows.reduce((s, r) => s + amt(r.usd!), 0n);

describe('pnlOverTime: the cumulative result at each moment', () => {
  it('is what the indicator said then: the sales made by then plus what was held then, at the last closed candle', () => {
    const out = run();
    const at = (d: number) => out.points.find((p) => p.at === day(d).toISOString())!;
    // Day 2: 1 BTC (cost 100) at the day-1 close of 110.
    expect(at(2)).toMatchObject({ totalUsd: '10', realizedUsd: '0', unrealizedUsd: '10', missing: [] });
    // Day 9: sold half for a result of 100; 0.5 BTC (cost 50) at the day-8 close of 180.
    expect(at(9)).toMatchObject({ totalUsd: '140', realizedUsd: '100', unrealizedUsd: '40' });
    // Day 20 (the end, not live): 0.5 BTC at the day-19 close of 290.
    expect(at(20)).toMatchObject({ totalUsd: '195', realizedUsd: '100', unrealizedUsd: '95' });
    expect(out.points).toHaveLength(19);
    expect(pnlOverTimeSchema.parse(out)).toEqual(out);
  });

  it('uses the candle still open only at a live end, so no past point sees a later price', () => {
    const live = run({ to: NOW });
    expect(live.points.at(-1)).toMatchObject({ at: NOW.toISOString(), unrealizedUsd: formatAmount(amt('0.5') * 310n - amt('50')) });
    const series = dailyFrom(0);
    expect(closeAt(series, '1d', day(10, 12), false)).toBe(amt('190'));
    expect(closeAt(series, '1d', day(10, 12), true)).toBe(amt('200'));
  });

  it('reads a moment with no price as missing, never zero, and names the coin', () => {
    const out = run({ closes: new Map([['BTC', dailyFrom(6)]]) });
    const before = out.points.filter((p) => new Date(p.at) <= day(6));
    expect(before.length).toBeGreaterThan(0);
    for (const p of before)
      expect(p).toMatchObject({ totalUsd: null, unrealizedUsd: null, missing: [{ assetId: 'BTC', reason: 'no_price' }] });
    expect(out.points.find((p) => p.at === day(8).toISOString())).toMatchObject({ totalUsd: formatAmount(amt('170') - amt('100')) });
    // The change over the range starts on a missing moment, so it is unknown too, and so is each day that touches one.
    expect(out.periodUsd).toBeNull();
    expect(out.byDay!.find((r) => r.key === '2026-10-03')!.usd).toBeNull();
    const noMarket = run({ closes: new Map([['BTC', null]]) });
    expect(noMarket.points.every((p) => p.totalUsd === null)).toBe(true);
  });

  it('starts from zero before the first trade, and a coin with no lot then needs no price', () => {
    const out = run({ from: day(1), to: day(3), closes: new Map([['BTC', dailyFrom(2)]]) });
    expect(out.points[0]).toMatchObject({ at: day(1).toISOString(), totalUsd: '0', missing: [] });
  });

  it('names an unknown cost: a deposited coin with no cost entered leaves every moment it is held unknown', () => {
    const deposit: Inflow = {
      txId: 'd1',
      postedAt: day(4, 12),
      assetId: 'BTC',
      amount: amt('0.25'),
      costUsd: null,
      source: 'deposit',
      reason: 'deposit.credited',
      valuedAt: null,
    };
    const book = bookOf([buy, sell], { BTC: '0.75', USDT: '150' }, { inflows: [deposit] });
    const out = run({ book });
    expect(out.points.find((p) => p.at === day(4).toISOString())!.totalUsd).toBe('30');
    expect(out.points.find((p) => p.at === day(5).toISOString())).toMatchObject({
      totalUsd: null,
      missing: [{ assetId: 'BTC', reason: 'cost_unknown' }],
    });
    // Left out (transfers do not count), the same deposit reaches no figure.
    const apart = run({ book: bookOf([buy, sell], { BTC: '0.75', USDT: '150' }, { inflows: [deposit], includeTransfers: false }) });
    expect(apart.points.find((p) => p.at === day(5).toISOString())!.totalUsd).toBe('40');
    expect(apart.includeTransfers).toBe(false);
  });
});

describe('pnlOverTime: the breakdown adds up to the change over the range', () => {
  it('by coin, by market (sales in the range plus the price move on what is held) and by day', () => {
    const out = run();
    expect(out.periodUsd).toBe('185');
    expect(out.byAsset).toEqual([{ key: 'BTC', usd: '185' }]);
    expect(out.byMarket).toEqual([
      { key: 'BTC/USDT', usd: '100' },
      { key: HELD_KEY, usd: '85' },
    ]);
    expect(out.byDay).toHaveLength(18);
    expect(out.byDay![0]).toEqual({ key: '2026-10-02', usd: '10' });
    for (const rows of [out.byAsset, out.byMarket, out.byDay!]) expect(sum(rows)).toBe(amt('185'));
    // The sale's fee is inside its result and shown apart; the buy (day 1) is outside the range.
    expect(out.feesUsd).toBe('1.5');
  });

  it('lists a withdrawal counted as a sale under moved:<coin>, and the markets still add up', () => {
    // Day 10 noon: 0.25 BTC leaves the platform, valued 200 when it left (cost 25 under FIFO): a result of 175.
    const out = run({
      book: bookOf(
        [buy, sell],
        { BTC: '0.25', USDT: '150' },
        {
          withdrawals: [{ txId: 'w1', postedAt: day(10, 12), assetId: 'BTC', amount: amt('0.25'), valueUsd: amt('200') }],
        },
      ),
    });
    expect(out.byMarket.find((r) => r.key === `${MOVED_KEY_PREFIX}BTC`)).toEqual({ key: 'moved:BTC', usd: '175' });
    expect(sum(out.byMarket)).toBe(amt(out.periodUsd!));
  });

  it('cuts the days at the customer midnight, and the days still add up', () => {
    const out = run({ utcOffsetMinutes: 5 * 60 + 30 });
    expect(out.byDay![0]!.key).toBe('2026-10-02');
    expect(dayEdges(day(2), day(4), 330)[0]).toEqual(new Date(day(2).getTime() + DAY - 330 * 60_000));
    expect(sum(out.byDay!)).toBe(amt(out.periodUsd!));
  });

  it('leaves the days out of a range longer than the breakdown lists', () => {
    const long = pnlOverTime({
      book: bookOf([], {}),
      from: new Date(NOW.getTime() - 500 * DAY),
      to: NOW,
      now: NOW,
      interval: '1w',
      utcOffsetMinutes: 0,
      closes: new Map(),
    });
    expect(long.byDay).toBeNull();
    expect(long.periodUsd).toBe('0');
  });

  it('refuses a range that ends before it starts', () => {
    expect(() => run({ from: day(5), to: day(5) })).toThrow(expect.objectContaining({ code: TAX_PNL_RANGE_INVALID }));
  });
});

describe('BookTimeline', () => {
  it('lands on the book own open lots at the book time, whatever the method', () => {
    const fills: Fill[] = [
      buy,
      {
        ...buy,
        txId: 'b2',
        postedAt: day(3, 12),
        received: { assetId: 'BTC', amount: amt('1') },
        paid: { assetId: 'USDT', amount: amt('300') },
      },
      {
        ...sell,
        txId: 's2',
        postedAt: day(6, 12),
        paid: { assetId: 'BTC', amount: amt('0.7') },
        received: { assetId: 'USDT', amount: amt('140') },
      },
      sell,
    ];
    for (const method of ['FIFO', 'LIFO', 'HIFO', 'AVERAGE'] as const) {
      const book = bookOf(fills, { BTC: '0.8', USDT: '290' }, { method });
      const at = new BookTimeline(book).positionsAt(NOW).get('BTC')!;
      expect(formatAmount(at.qty), method).toBe(book.assets.find((a) => a.assetId === 'BTC')!.openQty);
      expect(formatAmount(at.cost!), method).toBe(book.assets.find((a) => a.assetId === 'BTC')!.openCostUsd);
    }
  });

  it('follows coins moved to a space and back: gone from the main account while away', () => {
    const moves = [
      { txId: 'm1', postedAt: day(10), assetId: 'BTC', amount: amt('0.2'), from: null, to: 'space-1' },
      { txId: 'm2', postedAt: day(12), assetId: 'BTC', amount: amt('0.2'), from: 'space-1', to: null },
    ];
    const book = bookOf([buy, sell], { BTC: '0.5', USDT: '150' }, { moves });
    const timeline = new BookTimeline(book);
    expect(formatAmount(timeline.positionsAt(day(9)).get('BTC')!.qty)).toBe('0.5');
    expect(formatAmount(timeline.positionsAt(day(11)).get('BTC')!.qty)).toBe('0.3');
    expect(formatAmount(timeline.positionsAt(day(13)).get('BTC')!.qty)).toBe('0.5');
    expect(formatAmount(timeline.positionsAt(day(13)).get('BTC')!.cost!)).toBe('50');
  });
});

describe('chooseInterval and samplesOf', () => {
  it('picks the finest candle whose points fit a chart and whose window to now fits one read', () => {
    expect(chooseInterval(new Date(NOW.getTime() - DAY), NOW, NOW)).toBe('5m');
    expect(chooseInterval(new Date(NOW.getTime() - 7 * DAY), NOW, NOW)).toBe('1h');
    expect(chooseInterval(new Date(NOW.getTime() - 30 * DAY), NOW, NOW)).toBe('4h');
    expect(chooseInterval(new Date(NOW.getTime() - 365 * DAY), NOW, NOW)).toBe('1d');
    // A short range long ago still needs one read to reach it from now.
    expect(chooseInterval(new Date(NOW.getTime() - 90 * DAY), new Date(NOW.getTime() - 89 * DAY), NOW)).toBe('4h');
    expect(chooseInterval(new Date(NOW.getTime() - 20 * 365 * DAY), NOW, NOW)).toBeNull();
  });

  it('draws the start, every candle edge inside, and the end', () => {
    const points = samplesOf(day(2, 6), day(4, 6), '1d');
    expect(points.map((p) => p.toISOString())).toEqual([day(2, 6), day(3), day(4), day(4, 6)].map((d) => d.toISOString()));
  });
});

describe('TaxService.pnlOverTime', () => {
  const USER = 'u-over-time';
  const reads: TaxLedgerReads = {
    balances: async () => [
      { account: { ownerType: 'user', ownerId: USER, assetId: 'BTC', kind: 'available' }, accountId: 'a-1', amount: amt('0.5') },
      { account: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' }, accountId: 'a-2', amount: amt('150') },
    ],
    history: async () => [],
    tradeFills: async () => ({ fills: [buy, sell], truncated: false, outsideInflows: new Set<string>() }),
  };
  const asked: Array<[string, string, string, string]> = [];
  const closes: CloseSeriesSource = {
    async closes(assetId, timeframe, from, to) {
      asked.push([assetId, timeframe, from.toISOString(), to.toISOString()]);
      return dailyFrom(0);
    },
  };
  const service = (over: Partial<ConstructorParameters<typeof TaxService>[0]> = {}) =>
    new TaxService({
      mapRaw: '',
      reads,
      lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
      indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
      closes,
      now: () => NOW,
      ...over,
    });

  it('reads each coin once in the candle size the range needs, and ends a range in the future now', async () => {
    asked.length = 0;
    const out = await service().pnlOverTime({ userId: USER, from: day(1).toISOString(), to: day(30).toISOString(), utcOffsetMinutes: 0 });
    expect(out.to).toBe(NOW.toISOString());
    expect(out.interval).toBe('4h');
    expect(asked).toEqual([['BTC', '4h', day(1).toISOString(), NOW.toISOString()]]);
  });

  it('refuses a range that is empty, starts in the future or starts too long ago', async () => {
    await expect(service().pnlOverTime({ userId: USER, from: day(22).toISOString(), utcOffsetMinutes: 0 })).rejects.toMatchObject({
      code: TAX_PNL_RANGE_INVALID,
    });
    await expect(
      service().pnlOverTime({ userId: USER, from: new Date(NOW.getTime() - 20 * 365 * DAY).toISOString(), utcOffsetMinutes: 0 }),
    ).rejects.toMatchObject({ code: TAX_PNL_RANGE_TOO_LONG });
  });

  it('draws nothing from part of the market data: no source or a failed read refuses', async () => {
    const ask = { userId: USER, from: day(10).toISOString(), utcOffsetMinutes: 0 };
    await expect(service({ closes: undefined }).pnlOverTime(ask)).rejects.toMatchObject({ code: TAX_PNL_PRICES_UNAVAILABLE });
    const failing: CloseSeriesSource = { closes: async () => Promise.reject(new Error('down')) };
    await expect(service({ closes: failing }).pnlOverTime(ask)).rejects.toMatchObject({ code: TAX_PNL_PRICES_UNAVAILABLE });
  });
});
