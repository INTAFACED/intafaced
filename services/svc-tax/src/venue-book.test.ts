import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { lotBookSchema } from '@intafaced/contracts/tax-lot-book';
import type { TradeVenueAccountActivity, TradeVenueActivityResult } from '@intafaced/contracts';
import { buildLotBook, type Fill } from './lot-book.js';
import { venueAccountKey, venueFillToFill, withVenue } from './venue-book.js';

// J-cex-spot-01 #11: the person's own venue account in their profit and loss indicator. Every figure is TEST.
const OWNER = '0x00000000000000000000000000000000000000a1';
const ACCOUNT = `venue:test-venue:${OWNER}`;
const NOW = new Date('2026-11-12T00:00:00.000Z');
const shared = { method: 'FIFO' as const, preview: false, includeTransfers: true, now: NOW };

type VenueFill = TradeVenueAccountActivity['fills'][number];
const fill = (
  over: Partial<VenueFill> & Pick<VenueFill, 'fillId' | 'side' | 'price' | 'amount' | 'fee' | 'feeAsset' | 'filledAt'>,
): VenueFill => ({
  symbol: 'BTC-USDC',
  base: 'BTC',
  quote: 'USDC',
  ...over,
});

// #8's limit buy and #9's market buy: the venue takes a spot buy's fee in BTC, a sale's in USDC.
const BUY_1 = fill({
  fillId: 'f1',
  side: 'buy',
  price: '60000',
  amount: '0.01',
  fee: '0.00001',
  feeAsset: 'BTC',
  filledAt: '2026-11-10T03:00:00.000Z',
});
const BUY_2 = fill({
  fillId: 'f2',
  side: 'buy',
  price: '61000.5',
  amount: '0.003',
  fee: '0.000003',
  feeAsset: 'BTC',
  filledAt: '2026-11-10T03:05:00.000Z',
});
// #11's sale of every whole lot step held: 0.012 of the 0.012987 BTC.
const SELL = fill({
  fillId: 'f3',
  side: 'sell',
  price: '59400',
  amount: '0.012',
  fee: '0.7128',
  feeAsset: 'USDC',
  filledAt: '2026-11-11T03:00:00.000Z',
});

const activity = (fills: VenueFill[], btc: string, extra: Array<{ asset: string; total: string }> = []): TradeVenueAccountActivity => ({
  venueId: 'test-venue',
  owner: OWNER,
  subAccount: null,
  balances: [{ asset: 'USDC', total: '268.31' }, { asset: 'BTC', total: btc }, ...extra],
  fills,
  asOf: '2026-11-11T03:00:01.000Z',
});
const read = (...accounts: TradeVenueAccountActivity[]): TradeVenueActivityResult => ({ state: 'read', test: true, accounts });
const emptyMain = () => buildLotBook({ fills: [], held: new Map(), method: 'FIFO', truncated: false, now: NOW });

const u = (v: string) => parseAmount(v);

/** The FIFO result worked out by hand from the venue's own fills, as the journey test does (realisedFifo). */
function expectedRealised(buys: VenueFill[], sells: VenueFill[]): string {
  const lots = buys.map((f) => ({
    qty: u(f.amount) - (f.feeAsset === 'BTC' ? u(f.fee) : 0n),
    cost: (u(f.price) * u(f.amount)) / 10n ** 18n + (f.feeAsset === 'USDC' ? u(f.fee) : 0n),
  }));
  let left = sells.reduce((s, f) => s + u(f.amount), 0n);
  const proceeds = sells.reduce((s, f) => s + (u(f.price) * u(f.amount)) / 10n ** 18n - (f.feeAsset === 'USDC' ? u(f.fee) : 0n), 0n);
  let used = 0n;
  for (const lot of lots) {
    if (left === 0n) break;
    const take = left < lot.qty ? left : lot.qty;
    used += take === lot.qty ? lot.cost : (lot.cost * take) / lot.qty;
    left -= take;
  }
  return formatAmount(proceeds - used);
}

