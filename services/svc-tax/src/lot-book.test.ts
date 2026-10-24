import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_BOOK_INCOMPLETE, TAX_LOT_BOOK_UNRECONCILED, TAX_LOT_UNDERFLOW } from './codes.js';
import { buildLotBook, type Fill } from './lot-book.js';

// Every figure here is hand-computed TEST data, not a real balance.
const at = (n: number) => new Date(Date.UTC(2026, 9, n));
const buy = (txId: string, day: number, asset: string, qty: string, paidUsdt: string): Fill => ({
  txId,
  postedAt: at(day),
  received: { assetId: asset, amount: amt(qty) },
  paid: { assetId: 'USDT', amount: amt(paidUsdt) },
});
const sell = (txId: string, day: number, asset: string, qty: string, gotUsdt: string): Fill => ({
  txId,
  postedAt: at(day),
  received: { assetId: 'USDT', amount: amt(gotUsdt) },
  paid: { assetId: asset, amount: amt(qty) },
});
const held = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, amt(v)]));

describe('buildLotBook', () => {
  const fills = [buy('t1', 1, 'BTC', '1', '100'), buy('t2', 2, 'BTC', '1', '200'), sell('t3', 3, 'BTC', '1', '300')];

  it('FIFO: buy 1 at 100, buy 1 at 200, sell 1 at 300 realises 200 and leaves the 200 lot open', () => {
    const book = buildLotBook({ fills, held: held({ BTC: '1', USDT: '300' }), method: 'FIFO', truncated: false });
    expect(book.sales).toEqual([
      {
        kind: 'sale',
        counted: 'all',
        fee: { status: 'unknown' },
        method: 'FIFO',
        methodSource: 'default',
        pickedLotId: null,
        assetId: 'BTC',
        txId: 't3',
        disposedAt: at(3).toISOString(),
        qty: '1',
        unmatchedQty: '0',
        proceedsUsd: '300',
        costUsd: '100',
        realizedUsd: '200',
        matches: [{ lotId: 'lot:t1:BTC', qty: '1', costUsd: '100', proceedsUsd: '300', realizedUsd: '200', counted: true }],
      },
    ]);
    expect(book.realizedUsd).toBe('200');
    expect(book.assets.find((a) => a.assetId === 'BTC')).toEqual({
      assetId: 'BTC',
      openQty: '1',
      openCostUsd: '200',
      held: '1',
      uncountedQty: '0',
    });
    expect(book.indicator).toBe('indicator_not_tax_advice');
    expect(book.residuals).toEqual([]);
  });

  it('LIFO sells the newest lot and realises 100; HIFO the dearest, also 100', () => {
    expect(buildLotBook({ fills, held: held({ BTC: '1' }), method: 'LIFO', truncated: false }).realizedUsd).toBe('100');
    expect(buildLotBook({ fills, held: held({ BTC: '1' }), method: 'HIFO', truncated: false }).realizedUsd).toBe('100');
  });

  it('a sale of coins that arrived by deposit reaches no lot: unmatched and unknown, never a made-up cost', () => {
    const book = buildLotBook({ fills: [sell('s1', 5, 'BTC', '1', '300')], held: held({ BTC: '1' }), method: 'FIFO', truncated: false });
    expect(book.sales[0]).toMatchObject({ unmatchedQty: '1', costUsd: null, realizedUsd: null, proceedsUsd: '300' });
    expect(book.realizedUsd).toBeNull();
    expect(book.residuals).toContain(TAX_LOT_UNDERFLOW);
  });

  it('a sale that is half deposit and half bought is unknown as a whole', () => {
    const book = buildLotBook({
      fills: [buy('b1', 1, 'BTC', '1', '100'), sell('s1', 2, 'BTC', '2', '500')],
      held: held({ BTC: '0' }),
      method: 'FIFO',
      truncated: false,
    });
    expect(book.sales[0]).toMatchObject({ qty: '2', unmatchedQty: '1', realizedUsd: null });
    expect(book.realizedUsd).toBeNull();
  });

  it('a trade between two non-dollar coins has no dollar figure on either side', () => {
    const swap: Fill = {
      txId: 'x1',
      postedAt: at(1),
      received: { assetId: 'ETH', amount: amt('10') },
      paid: { assetId: 'BTC', amount: amt('1') },
    };
    const book = buildLotBook({
      fills: [buy('b1', 0, 'BTC', '1', '100'), swap],
      held: held({ ETH: '10' }),
      method: 'FIFO',
      truncated: false,
    });
    expect(book.assets.find((a) => a.assetId === 'ETH')).toMatchObject({ openQty: '10', openCostUsd: null });
    expect(book.sales[0]).toMatchObject({ assetId: 'BTC', proceedsUsd: null, realizedUsd: null });
    expect(book.residuals).toContain(TAX_COST_BASIS_UNAVAILABLE);
  });

  it('dollar coin for dollar coin is not a position', () => {
    const swap: Fill = {
      txId: 'p1',
      postedAt: at(1),
      received: { assetId: 'USDC', amount: amt('50') },
      paid: { assetId: 'USDT', amount: amt('50') },
    };
    const book = buildLotBook({ fills: [swap], held: held({ USDC: '50' }), method: 'FIFO', truncated: false });
    expect(book.sales).toEqual([]);
    expect(book.assets.map((a) => a.assetId)).toEqual(['USDC']);
  });

  it('more open in lots than held (coins left another way) makes that asset cost unknown', () => {
    const book = buildLotBook({ fills: [buy('b1', 1, 'BTC', '1', '100')], held: held({ BTC: '0.4' }), method: 'FIFO', truncated: false });
    expect(book.assets[0]).toMatchObject({ assetId: 'BTC', openQty: '1', openCostUsd: null, held: '0.4' });
    expect(book.residuals).toContain(TAX_LOT_BOOK_UNRECONCILED);
  });

  it('no sale is a null result, not a zero', () => {
    const book = buildLotBook({ fills: [buy('b1', 1, 'BTC', '1', '100')], held: held({ BTC: '1' }), method: 'FIFO', truncated: false });
    expect(book.sales).toEqual([]);
    expect(book.realizedUsd).toBeNull();
  });

  it('an unread paying leg and a cut-short read are named, not hidden', () => {
    const lonely: Fill = { txId: 'l1', postedAt: at(1), received: { assetId: 'BTC', amount: amt('1') }, paid: null };
    const book = buildLotBook({ fills: [lonely], held: held({ BTC: '1' }), method: 'FIFO', truncated: true });
    expect(book.residuals).toContain(TAX_LOT_BOOK_INCOMPLETE);
    expect(book.assets[0]).toMatchObject({ openQty: '1', openCostUsd: null });
  });

  it('an empty book is empty', () => {
    expect(buildLotBook({ fills: [], held: held({}), method: 'FIFO', truncated: false })).toMatchObject({
      assets: [],
      sales: [],
      realizedUsd: null,
      residuals: [],
    });
  });

  it('coins held beyond what fills account for make the result unknown: a deposit may have been sold first', () => {
    // 1 BTC deposited (no lot), bought 1 at 100, sold 1 at 300: under FIFO the deposited coin could have gone first.
    const book = buildLotBook({
      fills: [buy('b1', 1, 'BTC', '1', '100'), sell('s1', 2, 'BTC', '1', '300')],
      held: held({ BTC: '1' }),
      method: 'FIFO',
      truncated: false,
    });
    expect(book.sales[0]).toMatchObject({ costUsd: null, realizedUsd: null, proceedsUsd: '300' });
    expect(book.realizedUsd).toBeNull();
    expect(book.assets.find((a) => a.assetId === 'BTC')).toMatchObject({ openQty: '0', openCostUsd: null, held: '1' });
    expect(book.residuals).toContain(TAX_LOT_BOOK_UNRECONCILED);
  });

  it('a cut-short read shows no result and no cost, only the named incompleteness', () => {
    const book = buildLotBook({ fills, held: held({ BTC: '1' }), method: 'FIFO', truncated: true });
    expect(book.realizedUsd).toBeNull();
    expect(book.sales[0]).toMatchObject({ realizedUsd: null, costUsd: null });
    expect(book.assets.find((a) => a.assetId === 'BTC')?.openCostUsd).toBeNull();
    expect(book.residuals).toContain(TAX_LOT_BOOK_INCOMPLETE);
  });

  it('dollar coins held with no lots do not count as unreconciled', () => {
    const book = buildLotBook({ fills, held: held({ BTC: '1', USDT: '300' }), method: 'FIFO', truncated: false });
    expect(book.residuals).toEqual([]);
  });

  it('a coin that arrived outside a fill makes its sales unknown even when nothing is held at the end', () => {
    // 2 ETH deposited, 1 bought at 2000, 1 sold at 3000, all withdrawn: FIFO may have sold the deposited coin.
    const book = buildLotBook({
      fills: [buy('b1', 1, 'ETH', '1', '2000'), sell('s1', 2, 'ETH', '1', '3000')],
      held: held({ USDT: '1000' }),
      method: 'FIFO',
      truncated: false,
      outsideInflows: new Set(['ETH']),
    });
    expect(book.sales[0]?.costUsd).toBeNull();
    expect(book.sales[0]?.realizedUsd).toBeNull();
    expect(book.realizedUsd).toBeNull();
    expect(book.residuals).toContain(TAX_LOT_BOOK_UNRECONCILED);
  });

  it('a dollar-coin deposit does not make anything unknown', () => {
    const book = buildLotBook({
      fills: [buy('b1', 1, 'ETH', '1', '2000'), sell('s1', 2, 'ETH', '1', '3000')],
      held: held({ USDT: '3000' }),
      method: 'FIFO',
      truncated: false,
      outsideInflows: new Set(['USDT']),
    });
    expect(book.realizedUsd).toBe('1000');
  });
});
