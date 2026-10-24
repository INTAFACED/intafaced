import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { TAX_DATA_LAKE_UNAVAILABLE, TAX_INDEXER_UNAVAILABLE, TAX_LOT_BOOK_UNRECONCILED, TAX_PRICE_AT_TIME_UNAVAILABLE } from './codes.js';
import { createMemoryChoiceStore } from './choices.js';
import type { AccountLine, InflowLine, TaxLedgerReads } from './ledger-reads.js';
import type { Fill } from './lot-book.js';
import type { PriceAtTime } from './prices.js';
import { TaxService } from './tax-service.js';
import { outsideWithdrawals } from './withdrawals.js';

// J-portfolio-05 #2 and #3 (PF-performance-02). Every figure is hand-computed TEST data, not a real balance.
const USER = 'u-transfers';
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
const NOW = new Date(Date.UTC(2026, 9, 21, 12));

// Day 1: buy 1 BTC for 100 USDT, no fee (the ledger says 0). Day 8: sell 0.5 BTC, 150 USDT received after a 1.5 USDT fee.
const buy: Fill = {
  txId: 'b1',
  postedAt: at(1),
  received: { assetId: 'BTC', amount: amt('1') },
  paid: { assetId: 'USDT', amount: amt('100') },
  fee: 0n,
};
const sell: Fill = {
  txId: 's1',
  postedAt: at(8),
  received: { assetId: 'USDT', amount: amt('150') },
  paid: { assetId: 'BTC', amount: amt('0.5') },
  fee: amt('1.5'),
};
// Day 5: 0.5 BTC deposited from outside (worth 100 at 200). Day 9: 0.5 BTC withdrawn (worth 125 at 250).
const deposit: InflowLine = { txId: 'd1', postedAt: at(5), assetId: 'BTC', amount: amt('0.5'), reason: 'deposit.credited' };
const withdrawal: AccountLine = {
  txId: 'w1',
  postedAt: at(9),
  assetId: 'BTC',
  amount: amt('0.5'),
  reason: 'withdraw.held',
  direction: 'credit',
};
const orderHold: AccountLine = { ...withdrawal, txId: 'h1', reason: 'order.hold', amount: amt('0.5'), postedAt: at(8) };

const prices: PriceAtTime = {
  priceAt: async (assetId, when) =>
    assetId !== 'BTC'
      ? null
      : {
          price: amt(when.getUTCDate() === 5 ? '200' : when.getUTCDate() === 9 ? '250' : '300'),
          market: 'BTC/USDT',
          timeframe: '1m',
          candleAt: new Date(Math.floor(when.getTime() / 60_000) * 60_000),
        },
};

type Row = { assetId: string; amount: string; kind?: 'available' | 'hold'; purpose?: string };

function reads(opts: { held: Row[]; outflows?: AccountLine[]; returns?: AccountLine[]; inflows?: InflowLine[] }): TaxLedgerReads {
  const inflows = opts.inflows ?? [deposit];
  return {
    balances: async () =>
      opts.held.map((row, i) => ({
        account: {
          ownerType: 'user' as const,
          ownerId: USER,
          assetId: row.assetId,
          kind: row.kind ?? 'available',
          ...(row.purpose ? { purpose: row.purpose } : {}),
        },
        accountId: `a-${i}`,
        amount: amt(row.amount),
      })),
    history: async () => [],
    tradeFills: async () => ({
      fills: [buy, sell],
      truncated: false,
      outsideInflows: new Set(inflows.map((i) => i.assetId)),
      inflows,
      outflows: [orderHold, ...(opts.outflows ?? [withdrawal])],
      withdrawalReturns: opts.returns ?? [],
    }),
  };
}

const service = (r: TaxLedgerReads, choices = createMemoryChoiceStore()) =>
  new TaxService({
    mapRaw: '',
    reads: r,
    lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
    indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
    depositBasis: 'market',
    prices,
    choices,
    now: () => NOW,
  });

