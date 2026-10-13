import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './engine.js';
import { MemoryJournal, replay, toWire } from './journal.js';
import type { ComboLeg, EngineOrder, EngineOrderType, OrderSide, TimeInForce } from './types.js';
import { comboRestOf, installComboBook } from './combo-book.js';
import {
  COMBO_DISAGREES,
  COMBO_LEGS_MISSING,
  EXPIRY_MISSING,
  RATIO_MISSING,
  STRIKE_MISSING,
  comboIdentity,
  comboIntentRefuse,
} from './option-combo.js';

installComboBook();

/**
 * CARD E2 hitch. Named legs + ratios rest as one instrument.
 * Incomplete combo keeps A8 refuse. Two independent options are not a combo.
 */

const A = parseAmount;

const COMBO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAKE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPT_A = '11111111-1111-4111-8111-111111111111';
const OPT_B = '22222222-2222-4222-8222-222222222222';
const MISS = '44444444-4444-4444-8444-444444444444';
const STOP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FUEL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SPARK = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const WARM_SELL = 'abababab-abab-4aba-8aba-abababababab';
const WARM_BUY = 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd';
const EXPIRY = '2026-12-31T00:00:00.000Z';
const OTHER = '2026-06-30T00:00:00.000Z';

function namedLegs(over: Partial<ComboLeg>[] = []): ComboLeg[] {
  const base: ComboLeg[] = [
    { name: 'call', ratio: A('1'), strike: A('100'), expiry: EXPIRY },
    { name: 'put', ratio: A('-1'), strike: A('100'), expiry: EXPIRY },
  ];
  return base.map((leg, i) => ({ ...leg, ...(over[i] ?? {}) }));
}

function order(spec: {
  id: string;
  account?: string;
  type?: EngineOrderType;
  side: OrderSide;
  qty: string;
  price?: string;
  stop?: string;
  strike?: string | null;
  expiry?: string | null;
  combo?: boolean;
  legs?: ComboLeg[] | null;
  tif?: TimeInForce;
}): EngineOrder {
  const type = spec.type ?? (spec.price === undefined ? 'market' : 'limit');
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type,
    side: spec.side,
    qty: A(spec.qty),
    price: spec.price === undefined ? null : A(spec.price),
    stopPrice: spec.stop === undefined ? null : A(spec.stop),
    tif: spec.tif ?? 'GTC',
    ...(spec.strike !== undefined ? { strike: spec.strike == null ? null : A(spec.strike) } : {}),
    ...(spec.expiry !== undefined ? { expiry: spec.expiry } : {}),
    ...(spec.combo !== undefined ? { combo: spec.combo } : {}),
    ...(spec.legs !== undefined ? { legs: spec.legs } : {}),
  };
}

function liveIds(book: OrderBook): string[] {
  const state = book.toState();
  return [...state.bids.flatMap((l) => l.orders.map((o) => o.orderId)), ...state.asks.flatMap((l) => l.orders.map((o) => o.orderId))];
}

