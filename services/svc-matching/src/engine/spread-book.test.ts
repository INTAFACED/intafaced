import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { SCALE, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { MatchingEngine, OrderBook, type SpreadOrderInput } from './engine.js';
import { encode } from './journal-codec.js';
import { MemoryJournal, decodeAll, replayJournal, serializeBooks, type JournalRecord } from './journal.js';
import { installCoreTif } from './core-tif.js';
import { installSpreadBook, type SpreadFillEvent, type SpreadFillPublisher } from './spread-book.js';
import { readSpreadListing, spreadLegFills, type SpreadListingInput } from './spread-instrument.js';
import type { EngineOrder, Fill, OrderSide, SpreadInstrument, SubmitResult } from './types.js';

installSpreadBook();
installCoreTif();

/**
 * CB-otc-16 — spread book in matching.
 * Owner-listed calendar and inter-coin spreads rest and match as one instrument at a spread price; every fill prints
 * every leg at its ratio or nothing prints. Holds and the trade route are svc-trade's (a later PR).
 */

const A = parseAmount;

/** Calendar: buying the spread sells the near leg and buys the far leg. Spread = far - near. Near is the anchor. */
const CAL = 'BTC-CAL-MAR-JUN';
const NEAR = 'BTC-27MAR';
const FAR = 'BTC-26JUN';
const CAL_LISTING: SpreadListingInput = {
  spreadId: CAL,
  kind: 'calendar',
  legs: [
    { symbol: NEAR, side: 'sell', ratio: '1' },
    { symbol: FAR, side: 'buy', ratio: '1' },
  ],
  tick: '0.5',
  lot: '0.001',
};

/** Inter-coin 2:1: buying the spread buys 2 ETH and sells 1 BTC. Spread = 2 x ETH - BTC. ETH is the anchor. */
const PAIR = 'ETH-BTC-2X1';
const PAIR_LISTING: SpreadListingInput = {
  spreadId: PAIR,
  kind: 'inter_coin',
  legs: [
    { symbol: 'ETH-USDT', side: 'buy', ratio: '2' },
    { symbol: 'BTC-USDT', side: 'sell', ratio: '1' },
  ],
  tick: '0.01',
  lot: '0.01',
};

const OPS = { operatorId: 'ops-1', confirmOperatorId: 'ops-2' };

let counter = 0;
function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

function fixedClock(): () => Date {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 9, 20) + tick * 1000);
  };
}

class RecordingPublisher implements SpreadFillPublisher {
  readonly published: { event: SpreadFillEvent; key: string }[] = [];
  publish(event: SpreadFillEvent, opts: { readonly idempotencyKey: string }): void {
    this.published.push({ event, key: opts.idempotencyKey });
  }
}

function build(opts: { journal?: MemoryJournal; publisher?: SpreadFillPublisher | null } = {}) {
  const journal = opts.journal ?? new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const spreadFills = opts.publisher === null ? undefined : (opts.publisher ?? new RecordingPublisher());
  const engine = new MatchingEngine({
    journal,
    bus,
    clock: fixedClock(),
    snapshotEvery: 0,
    ...(spreadFills ? { spreadFills } : {}),
  });
  return { journal, bus, engine, publisher: spreadFills as RecordingPublisher | undefined };
}

function spreadOrder(spec: {
  side: OrderSide;
  qty: string;
  price: string;
  reference?: string | null;
  account?: string;
  id?: string;
  tif?: SpreadOrderInput['tif'];
  clientOrderId?: string;
}): SpreadOrderInput {
  return {
    orderId: spec.id ?? uuid(),
    accountId: spec.account ?? 'acct-taker',
    side: spec.side,
    qty: A(spec.qty),
    price: A(spec.price),
    tif: spec.tif ?? 'GTC',
    anchorReference: spec.reference === null ? null : A(spec.reference ?? '60000'),
    ...(spec.clientOrderId ? { clientOrderId: spec.clientOrderId } : {}),
  };
}

function instrumentOf(input: SpreadListingInput): SpreadInstrument {
  const read = readSpreadListing(input);
  if (!read.ok) throw new Error(read.rejected.message);
  return read.instrument;
}

function sign(side: OrderSide): bigint {
  return side === 'buy' ? 1n : -1n;
}

/** Legs in exact ratio, positive prices, and the leg prices sum to the spread price with no rounding. */
function expectWholeSpread(fill: Fill, instrument: SpreadInstrument): void {
  expect(fill.legs).toBeDefined();
  const legs = fill.legs ?? [];
  expect(legs).toHaveLength(instrument.legs.length);
  let spread = 0n;
  for (const [index, leg] of instrument.legs.entries()) {
    const printed = legs[index]!;
    expect(printed.symbol).toBe(leg.symbol);
    expect(printed.qty * SCALE).toBe(fill.qty * leg.ratio);
    expect(printed.price > 0n).toBe(true);
    expect(printed.takerSide).toBe(fill.takerSide === 'buy' ? leg.side : leg.side === 'buy' ? 'sell' : 'buy');
    spread += (sign(leg.side) * leg.ratio * printed.price) / SCALE;
  }
  expect(spread).toBe(fill.price);
}