describe('withdrawals and whether transfers count', () => {
  it('transfers count (the default): the deposit is a lot at its value then, the withdrawal a disposal at its value when it left', async () => {
    const book = await service(reads({ held: [{ assetId: 'BTC', amount: '0.5' }] })).lotBook({ userId: USER });
    expect(book.includeTransfers).toBe(true);
    // FIFO: the sale takes half the bought lot (cost 50, received 150: +100); the withdrawal the other half (cost 50, worth 125: +75).
    expect(book.sales.map((s) => [s.kind, s.counted, s.costUsd, s.proceedsUsd, s.realizedUsd])).toEqual([
      ['moved_out', 'all', '50', '125', '75'],
      ['sale', 'all', '50', '150', '100'],
    ]);
    expect(book.realizedUsd).toBe('175');
    // Left open: the deposited 0.5, at its value when it arrived.
    expect(book.assets.find((a) => a.assetId === 'BTC')).toEqual({
      assetId: 'BTC',
      openQty: '0.5',
      openCostUsd: '100',
      held: '0.5',
      uncountedQty: '0',
    });
    expect(book.residuals).not.toContain(TAX_LOT_BOOK_UNRECONCILED);
  });

  it('transfers left out: the deposit lot and the withdrawal stay listed but count for nothing; the trades still do', async () => {
    const choices = createMemoryChoiceStore();
    const tax = service(reads({ held: [{ assetId: 'BTC', amount: '0.5' }] }), choices);
    await tax.setIncludeTransfers({ userId: USER, include: false });
    const book = await tax.lotBook({ userId: USER });
    expect(book.includeTransfers).toBe(false);
    expect(book.choices).toMatchObject({ status: 'saved', includeTransfers: false });
    expect(book.sales.map((s) => [s.kind, s.counted, s.realizedUsd])).toEqual([
      ['moved_out', 'none', null],
      ['sale', 'all', '100'],
    ]);
    expect(book.sales[0]!.matches.every((m) => !m.counted)).toBe(true);
    expect(book.realizedUsd).toBe('100');
    expect(book.lots.map((lot) => [lot.source, lot.counted])).toEqual([
      ['trade', true],
      ['deposit', false],
    ]);
    // Nothing counted is open; the deposited coins are named apart.
    expect(book.assets.find((a) => a.assetId === 'BTC')).toMatchObject({ openQty: '0', uncountedQty: '0.5', held: '0.5' });
    // A preview changes the method only, never this choice.
    expect((await tax.lotBook({ userId: USER, method: 'LIFO' })).includeTransfers).toBe(false);
    // Clearing it goes back to the default: they count.
    await tax.setIncludeTransfers({ userId: USER, include: null });
    expect((await tax.lotBook({ userId: USER })).realizedUsd).toBe('175');
  });

  it('left out, a sale that drew on a deposit lot counts only its bought part', async () => {
    const tax = service(reads({ held: [{ assetId: 'BTC', amount: '1' }], outflows: [], inflows: [{ ...deposit, postedAt: at(0) }] }));
    await tax.setIncludeTransfers({ userId: USER, include: false });
    // FIFO: the day-0 deposit lot is oldest, so the day-8 sale of 0.5 draws all of it: none of the sale counts.
    const book = await tax.lotBook({ userId: USER });
    expect(book.sales).toMatchObject([{ kind: 'sale', counted: 'none', realizedUsd: null }]);
    expect(book.realizedUsd).toBeNull();
    // The bought lot is still all open and counted.
    expect(book.assets.find((a) => a.assetId === 'BTC')).toMatchObject({ openQty: '1', openCostUsd: '100', uncountedQty: '0' });
  });

  it('a withdrawal held on its way out is gone from the book, and its hold is not counted as held', async () => {
    const book = await service(
      reads({
        held: [
          { assetId: 'BTC', amount: '0' },
          { assetId: 'BTC', amount: '0.5', kind: 'hold', purpose: 'withdraw:w1' },
          { assetId: 'BTC', amount: '0.5', kind: 'available' },
        ],
      }),
    ).lotBook({ userId: USER });
    expect(book.assets.find((a) => a.assetId === 'BTC')).toMatchObject({ held: '0.5', openQty: '0.5', openCostUsd: '100' });
    expect(book.residuals).not.toContain(TAX_LOT_BOOK_UNRECONCILED);
  });

  it('a withdrawal the rail failed and put back did not happen: no disposal, and the coins are still in their lots', async () => {
    const back: AccountLine = { ...withdrawal, txId: 'w1-back', reason: 'withdraw.reversed', direction: 'debit', postedAt: at(10) };
    const book = await service(reads({ held: [{ assetId: 'BTC', amount: '1' }], returns: [back] })).lotBook({ userId: USER });
    expect(book.sales.map((s) => s.kind)).toEqual(['sale']);
    expect(book.realizedUsd).toBe('100');
    expect(book.assets.find((a) => a.assetId === 'BTC')).toMatchObject({ openQty: '1', openCostUsd: '150', held: '1' });
  });

  it('a withdrawal with no price when it left has an unknown result, named, never a zero', async () => {
    const noPrices: PriceAtTime = { priceAt: async (assetId, when) => (when.getUTCDate() === 9 ? null : prices.priceAt(assetId, when)) };
    const tax = new TaxService({
      mapRaw: '',
      reads: reads({ held: [{ assetId: 'BTC', amount: '0.5' }] }),
      lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
      indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
      depositBasis: 'market',
      prices: noPrices,
      choices: createMemoryChoiceStore(),
      now: () => NOW,
    });
    const book = await tax.lotBook({ userId: USER });
    expect(book.sales[0]).toMatchObject({ kind: 'moved_out', proceedsUsd: null, realizedUsd: null });
    expect(book.realizedUsd).toBeNull();
    expect(book.residuals).toContain(TAX_PRICE_AT_TIME_UNAVAILABLE);
  });

  it("each sale's fee is on its own line and already inside the result; a buy's fee is valued at the fill's price", async () => {
    const book = await service(reads({ held: [{ assetId: 'BTC', amount: '0.5' }] })).lotBook({ userId: USER });
    expect(book.sales.find((s) => s.kind === 'sale')?.fee).toEqual({ status: 'known', assetId: 'USDT', amount: '1.5', usd: '1.5' });
    expect(book.sales.find((s) => s.kind === 'moved_out')?.fee).toBeUndefined();
    expect(book.lots.find((lot) => lot.source === 'trade')?.fee).toEqual({ status: 'known', assetId: 'BTC', amount: '0', usd: '0' });
    expect(book.feesUsd).toBe('1.5');
  });

  it('a fee in the coin bought is worth what the fill paid for it: 0.01 BTC of a 1.01 BTC fill bought for 101 is 1', async () => {
    const feeBuy: Fill = {
      ...buy,
      received: { assetId: 'BTC', amount: amt('1') },
      paid: { assetId: 'USDT', amount: amt('101') },
      fee: amt('0.01'),
    };
    const tax = new TaxService({
      mapRaw: '',
      reads: {
        ...reads({ held: [{ assetId: 'BTC', amount: '1' }] }),
        tradeFills: async () => ({
          fills: [feeBuy],
          truncated: false,
          outsideInflows: new Set(),
          inflows: [],
          outflows: [],
          withdrawalReturns: [],
        }),
      },
      lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
      indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
      now: () => NOW,
    });
    const book = await tax.lotBook({ userId: USER });
    // The lot is 1 BTC for 101: the fee is inside its cost (101 a coin, not 100), and shown as 1 dollar apart.
    expect(book.lots[0]).toMatchObject({ qty: '1', costUsd: '101', fee: { status: 'known', assetId: 'BTC', amount: '0.01', usd: '1' } });
    expect(book.feesUsd).toBe('1');
  });
});

