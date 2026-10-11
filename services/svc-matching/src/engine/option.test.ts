import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { FileJournal, MemoryJournal, replay, toWire } from './journal.js';
import type { EngineOrder, EngineOrderType, OrderSide, TimeInForce } from './types.js';
import {
  EXPIRY_DISAGREES,
  EXPIRY_MISSING,
  STRIKE_DISAGREES,
  STRIKE_MISSING,
  expiryRefuse,
  installOption,
  readExpiry,
  readStrike,
  strikeRefuse,
  wantsOption,
} from './option.js';

installOption(OrderBook);

/**
 * Rest an option as a limit on the public book.
 * Refuse if strike or expiry is missing. No invented mark.
 */

const A = parseAmount;

const OPT = '11111111-1111-4111-8111-111111111111';
const MISS = '44444444-4444-4444-8444-444444444444';
const PLAIN = '55555555-5555-4555-8555-555555555555';
const EXPIRY = '2026-12-31T00:00:00.000Z';
const TAKE = '22222222-2222-4222-8222-222222222222';
const OTHER = '2026-06-30T00:00:00.000Z';
const EXER = '66666666-6666-4666-8666-666666666666';
const WRITER = '77777777-7777-4777-8777-777777777777';
const HOLDER = '88888888-8888-4888-8888-888888888888';
const NEAR = '12121212-1212-4212-8212-121212121212';
const FAR = '13131313-1313-4313-8313-131313131313';
const BID = '14141414-1414-4414-8414-141414141414';
const SELL = '15151515-1515-4515-8515-151515151515';
const RO = '16161616-1616-4616-8616-161616161616';
const FRONT = '17171717-1717-4717-8717-171717171717';
const OPEN = '18181818-1818-4818-8818-181818181818';

function order(spec: {
  id: string;
  account?: string;
  type?: EngineOrderType;
  side: OrderSide;
  qty: string;
  price?: string;
  stopPx?: string | null;
  trail?: string | null;
  mark?: string | null;
  strike?: string | null;
  expiry?: string | null;
  exercise?: boolean;
  tif?: TimeInForce;
  expireAt?: string;
  ocoSiblingId?: string;
  reduceOnly?: boolean;
  peg?: boolean;
  relative?: boolean;
  reference?: string;
  offset?: string;
}): EngineOrder {
  const type = spec.type ?? (spec.price !== undefined ? 'limit' : 'market');
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type,
    side: spec.side,
    qty: A(spec.qty),
    price: spec.price === undefined ? null : A(spec.price),
    stopPrice: spec.stopPx === undefined || spec.stopPx == null ? null : A(spec.stopPx),
    tif: spec.tif ?? 'GTC',
    ...(spec.expireAt !== undefined ? { expireAt: spec.expireAt } : {}),
    ...(spec.trail !== undefined ? { trail: spec.trail == null ? null : A(spec.trail) } : {}),
    ...(spec.mark !== undefined ? { mark: spec.mark == null ? null : A(spec.mark) } : {}),
    ...(spec.strike !== undefined ? { strike: spec.strike == null ? null : A(spec.strike) } : {}),
    ...(spec.expiry !== undefined ? { expiry: spec.expiry } : {}),
    ...(spec.exercise === true ? { exercise: true } : {}),
    ...(spec.ocoSiblingId ? { ocoSiblingId: spec.ocoSiblingId } : {}),
    ...(spec.reduceOnly ? { reduceOnly: true } : {}),
    ...(spec.peg !== undefined ? { peg: spec.peg } : {}),
    ...(spec.relative !== undefined ? { relative: spec.relative } : {}),
    ...(spec.reference !== undefined ? { reference: A(spec.reference) } : {}),
    ...(spec.offset !== undefined ? { offset: A(spec.offset) } : {}),
  };
}

