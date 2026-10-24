import { describe, expect, it } from 'vitest';
import {
  lotAssetFromQuery,
  lotAssets,
  lotsMissingCost,
  lotsOf,
  methodFromQuery,
  pnlView,
  unknownShareOf,
  type LotBook,
  type LotBookLot,
} from './pnl-model';
import type { MoneyRow } from './portfolio-source';

// TEST data, hand-computed.
const book = (over: Partial<LotBook> = {}): LotBook => ({
  method: 'FIFO',
  indicator: 'indicator_not_tax_advice',
  assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: '200', held: '1' }],
  sales: [],
  lots: [],
  realizedUsd: '200',
  termRule: { status: 'unset', code: 'tax.term_rule_unset' },
  residuals: [],
  ...over,
});
const row = (asset: string, amount: string, usdValue: string | null): MoneyRow => ({
  asset,
  class: 'crypto',
  amount,
  usdValue,
  usdChange24h: null,
  changeRatio: null,
  share: null,
  priceSymbol: null,
  priceUsd: null,
});

describe('pnlView', () => {
  it('unrealised is value now less open cost: 1 BTC bought at 200, worth 250, is +50 (25%)', () => {
    const view = pnlView(book(), [row('BTC', '1', '250')]);
    expect(view.assets[0]).toMatchObject({
      asset: 'BTC',
      costUsd: '200',
      valueUsd: '250',
      unrealisedUsd: '50',
      unrealisedRatio: '0.25',
      reason: null,
    });
    expect(view.unrealisedUsd).toBe('50');
    expect(view.realisedUsd).toBe('200');
  });

  it('values only the part the trades account for when more is held (a deposit on top)', () => {
    // 2 BTC held, worth 500 in all; 1 is from trades at cost 200: its share of the value is 250.
    const view = pnlView(book({ assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: '200', held: '2' }] }), [row('BTC', '2', '500')]);
    expect(view.assets[0]).toMatchObject({ valueUsd: '250', unrealisedUsd: '50', knownQty: '1', otherQty: '1' });
  });

  it('a loss is negative', () => {
    expect(pnlView(book(), [row('BTC', '1', '150')]).assets[0]).toMatchObject({ unrealisedUsd: '-50', unrealisedRatio: '-0.25' });
  });

  it('an unknown cost is not zero: unrealised is null with a reason', () => {
    const view = pnlView(book({ assets: [{ assetId: 'ETH', openQty: '10', openCostUsd: null, held: '10' }] }), [row('ETH', '10', '900')]);
    expect(view.assets[0]).toMatchObject({ costUsd: null, valueUsd: '900', unrealisedUsd: null, reason: 'cost_unknown' });
    expect(view.unrealisedUsd).toBeNull();
  });

  it('no price for the coin leaves value and unrealised unknown', () => {
    const view = pnlView(book(), [row('BTC', '1', null)]);
    expect(view.assets[0]).toMatchObject({ valueUsd: null, unrealisedUsd: null, reason: 'no_price' });
    expect(pnlView(book(), null).assets[0]).toMatchObject({ unrealisedUsd: null, reason: 'no_price' });
  });

  it('when coins left another way the cost is unknown and says so', () => {
    const view = pnlView(
      book({ assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: null, held: '0.4' }], residuals: ['tax.lot_book_unreconciled'] }),
      [row('BTC', '0.4', '100')],
    );
    expect(view.assets[0]).toMatchObject({ unrealisedUsd: null, reason: 'not_reconciled' });
  });

  it('the total is unknown if any asset is unknown, and coins with no open lot are not listed', () => {
    const view = pnlView(
      book({
        assets: [
          { assetId: 'BTC', openQty: '1', openCostUsd: '200', held: '1' },
          { assetId: 'ETH', openQty: '10', openCostUsd: null, held: '10' },
          { assetId: 'USDT', openQty: '0', openCostUsd: '0', held: '300' },
        ],
      }),
      [row('BTC', '1', '250'), row('ETH', '10', '900')],
    );
    expect(view.assets.map((a) => a.asset)).toEqual(['BTC', 'ETH']);
    expect(view.unrealisedUsd).toBeNull();
  });

  it('an empty book has no assets and no total', () => {
    expect(pnlView(book({ assets: [], realizedUsd: null }), [])).toEqual({ assets: [], unrealisedUsd: null, realisedUsd: null });
  });
});