describe('outsideWithdrawals', () => {
  const held = (txId: string, day: number, amount: string): AccountLine => ({
    ...withdrawal,
    txId,
    postedAt: at(day),
    amount: amt(amount),
  });
  const back = (txId: string, day: number, amount: string): AccountLine => ({
    ...withdrawal,
    txId,
    postedAt: at(day),
    amount: amt(amount),
    reason: 'withdraw.reversed',
    direction: 'debit',
  });

  it('keeps only withdrawals, and a return cancels the latest earlier one of the same coin and amount', () => {
    const kept = outsideWithdrawals([orderHold, held('w1', 2, '1'), held('w2', 3, '1'), held('w3', 4, '2')], [back('r2', 5, '1')]);
    expect(kept.map((l) => l.txId)).toEqual(['w1', 'w3']);
  });

  it('a return before any matching withdrawal, or of another amount, cancels nothing', () => {
    expect(outsideWithdrawals([held('w1', 5, '1')], [back('r0', 4, '1'), back('r1', 6, '0.5')]).map((l) => l.txId)).toEqual(['w1']);
  });

  it('two returns cancel two withdrawals, never the same one twice', () => {
    expect(outsideWithdrawals([held('w1', 1, '1'), held('w2', 2, '1')], [back('r1', 3, '1'), back('r2', 4, '1')])).toEqual([]);
  });
});