describe('option — rest as a limit', () => {
  it('rests with strike+expiry+price on the public book', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));

    expect(result.accepted).toBe(true);
    expect(result.resting).toMatchObject({ kind: 'book', orderId: OPT });
    expect(result.fills).toHaveLength(0);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
    expect(book.toState().stops).toHaveLength(0);
  });

  it('refuses a missing strike — no invented strike', () => {
    const book = new OrderBook('BTC/USDT');
    for (const strike of [null, '0'] as const) {
      const result = book.submit(order({ id: MISS, type: 'limit', side: 'buy', qty: '2', price: '99', strike, expiry: EXPIRY }));
      expect(result.accepted).toBe(false);
      expect(result.rejected?.code).toBe(STRIKE_MISSING);
      expect(result.resting).toBeNull();
    }
    expect(book.depth(50).bids).toEqual([]);
  });

  it('refuses a missing expiry — no invented expiry', () => {
    const book = new OrderBook('BTC/USDT');
    for (const expiry of [null, '', '   '] as const) {
      const result = book.submit(order({ id: MISS, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry }));
      expect(result.accepted).toBe(false);
      expect(result.rejected?.code).toBe(EXPIRY_MISSING);
      expect(result.resting).toBeNull();
    }
    expect(book.depth(50).bids).toEqual([]);
  });

  it('omitted mark is fine — do not require a mark', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    expect(result.accepted).toBe(true);
    expect(result.resting).toMatchObject({ kind: 'book', orderId: OPT });
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('missing price refuses invalid_price — do not substitute a mark', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: MISS, type: 'limit', side: 'buy', qty: '2', strike: '100', expiry: EXPIRY }));
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('invalid_price');
    expect(result.resting).toBeNull();
    expect(book.depth(50).bids).toEqual([]);
  });

  it('a plain limit without strike/expiry still rests', () => {
    const book = new OrderBook('BTC/USDT');
    const limit = book.submit(order({ id: PLAIN, type: 'limit', side: 'buy', qty: '2', price: '99' }));
    expect(limit.accepted).toBe(true);
    expect(limit.resting).toMatchObject({ kind: 'book', orderId: PLAIN });
    expect(book.depth(50).bids).toEqual([['99', '2']]);
    expect(wantsOption({ type: 'limit' })).toBe(false);
  });

  it('journal replay keeps strike/expiry and rests at the same price', () => {
    const marketId = 'BTC/USDT';
    const journal = new MemoryJournal();
    const live = new OrderBook(marketId);
    const opt = order({
      id: OPT,
      type: 'limit',
      side: 'buy',
      qty: '2',
      price: '99',
      strike: '100',
      expiry: EXPIRY,
    });
    const wire = toWire(opt);
    expect(wire.strike).toBe('100');
    expect(wire.expiry).toBe(EXPIRY);
    journal.append({ kind: 'submit', marketId, at: '2026-08-31T12:00:00.000Z', order: wire });
    live.submit(opt);
    const restored = replay(journal.read()).get(marketId)!;
    expect(restored.serialize()).toBe(live.serialize());
    expect(restored.depth(50).bids).toEqual([['99', '2']]);
  });

  it('journal replay still refuses a missing strike — crash cannot rest a refused option', () => {
    const marketId = 'BTC/USDT';
    const journal = new MemoryJournal();
    const live = new OrderBook(marketId);
    const bad = order({
      id: MISS,
      type: 'limit',
      side: 'buy',
      qty: '2',
      price: '99',
      strike: null,
      expiry: EXPIRY,
    });
    expect(toWire(bad).strike).toBeNull();
    expect(toWire(bad).expiry).toBe(EXPIRY);
    journal.append({ kind: 'submit', marketId, at: '2026-08-31T12:00:00.000Z', order: toWire(bad) });
    const result = live.submit(bad);
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(STRIKE_MISSING);
    expect(replay(journal.read()).get(marketId)).toBeUndefined();
  });

  it('FileJournal encode keeps a missing strike so a crash still refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-option-'));
    const path = join(dir, 'engine.ndjson');
    const journal = new FileJournal(path);
    const bad = order({
      id: MISS,
      type: 'limit',
      side: 'buy',
      qty: '2',
      price: '99',
      strike: null,
      expiry: EXPIRY,
    });
    journal.append({ kind: 'submit', marketId: 'BTC/USDT', at: '2026-08-31T12:00:00.000Z', order: toWire(bad) });
    journal.close();
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('"strike":null');
    expect(raw).toContain(`"expiry":"${EXPIRY}"`);
    const restored = replay(new FileJournal(path).read()).get('BTC/USDT');
    expect(restored).toBeUndefined();
  });

  it('helpers refuse a missing strike or expiry and do not invent a mark', () => {
    expect(strikeRefuse(null)?.code).toBe(STRIKE_MISSING);
    expect(strikeRefuse(A('0'))?.code).toBe(STRIKE_MISSING);
    expect(strikeRefuse(A('100'))).toBeNull();
    expect(expiryRefuse(null)?.code).toBe(EXPIRY_MISSING);
    expect(expiryRefuse(readExpiry({ expiry: '' }))?.code).toBe(EXPIRY_MISSING);
    expect(expiryRefuse(EXPIRY)).toBeNull();
    expect(wantsOption({ type: 'option' })).toBe(true);
    expect(wantsOption({ strike: A('100') })).toBe(true);
    expect(wantsOption({ expiry: EXPIRY })).toBe(true);
    expect(wantsOption({ type: 'limit' })).toBe(false);
    expect(wantsOption({ type: 'stop' })).toBe(false);
    expect(formatAmount(readStrike({ strike: A('100') })!)).toBe('100');
    expect(readStrike({ strike: null })).toBeNull();
    expect(readExpiry({ expiry: EXPIRY })).toBe(EXPIRY);
    expect(readExpiry({ expiry: null })).toBeNull();
    expect(readExpiry({ expiry: '  ' })).toBeNull();
  });
});

