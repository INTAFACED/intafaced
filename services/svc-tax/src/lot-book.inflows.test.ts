import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import {
  TAX_DATA_LAKE_UNAVAILABLE,
  TAX_DEPOSIT_BASIS_POLICY_UNSET,
  TAX_INDEXER_UNAVAILABLE,
  TAX_LOT_BOOK_UNRECONCILED,
  TAX_PRICE_AT_TIME_UNAVAILABLE,
} from './codes.js';
import type { InflowLine, TaxLedgerReads } from './ledger-reads.js';
import type { Fill } from './lot-book.js';
import type { PriceAtTime } from './prices.js';
import { inflowSource, TaxService, type DepositBasisPolicy } from './tax-service.js';

// Every figure here is hand-computed TEST data, not a real balance.
const USER = 'u-1';
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
const NOW = new Date(Date.UTC(2026, 9, 21, 12));

const buy: Fill = {
  txId: 'b1',
  postedAt: at(1),
  received: { assetId: 'BTC', amount: amt('1') },
  paid: { assetId: 'USDT', amount: amt('100') },
};
const sell: Fill = {
  txId: 's1',
  postedAt: at(10),
  received: { assetId: 'USDT', amount: amt('300') },
  paid: { assetId: 'BTC', amount: amt('1') },
};
const deposit: InflowLine = { txId: 'd1', postedAt: at(5), assetId: 'BTC', amount: amt('0.5'), reason: 'deposit.credited' };
const reward: InflowLine = { txId: 'r1', postedAt: at(6), assetId: 'BTC', amount: amt('0.1'), reason: 'bank.earn.interest' };

function reads(fills: Fill[], inflows: InflowLine[], held: Record<string, string>): TaxLedgerReads {
  return {
    balances: async () =>
      Object.entries(held).map(([assetId, amount]) => ({
        account: { ownerType: 'user', ownerId: USER, assetId, kind: 'available' },
        accountId: `a-${assetId}`,
        amount: amt(amount),
      })),
    history: async () => [],
    tradeFills: async () => ({ fills, truncated: false, outsideInflows: new Set(inflows.map((i) => i.assetId)), inflows }),
  };
}

/** TEST prices: BTC at 200 on day 5 and 210 on day 6, by the minute candle. */
const prices: PriceAtTime = {
  priceAt: async (assetId, when) =>
    assetId !== 'BTC'
      ? null
      : {
          price: amt(when.getUTCDate() === 5 ? '200' : '210'),
          market: 'BTC/USDT',
          timeframe: '1m',
          candleAt: new Date(Math.floor(when.getTime() / 60_000) * 60_000),
        },
};

const service = (r: TaxLedgerReads, depositBasis?: DepositBasisPolicy, withPrices = true) =>
  new TaxService({
    mapRaw: '',
    reads: r,
    lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
    indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
    now: () => NOW,
    ...(depositBasis ? { depositBasis } : {}),
    ...(withPrices ? { prices } : {}),
  });