describe('venue fills as lot book fills', () => {
  it('a buy receives the coin less the fee taken in it and pays price times amount', () => {
    const f: Fill = venueFillToFill(ACCOUNT, BUY_1);
    expect(f.txId).toBe(`${ACCOUNT}:f1`);
    expect(f.received).toEqual({ assetId: 'BTC', amount: u('0.00999') });
    expect(f.paid).toEqual({ assetId: 'USDC', amount: u('600') });
    expect(f.fee).toBe(u('0.00001'));
    expect(f.feeAssetId).toBeUndefined();
  });

  it('a sale receives the dollars less the fee taken in them and pays the coins sold', () => {
    const f = venueFillToFill(ACCOUNT, SELL);
    expect(f.received).toEqual({ assetId: 'USDC', amount: u('712.8') - u('0.7128') });
    expect(f.paid).toEqual({ assetId: 'BTC', amount: u('0.012') });
  });

  it('a fee taken in the coin paid is inside what was paid and named in that coin', () => {
    const f = venueFillToFill(ACCOUNT, { ...BUY_1, fee: '0.6', feeAsset: 'USDC' });
    expect(f.received.amount).toBe(u('0.01'));
    expect(f.paid?.amount).toBe(u('600.6'));
    expect(f.feeAssetId).toBe('USDC');
  });

  it('a fee in a third coin is in neither leg, so the fee is unknown rather than guessed', () => {
    const f = venueFillToFill(ACCOUNT, { ...BUY_1, fee: '1', feeAsset: 'HYPE' });
    expect(f.received.amount).toBe(u('0.01'));
    expect(f.paid?.amount).toBe(u('600'));
    expect(f.fee).toBeNull();
  });

  it('the account key names the venue, the owner and a sub-account', () => {
    expect(venueAccountKey({ venueId: 'v', owner: OWNER, subAccount: null })).toBe(`venue:v:${OWNER}`);
    expect(venueAccountKey({ venueId: 'v', owner: OWNER, subAccount: 's1' })).toBe(`venue:v:${OWNER}:s1`);
  });
});

