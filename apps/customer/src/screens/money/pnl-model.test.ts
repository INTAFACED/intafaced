import { describe, expect, it } from 'vitest';
import {
  coinMethod,
  lotAssetFromQuery,
  lotAssets,
  lotsOf,
  methodFromQuery,
  pickableLots,
  pnlView,
  type LotBook,
  type LotBookLot,
  type LotBookSale,
} from './pnl-model';
import type { MoneyRow } from './portfolio-source';

// TEST data, hand-computed.
const book = (over: Partial<LotBook> = {}): LotBook => ({
  method: 'FIFO',
  preview: false,
  choices: { status: 'saved', accountMethod: null, assetMethods: [], days: [], picks: [] },
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

  it('?method= absent is your saved choices; a method in any case is a preview of it; anything else is named unknown', () => {
    expect(methodFromQuery('')).toBe('saved');
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

  it('a sale can pick a lot of its own coin that arrived by then; a coin method is read from the saved choices', () => {
    const later = { ...lot('lot:d:ETH', 'ETH', 'trade'), acquiredAt: '2026-10-22T10:00:00.000Z' };
    const withLater = book({
      ...lots,
      lots: [...lots.lots, later],
      choices: { status: 'saved', accountMethod: null, assetMethods: [{ assetId: 'ETH', method: 'HIFO' }], days: [], picks: [] },
    });
    const sale: LotBookSale = {
      method: 'FIFO',
      methodSource: 'default',
      pickedLotId: null,
      assetId: 'ETH',
      txId: 's1',
      disposedAt: '2026-10-21T10:00:00.000Z',
      qty: '1',
      unmatchedQty: '0',
      proceedsUsd: null,
      costUsd: null,
      realizedUsd: null,
      matches: [],
    };
    expect(pickableLots(withLater, sale).map((l) => l.id)).toEqual(['lot:a:ETH', 'lot:c:ETH']);
    expect(coinMethod(withLater, 'ETH')).toBe('HIFO');
    expect(coinMethod(withLater, 'BTC')).toBeNull();
    expect(coinMethod(book({ choices: { status: 'unwired', code: 'tax.database_url_unset' } }), 'ETH')).toBeNull();
  });
});