describe('lot book: coins that were not bought', () => {
  it('a deposit and a reward are lots of their own, each valued when it arrived with the market and candle named', async () => {
    const book = await service(reads([buy], [deposit, reward], { BTC: '1.6' }), 'customer').lotBook({ userId: USER });
    expect(book.lots.map((l) => [l.id, l.source, l.qty, l.costUsd])).toEqual([
      ['lot:b1:BTC', 'trade', '1', '100'],
      ['lot:d1:BTC', 'deposit', '0.5', null],
      ['lot:r1:BTC', 'reward', '0.1', null],
    ]);
    expect(book.lots[1]!.valuedAt).toEqual({
      usd: '100',
      price: '200',
      market: 'BTC/USDT',
      timeframe: '1m',
      candleAt: at(5).toISOString(),
    });
    expect(book.lots[2]!.valuedAt?.usd).toBe('21');
    expect(book.lots[0]!.valuedAt).toBeNull(); // a bought lot's cost is what was paid
    expect(book.lots.map((l) => l.daysHeld)).toEqual([20, 16, 15]);
    expect(book.lots.every((l) => l.termClass === null)).toBe(true);
    expect(book.termRule).toEqual({ status: 'unset', code: 'tax.term_rule_unset' });
    // Under the customer policy the arrivals have no cost yet, so the asset's open cost is unknown, never zero.
    expect(book.assets.find((a) => a.assetId === 'BTC')).toMatchObject({ openQty: '1.6', openCostUsd: null, held: '1.6' });
    expect(book.residuals).not.toContain(TAX_LOT_BOOK_UNRECONCILED);
  });

  it('under the market policy an arrival costs its value when it arrived', async () => {
    const book = await service(reads([buy], [deposit, reward], { BTC: '1.6' }), 'market').lotBook({ userId: USER });
    expect(book.lots.map((l) => l.costUsd)).toEqual(['100', '100', '21']);
    expect(book.assets.find((a) => a.assetId === 'BTC')?.openCostUsd).toBe('221');
  });

  it('FIFO sells the bought coin first and keeps its result; a sale that reaches the deposit is unknown for that part', async () => {
    // Day 10: sell 1 for 300. FIFO takes the day-1 lot: realised 200.
    const first = await service(reads([buy, sell], [deposit], { BTC: '0.5' }), 'customer').lotBook({ userId: USER });
    expect(first.sales[0]).toMatchObject({ realizedUsd: '200', costUsd: '100' });
    // LIFO takes the day-5 deposit first: 0.5 has no cost, so the sale is unknown and the total stays blank.
    const lifo = await service(reads([buy, sell], [deposit], { BTC: '0.5' }), 'customer').lotBook({ userId: USER, method: 'LIFO' });
    expect(lifo.sales[0]).toMatchObject({ costUsd: null, realizedUsd: null, unmatchedQty: '0' });
    expect(lifo.sales[0]!.matches.map((m) => [m.lotId, m.qty, m.costUsd])).toEqual([
      ['lot:d1:BTC', '0.5', null],
      ['lot:b1:BTC', '0.5', '50'],
    ]);
    expect(lifo.realizedUsd).toBeNull();
  });

  it('with no policy published the arrival has no cost and the gap is named; with no price source the value is named missing', async () => {
    const unset = await service(reads([buy], [deposit], { BTC: '1.5' })).lotBook({ userId: USER });
    expect(unset.lots[1]).toMatchObject({ costUsd: null });
    expect(unset.residuals).toContain(TAX_DEPOSIT_BASIS_POLICY_UNSET);
    const blind = await service(reads([buy], [deposit], { BTC: '1.5' }), 'market', false).lotBook({ userId: USER });
    expect(blind.lots[1]).toMatchObject({ costUsd: null, valuedAt: null });
    expect(blind.residuals).toContain(TAX_PRICE_AT_TIME_UNAVAILABLE);
  });

  it('a failed price read leaves that value unknown and the book still answers', async () => {
    const broken: PriceAtTime = { priceAt: async () => Promise.reject(new Error('market data down')) };
    const book = await new TaxService({
      mapRaw: '',
      reads: reads([buy], [deposit], { BTC: '1.5' }),
      lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
      indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
      depositBasis: 'market',
      prices: broken,
    }).lotBook({ userId: USER });
    expect(book.lots[1]).toMatchObject({ costUsd: null, valuedAt: null });
    expect(book.residuals).toContain(TAX_PRICE_AT_TIME_UNAVAILABLE);
  });

  it('a dollar-coin deposit is not a lot, and coins that left another way still make the asset unknown', async () => {
    const usdt: InflowLine = { txId: 'u1', postedAt: at(2), assetId: 'USDT', amount: amt('500'), reason: 'deposit.credited' };
    const book = await service(reads([buy], [usdt, deposit], { BTC: '1', USDT: '400' }), 'market').lotBook({ userId: USER });
    expect(book.lots.map((l) => l.assetId)).toEqual(['BTC', 'BTC']);
    // 1.5 open in lots, 1 held: 0.5 left without a trade, so which lot is open is not known.
    expect(book.assets.find((a) => a.assetId === 'BTC')?.openCostUsd).toBeNull();
    expect(book.residuals).toContain(TAX_LOT_BOOK_UNRECONCILED);
  });

  it('names where a coin came from by the ledger reason', () => {
    expect(inflowSource('deposit.credited')).toBe('deposit');
    expect(inflowSource('bank.earn.interest')).toBe('reward');
    expect(inflowSource('bank.transfer.manual')).toBe('transfer_in');
    expect(inflowSource('loan.drawn')).toBe('other_in');
  });
});
