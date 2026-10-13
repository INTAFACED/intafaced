import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './engine.js';
import { FileJournal, MemoryJournal, replay, toWire } from './journal.js';
import type { ComboLeg, EngineOrder, EngineOrderType, OrderSide, TimeInForce } from './types.js';
import { comboRestOf, installComboBook } from './combo-book.js';
import {
  COMBO_DISAGREES,
  COMBO_LEGS_MISSING,
  COMBO_UNSUPPORTED,
  EXPIRY_MISSING,
  RATIO_MISSING,
  STRIKE_MISSING,
  comboDisagreesRefuse,
  comboIdentity,
  comboIntentRefuse,
  comboLegsRefuse,
  comboUnsupportedRefuse,
  readExpiry,
  readRatio,
  readStrike,
  ratioRefuse,
  wantsCombo,
} from './option-combo.js';

installComboBook();

/**
 * Combo / multi-leg. Named legs + ratios rest as one instrument.
 * Missing strike/expiry/ratio refuses. No silent two-leg rest.
 */

const A = parseAmount;

const ASK = '11111111-1111-4111-8111-111111111111';
const MISS = '44444444-4444-4444-8444-444444444444';
const PLAIN = '55555555-5555-4555-8555-555555555555';
const OPT = '11111111-1111-4111-8111-111111111111';
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
    stopPrice: null,
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