describe('option — take against a resting option', () => {
  it('takes a resting option with the same strike and expiry', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(
      order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
    );
    expect(rest.accepted).toBe(true);
    expect(rest.resting).toMatchObject({ kind: 'book', orderId: OPT });

    const take = book.submit(
      order({ id: TAKE, account: 'taker', type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
    );
    expect(take.accepted).toBe(true);
    expect(take.fills).toHaveLength(1);
    expect(take.fills[0]).toMatchObject({ makerOrderId: OPT, takerOrderId: TAKE });
    expect(formatAmount(take.fills[0]!.price)).toBe('99');
    expect(take.resting).toBeNull();
    expect(book.depth(50).asks).toEqual([]);
    expect(book.depth(50).bids).toEqual([]);
  });

  it('refuses a missing strike on the take — no invented strike', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const take = book.submit(order({ id: TAKE, type: 'limit', side: 'buy', qty: '2', price: '99', strike: null, expiry: EXPIRY }));
    expect(take.accepted).toBe(false);
    expect(take.rejected?.code).toBe(STRIKE_MISSING);
    expect(take.fills).toHaveLength(0);
    expect(book.depth(50).asks).toEqual([['99', '2']]);
  });

  it('refuses a missing expiry on the take — no invented expiry', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const take = book.submit(order({ id: TAKE, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: null }));
    expect(take.accepted).toBe(false);
    expect(take.rejected?.code).toBe(EXPIRY_MISSING);
    expect(take.fills).toHaveLength(0);
    expect(book.depth(50).asks).toEqual([['99', '2']]);
  });

  it('refuses when strike disagrees — do not take a different contract', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const take = book.submit(order({ id: TAKE, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '105', expiry: EXPIRY }));
    expect(take.accepted).toBe(false);
    expect(take.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(take.fills).toHaveLength(0);
    expect(book.depth(50).asks).toEqual([['99', '2']]);
  });

  it('refuses when expiry disagrees — do not take a different contract', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const take = book.submit(order({ id: TAKE, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: OTHER }));
    expect(take.accepted).toBe(false);
    expect(take.rejected?.code).toBe(EXPIRY_DISAGREES);
    expect(take.fills).toHaveLength(0);
    expect(book.depth(50).asks).toEqual([['99', '2']]);
  });

  it('refuses a take that would print a plain limit — not a resting option', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: PLAIN, type: 'limit', side: 'sell', qty: '2', price: '99' }));
    const take = book.submit(order({ id: TAKE, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    expect(take.accepted).toBe(false);
    expect(take.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(take.fills).toHaveLength(0);
    expect(book.depth(50).asks).toEqual([['99', '2']]);
  });

  it('omitted mark is fine on a take — do not require a mark', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const take = book.submit(
      order({ id: TAKE, account: 'taker', type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
    );
    expect(take.accepted).toBe(true);
    expect(take.fills).toHaveLength(1);
  });

  it('a non-crossing option still rests — do not invent a take', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, type: 'limit', side: 'sell', qty: '2', price: '101', strike: '100', expiry: EXPIRY }));
    const bid = book.submit(order({ id: TAKE, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    expect(bid.accepted).toBe(true);
    expect(bid.fills).toHaveLength(0);
    expect(bid.resting).toMatchObject({ kind: 'book', orderId: TAKE });
    expect(book.depth(50).asks).toEqual([['101', '2']]);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });
});