describe('the venue account beside the ledger book (J-cex-spot-01 #11)', () => {
  it('after the buys, the bought lots are open at their cost and hold what the venue holds', () => {
    const book = withVenue(emptyMain(), read(activity([BUY_1, BUY_2], '0.012987')), shared);
    expect(() => lotBookSchema.parse(book)).not.toThrow();
    const lots = book.lots.filter((lot) => lot.assetId === 'BTC');
    expect(lots.map((lot) => [lot.id, lot.venueAccount, lot.source, lot.remaining, lot.costUsd, lot.daysHeld])).toEqual([
      [`lot:${ACCOUNT}:f1:BTC`, ACCOUNT, 'trade', '0.00999', '600', 1],
      [`lot:${ACCOUNT}:f2:BTC`, ACCOUNT, 'trade', '0.002997', '183.0015', 1],
    ]);
    expect(lots.reduce((s, lot) => s + u(lot.remaining), 0n)).toBe(u('0.012987'));
    expect(book.assets).toEqual([
      { assetId: 'BTC', openQty: '0.012987', openCostUsd: '783.0015', held: '0.012987', uncountedQty: '0', venueAccount: ACCOUNT },
    ]);
    expect(book.sales).toEqual([]);
    // Nothing sold anywhere: the realised result is not a zero.
    expect(book.realizedUsd).toBeNull();
    expect(book.venue).toEqual({
      status: 'read',
      test: true,
      accounts: [{ account: ACCOUNT, venueId: 'test-venue', owner: OWNER, subAccount: null, asOf: '2026-11-11T03:00:01.000Z' }],
    });
    expect(book.residuals).not.toContain('tax.lot_book_unreconciled');
    expect(book.residuals).not.toContain('tax.venue_unavailable');
  });

  it("after the sale, the realised result is FIFO over the venue's own fills, fees inside it", () => {
    const book = withVenue(emptyMain(), read(activity([BUY_1, BUY_2, SELL], '0.000987')), shared);
    expect(() => lotBookSchema.parse(book)).not.toThrow();
    const want = expectedRealised([BUY_1, BUY_2], [SELL]);
    expect(book.realizedUsd).toBe(want);
    expect(book.sales).toHaveLength(1);
    expect(book.sales[0]).toMatchObject({
      kind: 'sale',
      venueAccount: ACCOUNT,
      assetId: 'BTC',
      qty: '0.012',
      market: 'BTC/USDC',
      realizedUsd: want,
      fee: { status: 'known', assetId: 'USDC', amount: '0.7128', usd: '0.7128' },
    });
    // What is left open is the venue's dust, at its share of the second lot's cost.
    const open = book.lots.filter((lot) => u(lot.remaining) > 0n);
    expect(open.map((lot) => [lot.id, lot.remaining])).toEqual([[`lot:${ACCOUNT}:f2:BTC`, '0.000987']]);
    expect(book.assets[0]).toMatchObject({ openQty: '0.000987', held: '0.000987' });
  });

  it('the ledger and the venue results add up, and a ledger sale never draws on a venue lot', () => {
    // On our ledger: 0.1 ETH bought for 300 USDT and sold for 320 USDT.
    const ledgerFills: Fill[] = [
      {
        txId: 'tx-buy',
        postedAt: new Date('2026-11-01T00:00:00Z'),
        received: { assetId: 'ETH', amount: u('0.1') },
        paid: { assetId: 'USDT', amount: u('300') },
        fee: 0n,
      },
      {
        txId: 'tx-sell',
        postedAt: new Date('2026-11-02T00:00:00Z'),
        received: { assetId: 'USDT', amount: u('320') },
        paid: { assetId: 'ETH', amount: u('0.1') },
        fee: 0n,
      },
    ];
    const main = buildLotBook({ fills: ledgerFills, held: new Map(), method: 'FIFO', truncated: false, now: NOW });
    expect(main.realizedUsd).toBe('20');
    const book = withVenue(main, read(activity([BUY_1, BUY_2, SELL], '0.000987')), shared);
    expect(book.realizedUsd).toBe(formatAmount(u('20') + u(expectedRealised([BUY_1, BUY_2], [SELL]))));
    const ledgerSale = book.sales.find((s) => s.txId === 'tx-sell')!;
    expect(ledgerSale.venueAccount).toBeUndefined();
    expect(ledgerSale.matches.map((m) => m.lotId)).toEqual(['lot:tx-buy:ETH']);
  });

  it('a venue coin that arrived other than by a fill does not reconcile: its cost and result are unknown, named', () => {
    // 0.5 BTC more on the venue than its fills bought (sent in from a wallet, which the book does not follow).
    const book = withVenue(emptyMain(), read(activity([BUY_1, BUY_2, SELL], '0.500987')), shared);
    expect(book.residuals).toContain('tax.lot_book_unreconciled');
    expect(book.assets[0]).toMatchObject({ openCostUsd: null, held: '0.500987' });
    expect(book.sales[0]!.realizedUsd).toBeNull();
    expect(book.realizedUsd).toBeNull();
  });

  it('two venue accounts stay apart: a sale in one draws only on its own lots', () => {
    const other = '0x00000000000000000000000000000000000000b2';
    const a = activity([BUY_1], '0.00999');
    const b: TradeVenueAccountActivity = { ...activity([{ ...SELL, fillId: 'g1', amount: '0.00999', fee: '0' }], '0'), owner: other };
    const book = withVenue(emptyMain(), read(a, b), shared);
    // The second account sold coins it has no lot for: that sale is unmatched there, never matched to the first's lot.
    const sale = book.sales.find((s) => s.venueAccount === `venue:test-venue:${other}`)!;
    expect(sale.matches).toEqual([]);
    expect(sale.unmatchedQty).toBe('0.00999');
    expect(book.lots.find((lot) => lot.venueAccount === ACCOUNT)!.remaining).toBe('0.00999');
    expect(book.realizedUsd).toBeNull();
  });

  it('a dollar coin on the venue is not a position', () => {
    const book = withVenue(emptyMain(), read(activity([BUY_1], '0.00999')), shared);
    expect(book.assets.map((a) => a.assetId)).toEqual(['BTC']);
  });

  it('the venue not read just now shows no venue figure and no realised total, by name', () => {
    const main = buildLotBook({
      fills: [
        {
          txId: 't1',
          postedAt: new Date('2026-11-01T00:00:00Z'),
          received: { assetId: 'ETH', amount: u('1') },
          paid: { assetId: 'USDT', amount: u('3000') },
          fee: 0n,
        },
        {
          txId: 't2',
          postedAt: new Date('2026-11-02T00:00:00Z'),
          received: { assetId: 'USDT', amount: u('3100') },
          paid: { assetId: 'ETH', amount: u('1') },
          fee: 0n,
        },
      ],
      held: new Map(),
      method: 'FIFO',
      truncated: false,
      now: NOW,
    });
    const book = withVenue(main, { state: 'unavailable', code: 'trade.venue_activity_unavailable' }, shared);
    expect(book.venue).toEqual({ status: 'unavailable', code: 'tax.venue_unavailable' });
    expect(book.residuals).toContain('tax.venue_unavailable');
    expect(book.realizedUsd).toBeNull();
    expect(book.feesUsd).toBeNull();
    expect(book.lots.every((lot) => lot.venueAccount === undefined)).toBe(true);
    expect(() => lotBookSchema.parse(book)).not.toThrow();
  });

  it('the door off, or no svc-trade to ask, leaves the ledger book as it is and says which', () => {
    const main = emptyMain();
    expect(withVenue(main, { state: 'off' }, shared)).toEqual({ ...main, venue: { status: 'off', code: 'tax.venue_off' } });
    expect(withVenue(main, null, shared)).toEqual({ ...main, venue: { status: 'unwired', code: 'tax.venue_unwired' } });
    expect(withVenue(main, read(), shared)).toEqual({ ...main, venue: { status: 'read', test: true, accounts: [] } });
  });
});