describe('option combo — named legs, never a silent two-leg rest', () => {
  it('missing flags are a normal option rest', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    expect(result.accepted).toBe(true);
    expect(result.resting).toMatchObject({ kind: 'book', orderId: OPT });
    expect(book.depth(50).bids).toEqual([['99', '2']]);
    expect(wantsCombo({})).toBe(false);
    expect(comboIntentRefuse({})).toBeNull();
  });

  it('combo:false is a normal order — no invented combo book', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: ASK, account: 'mm', side: 'sell', qty: '2', price: '100' }));
    const take = book.submit(order({ id: PLAIN, side: 'buy', qty: '10', price: '100', combo: false }));
    expect(take.accepted).toBe(true);
    expect(take.fills).toHaveLength(1);
    expect(formatAmount(take.fills[0]!.qty)).toBe('2');
  });

  it('combo:true without named legs refuses — does not rest as an option', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(
      order({
        id: MISS,
        type: 'limit',
        side: 'buy',
        qty: '2',
        price: '99',
        strike: '100',
        expiry: EXPIRY,
        combo: true,
      }),
    );
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(COMBO_LEGS_MISSING);
    expect(result.fills).toHaveLength(0);
    expect(result.resting).toBeNull();
    expect(liveIds(book)).toEqual([]);
    expect(book.depth(50).bids).toEqual([]);
  });

  it('combo with unnamed or one leg refuses', () => {
    const book = new OrderBook('BTC/USDT');
    const unnamed = book.submit(
      order({
        id: MISS,
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: [
          { name: '', ratio: A('1'), strike: A('100'), expiry: EXPIRY },
          { name: 'put', ratio: A('-1'), strike: A('100'), expiry: EXPIRY },
        ],
      }),
    );
    expect(unnamed.accepted).toBe(false);
    expect(unnamed.rejected?.code).toBe(COMBO_LEGS_MISSING);

    const one = book.submit(
      order({
        id: PLAIN,
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: [{ name: 'call', ratio: A('1'), strike: A('100'), expiry: EXPIRY }],
      }),
    );
    expect(one.accepted).toBe(false);
    expect(one.rejected?.code).toBe(COMBO_LEGS_MISSING);
    expect(liveIds(book)).toEqual([]);
  });

  it('missing ratio on a combo rest refuses — qty is a ledger amount, never a number', () => {
    const book = new OrderBook('BTC/USDT');
    for (const ratio of [null, A('0')] as const) {
      const result = book.submit(
        order({
          id: MISS,
          side: 'buy',
          qty: '2',
          price: '99',
          combo: true,
          legs: namedLegs([{ ratio }]),
        }),
      );
      expect(result.accepted).toBe(false);
      expect(result.rejected?.code).toBe(RATIO_MISSING);
      expect(result.resting).toBeNull();
    }
    const qty = A('2');
    expect(typeof qty).toBe('bigint');
    expect(readRatio({ ratio: A('-1') })).toBe(A('-1'));
    expect(typeof readRatio({ ratio: A('-1') })).toBe('bigint');
    expect(liveIds(book)).toEqual([]);
  });

  it('missing strike on a combo rest refuses — no invented strike', () => {
    const book = new OrderBook('BTC/USDT');
    for (const strike of [null, A('0')] as const) {
      const result = book.submit(
        order({
          id: MISS,
          side: 'buy',
          qty: '2',
          price: '99',
          combo: true,
          legs: namedLegs([{ strike }]),
        }),
      );
      expect(result.accepted).toBe(false);
      expect(result.rejected?.code).toBe(STRIKE_MISSING);
      expect(result.resting).toBeNull();
    }
    expect(book.depth(50).bids).toEqual([]);
  });

  it('missing expiry on a combo rest refuses — no invented expiry', () => {
    const book = new OrderBook('BTC/USDT');
    for (const expiry of [null, '', '   '] as const) {
      const result = book.submit(
        order({
          id: MISS,
          side: 'buy',
          qty: '2',
          price: '99',
          combo: true,
          legs: namedLegs([{ expiry }]),
        }),
      );
      expect(result.accepted).toBe(false);
      expect(result.rejected?.code).toBe(EXPIRY_MISSING);
      expect(result.resting).toBeNull();
    }
    expect(book.depth(50).asks).toEqual([]);
  });

  it('named legs with ratios rest as one instrument — not two independent options', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(
      order({
        id: MISS,
        type: 'limit',
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: namedLegs(),
      }),
    );
    expect(result.accepted).toBe(true);
    expect(result.resting).toMatchObject({ kind: 'book', orderId: MISS });
    expect(result.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([MISS]);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
    expect(book.depth(50).asks).toEqual([]);
    const remembered = comboRestOf(book, MISS);
    expect(remembered?.legs.map((leg) => leg.name)).toEqual(['call', 'put']);
    expect(remembered?.legs.map((leg) => formatAmount(leg.ratio))).toEqual(['1', '-1']);
    expect(typeof remembered?.legs[0]?.ratio).toBe('bigint');
  });

  it('legs without combo flag rest as one instrument when named legs are complete', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(
      order({
        id: MISS,
        type: 'limit',
        side: 'buy',
        qty: '2',
        price: '99',
        legs: namedLegs(),
      }),
    );
    expect(result.accepted).toBe(true);
    expect(result.resting).toMatchObject({ kind: 'book', orderId: MISS });
    expect(liveIds(book)).toEqual([MISS]);
    expect(comboRestOf(book, MISS)?.legs).toHaveLength(2);
  });

  it('journal replay of a combo without named legs does not invent a book', () => {
    const marketId = 'BTC/USDT';
    const journal = new MemoryJournal();
    const comboed = order({
      id: MISS,
      side: 'buy',
      qty: '2',
      price: '99',
      strike: '100',
      expiry: EXPIRY,
      combo: true,
    });
    expect(toWire(comboed).combo).toBe(true);
    journal.append({ kind: 'submit', marketId, at: '2026-08-31T12:00:00.000Z', order: toWire(comboed) });
    expect(new OrderBook(marketId).submit(comboed).accepted).toBe(false);
    expect(replay(journal.read()).get(marketId)).toBeUndefined();
  });

  it('journal replay of a complete combo restores one rest — not two, not empty', () => {
    const marketId = 'BTC/USDT';
    const journal = new MemoryJournal();
    const comboed = order({
      id: MISS,
      side: 'buy',
      qty: '2',
      price: '99',
      combo: true,
      legs: namedLegs(),
    });
    const wire = toWire(comboed);
    expect(wire.legs).toHaveLength(2);
    expect(wire.legs?.[0]?.ratio).toBe('1');
    expect(wire.legs?.[1]?.ratio).toBe('-1');
    journal.append({ kind: 'submit', marketId, at: '2026-08-31T12:00:00.000Z', order: wire });
    expect(new OrderBook(marketId).submit(comboed).accepted).toBe(true);
    const restored = replay(journal.read()).get(marketId);
    expect(restored).toBeDefined();
    expect(liveIds(restored!)).toEqual([MISS]);
    expect(restored!.depth(50).bids).toEqual([['99', '2']]);
    expect(comboRestOf(restored!, MISS)?.legs.map((leg) => formatAmount(leg.ratio))).toEqual(['1', '-1']);
  });

  it('FileJournal encode keeps missing legs so a crash still refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-option-combo-'));
    const path = join(dir, 'engine.ndjson');
    const marketId = 'BTC/USDT';
    const comboed = order({
      id: MISS,
      side: 'buy',
      qty: '2',
      price: '99',
      combo: true,
      legs: namedLegs([{ strike: null }]),
    });
    const live = new OrderBook(marketId).submit(comboed);
    expect(live.accepted).toBe(false);
    expect(live.rejected?.code).toBe(STRIKE_MISSING);

    const j1 = new FileJournal(path);
    j1.append({ kind: 'submit', marketId, at: '2026-08-31T12:00:00.000Z', order: toWire(comboed) });
    j1.close();

    const onDisk = JSON.parse(readFileSync(path, 'utf8').trim()) as {
      order: { combo?: boolean; legs?: { strike?: string | null; ratio?: string | null }[] };
    };
    expect(onDisk.order.combo).toBe(true);
    expect(onDisk.order.legs?.[0]?.strike).toBeNull();
    expect(onDisk.order.legs?.[0]?.ratio).toBe('1');

    const j2 = new FileJournal(path);
    expect(replay(j2.read()).get(marketId)).toBeUndefined();
    j2.close();
  });

  it('read helpers treat missing and false as not set; combo true without legs refuses', () => {
    expect(wantsCombo({})).toBe(false);
    expect(wantsCombo({ combo: null })).toBe(false);
    expect(wantsCombo({ combo: false })).toBe(false);
    expect(wantsCombo({ combo: true })).toBe(true);
    expect(wantsCombo({ legs: [] })).toBe(true);
    expect(readRatio({})).toBeNull();
    expect(readRatio({ ratio: A('0') })).toBeNull();
    expect(readStrike({ strike: A('0') })).toBeNull();
    expect(readExpiry({ expiry: '  ' })).toBeNull();
    expect(comboLegsRefuse(undefined)?.code).toBe(COMBO_LEGS_MISSING);
    expect(ratioRefuse(null)?.code).toBe(RATIO_MISSING);
    expect(comboUnsupportedRefuse().code).toBe(COMBO_UNSUPPORTED);
    expect(comboDisagreesRefuse().code).toBe(COMBO_DISAGREES);
    expect(comboIntentRefuse({ combo: true })?.code).toBe(COMBO_LEGS_MISSING);
    expect(comboIntentRefuse({ combo: true, legs: namedLegs() })).toBeNull();
    expect(comboIdentity(namedLegs())).toContain('call|1|100|');
    expect(comboIdentity(namedLegs())).toBe(comboIdentity([...namedLegs()].reverse()));
  });

  it('a leg name containing an identity separator is refused and does not alias another leg set', () => {
    const pipe: ComboLeg[] = [
      { name: 'call|1', ratio: A('100'), strike: A('50'), expiry: EXPIRY },
      { name: 'put', ratio: A('-1'), strike: A('90'), expiry: EXPIRY },
    ];
    const shifted: ComboLeg[] = [
      { name: 'call', ratio: A('1'), strike: A('100'), expiry: `50|${EXPIRY}` },
      { name: 'put', ratio: A('-1'), strike: A('90'), expiry: EXPIRY },
    ];
    const semi: ComboLeg[] = [
      { name: 'call;put', ratio: A('1'), strike: A('100'), expiry: EXPIRY },
      { name: 'hedge', ratio: A('-1'), strike: A('100'), expiry: EXPIRY },
    ];
    const collided = `call|1|100|50|${EXPIRY};put|-1|90|${EXPIRY}`;
    const aliasOfNamed: ComboLeg[] = [{ name: `call|1|100|${EXPIRY};put`, ratio: A('-1'), strike: A('100'), expiry: EXPIRY }];

    expect(comboLegsRefuse(pipe)?.code).toBe(COMBO_LEGS_MISSING);
    expect(comboLegsRefuse(semi)?.code).toBe(COMBO_LEGS_MISSING);
    expect(comboIntentRefuse({ combo: true, legs: pipe })?.code).toBe(COMBO_LEGS_MISSING);
    expect(comboIntentRefuse({ combo: true, legs: semi })?.code).toBe(COMBO_LEGS_MISSING);

    const pipeId = comboIdentity(pipe);
    const shiftedId = comboIdentity(shifted);
    const semiId = comboIdentity(semi);
    const aliasId = comboIdentity(aliasOfNamed);
    const stable = comboIdentity(namedLegs());

    expect(pipeId).toMatchObject({ code: COMBO_LEGS_MISSING });
    expect(shiftedId).toMatchObject({ code: COMBO_LEGS_MISSING });
    expect(semiId).toMatchObject({ code: COMBO_LEGS_MISSING });
    expect(aliasId).toMatchObject({ code: COMBO_LEGS_MISSING });
    expect(typeof pipeId).not.toBe('string');
    expect(typeof shiftedId).not.toBe('string');
    expect(typeof semiId).not.toBe('string');
    expect(typeof aliasId).not.toBe('string');
    expect(typeof pipeId === 'string' && pipeId === shiftedId).toBe(false);
    expect(pipeId).not.toBe(collided);
    expect(shiftedId).not.toBe(collided);
    expect(aliasId).not.toBe(stable);
    expect(stable).not.toBe(collided);

    const book = new OrderBook('BTC/USDT');
    const rested = book.submit(
      order({
        id: MISS,
        side: 'buy',
        qty: '2',
        price: '99',
        combo: true,
        legs: pipe,
      }),
    );
    expect(rested.accepted).toBe(false);
    expect(rested.rejected?.code).toBe(COMBO_LEGS_MISSING);
    expect(rested.resting).toBeNull();
    expect(liveIds(book)).toEqual([]);
  });

  it('comboIdentity refuses a missing ratio, strike, or expiry', () => {
    const missingRatio = comboIdentity(namedLegs([{ ratio: null }]));
    const missingStrike = comboIdentity(namedLegs([{ strike: null }]));
    const missingExpiry = comboIdentity(namedLegs([{ expiry: null }]));
    expect(missingRatio).toMatchObject({ code: RATIO_MISSING });
    expect(missingStrike).toMatchObject({ code: STRIKE_MISSING });
    expect(missingExpiry).toMatchObject({ code: EXPIRY_MISSING });
    expect(typeof missingRatio).not.toBe('string');
    expect(typeof missingStrike).not.toBe('string');
    expect(typeof missingExpiry).not.toBe('string');
    expect(comboIdentity(namedLegs([{ ratio: A('0') }]))).toMatchObject({ code: RATIO_MISSING });
    expect(comboIdentity(namedLegs([{ strike: A('0') }]))).toMatchObject({ code: STRIKE_MISSING });
    expect(comboIdentity(namedLegs([{ expiry: '   ' }]))).toMatchObject({ code: EXPIRY_MISSING });
  });

  it('an ordinary named pair keeps one stable combo id', () => {
    const id = comboIdentity(namedLegs());
    expect(typeof id).toBe('string');
    expect(id).toContain('call|1|100|');
    expect(id).toBe(comboIdentity([...namedLegs()].reverse()));
    expect(comboIntentRefuse({ combo: true, legs: namedLegs() })).toBeNull();
  });
});