describe('option — a non-option cannot take a resting option', () => {
  it('refuses a plain order that would take a resting option and leaves the option position unchanged', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: WRITER, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
    );
    book.submit(order({ id: HOLDER, account: 'holder', type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const positions = book.toState().positions;

    const plain = book.submit(order({ id: PLAIN, account: 'taker', type: 'limit', side: 'buy', qty: '2', price: '99' }));
    expect(plain.accepted).toBe(false);
    expect(plain.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(plain.fills).toHaveLength(0);
    expect(plain.resting).toBeNull();
    expect(book.depth(50).asks).toEqual([['99', '2']]);
    expect(book.toState().positions).toEqual(positions);

    const ex = book.submit(
      order({ id: EXER, account: 'holder', type: 'limit', side: 'buy', qty: '2', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(ex.accepted).toBe(true);
    expect(ex.fills).toHaveLength(1);
    expect(formatAmount(ex.fills[0]!.qty)).toBe('2');
    expect(formatAmount(ex.fills[0]!.price)).toBe('100');

    const extra = book.submit(
      order({ id: TAKE, account: 'holder', type: 'limit', side: 'buy', qty: '1', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(extra.accepted).toBe(false);
    expect(extra.rejected?.code).toBe('position_flat');

    const invented = book.submit(
      order({ id: MISS, account: 'taker', type: 'limit', side: 'buy', qty: '1', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(invented.accepted).toBe(false);
    expect(invented.rejected?.code).toBe('position_flat');
    expect(book.depth(50).asks).toEqual([['99', '2']]);
  });

  it('a plain order that does not cross a resting option still submits', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, type: 'limit', side: 'sell', qty: '2', price: '101', strike: '100', expiry: EXPIRY }));
    const bid = book.submit(order({ id: PLAIN, type: 'limit', side: 'buy', qty: '2', price: '99' }));
    expect(bid.accepted).toBe(true);
    expect(bid.fills).toHaveLength(0);
    expect(bid.resting).toMatchObject({ kind: 'book', orderId: PLAIN });
    expect(book.depth(50).asks).toEqual([['101', '2']]);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('a plain order that fills in front of a resting option still submits', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: PLAIN, account: 'maker', type: 'limit', side: 'sell', qty: '1', price: '90' }));
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const buy = book.submit(order({ id: TAKE, account: 'taker', type: 'limit', side: 'buy', qty: '1', price: '99' }));
    expect(buy.accepted).toBe(true);
    expect(buy.fills).toHaveLength(1);
    expect(buy.fills[0]?.makerOrderId).toBe(PLAIN);
    expect(book.depth(50).asks).toEqual([['99', '2']]);
  });

  it('refuses a market order that would take a resting option', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const market = book.submit(order({ id: PLAIN, account: 'taker', type: 'market', side: 'buy', qty: '1' }));
    expect(market.accepted).toBe(false);
    expect(market.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(market.fills).toHaveLength(0);
    expect(book.depth(50).asks).toEqual([['99', '2']]);
  });

  it('refuses a stop that would trigger through a resting option', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: MISS, account: 'seed-ask', type: 'limit', side: 'sell', qty: '1', price: '50' }));
    book.submit(order({ id: TAKE, account: 'seed-bid', type: 'limit', side: 'buy', qty: '1', price: '50' }));
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '50', strike: '100', expiry: EXPIRY }));
    const stop = book.submit(order({ id: PLAIN, account: 'taker', type: 'stop', side: 'buy', qty: '1', stopPx: '50' }));
    expect(stop.accepted).toBe(false);
    expect(stop.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(stop.fills).toHaveLength(0);
    expect(book.depth(50).asks).toEqual([['50', '2']]);
    expect(book.toState().stops).toHaveLength(0);
  });

  it('a stop that does not trigger still rests beside a resting option', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const stop = book.submit(order({ id: PLAIN, type: 'stop', side: 'buy', qty: '1', stopPx: '120' }));
    expect(stop.accepted).toBe(true);
    expect(stop.fills).toHaveLength(0);
    expect(stop.resting).toMatchObject({ kind: 'stop', orderId: PLAIN });
    expect(book.depth(50).asks).toEqual([['99', '2']]);
  });

  it('a later trade that triggers a resting stop does not take a resting option', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '100', expiry: EXPIRY }));
    const stop = book.submit(order({ id: PLAIN, account: 'taker', type: 'stop', side: 'buy', qty: '1', stopPx: '50' }));
    expect(stop.accepted).toBe(true);
    expect(stop.resting).toMatchObject({ kind: 'stop', orderId: PLAIN });
    book.submit(order({ id: BID, account: 'mm', type: 'limit', side: 'buy', qty: '1', price: '50' }));

    const trade = book.submit(order({ id: SELL, account: 'seller', type: 'limit', side: 'sell', qty: '1', price: '50' }));
    expect(trade.accepted).toBe(true);
    expect(trade.fills).toHaveLength(1);
    expect(trade.fills[0]?.makerOrderId).toBe(BID);
    expect(trade.triggered).toHaveLength(1);
    expect(trade.triggered[0]?.orderId).toBe(PLAIN);
    expect(trade.triggered[0]?.fills).toHaveLength(0);
    expect(trade.triggered[0]?.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(trade.triggered[0]?.cancellations.map((row) => row.reason)).toEqual(['trigger_rejected']);
    expect(book.depth(50).asks).toEqual([['99', '1']]);
    expect(book.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([OPT]);
    expect(book.toState().stops).toHaveLength(0);

    const invented = book.submit(
      order({ id: EXER, account: 'taker', type: 'limit', side: 'buy', qty: '1', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(invented.accepted).toBe(false);
    expect(invented.rejected?.code).toBe('position_flat');
    expect(book.depth(50).asks).toEqual([['99', '1']]);
  });

  it('a stop that triggers into a plain in front of a resting option still fills that plain', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: FRONT, account: 'maker', type: 'limit', side: 'sell', qty: '1', price: '90' }));
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '100', expiry: EXPIRY }));
    book.submit(order({ id: PLAIN, account: 'taker', type: 'stop', side: 'buy', qty: '1', stopPx: '50' }));
    book.submit(order({ id: BID, account: 'mm', type: 'limit', side: 'buy', qty: '1', price: '50' }));

    const trade = book.submit(order({ id: SELL, account: 'seller', type: 'limit', side: 'sell', qty: '1', price: '50' }));
    expect(trade.accepted).toBe(true);
    expect(trade.triggered).toHaveLength(1);
    expect(trade.triggered[0]?.fills).toHaveLength(1);
    expect(trade.triggered[0]?.fills[0]?.makerOrderId).toBe(FRONT);
    expect(trade.triggered[0]?.rejected).toBeUndefined();
    expect(book.depth(50).asks).toEqual([['99', '1']]);
    expect(book.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([OPT]);
  });

  it('an OCO sibling cancelled before the sweep does not let the remainder take a resting option', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: NEAR, account: 'desk', type: 'limit', side: 'sell', qty: '1', price: '100', ocoSiblingId: FAR }));
    book.submit(order({ id: FAR, account: 'desk', type: 'limit', side: 'sell', qty: '1', price: '101', ocoSiblingId: NEAR }));
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '102', strike: '100', expiry: EXPIRY }));

    const sized = book.submit(order({ id: PLAIN, account: 'taker', type: 'limit', side: 'buy', qty: '2', price: '102' }));
    expect(sized.accepted).toBe(false);
    expect(sized.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(sized.fills).toHaveLength(0);
    expect(book.depth(50).asks).toEqual([
      ['100', '1'],
      ['101', '1'],
      ['102', '1'],
    ]);
    expect(book.toState().asks.flatMap((level) => level.orders.map((row) => row.orderId))).toEqual([NEAR, FAR, OPT]);

    const one = book.submit(order({ id: TAKE, account: 'taker', type: 'limit', side: 'buy', qty: '1', price: '102' }));
    expect(one.accepted).toBe(true);
    expect(one.fills.map((fill) => fill.makerOrderId)).toEqual([NEAR]);
    expect(one.cancellations.map((row) => row.orderId)).toContain(FAR);
    expect(book.toState().asks.flatMap((level) => level.orders.map((row) => row.orderId))).toEqual([OPT]);

    const invented = book.submit(
      order({ id: EXER, account: 'taker', type: 'limit', side: 'buy', qty: '1', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(invented.accepted).toBe(false);
    expect(invented.rejected?.code).toBe('position_flat');
  });

  it('a reduce-only clip does not let the remainder take a resting option', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPEN, account: 'mm', type: 'limit', side: 'sell', qty: '2', price: '50' }));
    const opened = book.submit(order({ id: HOLDER, account: 'desk', type: 'limit', side: 'buy', qty: '2', price: '50' }));
    expect(opened.fills).toHaveLength(1);
    book.submit(order({ id: FRONT, account: 'desk', type: 'limit', side: 'sell', qty: '1', price: '60' }));
    const ro = book.submit(order({ id: RO, account: 'desk', type: 'limit', side: 'sell', qty: '2', price: '70', reduceOnly: true }));
    expect(ro.accepted).toBe(true);
    expect(ro.resting).toMatchObject({ kind: 'book', orderId: RO });
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '80', strike: '100', expiry: EXPIRY }));
    const positions = book.toState().positions;

    const sized = book.submit(order({ id: PLAIN, account: 'taker', type: 'limit', side: 'buy', qty: '3', price: '80' }));
    expect(sized.accepted).toBe(false);
    expect(sized.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(sized.fills).toHaveLength(0);
    expect(book.depth(50).asks).toEqual([
      ['60', '1'],
      ['70', '2'],
      ['80', '1'],
    ]);
    expect(book.toState().positions).toEqual(positions);
    expect(book.toState().asks[2]?.orders.map((row) => row.orderId)).toEqual([OPT]);

    const printed = book.submit(order({ id: TAKE, account: 'taker', type: 'limit', side: 'buy', qty: '2', price: '80' }));
    expect(printed.accepted).toBe(true);
    expect(printed.fills.map((fill) => fill.makerOrderId)).toEqual([FRONT, RO]);
    expect(printed.fills.map((fill) => formatAmount(fill.qty))).toEqual(['1', '1']);
    expect(book.depth(50).asks).toEqual([['80', '1']]);
    expect(book.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([OPT]);

    const invented = book.submit(
      order({ id: EXER, account: 'taker', type: 'limit', side: 'buy', qty: '1', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(invented.accepted).toBe(false);
    expect(invented.rejected?.code).toBe('position_flat');
  });

  it('an amend that moves a plain order into a resting option refuses', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: PLAIN, account: 'taker', type: 'limit', side: 'buy', qty: '1', price: '90' }));
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '100', expiry: EXPIRY }));
    const positions = book.toState().positions;

    const moved = book.amend({ orderId: PLAIN, expectedVersion: 1, price: A('99') });
    expect(moved.accepted).toBe(false);
    expect(moved.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(moved.fills).toHaveLength(0);
    expect(book.depth(50).bids).toEqual([['90', '1']]);
    expect(book.depth(50).asks).toEqual([['99', '1']]);
    expect(book.toState().positions).toEqual(positions);

    const aside = book.amend({ orderId: PLAIN, expectedVersion: 1, price: A('91') });
    expect(aside.accepted).toBe(true);
    expect(aside.fills).toHaveLength(0);
    expect(book.depth(50).bids).toEqual([['91', '1']]);
    expect(book.depth(50).asks).toEqual([['99', '1']]);

    const invented = book.submit(
      order({ id: EXER, account: 'taker', type: 'limit', side: 'buy', qty: '1', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(invented.accepted).toBe(false);
    expect(invented.rejected?.code).toBe('position_flat');
  });

  it('a due GTD or GTT plain in front does not let the remainder print a resting option', () => {
    const early = new Date('2026-08-25T11:00:00.000Z');
    const late = new Date('2026-08-25T15:00:00.000Z');
    const dueAt = '2026-08-25T12:00:00.000Z';

    const arm = (tif: TimeInForce) => {
      const book = new OrderBook('BTC/USDT');
      book.submit(order({ id: OPEN, account: 'mm', type: 'limit', side: 'sell', qty: '1', price: '50' }));
      book.submit(order({ id: HOLDER, account: 'desk', type: 'limit', side: 'buy', qty: '1', price: '50' }));
      const due = book.submit(
        order({ id: FRONT, account: 'maker', type: 'limit', side: 'sell', qty: '1', price: '90', tif, expireAt: dueAt }),
        early,
      );
      expect(due.accepted).toBe(true);
      book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '100', expiry: EXPIRY }));
      book.submit(order({ id: BID, account: 'taker', type: 'limit', side: 'buy', qty: '1', price: '80' }));
      return book;
    };

    const gtd = arm('GTD');
    const positions = gtd.toState().positions;
    const plain = gtd.submit(order({ id: PLAIN, account: 'taker', type: 'limit', side: 'buy', qty: '1', price: '99' }), late);
    expect(plain.accepted).toBe(false);
    expect(plain.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(plain.fills).toHaveLength(0);
    expect(plain.cancellations.map((row) => [row.orderId, row.reason])).toEqual([[FRONT, 'expired']]);
    expect(gtd.depth(50).bids).toEqual([['80', '1']]);
    expect(gtd.depth(50).asks).toEqual([['99', '1']]);
    expect(gtd.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([OPT]);
    expect(gtd.toState().positions).toEqual(positions);

    const marketBook = arm('GTD');
    const market = marketBook.submit(order({ id: MISS, account: 'taker', type: 'market', side: 'buy', qty: '1' }), late);
    expect(market.accepted).toBe(false);
    expect(market.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(market.fills).toHaveLength(0);
    expect(market.cancellations.map((row) => [row.orderId, row.reason])).toEqual([[FRONT, 'expired']]);
    expect(marketBook.depth(50).asks).toEqual([['99', '1']]);
    expect(marketBook.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([OPT]);

    const stopBook = arm('GTT');
    const stop = stopBook.submit(order({ id: TAKE, account: 'taker', type: 'stop', side: 'buy', qty: '1', stopPx: '50' }), late);
    expect(stop.accepted).toBe(false);
    expect(stop.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(stop.fills).toHaveLength(0);
    expect(stop.cancellations.map((row) => [row.orderId, row.reason])).toEqual([[FRONT, 'expired']]);
    expect(stopBook.toState().stops).toHaveLength(0);
    expect(stopBook.depth(50).asks).toEqual([['99', '1']]);
    expect(stopBook.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([OPT]);

    const gtt = arm('GTT');
    const moved = gtt.amend({ orderId: BID, expectedVersion: 1, price: A('99') }, late);
    expect(moved.accepted).toBe(false);
    expect(moved.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(moved.fills).toHaveLength(0);
    expect(moved.cancellations.map((row) => [row.orderId, row.reason])).toEqual([[FRONT, 'expired']]);
    expect(gtt.depth(50).bids).toEqual([['80', '1']]);
    expect(gtt.depth(50).asks).toEqual([['99', '1']]);
    expect(gtt.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([OPT]);
    expect(gtt.toState().positions).toEqual(positions);

    const asideBook = arm('GTD');
    const aside = asideBook.submit(order({ id: SELL, account: 'taker', type: 'limit', side: 'buy', qty: '1', price: '70' }), late);
    expect(aside.accepted).toBe(true);
    expect(aside.fills).toHaveLength(0);
    expect(aside.cancellations.map((row) => [row.orderId, row.reason])).toEqual([[FRONT, 'expired']]);
    expect(aside.resting).toMatchObject({ kind: 'book', orderId: SELL });
    expect(asideBook.depth(50).asks).toEqual([['99', '1']]);
    expect(asideBook.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([OPT]);
    expect(asideBook.depth(50).bids).toEqual([
      ['80', '1'],
      ['70', '1'],
    ]);

    const invented = gtd.submit(
      order({ id: EXER, account: 'taker', type: 'limit', side: 'buy', qty: '1', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(invented.accepted).toBe(false);
    expect(invented.rejected?.code).toBe('position_flat');
    expect(gtd.depth(50).asks).toEqual([['99', '1']]);
  });

  it('a peg or relative order is judged after it binds and does not print a resting option it reaches', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '100', expiry: EXPIRY }));
    const positions = book.toState().positions;

    const reached = book.submit(
      order({
        id: PLAIN,
        account: 'taker',
        type: 'limit',
        side: 'buy',
        qty: '1',
        price: '80',
        relative: true,
        reference: '90',
        offset: '9',
      }),
    );
    expect(reached.accepted).toBe(false);
    expect(reached.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(reached.fills).toHaveLength(0);
    expect(reached.resting).toBeNull();
    expect(book.depth(50).bids).toEqual([]);
    expect(book.depth(50).asks).toEqual([['99', '1']]);
    expect(book.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([OPT]);
    expect(book.toState().positions).toEqual(positions);

    const rests = book.submit(order({ id: TAKE, account: 'taker', side: 'buy', qty: '1', peg: true, reference: '80', offset: '0' }));
    expect(rests.accepted).toBe(true);
    expect(rests.fills).toHaveLength(0);
    expect(rests.resting).toMatchObject({ kind: 'book', orderId: TAKE });
    expect(book.depth(50).bids).toEqual([['80', '1']]);
    expect(book.depth(50).asks).toEqual([['99', '1']]);
    expect(book.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([OPT]);
    expect(book.toState().positions).toEqual(positions);

    const invented = book.submit(
      order({ id: EXER, account: 'taker', type: 'limit', side: 'buy', qty: '1', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(invented.accepted).toBe(false);
    expect(invented.rejected?.code).toBe('position_flat');
    expect(book.depth(50).asks).toEqual([['99', '1']]);
  });
});

describe('option — exercise a long', () => {
  it('exercises a long at strike — never a mark', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: WRITER, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
    );
    const take = book.submit(
      order({ id: HOLDER, account: 'holder', type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
    );
    expect(take.accepted).toBe(true);
    expect(take.fills).toHaveLength(1);

    const ex = book.submit(
      order({ id: EXER, account: 'holder', type: 'limit', side: 'buy', qty: '2', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(ex.accepted).toBe(true);
    expect(ex.resting).toBeNull();
    expect(ex.fills).toHaveLength(1);
    expect(formatAmount(ex.fills[0]!.price)).toBe('100');
    expect(book.wouldOpenOrIncrease('holder', 'sell', A('2'))).toBe(true);
  });

  it('assigns the earlier short, then the later short, when one account sold twice', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: WRITER, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '100', expiry: EXPIRY }),
    );
    book.submit(order({ id: HOLDER, account: 'holder', type: 'limit', side: 'buy', qty: '1', price: '99', strike: '100', expiry: EXPIRY }));
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '100', expiry: EXPIRY }));
    const second = book.submit(
      order({ id: TAKE, account: 'holder', type: 'limit', side: 'buy', qty: '1', price: '99', strike: '100', expiry: EXPIRY }),
    );
    expect(second.accepted).toBe(true);
    expect(second.fills[0]?.makerOrderId).toBe(OPT);

    const ex = book.submit(
      order({ id: EXER, account: 'holder', type: 'limit', side: 'buy', qty: '2', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(ex.accepted).toBe(true);
    expect(ex.fills.map((fill) => fill.makerOrderId)).toEqual([WRITER, OPT]);
    expect(ex.fills.map((fill) => fill.makerAccountId)).toEqual(['writer', 'writer']);
    expect(ex.fills.map((fill) => formatAmount(fill.qty))).toEqual(['1', '1']);
    expect(ex.fills.map((fill) => formatAmount(fill.price))).toEqual(['100', '100']);
  });

  it('reducing a short consumes the earliest lot and leaves the later order id', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: WRITER, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '100', expiry: EXPIRY }),
    );
    book.submit(order({ id: HOLDER, account: 'holder', type: 'limit', side: 'buy', qty: '1', price: '99', strike: '100', expiry: EXPIRY }));
    book.submit(order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '100', expiry: EXPIRY }));
    book.submit(order({ id: TAKE, account: 'holder', type: 'limit', side: 'buy', qty: '1', price: '99', strike: '100', expiry: EXPIRY }));
    book.submit(order({ id: SELL, account: 'other', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '100', expiry: EXPIRY }));
    const reduced = book.submit(
      order({ id: BID, account: 'writer', type: 'limit', side: 'buy', qty: '1', price: '99', strike: '100', expiry: EXPIRY }),
    );
    expect(reduced.accepted).toBe(true);
    expect(reduced.fills[0]?.makerOrderId).toBe(SELL);

    const ex = book.submit(
      order({ id: EXER, account: 'holder', type: 'limit', side: 'buy', qty: '1', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(ex.accepted).toBe(true);
    expect(ex.fills.map((fill) => fill.makerOrderId)).toEqual([OPT]);
    expect(ex.fills.map((fill) => fill.makerAccountId)).toEqual(['writer']);
    expect(ex.fills.map((fill) => formatAmount(fill.qty))).toEqual(['1']);
  });

  it('refuses a missing strike — no invented strike', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: WRITER, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
    );
    book.submit(order({ id: HOLDER, account: 'holder', type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const ex = book.submit(order({ id: EXER, account: 'holder', type: 'limit', side: 'buy', qty: '2', expiry: EXPIRY, exercise: true }));
    expect(ex.accepted).toBe(false);
    expect(ex.rejected?.code).toBe(STRIKE_MISSING);
    expect(ex.fills).toHaveLength(0);
  });

  it('refuses a missing expiry — no invented expiry', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: WRITER, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
    );
    book.submit(order({ id: HOLDER, account: 'holder', type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const ex = book.submit(order({ id: EXER, account: 'holder', type: 'limit', side: 'buy', qty: '2', strike: '100', exercise: true }));
    expect(ex.accepted).toBe(false);
    expect(ex.rejected?.code).toBe(EXPIRY_MISSING);
    expect(ex.fills).toHaveLength(0);
  });

  it('a supplied mark is ignored — exercise prints at strike', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: WRITER, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
    );
    book.submit(order({ id: HOLDER, account: 'holder', type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const ex = book.submit(
      order({
        id: EXER,
        account: 'holder',
        type: 'limit',
        side: 'buy',
        qty: '2',
        strike: '100',
        expiry: EXPIRY,
        mark: '50',
        exercise: true,
      }),
    );
    expect(ex.accepted).toBe(true);
    expect(formatAmount(ex.fills[0]!.price)).toBe('100');
  });

  it('refuses when the account is not long — no invented mark', () => {
    const book = new OrderBook('BTC/USDT');
    const ex = book.submit(
      order({ id: EXER, account: 'holder', type: 'limit', side: 'buy', qty: '2', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(ex.accepted).toBe(false);
    expect(ex.rejected?.code).toBe('position_flat');
    expect(ex.fills).toHaveLength(0);
  });
});