async function listed(...listings: SpreadListingInput[]) {
  const built = build();
  for (const listing of listings) {
    const result = await built.engine.listSpread(listing, OPS);
    expect(result.accepted).toBe(true);
  }
  return built;
}

describe('spread listing — owner data, refused when blank', () => {
  it('no listing is an empty registry, with no sample instruments', () => {
    const { engine } = build();
    expect(engine.spreadInstruments()).toEqual([]);
    expect(engine.spreadBook(CAL, 10)).toBeNull();
  });

  it('lists a calendar and an inter-coin spread and journals each listing once', async () => {
    const { engine, journal } = await listed(CAL_LISTING, PAIR_LISTING);
    expect(engine.spreadInstruments().map((row) => row.spreadId)).toEqual([PAIR, CAL].sort());
    expect(journal.read().filter((row) => row.kind === 'spread_list')).toHaveLength(2);

    const again = await engine.listSpread(CAL_LISTING, OPS);
    expect(again).toMatchObject({ accepted: true, alreadyListed: true });
    expect(journal.length).toBe(2);
  });

  it.each([
    ['spread id', { spreadId: '  ' }, 'spread_id_missing'],
    ['kind', { kind: '' }, 'spread_kind_unsupported'],
    ['unknown kind', { kind: 'butterfly' }, 'spread_kind_unsupported'],
    ['legs', { legs: null }, 'spread_legs_invalid'],
    ['one leg', { legs: [{ symbol: NEAR, side: 'sell', ratio: '1' }] }, 'spread_legs_invalid'],
    [
      'leg symbol',
      {
        legs: [
          { symbol: '', side: 'sell', ratio: '1' },
          { symbol: FAR, side: 'buy', ratio: '1' },
        ],
      },
      'spread_leg_symbol_missing',
    ],
    [
      'leg side',
      {
        legs: [
          { symbol: NEAR, side: null, ratio: '1' },
          { symbol: FAR, side: 'buy', ratio: '1' },
        ],
      },
      'spread_leg_side_missing',
    ],
    [
      'blank ratio',
      {
        legs: [
          { symbol: NEAR, side: 'sell', ratio: '' },
          { symbol: FAR, side: 'buy', ratio: '1' },
        ],
      },
      'spread_ratio_missing',
    ],
    [
      'zero ratio',
      {
        legs: [
          { symbol: NEAR, side: 'sell', ratio: '0' },
          { symbol: FAR, side: 'buy', ratio: '1' },
        ],
      },
      'spread_ratio_missing',
    ],
    [
      'same side twice',
      {
        legs: [
          { symbol: NEAR, side: 'buy', ratio: '1' },
          { symbol: FAR, side: 'buy', ratio: '1' },
        ],
      },
      'spread_legs_invalid',
    ],
    [
      'one symbol twice',
      {
        legs: [
          { symbol: NEAR, side: 'sell', ratio: '1' },
          { symbol: NEAR, side: 'buy', ratio: '1' },
        ],
      },
      'spread_legs_invalid',
    ],
    [
      'a leg that is the spread itself',
      {
        legs: [
          { symbol: CAL, side: 'sell', ratio: '1' },
          { symbol: FAR, side: 'buy', ratio: '1' },
        ],
      },
      'spread_legs_invalid',
    ],
    [
      'calendar at unequal ratios',
      {
        legs: [
          { symbol: NEAR, side: 'sell', ratio: '1' },
          { symbol: FAR, side: 'buy', ratio: '2' },
        ],
      },
      'spread_legs_invalid',
    ],
    ['tick', { tick: null }, 'spread_tick_missing'],
    ['zero tick', { tick: '0' }, 'spread_tick_missing'],
    ['lot', { lot: '' }, 'spread_lot_missing'],
    ['malformed lot', { lot: '1e-3' }, 'spread_lot_missing'],
  ])('a missing or invalid %s refuses typed and lists nothing', async (_label, over, code) => {
    const { engine, journal } = build();
    const result = await engine.listSpread({ ...CAL_LISTING, ...over } as SpreadListingInput, OPS);
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(code);
    expect(engine.spreadInstruments()).toEqual([]);
    expect(journal.length).toBe(0);
  });

  it('a lot or tick that would force rounding a leg refuses spread_size_inexact', async () => {
    const { engine } = build();
    const lotRounds = await engine.listSpread(
      {
        ...PAIR_LISTING,
        lot: '0.000000000000000001',
        legs: [
          { symbol: 'ETH-USDT', side: 'buy', ratio: '0.5' },
          { symbol: 'BTC-USDT', side: 'sell', ratio: '1' },
        ],
      },
      OPS,
    );
    expect(lotRounds.rejected?.code).toBe('spread_size_inexact');
    const tickRounds = await engine.listSpread(
      {
        ...PAIR_LISTING,
        legs: [
          { symbol: 'ETH-USDT', side: 'buy', ratio: '1' },
          { symbol: 'BTC-USDT', side: 'sell', ratio: '3' },
        ],
      },
      OPS,
    );
    expect(tickRounds.rejected?.code).toBe('spread_size_inexact');
  });

  it('a second, different definition under a listed id refuses; an outright market id refuses', async () => {
    const { engine, journal } = await listed(CAL_LISTING);
    const changed = await engine.listSpread({ ...CAL_LISTING, tick: '1' }, OPS);
    expect(changed.rejected?.code).toBe('spread_listing_conflict');
    expect(engine.spreadInstrument(CAL)?.tick).toBe(A('0.5'));

    await engine.submit('XRP-USDT', {
      orderId: uuid(),
      accountId: 'mm',
      type: 'limit',
      side: 'sell',
      qty: A('1'),
      price: A('100'),
      stopPrice: null,
      tif: 'GTC',
    });
    const collides = await engine.listSpread({ ...PAIR_LISTING, spreadId: 'XRP-USDT' }, OPS);
    expect(collides.rejected?.code).toBe('spread_id_collides');
    expect(journal.read().filter((row) => row.kind === 'spread_list')).toHaveLength(1);
  });

  it('a spread whose leg is itself a listed spread refuses', async () => {
    const { engine } = await listed(CAL_LISTING);
    const nested = await engine.listSpread(
      {
        ...PAIR_LISTING,
        spreadId: 'NESTED',
        legs: [
          { symbol: CAL, side: 'buy', ratio: '1' },
          { symbol: 'BTC-USDT', side: 'sell', ratio: '1' },
        ],
      },
      OPS,
    );
    expect(nested.rejected?.code).toBe('spread_legs_invalid');
    expect(engine.spreadInstrument('NESTED')).toBeNull();
  });

  it('a listing needs two distinct operators', async () => {
    const { engine } = build();
    const single = await engine.listSpread(CAL_LISTING, { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(single.accepted).toBe(false);
    expect(engine.spreadInstruments()).toEqual([]);
  });
});

describe('spread book — spread price, rest and match as one instrument', () => {
  it('given a calendar spread listed, the book shows the spread price, including a negative one', async () => {
    const { engine } = await listed(CAL_LISTING);
    expect(engine.spreadBook(CAL, 10)).toMatchObject({ bids: [], asks: [], bestBid: null, bestAsk: null, lastPrice: null });

    await engine.submitSpread(CAL, spreadOrder({ side: 'sell', qty: '0.5', price: '150', account: 'mm' }));
    await engine.submitSpread(CAL, spreadOrder({ side: 'buy', qty: '0.25', price: '-25', account: 'mm-2' }));
    const book = engine.spreadBook(CAL, 10);
    expect(book).toMatchObject({
      bids: [['-25', '0.25']],
      asks: [['150', '0.5']],
      bestBid: '-25',
      bestAsk: '150',
      lastPrice: null,
    });

    const take = await engine.submitSpread(CAL, spreadOrder({ side: 'buy', qty: '0.1', price: '150' }));
    expect(take.fills).toHaveLength(1);
    expect(engine.spreadBook(CAL, 10)).toMatchObject({ lastPrice: '150', asks: [['150', '0.4']] });
  });

  it('fills at the maker spread price and prints both calendar legs: near at the reference, far = near + spread', async () => {
    const { engine, publisher, bus } = await listed(CAL_LISTING);
    const maker = spreadOrder({ side: 'sell', qty: '2', price: '150', account: 'mm', reference: '59000' });
    await engine.submitSpread(CAL, maker);
    const take = await engine.submitSpread(CAL, spreadOrder({ side: 'buy', qty: '2', price: '155', reference: '60000' }));

    expect(take.accepted).toBe(true);
    expect(take.fills).toHaveLength(1);
    const fill = take.fills[0]!;
    expect(formatAmount(fill.price)).toBe('150');
    expect(fill.legs?.map((leg) => [leg.symbol, leg.takerSide, formatAmount(leg.qty), formatAmount(leg.price)])).toEqual([
      [NEAR, 'sell', '2', '60000'],
      [FAR, 'buy', '2', '60150'],
    ]);
    expectWholeSpread(fill, instrumentOf(CAL_LISTING));
    expect(publisher?.published).toHaveLength(1);
    expect(publisher?.published[0]?.key).toBe(`matching.spread.filled:${CAL}:${fill.sequence}`);
    expect(bus.published.filter((env) => env.subject.endsWith('order.filled'))).toHaveLength(0);
  });

  it('given an inter-coin spread at 2:1, one match is one spread fill carrying both legs', async () => {
    const { engine, publisher } = await listed(PAIR_LISTING);
    await engine.submitSpread(PAIR, spreadOrder({ side: 'sell', qty: '3', price: '-54000', account: 'mm', reference: '3000' }));
    const take = await engine.submitSpread(PAIR, spreadOrder({ side: 'buy', qty: '3', price: '-54000', reference: '3000' }));

    expect(take.fills).toHaveLength(1);
    const fill = take.fills[0]!;
    expect(fill.legs?.map((leg) => [leg.symbol, leg.takerSide, formatAmount(leg.qty), formatAmount(leg.price)])).toEqual([
      ['ETH-USDT', 'buy', '6', '3000'],
      ['BTC-USDT', 'sell', '3', '60000'],
    ]);
    expectWholeSpread(fill, instrumentOf(PAIR_LISTING));

    expect(publisher?.published).toHaveLength(1);
    const event = publisher!.published[0]!.event;
    expect(event).toMatchObject({ spreadId: PAIR, price: '-54000', qty: '3', takerSide: 'buy', makerAccountId: 'mm' });
    expect(event.legs).toEqual([
      { symbol: 'ETH-USDT', takerSide: 'buy', qty: '6', price: '3000' },
      { symbol: 'BTC-USDT', takerSide: 'sell', qty: '3', price: '60000' },
    ]);
  });

  it('a partial spread fill keeps every leg at the ratio and rests the rest as one spread order', async () => {
    const { engine } = await listed(PAIR_LISTING);
    await engine.submitSpread(PAIR, spreadOrder({ side: 'sell', qty: '1', price: '-100', account: 'mm', reference: '3000' }));
    const take = await engine.submitSpread(PAIR, spreadOrder({ side: 'buy', qty: '2.5', price: '-100', reference: '3000' }));
    expect(take.fills).toHaveLength(1);
    expect(formatAmount(take.fills[0]!.qty)).toBe('1');
    expect(take.fills[0]!.legs?.map((leg) => formatAmount(leg.qty))).toEqual(['2', '1']);
    expect(take.resting).toMatchObject({ remaining: A('1.5') });
    expect(engine.spreadBook(PAIR, 10)?.bids).toEqual([['-100', '1.5']]);
  });

  it('outright orders never touch a spread book, and spread orders never touch an outright book', async () => {
    const { engine, journal } = await listed(CAL_LISTING);
    const outright: EngineOrder = {
      orderId: uuid(),
      accountId: 'acct',
      type: 'limit',
      side: 'buy',
      qty: A('1'),
      price: A('100'),
      stopPrice: null,
      tif: 'GTC',
    };
    const before = journal.length;
    const refused = await engine.submit(CAL, outright);
    expect(refused.rejected?.code).toBe('spread_book_outright_refused');
    expect(journal.length).toBe(before);

    const unlisted = await engine.submitSpread('NOT-LISTED', spreadOrder({ side: 'buy', qty: '1', price: '1' }));
    expect(unlisted.rejected?.code).toBe('spread_unlisted');
    expect(journal.length).toBe(before);
  });

  it('cancel works through the normal door and releases the whole spread order', async () => {
    const { engine, bus } = await listed(CAL_LISTING);
    const maker = spreadOrder({ side: 'sell', qty: '1', price: '150', account: 'mm' });
    await engine.submitSpread(CAL, maker);
    const cancel = await engine.cancel(CAL, maker.orderId);
    expect(cancel.cancelled).toBe(true);
    expect(formatAmount(cancel.cancellation!.remainingQty)).toBe('1');
    expect(bus.published.filter((env) => env.subject.endsWith('order.cancelled'))).toHaveLength(1);
    expect(engine.spreadBook(CAL, 10)?.asks).toEqual([]);
  });

  it('native amend on a spread refuses before the journal', async () => {
    const { engine, journal } = await listed(CAL_LISTING);
    const maker = spreadOrder({ side: 'sell', qty: '1', price: '150', account: 'mm' });
    await engine.submitSpread(CAL, maker);
    const before = journal.length;
    const amended = await engine.amend(CAL, { orderId: maker.orderId, expectedVersion: 1, price: A('149.5') });
    expect(amended.rejected?.code).toBe('spread_amend_unsupported');
    expect(journal.length).toBe(before);
  });
});

describe('equal or nothing — a spread that cannot fill every leg refuses whole', () => {
  async function unchanged<T>(
    engine: MatchingEngine,
    journal: MemoryJournal,
    publisher: RecordingPublisher | undefined,
    act: () => Promise<T>,
  ) {
    const book = engine.serialize();
    const records = journal.length;
    const fills = publisher?.published.length ?? 0;
    const out = await act();
    expect(engine.serialize()).toBe(book);
    expect(journal.length).toBe(records);
    expect(publisher?.published.length ?? 0).toBe(fills);
    return out;
  }

  it('given one leg market halted, the whole spread refuses and nothing is journalled or filled', async () => {
    const { engine, journal, publisher } = await listed(CAL_LISTING);
    await engine.submitSpread(CAL, spreadOrder({ side: 'sell', qty: '1', price: '150', account: 'mm' }));
    await engine.halt(FAR, OPS);
    const recordsAfterHalt = journal.length;
    const refused = await unchanged(engine, journal, publisher, () =>
      engine.submitSpread(CAL, spreadOrder({ side: 'buy', qty: '1', price: '150' })),
    );
    expect(refused.rejected?.code).toBe('spread_leg_unavailable');
    expect(journal.length).toBe(recordsAfterHalt);
  });

  it.each([
    ['halted', (engine: MatchingEngine) => engine.halt(FAR, OPS)],
    ['delisted', (engine: MatchingEngine) => engine.delist(FAR, OPS)],
    ['expired', (engine: MatchingEngine) => engine.expire(FAR, OPS)],
    ['in prelaunch', (engine: MatchingEngine) => engine.prelaunch(FAR, OPS)],
    ['in maintenance', (engine: MatchingEngine) => engine.enterMaintenance(FAR, OPS)],
    ['held closed by the replay hold check', async (engine: MatchingEngine) => engine.holdHalt(FAR, 'matching.hold_missing')],
  ])('a leg market %s refuses the whole spread', async (_label, close) => {
    const { engine, journal, publisher } = await listed(CAL_LISTING);
    await engine.submitSpread(CAL, spreadOrder({ side: 'sell', qty: '1', price: '150', account: 'mm' }));
    await close(engine);
    const refused = await unchanged(engine, journal, publisher, () =>
      engine.submitSpread(CAL, spreadOrder({ side: 'buy', qty: '1', price: '150' })),
    );
    expect(refused.rejected?.code).toBe('spread_leg_unavailable');
  });

  it('given a fill that would price the residual leg at or below zero, nothing fills — not even a good level first', async () => {
    const { engine, journal, publisher } = await listed(CAL_LISTING);
    // Rests priced for their own reference: far = 100 - 70 = 30 and 100 + 10 = 110.
    await engine.submitSpread(CAL, spreadOrder({ side: 'sell', qty: '1', price: '-70', account: 'mm', reference: '100' }));
    await engine.submitSpread(CAL, spreadOrder({ side: 'sell', qty: '1', price: '10', account: 'mm', reference: '100' }));
    // Taker reference 60: the -70 level would print far at -10. The 10 level alone would be fine.
    const refused = await unchanged(engine, journal, publisher, () =>
      engine.submitSpread(CAL, spreadOrder({ side: 'buy', qty: '2', price: '10', reference: '60' })),
    );
    expect(refused.accepted).toBe(false);
    expect(refused.fills).toEqual([]);
    expect(refused.rejected?.code).toBe('spread_leg_unfillable');
    expect(engine.spreadBook(CAL, 10)?.asks).toEqual([
      ['-70', '1'],
      ['10', '1'],
    ]);
  });

  it('an order whose own price cannot price the residual leg refuses before it can rest', async () => {
    const { engine, journal, publisher } = await listed(PAIR_LISTING);
    // 2 x 120 - 300 = -60 for BTC.
    const refused = await unchanged(engine, journal, publisher, () =>
      engine.submitSpread(PAIR, spreadOrder({ side: 'buy', qty: '1', price: '300', reference: '120' })),
    );
    expect(refused.rejected?.code).toBe('spread_leg_unfillable');
  });

  it.each([
    ['a missing anchor reference', { reference: null }, 'spread_reference_missing'],
    ['a zero anchor reference', { reference: '0' }, 'spread_reference_missing'],
    ['an off-tick spread price', { price: '150.25' }, 'spread_price_off_tick'],
    ['an off-lot qty', { qty: '0.0005' }, 'spread_qty_off_lot'],
    ['IOC (CB-otc-17)', { tif: 'IOC' as const }, 'spread_order_unsupported'],
  ])('%s refuses typed and leaves no trace', async (_label, over, code) => {
    const { engine, journal, publisher } = await listed(CAL_LISTING);
    await engine.submitSpread(CAL, spreadOrder({ side: 'sell', qty: '1', price: '150', account: 'mm' }));
    const refused = await unchanged(engine, journal, publisher, () =>
      engine.submitSpread(CAL, spreadOrder({ side: 'buy', qty: '1', price: '150', ...over })),
    );
    expect(refused.rejected?.code).toBe(code);
  });

  it('a spread order for an id that is not listed refuses before the journal, even off the spread door', async () => {
    const { engine, journal, publisher } = await listed(CAL_LISTING);
    const forged: EngineOrder = {
      orderId: uuid(),
      accountId: 'acct',
      type: 'limit',
      side: 'buy',
      qty: A('1'),
      price: A('150'),
      stopPrice: null,
      tif: 'GTC',
      spread: { instrument: instrumentOf({ ...CAL_LISTING, spreadId: 'NOT-LISTED' }), anchorReference: A('60000') },
    };
    const refused = await unchanged(engine, journal, publisher, () => engine.submit('NOT-LISTED', forged));
    expect(refused.rejected?.code).toBe('spread_unlisted');
    expect(engine.existingBook('NOT-LISTED')).toBeNull();
  });

  it('an order carrying another listing than the registry refuses before the journal', async () => {
    const { engine, journal, publisher } = await listed(CAL_LISTING);
    const forged: EngineOrder = {
      orderId: uuid(),
      accountId: 'acct',
      type: 'limit',
      side: 'buy',
      qty: A('1'),
      price: A('150'),
      stopPrice: null,
      tif: 'GTC',
      spread: { instrument: instrumentOf({ ...CAL_LISTING, tick: '0.25' }), anchorReference: A('60000') },
    };
    const refused = await unchanged(engine, journal, publisher, () => engine.submit(CAL, forged));
    expect(refused.rejected?.code).toBe('spread_identity_disagrees');
  });

  it.each([
    ['a market spread order', { type: 'market' as const, price: null }],
    ['a stop price', { stopPrice: A('1') }],
    ['reduce-only', { reduceOnly: true }],
    ['an iceberg', { iceberg: true, displayQty: A('0.5') }],
    ['option legs', { combo: true }],
  ])('%s is not a spread feature yet and refuses spread_order_unsupported', async (_label, over) => {
    const { engine, journal, publisher } = await listed(CAL_LISTING);
    const order: EngineOrder = {
      orderId: uuid(),
      accountId: 'acct',
      type: 'limit',
      side: 'buy',
      qty: A('1'),
      price: A('150'),
      stopPrice: null,
      tif: 'GTC',
      spread: { instrument: instrumentOf(CAL_LISTING), anchorReference: A('60000') },
      ...over,
    };
    const refused = await unchanged(engine, journal, publisher, () => engine.submit(CAL, order));
    expect(refused.rejected?.code).toBe('spread_order_unsupported');
  });

  it.each([
    [
      'anchor ratio 0.5',
      [
        { symbol: 'ETH-USDT', side: 'buy', ratio: '0.5' },
        { symbol: 'BTC-USDT', side: 'sell', ratio: '1' },
      ],
      '2',
    ],
    [
      'residual ratio 4',
      [
        { symbol: 'ETH-USDT', side: 'buy', ratio: '1' },
        { symbol: 'BTC-USDT', side: 'sell', ratio: '4' },
      ],
      '1',
    ],
  ])('a reference that would force rounding a leg refuses spread_reference_missing (%s)', async (_label, legs, lot) => {
    const listing = { ...PAIR_LISTING, spreadId: 'ROUNDING', tick: '0.04', lot, legs };
    const { engine, journal, publisher } = await listed(listing);
    const refused = await unchanged(engine, journal, publisher, () =>
      engine.submitSpread('ROUNDING', spreadOrder({ side: 'buy', qty: lot, price: '0', reference: '0.000000000000000001' })),
    );
    expect(refused.rejected?.code).toBe('spread_reference_missing');
  });

  it('with no spread fill publisher wired, spread orders refuse before the journal (no maker fill goes unannounced)', async () => {
    const { engine, journal } = build({ publisher: null });
    await engine.listSpread(CAL_LISTING, OPS);
    const records = journal.length;
    const refused = await engine.submitSpread(CAL, spreadOrder({ side: 'sell', qty: '1', price: '150' }));
    expect(refused.rejected?.code).toBe('spread_fill_event_unwired');
    expect(journal.length).toBe(records);
    expect(engine.spreadBook(CAL, 10)?.asks).toEqual([]);
  });
});

describe('idempotency', () => {
  it('a retried order id does not rest or fill twice and is not journalled again', async () => {
    const { engine, journal, publisher } = await listed(CAL_LISTING);
    const maker = spreadOrder({ side: 'sell', qty: '2', price: '150', account: 'mm' });
    await engine.submitSpread(CAL, maker);
    const take = spreadOrder({ side: 'buy', qty: '1', price: '150' });
    await engine.submitSpread(CAL, take);
    const records = journal.length;

    const retryTake = await engine.submitSpread(CAL, take);
    expect(retryTake.rejected?.code).toBe('duplicate_order_id');
    const retryMaker = await engine.submitSpread(CAL, maker);
    expect(retryMaker.rejected?.code).toBe('duplicate_order_id');
    expect(journal.length).toBe(records);
    expect(publisher?.published).toHaveLength(1);
    expect(engine.spreadBook(CAL, 10)?.asks).toEqual([['150', '1']]);
  });

  it('a retried id answers duplicate_order_id even when the retry would now refuse for a spread reason', async () => {
    const { engine } = await listed(CAL_LISTING);
    const maker = spreadOrder({ side: 'sell', qty: '1', price: '150', account: 'mm' });
    await engine.submitSpread(CAL, maker);
    const retry = await engine.submitSpread(CAL, { ...maker, anchorReference: null });
    expect(retry.rejected?.code).toBe('duplicate_order_id');
  });

  it('a reused client order id refuses client_order_id_reuse', async () => {
    const { engine, journal } = await listed(CAL_LISTING);
    const first = await engine.submitSpread(CAL, spreadOrder({ side: 'sell', qty: '1', price: '150', clientOrderId: 'spread:mm:1' }));
    expect(first.accepted).toBe(true);
    const records = journal.length;
    const again = await engine.submitSpread(CAL, spreadOrder({ side: 'sell', qty: '1', price: '150', clientOrderId: 'spread:mm:1' }));
    expect(again.rejected?.code).toBe('client_order_id_reuse');
    expect(journal.length).toBe(records);
  });
});

describe('journal and replay', () => {
  async function trade() {
    const built = await listed(CAL_LISTING, PAIR_LISTING);
    const { engine } = built;
    await engine.submitSpread(CAL, spreadOrder({ side: 'sell', qty: '2', price: '150', account: 'mm', reference: '59000' }));
    await engine.submitSpread(CAL, spreadOrder({ side: 'buy', qty: '1', price: '-20', account: 'mm-2', reference: '59000' }));
    await engine.submitSpread(CAL, spreadOrder({ side: 'buy', qty: '1.5', price: '150', reference: '60000' }));
    await engine.submitSpread(PAIR, spreadOrder({ side: 'sell', qty: '1', price: '-54000', account: 'mm', reference: '3000' }));
    await engine.submitSpread(PAIR, spreadOrder({ side: 'buy', qty: '0.5', price: '-54000', reference: '3000' }));
    return built;
  }

  it('a restart replays the listings and rebuilds the exact spread books, then keeps trading the same way', async () => {
    const live = await trade();
    const restarted = build({ journal: live.journal });
    await restarted.engine.recover();

    expect(restarted.engine.serialize()).toBe(live.engine.serialize());
    expect(restarted.engine.spreadInstruments()).toEqual(live.engine.spreadInstruments());
    expect(restarted.engine.spreadBook(CAL, 10)).toEqual(live.engine.spreadBook(CAL, 10));

    // Recovery re-announces each spread fill once, under the original key (ordered by sequence, as for outright fills).
    const keys = (rows: { key: string }[] | undefined) => (rows ?? []).map((row) => row.key).sort();
    expect(keys(restarted.publisher?.published)).toEqual(keys(live.publisher?.published));
    expect(restarted.publisher?.published).toHaveLength(2);

    const next = spreadOrder({ side: 'buy', qty: '0.5', price: '150', reference: '61000' });
    const a = await live.engine.submitSpread(CAL, next);
    const b = await restarted.engine.submitSpread(CAL, next);
    expect(b).toEqual(a);
  });

  it('the journal on disk carries each order with the listing it was admitted under', async () => {
    const live = await trade();
    const text = live.journal
      .read()
      .map((record) => encode(record))
      .join('\n');
    const decoded = decodeAll(text);
    expect(decoded).toEqual(JSON.parse(JSON.stringify(live.journal.read())));
    expect(serializeBooks(replayJournal(decoded).books)).toBe(live.engine.serialize());
    const submit = decoded.find((record) => record.kind === 'submit') as Extract<JournalRecord, { kind: 'submit' }>;
    expect(submit.order.spread?.instrument.spreadId).toBe(CAL);
    expect(submit.order.spread?.anchorReference).toBe('59000');
  });

  it('a recovered journal with spread fills and no publisher fails closed instead of dropping the fills', async () => {
    const live = await trade();
    const restarted = build({ journal: live.journal, publisher: null });
    await expect(restarted.engine.recover()).rejects.toThrow(/no publisher/);
  });
});

describe('book hitch — replay builds plain OrderBooks', () => {
  function bookOrder(side: OrderSide, qty: string, price: string, reference = '100'): EngineOrder {
    return {
      orderId: uuid(),
      accountId: side === 'buy' ? 'b' : 's',
      type: 'limit',
      side,
      qty: A(qty),
      price: A(price),
      stopPrice: null,
      tif: 'GTC',
      spread: { instrument: instrumentOf(CAL_LISTING), anchorReference: A(reference) },
    };
  }

  it('an outright order on a spread book refuses, and a spread order on a traded outright book refuses', () => {
    const spreadBook = new OrderBook(CAL);
    expect(spreadBook.submit(bookOrder('sell', '1', '5')).accepted).toBe(true);
    const outright = { ...bookOrder('buy', '1', '5'), spread: undefined };
    expect(spreadBook.submit(outright).rejected?.code).toBe('spread_book_outright_refused');

    const outrightBook = new OrderBook(CAL);
    expect(outrightBook.submit({ ...bookOrder('sell', '1', '5'), spread: undefined }).accepted).toBe(true);
    expect(outrightBook.submit(bookOrder('buy', '1', '5')).rejected?.code).toBe('spread_book_outright_refused');
  });

  it('a spread order for another spread id refuses spread_identity_disagrees', () => {
    const book = new OrderBook('SOMETHING-ELSE');
    expect(book.submit(bookOrder('sell', '1', '5')).rejected?.code).toBe('spread_identity_disagrees');
  });

  it('a spread book refuses an order for a different listing of the same id', () => {
    const book = new OrderBook(CAL);
    expect(book.submit(bookOrder('sell', '1', '5')).accepted).toBe(true);
    const other = {
      ...bookOrder('buy', '1', '5'),
      spread: { instrument: instrumentOf({ ...CAL_LISTING, lot: '0.01' }), anchorReference: A('100') },
    };
    expect(book.submit(other).rejected?.code).toBe('spread_identity_disagrees');
  });

  it('native amend on a spread book refuses at the book too (replay of an old amend record)', () => {
    const book = new OrderBook(CAL);
    const rest = bookOrder('sell', '1', '5');
    book.submit(rest);
    expect(book.amend({ orderId: rest.orderId, expectedVersion: 1, price: A('5.5') }).rejected?.code).toBe('spread_amend_unsupported');
  });

  it('a refused spread takes no sequence', () => {
    const book = new OrderBook(CAL);
    book.submit(bookOrder('sell', '1', '-70'));
    const sequence = book.currentSequence;
    expect(book.submit(bookOrder('buy', '1', '10', '60')).rejected?.code).toBe('spread_leg_unfillable');
    expect(book.currentSequence).toBe(sequence);
  });
});

describe('property — random spread flow never prints a partial or off-ratio leg', () => {
  /** Mulberry32: seeded, so a failure reproduces. */
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

  function onGrid(rand: () => number, step: Amount, lo: bigint, hi: bigint): Amount {
    const k = lo + BigInt(Math.floor(rand() * Number(hi - lo + 1n)));
    return step * k;
  }

  it.each([1, 7, 42, 2026])('seed %i: every fill is whole and in ratio, refusals change nothing, replay agrees', async (seed) => {
    const rand = prng(seed);
    const { engine, journal, publisher } = await listed(CAL_LISTING, PAIR_LISTING);
    const instruments: Record<string, SpreadInstrument> = { [CAL]: instrumentOf(CAL_LISTING), [PAIR]: instrumentOf(PAIR_LISTING) };
    const live: { spreadId: string; orderId: string }[] = [];
    let fills = 0;
    let refusals = 0;

    for (let step = 0; step < 300; step += 1) {
      const spreadId = pick(rand, [CAL, PAIR]);
      const instrument = instruments[spreadId]!;
      if (rand() < 0.1 && live.length > 0) {
        const victim = live.splice(Math.floor(rand() * live.length), 1)[0]!;
        await engine.cancel(victim.spreadId, victim.orderId);
        continue;
      }
      const reference = spreadId === CAL ? onGrid(rand, A('1'), 40n, 160n) : onGrid(rand, A('1'), 20n, 80n);
      const price = onGrid(rand, instrument.tick, -400n, 400n);
      const qty = onGrid(rand, instrument.lot, 1n, 300n);
      const input: SpreadOrderInput = {
        orderId: uuid(),
        accountId: pick(rand, ['a', 'b', 'c', 'd']),
        side: pick(rand, ['buy', 'sell'] as const),
        qty,
        price,
        tif: 'GTC',
        anchorReference: reference,
      };

      const before = engine.serialize();
      const records = journal.length;
      const result: SubmitResult = await engine.submitSpread(spreadId, input);
      if (!result.accepted) {
        refusals += 1;
        expect(result.fills).toEqual([]);
        expect(engine.serialize()).toBe(before);
        expect(journal.length).toBe(records);
        continue;
      }
      for (const fill of result.fills) {
        fills += 1;
        expectWholeSpread(fill, instrument);
        // Each leg is exactly re-derivable from the journalled taker reference.
        const again = spreadLegFills(instrument, reference, fill.price, fill.qty, fill.takerSide);
        expect(again.ok && again.legs).toEqual(fill.legs);
      }
      if (result.resting) live.push({ spreadId, orderId: input.orderId });
    }

    // The workload must actually fill and refuse, or the property is vacuous.
    expect(fills).toBeGreaterThan(10);
    expect(refusals).toBeGreaterThan(0);

    // Every announced spread fill carries both legs.
    for (const { event } of publisher!.published) expect(event.legs).toHaveLength(2);

    // Replay of the journal reaches the same books and prints only whole spreads.
    const replayed = replayJournal(journal.read());
    expect(serializeBooks(replayed.books)).toBe(engine.serialize());
    expect(replayed.fills).toHaveLength(fills);
    for (const row of replayed.fills) expectWholeSpread(row.fill, instruments[row.marketId]!);
  });
});