describe('average price and the method in the link', () => {
  it('average price is open cost over open quantity, fee inside: 0.0999 BTC received for 7.7 USDT is 77.077077...', () => {
    const view = pnlView(book({ assets: [{ assetId: 'BTC', openQty: '0.0999', openCostUsd: '7.7', held: '0.0999' }] }), [
      row('BTC', '0.0999', '13.2867'),
    ]);
    expect(view.assets[0]!.avgPriceUsd).toBe('77.077077077077077077');
    expect(view.assets[0]!.costUsd).toBe('7.7');
  });

  it('an unknown cost has no average price, never a zero', () => {
    const view = pnlView(book({ assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: null, held: '1' }] }), [row('BTC', '1', '250')]);
    expect(view.assets[0]!.avgPriceUsd).toBeNull();
  });

  it('?method= picks FIFO by default, takes the three methods in any case, and names anything else as unknown', () => {
    expect(methodFromQuery('')).toBe('FIFO');
    expect(methodFromQuery('?method=lifo')).toBe('LIFO');
    expect(methodFromQuery('?method=HIFO')).toBe('HIFO');
    expect(methodFromQuery('?method=average')).toBe('AVERAGE');
    expect(methodFromQuery('?method=LOFO')).toEqual({ unknown: 'LOFO' });
  });
});

describe('lots', () => {
  const lot = (id: string, assetId: string, source: LotBookLot['source']): LotBookLot => ({
    id,
    assetId,
    acquiredAt: '2026-10-20T10:00:00.000Z',
    source,
    qty: '1',
    remaining: '1',
    costUsd: null,
    remainingCostUsd: null,
    valuedAt: null,
    daysHeld: 0,
    termClass: null,
  });
  const lots = book({ lots: [lot('lot:a:ETH', 'ETH', 'trade'), lot('lot:b:BTC', 'BTC', 'deposit'), lot('lot:c:ETH', 'ETH', 'reward')] });

  it('lists the coins that have lots in the order they first arrived, and the lots of one coin', () => {
    expect(lotAssets(lots)).toEqual(['ETH', 'BTC']);
    expect(lotsOf(lots, 'ETH').map((l) => l.id)).toEqual(['lot:a:ETH', 'lot:c:ETH']);
  });

  it('?asset= picks the coin, any case; an unknown or absent one falls back to the first', () => {
    expect(lotAssetFromQuery('?asset=btc', lotAssets(lots))).toBe('BTC');
    expect(lotAssetFromQuery('?asset=DOGE', lotAssets(lots))).toBe('ETH');
    expect(lotAssetFromQuery('', [])).toBeNull();
  });
});

describe('missing cost', () => {
  const missing = {
    items: [
      {
        lotId: 'lot:d1:BTC',
        assetId: 'BTC',
        kind: 'open' as const,
        qty: '0.003',
        code: 'tax.cost_basis_unavailable' as const,
        effect: 'unknown share' as const,
        saleTxId: null,
      },
      {
        lotId: 'lot:d1:BTC',
        assetId: 'BTC',
        kind: 'disposal' as const,
        qty: '0.001',
        code: 'tax.cost_basis_unavailable' as const,
        effect: 'unknown share' as const,
        saleTxId: 's1',
      },
      {
        lotId: null,
        assetId: 'BTC',
        kind: 'disposal' as const,
        qty: '0.0005',
        code: 'tax.lot_underflow' as const,
        effect: 'unknown share' as const,
        saleTxId: 's2',
      },
    ],
  };

  it('lists the open lots with no cost, and the unknown parts of one sale', () => {
    expect(lotsMissingCost(missing).map((item) => item.lotId)).toEqual(['lot:d1:BTC']);
    expect(unknownShareOf(missing, { txId: 's1', assetId: 'BTC' }).map((item) => item.qty)).toEqual(['0.001']);
    expect(unknownShareOf(missing, { txId: 's2', assetId: 'BTC' }).map((item) => item.lotId)).toEqual([null]);
    expect(unknownShareOf(missing, { txId: 's3', assetId: 'BTC' })).toEqual([]);
  });
});