describe('combo book — named legs rest as one instrument', () => {
  it('named legs + ratios, combo:true, one qty/price → accepted, exactly one live orderId', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(
      order({
        id: COMBO,
        type: 'limit',
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    expect(result.accepted).toBe(true);
    expect(result.resting).toMatchObject({ kind: 'book', orderId: COMBO });
    expect(liveIds(book)).toEqual([COMBO]);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
    expect(book.depth(50).asks).toEqual([]);
    expect(comboIntentRefuse({ combo: true, legs: namedLegs() })).toBeNull();
  });

  it('remembered combo has both leg names and ratios as ledger Amounts', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: COMBO,
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    const remembered = comboRestOf(book, COMBO);
    expect(remembered?.orderId).toBe(COMBO);
    expect(remembered?.legs).toHaveLength(2);
    expect(remembered?.legs.map((leg) => leg.name)).toEqual(['call', 'put']);
    expect(remembered?.legs.map((leg) => formatAmount(leg.ratio))).toEqual(['1', '-1']);
    expect(typeof remembered?.legs[0]?.ratio).toBe('bigint');
    expect(typeof remembered?.legs[1]?.ratio).toBe('bigint');
    expect(remembered?.legs[0]?.ratio).toBe(A('1'));
    expect(remembered?.legs[1]?.ratio).toBe(A('-1'));
  });

  it('missing legs/ratio/strike/expiry still refuse A8 codes; liveIds empty', () => {
    const book = new OrderBook('BTC/USDT');
    const missingLegs = book.submit(
      order({
        id: MISS,
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
      }),
    );
    expect(missingLegs.accepted).toBe(false);
    expect(missingLegs.rejected?.code).toBe(COMBO_LEGS_MISSING);
    expect(comboIntentRefuse({ combo: true })?.code).toBe(COMBO_LEGS_MISSING);

    const missingRatio = book.submit(
      order({
        id: MISS,
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs([{ ratio: null }]),
      }),
    );
    expect(missingRatio.accepted).toBe(false);
    expect(missingRatio.rejected?.code).toBe(RATIO_MISSING);

    const missingStrike = book.submit(
      order({
        id: MISS,
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs([{ strike: null }]),
      }),
    );
    expect(missingStrike.accepted).toBe(false);
    expect(missingStrike.rejected?.code).toBe(STRIKE_MISSING);

    const missingExpiry = book.submit(
      order({
        id: MISS,
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs([{ expiry: null }]),
      }),
    );
    expect(missingExpiry.accepted).toBe(false);
    expect(missingExpiry.rejected?.code).toBe(EXPIRY_MISSING);
    expect(liveIds(book)).toEqual([]);
    expect(book.depth(50).bids).toEqual([]);
    expect(comboRestOf(book, MISS)).toBeUndefined();
  });

  it('two separate option submits (no combo) are two rests — not labeled combo', () => {
    const book = new OrderBook('BTC/USDT');
    const a = book.submit(
      order({
        id: OPT_A,
        type: 'limit',
        side: 'buy',
        qty: '2',
        price: '99',
        strike: '100',
        expiry: EXPIRY,
      }),
    );
    const b = book.submit(
      order({
        id: OPT_B,
        type: 'limit',
        side: 'buy',
        qty: '3',
        price: '98',
        strike: '100',
        expiry: EXPIRY,
      }),
    );
    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
    expect(liveIds(book).sort()).toEqual([OPT_A, OPT_B].sort());
    expect(book.depth(50).bids).toEqual([
      ['99', '2'],
      ['98', '3'],
    ]);
    expect(comboRestOf(book, OPT_A)).toBeUndefined();
    expect(comboRestOf(book, OPT_B)).toBeUndefined();
  });

  it('journal replay of a complete combo restores one rest, not two, not empty', () => {
    const marketId = 'BTC/USDT';
    const journal = new MemoryJournal();
    const comboed = order({
      id: COMBO,
      side: 'buy',
      qty: '2',
      price: '99',
      combo: true,
      legs: namedLegs(),
    });
    const wire = toWire(comboed);
    expect(wire.combo).toBe(true);
    expect(wire.legs).toHaveLength(2);
    expect(wire.legs?.[0]?.ratio).toBe('1');
    expect(wire.legs?.[1]?.ratio).toBe('-1');
    journal.append({ kind: 'submit', marketId, at: '2026-08-31T12:00:00.000Z', order: wire });
    const live = new OrderBook(marketId).submit(comboed);
    expect(live.accepted).toBe(true);
    expect(live.resting?.orderId).toBe(COMBO);
    const restored = replay(journal.read()).get(marketId);
    expect(restored).toBeDefined();
    expect(liveIds(restored!)).toEqual([COMBO]);
    expect(restored!.depth(50).bids).toEqual([['99', '2']]);
    expect(restored!.depth(50).asks).toEqual([]);
    const remembered = comboRestOf(restored!, COMBO);
    expect(remembered?.legs.map((leg) => leg.name)).toEqual(['call', 'put']);
    expect(remembered?.legs.map((leg) => formatAmount(leg.ratio))).toEqual(['1', '-1']);
  });
});

describe('combo book — match/unwind as one instrument', () => {
  it('two combos with the same named legs+ratios match as one fill, not two option legs', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(
      order({
        id: COMBO,
        account: 'maker',
        side: 'sell',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    expect(rest.accepted).toBe(true);
    expect(rest.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([COMBO]);

    const take = book.submit(
      order({
        id: TAKE,
        account: 'taker',
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    expect(take.accepted).toBe(true);
    expect(take.fills).toHaveLength(1);
    expect(take.fills[0]).toMatchObject({ makerOrderId: COMBO, takerOrderId: TAKE, takerSide: 'buy' });
    expect(formatAmount(take.fills[0]!.qty)).toBe('2');
    expect(formatAmount(take.fills[0]!.price)).toBe('99');
    expect(typeof take.fills[0]!.qty).toBe('bigint');
    expect(typeof take.fills[0]!.price).toBe('bigint');
    expect(take.resting).toBeNull();
    expect(liveIds(book)).toEqual([]);
    expect(book.depth(50).bids).toEqual([]);
    expect(book.depth(50).asks).toEqual([]);
    expect(comboRestOf(book, COMBO)).toBeUndefined();
    expect(comboRestOf(book, TAKE)).toBeUndefined();
    expect(comboIdentity(namedLegs())).toBe(comboIdentity([...namedLegs()].reverse()));
  });

  it('partial combo take unwinds one remaining combo rest', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: COMBO,
        account: 'maker',
        side: 'sell',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    const take = book.submit(
      order({
        id: TAKE,
        account: 'taker',
        side: 'buy',
        qty: '1',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    expect(take.accepted).toBe(true);
    expect(take.fills).toHaveLength(1);
    expect(formatAmount(take.fills[0]!.qty)).toBe('1');
    expect(take.resting).toBeNull();
    expect(liveIds(book)).toEqual([COMBO]);
    expect(book.depth(50).asks).toEqual([['99', '1']]);
    expect(comboRestOf(book, COMBO)?.legs.map((leg) => formatAmount(leg.ratio))).toEqual(['1', '-1']);
  });

  it('refuses a combo take against a different named-leg identity', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: COMBO,
        account: 'maker',
        side: 'sell',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    const take = book.submit(
      order({
        id: TAKE,
        account: 'taker',
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs([{ strike: A('105') }]),
      }),
    );
    expect(take.accepted).toBe(false);
    expect(take.rejected?.code).toBe(COMBO_DISAGREES);
    expect(take.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([COMBO]);
    expect(book.depth(50).asks).toEqual([['99', '2']]);
  });

  it('refuses a combo take against a plain rest — not two independent option legs', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT_A, side: 'sell', qty: '2', price: '99' }));
    const take = book.submit(
      order({
        id: TAKE,
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    expect(take.accepted).toBe(false);
    expect(take.rejected?.code).toBe(COMBO_DISAGREES);
    expect(take.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([OPT_A]);
  });

  it('refuses a plain take against a resting combo — does not unwind legs independently', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: COMBO,
        side: 'sell',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    const take = book.submit(order({ id: OPT_A, side: 'buy', qty: '2', price: '99' }));
    expect(take.accepted).toBe(false);
    expect(take.rejected?.code).toBe(COMBO_DISAGREES);
    expect(take.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([COMBO]);
    expect(comboRestOf(book, COMBO)?.orderId).toBe(COMBO);
  });

  it('refuses a combo take against a resting option — not a combo instrument', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: OPT_A,
        type: 'limit',
        side: 'sell',
        qty: '2',
        price: '99',
        strike: '100',
        expiry: EXPIRY,
      }),
    );
    const take = book.submit(
      order({
        id: TAKE,
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    expect(take.accepted).toBe(false);
    expect(take.rejected?.code).toBe(COMBO_DISAGREES);
    expect(take.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([OPT_A]);
  });

  it('incomplete combo still refuses and does not take a resting combo', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: COMBO,
        side: 'sell',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    const take = book.submit(
      order({
        id: MISS,
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs([{ expiry: OTHER }, { expiry: null }]),
      }),
    );
    expect(take.accepted).toBe(false);
    expect(take.rejected?.code).toBe(EXPIRY_MISSING);
    expect(take.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([COMBO]);
  });

  it('journal replay of two matching combos restores an empty book, not two legs', () => {
    const marketId = 'BTC/USDT';
    const journal = new MemoryJournal();
    const maker = order({
      id: COMBO,
      account: 'maker',
      side: 'sell',
      qty: '2',
      price: '99',
      combo: true,
      legs: namedLegs(),
    });
    const taker = order({
      id: TAKE,
      account: 'taker',
      side: 'buy',
      qty: '2',
      price: '99',
      combo: true,
      legs: namedLegs(),
    });
    journal.append({ kind: 'submit', marketId, at: '2026-08-31T12:00:00.000Z', order: toWire(maker) });
    journal.append({ kind: 'submit', marketId, at: '2026-08-31T12:00:01.000Z', order: toWire(taker) });
    const live = new OrderBook(marketId);
    expect(live.submit(maker).accepted).toBe(true);
    const printed = live.submit(taker);
    expect(printed.accepted).toBe(true);
    expect(printed.fills).toHaveLength(1);
    expect(formatAmount(printed.fills[0]!.qty)).toBe('2');
    const restored = replay(journal.read()).get(marketId);
    expect(restored).toBeDefined();
    expect(liveIds(restored!)).toEqual([]);
    expect(restored!.depth(50).bids).toEqual([]);
    expect(restored!.depth(50).asks).toEqual([]);
    expect(comboRestOf(restored!, COMBO)).toBeUndefined();
  });
});

describe('combo book — a triggered stop does not print a different identity', () => {
  function bookAt100(): OrderBook {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: WARM_SELL, account: 'warm', side: 'sell', qty: '1', price: '100' }));
    const bought = book.submit(order({ id: WARM_BUY, account: 'spark', side: 'buy', qty: '1' }));
    expect(bought.fills).toHaveLength(1);
    expect(formatAmount(bought.fills[0]!.price)).toBe('100');
    expect(liveIds(book)).toEqual([]);
    return book;
  }

  function parkStop(book: OrderBook, spec: { type: 'stop' | 'stop_limit'; price?: string }): void {
    const parked = book.submit(
      order({
        id: STOP_ID,
        account: 'stopdesk',
        type: spec.type,
        side: 'buy',
        qty: '2',
        ...(spec.price !== undefined ? { price: spec.price } : {}),
        stop: '105',
        combo: true,
        legs: namedLegs(),
      }),
    );
    expect(parked.accepted).toBe(true);
    expect(parked.fills).toHaveLength(0);
    expect(parked.resting).toMatchObject({ kind: 'stop', orderId: STOP_ID });
    expect(liveIds(book)).toEqual([]);
    expect(comboRestOf(book, STOP_ID)?.identity).toBe(comboIdentity(namedLegs()));
  }

  function arm(book: OrderBook): ReturnType<OrderBook['submit']> {
    book.submit(order({ id: FUEL, account: 'fuel', side: 'sell', qty: '1', price: '105' }));
    return book.submit(order({ id: SPARK, account: 'spark2', side: 'buy', qty: '1', price: '105' }));
  }

  it('a combo stop-limit that later activates does not print against a plain order', () => {
    const book = bookAt100();
    parkStop(book, { type: 'stop_limit', price: '120' });
    book.submit(order({ id: OPT_A, account: 'maker', side: 'sell', qty: '2', price: '110' }));

    const trigger = arm(book);

    expect(trigger.accepted).toBe(true);
    expect(trigger.fills).toHaveLength(1);
    expect(formatAmount(trigger.fills[0]!.price)).toBe('105');
    expect(formatAmount(trigger.fills[0]!.qty)).toBe('1');
    expect(trigger.triggered).toHaveLength(1);
    expect(trigger.triggered[0]!.orderId).toBe(STOP_ID);
    expect(trigger.triggered[0]!.fills).toHaveLength(0);
    expect(trigger.triggered[0]!.rejected?.code).toBe(COMBO_DISAGREES);
    expect(trigger.triggered[0]!.resting).toBeNull();
    expect(trigger.triggered[0]!.cancellations[0]?.reason).toBe('trigger_rejected');
    expect(trigger.triggered[0]!.cancellations[0]?.sequence).toBe(trigger.triggered[0]!.sequence);
    expect(typeof trigger.triggered[0]!.cancellations[0]?.remainingQty).toBe('bigint');
    expect(liveIds(book)).toEqual([OPT_A]);
    expect(book.depth(50).asks).toEqual([['110', '2']]);
    expect(book.depth(50).bids).toEqual([]);
    expect(book.toState().stops).toHaveLength(0);
    expect(comboRestOf(book, STOP_ID)).toBeUndefined();
    expect(comboRestOf(book, OPT_A)).toBeUndefined();
  });

  it('a combo stop that later activates does not print against a different leg identity', () => {
    const book = bookAt100();
    parkStop(book, { type: 'stop' });
    book.submit(
      order({
        id: COMBO,
        account: 'maker',
        side: 'sell',
        qty: '2',
        price: '110',
        combo: true,
        legs: namedLegs([{ strike: A('105') }]),
      }),
    );

    const trigger = arm(book);

    expect(trigger.accepted).toBe(true);
    expect(trigger.fills).toHaveLength(1);
    expect(formatAmount(trigger.fills[0]!.price)).toBe('105');
    expect(trigger.triggered).toHaveLength(1);
    expect(trigger.triggered[0]!.fills).toHaveLength(0);
    expect(trigger.triggered[0]!.rejected?.code).toBe(COMBO_DISAGREES);
    expect(trigger.triggered[0]!.resting).toBeNull();
    expect(liveIds(book)).toEqual([COMBO]);
    expect(book.depth(50).asks).toEqual([['110', '2']]);
    expect(book.depth(50).bids).toEqual([]);
    expect(formatAmount(comboRestOf(book, COMBO)!.legs[0]!.ratio)).toBe('1');
  });

  it('a same-identity combo stop-limit still prints at the resting combo price', () => {
    const book = bookAt100();
    parkStop(book, { type: 'stop_limit', price: '120' });
    book.submit(
      order({
        id: COMBO,
        account: 'maker',
        side: 'sell',
        qty: '2',
        price: '110',
        combo: true,
        legs: namedLegs(),
      }),
    );

    const trigger = arm(book);
    const printed = trigger.triggered[0]!;

    expect(trigger.accepted).toBe(true);
    expect(trigger.fills).toHaveLength(1);
    expect(formatAmount(trigger.fills[0]!.price)).toBe('105');
    expect(printed.fills).toHaveLength(1);
    expect(printed.fills[0]).toMatchObject({ makerOrderId: COMBO, takerOrderId: STOP_ID, takerSide: 'buy' });
    expect(formatAmount(printed.fills[0]!.qty)).toBe('2');
    expect(formatAmount(printed.fills[0]!.price)).toBe('110');
    expect(typeof printed.fills[0]!.qty).toBe('bigint');
    expect(typeof printed.fills[0]!.price).toBe('bigint');
    expect(printed.rejected).toBeUndefined();
    expect(printed.resting).toBeNull();
    expect(liveIds(book)).toEqual([]);
    expect(book.depth(50).asks).toEqual([]);
    expect(book.depth(50).bids).toEqual([]);
    expect(comboRestOf(book, COMBO)).toBeUndefined();
    expect(comboRestOf(book, STOP_ID)).toBeUndefined();
  });
});
