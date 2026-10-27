import { describe, expect, it } from 'vitest';
import {
  coinMethod,
  lotAccountFromQuery,
  lotAccounts,
  lotAssetFromQuery,
  lotAssets,
  lotsMissingCost,
  lotsOf,
  methodFromQuery,
  pickableLots,
  pnlFigures,
  pnlView,
  saleFeesUsd,
  spaceOf,
  viewFromQuery,
  unknownShareOf,
  type LotBook,
  type LotBookLot,
  type LotBookSale,
} from './pnl-model';
import type { MoneyRow } from './portfolio-source';

// TEST data, hand-computed.
const book = (over: Partial<LotBook> = {}): LotBook => ({
  method: 'FIFO',
  preview: false,
  choices: { status: 'saved', accountMethod: null, assetMethods: [], days: [], picks: [], includeTransfers: null },
  indicator: 'indicator_not_tax_advice',
  assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: '200', held: '1', uncountedQty: '0' }],
  sales: [],
  lots: [],
  realizedUsd: '200',
  includeTransfers: true,
  feesUsd: '0',
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
    const view = pnlView(book({ assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: '200', held: '2', uncountedQty: '0' }] }), [
      row('BTC', '2', '500'),
    ]);
    expect(view.assets[0]).toMatchObject({ valueUsd: '250', unrealisedUsd: '50', knownQty: '1', otherQty: '1' });
  });

  it('a loss is negative', () => {
    expect(pnlView(book(), [row('BTC', '1', '150')]).assets[0]).toMatchObject({ unrealisedUsd: '-50', unrealisedRatio: '-0.25' });
  });

  it('an unknown cost is not zero: unrealised is null with a reason', () => {
    const view = pnlView(book({ assets: [{ assetId: 'ETH', openQty: '10', openCostUsd: null, held: '10', uncountedQty: '0' }] }), [
      row('ETH', '10', '900'),
    ]);
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
      book({
        assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: null, held: '0.4', uncountedQty: '0' }],
        residuals: ['tax.lot_book_unreconciled'],
      }),
      [row('BTC', '0.4', '100')],
    );
    expect(view.assets[0]).toMatchObject({ unrealisedUsd: null, reason: 'not_reconciled' });
  });

  it('the total is unknown if any asset is unknown, and coins with no open lot are not listed', () => {
    const view = pnlView(
      book({
        assets: [
          { assetId: 'BTC', openQty: '1', openCostUsd: '200', held: '1', uncountedQty: '0' },
          { assetId: 'ETH', openQty: '10', openCostUsd: null, held: '10', uncountedQty: '0' },
          { assetId: 'USDT', openQty: '0', openCostUsd: '0', held: '300', uncountedQty: '0' },
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
    const view = pnlView(book({ assets: [{ assetId: 'BTC', openQty: '0.0999', openCostUsd: '7.7', held: '0.0999', uncountedQty: '0' }] }), [
      row('BTC', '0.0999', '13.2867'),
    ]);
    expect(view.assets[0]!.avgPriceUsd).toBe('77.077077077077077077');
    expect(view.assets[0]!.costUsd).toBe('7.7');
  });

  it('an unknown cost has no average price, never a zero', () => {
    const view = pnlView(book({ assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: null, held: '1', uncountedQty: '0' }] }), [
      row('BTC', '1', '250'),
    ]);
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
    counted: true,
  });
  const lots = book({ lots: [lot('lot:a:ETH', 'ETH', 'trade'), lot('lot:b:BTC', 'BTC', 'deposit'), lot('lot:c:ETH', 'ETH', 'reward')] });

  it('lists the coins that have lots in the order they first arrived, and the lots of one coin', () => {
    expect(lotAssets(lots)).toEqual(['ETH', 'BTC']);
    expect(lotsOf(lots, 'ETH').map((l) => l.id)).toEqual(['lot:a:ETH', 'lot:c:ETH']);
  });

  it('splits the lots of a coin by the account they sit in, main first, and ?account= picks one or all', () => {
    const SPACE = '33333333-3333-4333-8333-333333333333';
    const carried = {
      ...lot('lot:a:ETH>mv', 'ETH', 'trade'),
      spaceId: SPACE,
      carriedFrom: { lotId: 'lot:a:ETH', txId: 'mv', movedAt: '2026-10-21T10:00:00.000Z' },
    };
    const spaced = book({
      lots: [...lots.lots, carried],
      spaces: { status: 'read', list: [{ spaceId: SPACE, assetId: 'ETH', name: 'Cold TEST', archived: true }] },
    });
    expect(lotAccounts(spaced, 'ETH')).toEqual(['main', SPACE]);
    expect(lotAccounts(spaced, 'BTC')).toEqual(['main']);
    expect(lotsOf(spaced, 'ETH', SPACE).map((l) => l.id)).toEqual(['lot:a:ETH>mv']);
    expect(lotsOf(spaced, 'ETH', 'main').map((l) => l.id)).toEqual(['lot:a:ETH', 'lot:c:ETH']);
    expect(lotsOf(spaced, 'ETH').map((l) => l.id)).toHaveLength(3);
    expect(lotAccountFromQuery(`?account=${SPACE}`, lotAccounts(spaced, 'ETH'))).toBe(SPACE);
    expect(lotAccountFromQuery('?account=nope', lotAccounts(spaced, 'ETH'))).toBe('all');
    expect(spaceOf(spaced, SPACE)).toEqual({ name: 'Cold TEST', archived: true });
    // A sale on the main account cannot pick a lot that sits in a space.
    const sale = { assetId: 'ETH', disposedAt: '2026-10-22T10:00:00.000Z', matches: [] } as unknown as LotBookSale;
    expect(pickableLots(spaced, sale).map((l) => l.id)).toEqual(['lot:a:ETH', 'lot:c:ETH']);
    expect(spaceOf(book({ spaces: { status: 'unavailable', code: 'tax.own_spaces_unavailable' } }), SPACE)).toBeNull();
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
      choices: {
        status: 'saved',
        accountMethod: null,
        assetMethods: [{ assetId: 'ETH', method: 'HIFO' }],
        days: [],
        picks: [],
        includeTransfers: null,
      },
    });
    const sale: LotBookSale = {
      kind: 'sale',
      counted: 'all',
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
    // A lot used up by an earlier sale is not offered; one this sale or a later sale drew on is.
    const usedUp = book({
      ...withLater,
      lots: withLater.lots.map((l) => (l.id === 'lot:a:ETH' || l.id === 'lot:c:ETH' ? { ...l, remaining: '0' } : l)),
      sales: [
        {
          ...sale,
          txId: 's2',
          disposedAt: '2026-10-21T12:00:00.000Z',
          matches: [{ lotId: 'lot:c:ETH', qty: '1', costUsd: null, proceedsUsd: null, realizedUsd: null, counted: true }],
        },
      ],
    });
    expect(pickableLots(usedUp, sale).map((l) => l.id)).toEqual(['lot:c:ETH']);
    expect(coinMethod(withLater, 'ETH')).toBe('HIFO');
    expect(coinMethod(withLater, 'BTC')).toBeNull();
    expect(coinMethod(book({ choices: { status: 'unwired', code: 'tax.basis_store_unwired' } }), 'ETH')).toBeNull();
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

describe('the five views (J-portfolio-05 #1)', () => {
  // TEST data, hand-counted. Now is 24 Oct 12:00 UTC; BTC is worth 300 now and moved +30 over the last 24 hours.
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  const lot = (over: Partial<LotBookLot>): LotBookLot => ({
    id: 'lot:x:BTC',
    assetId: 'BTC',
    acquiredAt: '2026-10-01T10:00:00.000Z',
    source: 'trade',
    qty: '1',
    remaining: '1',
    costUsd: '100',
    remainingCostUsd: '100',
    valuedAt: null,
    daysHeld: 23,
    termClass: null,
    counted: true,
    ...over,
  });
  const sale = (over: Partial<LotBookSale>): LotBookSale => ({
    kind: 'sale',
    counted: 'all',
    method: 'FIFO',
    methodSource: 'default',
    pickedLotId: null,
    assetId: 'BTC',
    txId: 's1',
    disposedAt: '2026-10-10T10:00:00.000Z',
    qty: '0.5',
    unmatchedQty: '0',
    proceedsUsd: '90',
    costUsd: '50',
    realizedUsd: '40',
    matches: [],
    ...over,
  });
  // Bought 1 BTC for 100 on 1 Oct, sold 0.5 for 90 (fee $1.50) on 10 Oct, withdrew nothing counted; bought 0.5 for 140
  // six hours ago. A deposit of 2 ETH is left out (transfers off).
  const full = book({
    assets: [
      { assetId: 'BTC', openQty: '1', openCostUsd: '190', held: '1', uncountedQty: '0' },
      { assetId: 'ETH', openQty: '0', openCostUsd: '0', held: '2', uncountedQty: '2' },
    ],
    lots: [
      lot({ id: 'lot:a:BTC', remaining: '0.5', remainingCostUsd: '50' }),
      lot({
        id: 'lot:b:BTC',
        acquiredAt: '2026-10-24T06:00:00.000Z',
        qty: '0.5',
        remaining: '0.5',
        costUsd: '140',
        remainingCostUsd: '140',
      }),
      lot({
        id: 'lot:c:ETH',
        assetId: 'ETH',
        source: 'deposit',
        qty: '2',
        remaining: '2',
        costUsd: null,
        remainingCostUsd: null,
        counted: false,
      }),
    ],
    sales: [
      sale({ txId: 'w1', kind: 'moved_out', disposedAt: '2026-10-12T10:00:00.000Z', realizedUsd: '25' }),
      sale({ fee: { status: 'known', assetId: 'USDT', amount: '1.5', usd: '1.5' } }),
    ],
    realizedUsd: '65',
    includeTransfers: false,
  });
  const rows = [
    { ...row('BTC', '1', '300'), usdChange24h: '30' },
    { ...row('ETH', '2', '4000'), usdChange24h: '-80' },
  ];

  it('all time is realised plus unrealised: 65 + (300 - 190) = 175', () => {
    const f = pnlFigures(full, rows, now);
    expect(f.realised).toEqual({ kind: 'value', usd: '65' });
    expect(f.unrealised).toEqual({ kind: 'value', usd: '110' });
    expect(f.all).toEqual({ kind: 'value', usd: '175' });
  });

  it('last is the newest trade: the buy six hours ago, worth 150 now for 140, is +10; a withdrawal is not a trade', () => {
    const f = pnlFigures(full, rows, now);
    expect(f.last).toEqual({
      trade: { kind: 'buy', assetId: 'BTC', at: '2026-10-24T06:00:00.000Z', figure: { kind: 'value', usd: '10' } },
      figure: { kind: 'value', usd: '10' },
    });
    // Without that buy, the newest counted sale: +40, not the later withdrawal's 25.
    const older = pnlFigures({ ...full, lots: full.lots.filter((l) => l.id !== 'lot:b:BTC') }, rows, now);
    expect(older.last.trade).toMatchObject({ kind: 'sale', assetId: 'BTC', at: '2026-10-10T10:00:00.000Z' });
    expect(older.last.figure).toEqual({ kind: 'value', usd: '40' });
  });

  it('24 hours: the old half moved with the price (30 x 0.5 = 15), the new half counts from its cost (150 - 140 = 10); the uncounted ETH stays out', () => {
    expect(pnlFigures(full, rows, now).day).toEqual({ kind: 'value', usd: '25' });
  });

  it('an unknown part is unknown, never zero; nothing to measure says so', () => {
    const noCost = pnlFigures({ ...full, realizedUsd: null }, rows, now);
    expect(noCost.realised).toEqual({ kind: 'unknown', reason: 'cost_unknown' });
    expect(noCost.all).toEqual({ kind: 'unknown', reason: 'cost_unknown' });
    const noPrice = pnlFigures(full, [rows[1]!], now);
    expect(noPrice.unrealised).toEqual({ kind: 'unknown', reason: 'no_price' });
    expect(noPrice.day).toEqual({ kind: 'unknown', reason: 'no_price' });
    const empty = pnlFigures(book({ assets: [], lots: [], sales: [], realizedUsd: '0' }), rows, now);
    expect(empty).toMatchObject({
      all: { kind: 'none', reason: 'no_trades' },
      realised: { kind: 'none', reason: 'no_trades' },
      unrealised: { kind: 'none', reason: 'no_open_lots' },
      last: { trade: null, figure: { kind: 'none', reason: 'no_trades' } },
      day: { kind: 'none', reason: 'no_open_lots' },
    });
    // Sold everything: all time is the realised part alone.
    const closed = pnlFigures(book({ assets: [], lots: [], sales: [sale({})], realizedUsd: '40' }), rows, now);
    expect(closed.all).toEqual({ kind: 'value', usd: '40' });
  });

  it('?view= picks the view; absent or unknown is all time', () => {
    expect(viewFromQuery('')).toBe('all');
    expect(viewFromQuery('?view=day&method=FIFO')).toBe('day');
    expect(viewFromQuery('?view=last')).toBe('last');
    expect(viewFromQuery('?view=weekly')).toBe('all');
  });

  it("sale fees (#3): the counted sales' fees in dollars; a withdrawal has none; one unknown fee makes the total unknown", () => {
    expect(saleFeesUsd(full)).toBe('1.5');
    expect(saleFeesUsd(book({ sales: [] }))).toBe('0');
    expect(saleFeesUsd({ ...full, sales: [...full.sales, sale({ txId: 's2', fee: { status: 'unknown' } })] })).toBeNull();
    expect(saleFeesUsd({ ...full, sales: [...full.sales, sale({ txId: 's3', counted: 'none', fee: { status: 'unknown' } })] })).toBe('1.5');
  });

  it('a quantity from transfers left out is named on its own, not as "no recorded cost"', () => {
    // Held 2: 1 in counted lots, 0.5 from a deposit left out, and 0.5 no lot accounts for.
    const view = pnlView(book({ assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: '200', held: '2', uncountedQty: '0.5' }] }), [
      row('BTC', '2', '500'),
    ]);
    expect(view.assets[0]).toMatchObject({ knownQty: '1', otherQty: '0.5', uncountedQty: '0.5', valueUsd: '250', unrealisedUsd: '50' });
  });
  it('a coin held only in lots left out is listed as not counted, and stays out of every figure', () => {
    const only = book({
      assets: [{ assetId: 'ETH', openQty: '0', openCostUsd: '0', held: '2', uncountedQty: '2' }],
      sales: [],
      realizedUsd: null,
    });
    const view = pnlView(only, rows);
    expect(view.assets).toMatchObject([
      { asset: 'ETH', knownQty: '0', uncountedQty: '2', otherQty: '0', reason: 'not_counted', costUsd: null },
    ]);
    expect(view.assets[0]!.valueUsd).toBe('4000');
    expect(view.unrealisedUsd).toBeNull();
    expect(pnlFigures(only, rows, now).unrealised).toEqual({ kind: 'none', reason: 'no_open_lots' });
  });

  it('not reconciled is checked against every open lot, counted or not', () => {
    const short = book({
      assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: null, held: '1.5', uncountedQty: '1' }],
      residuals: ['tax.lot_book_unreconciled'],
    });
    expect(pnlView(short, rows).assets[0]).toMatchObject({ reason: 'not_reconciled' });
  });

  it('a buy whose coins all left is not the last trade: the newest sale is', () => {
    const gone = { ...full, lots: full.lots.map((l) => (l.id === 'lot:b:BTC' ? { ...l, remaining: '0', remainingCostUsd: '0' } : l)) };
    expect(pnlFigures(gone, rows, now).last.trade).toMatchObject({ kind: 'sale', at: '2026-10-10T10:00:00.000Z' });
  });

  it('24 hours is unknown when the book is incomplete or a coin does not reconcile, never a number from lots it cannot trust', () => {
    expect(pnlFigures({ ...full, residuals: ['tax.lot_book_incomplete'] }, rows, now).day).toEqual({
      kind: 'unknown',
      reason: 'cost_unknown',
    });
    const short = {
      ...full,
      assets: [{ assetId: 'BTC', openQty: '1', openCostUsd: null, held: '0.5', uncountedQty: '0' }],
      residuals: ['tax.lot_book_unreconciled'],
    };
    expect(pnlFigures(short, rows, now).day).toEqual({ kind: 'unknown', reason: 'cost_unknown' });
  });
});
