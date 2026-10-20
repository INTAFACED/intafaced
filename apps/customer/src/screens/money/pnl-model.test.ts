import { describe, expect, it } from 'vitest';
import { pnlView, type LotBook } from './pnl-model';
import type { MoneyRow } from './portfolio-source';

// TEST data, hand-computed.
const book = (over: Partial<LotBook> = {}): LotBook => ({
  method: 'FIFO',
  indicator: 'indicator_not_tax_advice',
  assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: '200', held: '1' }],
  sales: [],
  realizedUsd: '200',
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