// J-portfolio-04 #2: a move from the main venue account to the person's own venue sub-account, signed in their wallet,
// carries the lots with their acquired date and basis. Every figure is TEST, worked out by hand.
describe('a move into the person own venue sub-account carries the lots', () => {
  const SUB = '0x00000000000000000000000000000000000000c5';
  const SUB_KEY = `venue:test-venue:${OWNER}:${SUB}`;
  const A = fill({
    fillId: 'a',
    side: 'buy',
    price: '60000',
    amount: '0.6',
    fee: '0',
    feeAsset: 'BTC',
    filledAt: '2026-11-10T01:00:00.000Z',
  });
  const B = fill({
    fillId: 'b',
    side: 'buy',
    price: '61000',
    amount: '0.6',
    fee: '0',
    feeAsset: 'BTC',
    filledAt: '2026-11-10T02:00:00.000Z',
  });
  const MOVED_AT = '2026-11-11T01:00:00.000Z';
  const main = (
    transfers: NonNullable<TradeVenueAccountActivity['transfers']>,
    btc: string,
    fills = [A, B],
  ): TradeVenueAccountActivity => ({
    ...activity(fills, btc),
    transfers,
  });
  const sub = (btc: string, fills: VenueFill[] = []): TradeVenueAccountActivity => ({
    venueId: 'test-venue',
    owner: OWNER,
    subAccount: SUB,
    balances: [{ asset: 'BTC', total: btc }],
    fills,
    asOf: '2026-11-11T03:00:01.000Z',
  });
  const into = (amount: string, moveId = 'n1', settledAt = MOVED_AT) => ({
    moveId,
    subAccount: SUB,
    direction: 'into_sub_account' as const,
    asset: 'BTC',
    amount,
    settledAt,
  });
  const lotsIn = (book: ReturnType<typeof withVenue>, account: string) => book.lots.filter((l) => l.venueAccount === account);

  it('FIFO: the whole oldest lot and a share of the next arrive in the sub-account with their dates and basis; the main account keeps the rest', () => {
    const book = withVenue(emptyMain(), read(main([into('1')], '0.2'), sub('1')), shared);
    expect(lotBookSchema.safeParse(book).success).toBe(true);
    const moved = lotsIn(book, SUB_KEY);
    expect(
      moved.map((l) => [
        l.acquiredAt,
        l.source,
        l.qty,
        l.remaining,
        l.costUsd,
        l.remainingCostUsd,
        l.carriedFrom?.lotId,
        l.carriedFrom?.movedAt,
      ]),
    ).toEqual([
      // TEST: 0.6 BTC at 60000 is 36000; 0.4 of the 0.6 BTC bought at 61000 (36600) is 24400.
      [A.filledAt, 'trade', '0.6', '0.6', '36000', '36000', `lot:${ACCOUNT}:a:BTC`, MOVED_AT],
      [B.filledAt, 'trade', '0.4', '0.4', '24400', '24400', `lot:${ACCOUNT}:b:BTC`, MOVED_AT],
    ]);
    // Not a buy: a carried lot names no fee of its own.
    expect(moved.every((l) => l.fee === undefined)).toBe(true);
    const left = lotsIn(book, ACCOUNT);
    expect(left.map((l) => [l.id, l.remaining, l.remainingCostUsd])).toEqual([
      [`lot:${ACCOUNT}:a:BTC`, '0', '0'],
      [`lot:${ACCOUNT}:b:BTC`, '0.2', '12200'],
    ]);
    // Both accounts reconcile with what the venue holds, and a move is not a sale.
    expect(book.residuals).toEqual([]);
    expect(book.sales).toEqual([]);
    expect(book.assets.filter((a) => a.assetId === 'BTC').map((a) => [a.venueAccount, a.openQty, a.openCostUsd, a.held])).toEqual([
      [ACCOUNT, '0.2', '12200', '0.2'],
      [SUB_KEY, '1', '60400', '1'],
    ]);
  });

  it('LIFO moves the newest lot first, by the method a sale at that moment would use', () => {
    const book = withVenue(emptyMain(), read(main([into('1')], '0.2'), sub('1')), { ...shared, method: 'LIFO' as const });
    expect(lotsIn(book, SUB_KEY).map((l) => [l.acquiredAt, l.qty, l.costUsd])).toEqual([
      [A.filledAt, '0.4', '24000'],
      [B.filledAt, '0.6', '36600'],
    ]);
  });

  it("a sale in the sub-account draws on the lots carried there, at their basis, never on the main account's", () => {
    const SELL_SUB = fill({
      fillId: 's',
      side: 'sell',
      price: '62000',
      amount: '0.5',
      fee: '0',
      feeAsset: 'USDC',
      filledAt: '2026-11-11T02:00:00.000Z',
    });
    const book = withVenue(emptyMain(), read(main([into('1')], '0.2'), sub('0.5', [SELL_SUB])), shared);
    const sale = book.sales.find((s) => s.venueAccount === SUB_KEY)!;
    // TEST: 0.5 of the carried 0.6 at 36000 is 30000; sold for 31000.
    expect([sale.costUsd, sale.proceedsUsd, sale.realizedUsd]).toEqual(['30000', '31000', '1000']);
    expect(sale.matches.map((m) => m.lotId)).toEqual([lotsIn(book, SUB_KEY)[0]!.id]);
    expect(lotsIn(book, ACCOUNT).find((l) => l.remaining !== '0')?.remaining).toBe('0.2');
    expect(book.residuals).toEqual([]);
  });

  it('a move with no lot behind it arrives with no basis, named, never a made-up one', () => {
    const book = withVenue(emptyMain(), read(main([into('1')], '0', []), sub('1')), shared);
    const moved = lotsIn(book, SUB_KEY);
    expect(moved.map((l) => [l.source, l.qty, l.costUsd])).toEqual([['transfer_in', '1', null]]);
    expect(book.residuals).toContain('tax.cost_basis_unavailable');
  });

  it('a move back out of a sub-account is not followed: that coin is unknown on both accounts, named', () => {
    const out = { ...into('0.3', 'n2', '2026-11-11T02:00:00.000Z'), direction: 'out_of_sub_account' as const };
    const book = withVenue(emptyMain(), read(main([into('1'), out], '0.5'), sub('0.7')), shared);
    expect(book.residuals).toContain('tax.lot_book_unreconciled');
    for (const key of [ACCOUNT, SUB_KEY]) {
      expect(book.assets.find((a) => a.venueAccount === key && a.assetId === 'BTC')?.openCostUsd).toBeNull();
    }
  });
});
