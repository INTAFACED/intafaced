import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZERO, parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { FileJournal, MemoryJournal } from './journal.js';
import { flattenCloseOrder, netPositionOf } from './close-position.js';
import type { EngineOrder, OrderSide, TimeInForce } from './types.js';
import { CLIENT_ORDER_ID_REUSE, TIF_MISSING, installCoreTif } from './core-tif.js';

installCoreTif();

/**
 * CARD D-core-tif hitch. Missing TIF refuses tif_missing — never a GTC map.
 * GTD/GTT pass through the engine. Client-id uniqueness is account/environment domain.
 * Close-position stays IOC flatten.
 */

const MARKET = 'BTC/USDT';
const REST = '11111111-1111-4111-8111-111111111111';
const BLANK = '22222222-2222-4222-8222-222222222222';
const EMPTY = '33333333-3333-4333-8333-333333333333';
const GTD = '44444444-4444-4444-8444-444444444444';
const GTT = '55555555-5555-4555-8555-555555555555';
const CLID_FIRST = '66666666-6666-4666-8666-666666666666';
const CLID_AGAIN = '77777777-7777-4777-8777-777777777777';
const CLID_OTHER = '88888888-8888-4888-8888-888888888888';
const CLID_NONE = '99999999-9999-4999-8999-999999999999';
const LIQ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXIT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLOSE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UNKNOWN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CLID_FRESH = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const RACE_WIN = '12121212-1212-4212-8212-121212121212';
const RACE_LOSE = '13131313-1313-4313-8313-131313131313';
const RACE_OTHER = '14141414-1414-4414-8414-141414141414';
const RACE_BARE = '15151515-1515-4515-8515-151515151515';
const RACE_LATER = '16161616-1616-4616-8616-161616161616';
const RETRY_BAD = '17171717-1717-4717-8717-171717171717';
const RETRY_OK = '18181818-1818-4818-8818-181818181818';

const EXPIRE = '2026-08-25T12:00:00.000Z';
const BEFORE = new Date('2026-08-25T11:00:00.000Z');

function order(spec: {
  id: string;
  account?: string;
  side: OrderSide;
  qty: string;
  price?: string;
  tif?: TimeInForce;
  expireAt?: string;
  clientOrderId?: string | null;
  environment?: string | null;
  type?: EngineOrder['type'];
}): EngineOrder {
  const type = spec.type ?? (spec.price === undefined ? 'market' : 'limit');
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type,
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: spec.price === undefined ? null : parseAmount(spec.price),
    stopPrice: null,
    tif: spec.tif ?? 'GTC',
    ...(spec.expireAt ? { expireAt: spec.expireAt } : {}),
    ...(spec.clientOrderId !== undefined ? { clientOrderId: spec.clientOrderId } : {}),
    ...(spec.environment !== undefined ? { environment: spec.environment } : {}),
  };
}

function withoutTif(spec: Parameters<typeof order>[0]): EngineOrder {
  return { ...order({ ...spec, tif: 'GTC' }), tif: undefined as unknown as TimeInForce };
}

function withTif(spec: Parameters<typeof order>[0], tif: string): EngineOrder {
  return { ...order(spec), tif: tif as TimeInForce };
}

function build(clock?: () => Date) {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({
    journal,
    bus,
    snapshotEvery: 0,
    ...(clock ? { clock } : {}),
  });
  return { journal, bus, engine };
}

function liveIds(engine: MatchingEngine): string[] {
  return engine.restingOrders(MARKET).map((row) => row.orderId);
}

describe('core TIF — hitch missing TIF, not a GTC map', () => {
  it('omitted tif refuses tif_missing; nothing rests; not GTC', async () => {
    const { journal, engine } = build();
    const result = await engine.submit(MARKET, withoutTif({ id: BLANK, side: 'buy', qty: '1', price: '100' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(TIF_MISSING);
    expect(result.rejected?.code).not.toBe('invalid_tif');
    expect(result.sequence).toBeNull();
    expect(result.resting).toBeNull();
    expect(result.fills).toHaveLength(0);
    expect(liveIds(engine)).toEqual([]);
    expect(journal.length).toBe(0);
    expect(engine.hasMarket(MARKET)).toBe(false);
  });

  it('empty/blank tif refuses tif_missing; unknown TIF is not mapped to GTC', async () => {
    const { journal, engine } = build();
    const empty = await engine.submit(MARKET, withTif({ id: EMPTY, side: 'buy', qty: '1', price: '100' }, ''));
    const blank = await engine.submit(MARKET, withTif({ id: BLANK, side: 'sell', qty: '1', price: '101' }, '   '));
    const unknown = await engine.submit(MARKET, withTif({ id: UNKNOWN, side: 'buy', qty: '1', price: '99' }, 'DAY'));

    expect(empty.rejected?.code).toBe(TIF_MISSING);
    expect(blank.rejected?.code).toBe(TIF_MISSING);
    expect(unknown.rejected?.code).toBe(TIF_MISSING);
    expect(empty.sequence).toBeNull();
    expect(blank.resting).toBeNull();
    expect(unknown.resting).toBeNull();
    expect(liveIds(engine)).toEqual([]);
    expect(journal.length).toBe(0);
  });

  it('present tif GTC still rests (control)', async () => {
    const { engine } = build();
    const result = await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100', tif: 'GTC' }));

    expect(result.accepted).toBe(true);
    expect(result.rejected).toBeUndefined();
    expect(result.resting?.orderId).toBe(REST);
    expect(liveIds(engine)).toEqual([REST]);
  });

  it('present GTC/IOC/FOK/PO/GTD/GTT with required fields are not tif_missing', async () => {
    const { engine } = build(() => BEFORE);
    const gtc = await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100', tif: 'GTC' }));
    const ioc = await engine.submit(MARKET, order({ id: EMPTY, account: 'ioc', side: 'buy', qty: '1', price: '99', tif: 'IOC' }));
    const fok = await engine.submit(MARKET, order({ id: BLANK, account: 'fok', side: 'buy', qty: '1', price: '99', tif: 'FOK' }));
    const po = await engine.submit(MARKET, order({ id: UNKNOWN, account: 'po', side: 'buy', qty: '1', price: '99', tif: 'PO' }));
    const gtd = await engine.submit(
      MARKET,
      order({ id: GTD, account: 'gtd', side: 'buy', qty: '1', price: '98', tif: 'GTD', expireAt: EXPIRE }),
    );
    const gtt = await engine.submit(
      MARKET,
      order({ id: GTT, account: 'gtt', side: 'buy', qty: '1', price: '97', tif: 'GTT', expireAt: EXPIRE }),
    );

    expect([gtc, ioc, fok, po, gtd, gtt].map((row) => row.rejected?.code)).not.toContain(TIF_MISSING);
    expect(gtc.accepted).toBe(true);
    expect(gtd.accepted).toBe(true);
    expect(gtt.accepted).toBe(true);
    expect(gtd.resting?.orderId).toBe(GTD);
    expect(gtt.resting?.orderId).toBe(GTT);
  });

  it('engine.submit GTD with expireAt + clock rests; GTT missing expireAt refuses missing_expire_at', async () => {
    const { engine } = build(() => BEFORE);
    const gtd = await engine.submit(MARKET, order({ id: GTD, side: 'buy', qty: '1', price: '100', tif: 'GTD', expireAt: EXPIRE }));
    const gtt = await engine.submit(MARKET, order({ id: GTT, side: 'sell', qty: '1', price: '101', tif: 'GTT' }));

    expect(gtd.accepted).toBe(true);
    expect(gtd.resting?.orderId).toBe(GTD);
    expect(gtd.rejected?.code).not.toBe(TIF_MISSING);
    expect(gtt.accepted).toBe(false);
    expect(gtt.rejected?.code).toBe('missing_expire_at');
    expect(gtt.rejected?.code).not.toBe(TIF_MISSING);
    expect(gtt.resting).toBeNull();
    expect(gtt.sequence).toBeNull();
    expect(liveIds(engine)).toEqual([GTD]);
  });

  it('clientOrderId reuse on same account after cancel refuses; different account may reuse', async () => {
    const { engine } = build();
    const first = await engine.submit(MARKET, order({ id: CLID_FIRST, side: 'sell', qty: '1', price: '100', clientOrderId: 'desk-1' }));
    expect(first.accepted).toBe(true);
    const cancelled = await engine.cancel(MARKET, CLID_FIRST);
    expect(cancelled.cancelled).toBe(true);
    expect(liveIds(engine)).toEqual([]);

    const reuse = await engine.submit(MARKET, order({ id: CLID_AGAIN, side: 'sell', qty: '1', price: '100', clientOrderId: 'desk-1' }));
    expect(reuse.accepted).toBe(false);
    expect(reuse.rejected?.code).toBe(CLIENT_ORDER_ID_REUSE);
    expect(reuse.sequence).toBeNull();
    expect(reuse.resting).toBeNull();
    expect(liveIds(engine)).toEqual([]);

    const other = await engine.submit(
      MARKET,
      order({ id: CLID_OTHER, account: 'mm', side: 'sell', qty: '1', price: '101', clientOrderId: 'desk-1' }),
    );
    expect(other.accepted).toBe(true);
    expect(other.resting?.orderId).toBe(CLID_OTHER);
    expect(liveIds(engine)).toEqual([CLID_OTHER]);
  });

  it('missing clientOrderId still accepts', async () => {
    const { engine } = build();
    const result = await engine.submit(MARKET, order({ id: CLID_NONE, side: 'buy', qty: '1', price: '100' }));

    expect(result.accepted).toBe(true);
    expect(result.rejected).toBeUndefined();
    expect(result.resting?.orderId).toBe(CLID_NONE);
    expect(liveIds(engine)).toEqual([CLID_NONE]);
  });

  it('recover refuses the same account and environment clientOrderId and still accepts one that was never used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-clid-'));
    const path = join(dir, 'engine.ndjson');
    const journal = new FileJournal(path);
    const engine = new MatchingEngine({ journal, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
    const first = await engine.submit(
      MARKET,
      order({ id: CLID_FIRST, side: 'sell', qty: '1', price: '100', clientOrderId: 'desk-1', environment: 'paper' }),
    );
    expect(first.accepted).toBe(true);

    const submitted = journal.read().find((record) => record.kind === 'submit');
    expect(submitted?.kind).toBe('submit');
    if (submitted?.kind === 'submit') {
      expect(submitted.order.clientOrderId).toBe('desk-1');
      expect(submitted.order.environment).toBe('paper');
      expect(submitted.order.price).toBe('100');
      expect(submitted.order.expireAt).toBeUndefined();
    }
    journal.close();

    const reopened = new FileJournal(path);
    const recovered = new MatchingEngine({
      journal: reopened,
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    });
    await recovered.recover();

    const reuse = await recovered.submit(
      MARKET,
      order({ id: CLID_AGAIN, side: 'buy', qty: '1', price: '100', clientOrderId: 'desk-1', environment: 'paper' }),
    );
    expect(reuse.accepted).toBe(false);
    expect(reuse.rejected?.code).toBe(CLIENT_ORDER_ID_REUSE);
    expect(reuse.sequence).toBeNull();
    expect(reuse.resting).toBeNull();
    expect(reuse.fills).toHaveLength(0);
    expect(liveIds(recovered)).toEqual([CLID_FIRST]);
    expect(reopened.length).toBe(1);

    const otherEnv = await recovered.submit(
      MARKET,
      order({ id: CLID_OTHER, side: 'buy', qty: '1', price: '99', clientOrderId: 'desk-1', environment: 'live' }),
    );
    expect(otherEnv.accepted).toBe(true);
    expect(otherEnv.resting?.orderId).toBe(CLID_OTHER);

    const fresh = await recovered.submit(
      MARKET,
      order({ id: CLID_NONE, account: 'other', side: 'sell', qty: '1', price: '102', clientOrderId: 'fresh-1', environment: 'paper' }),
    );
    expect(fresh.accepted).toBe(true);
    expect(fresh.resting?.orderId).toBe(CLID_NONE);

    const freshAgain = await recovered.submit(
      MARKET,
      order({ id: CLID_FRESH, account: 'other', side: 'sell', qty: '1', price: '103', clientOrderId: 'fresh-1', environment: 'paper' }),
    );
    expect(freshAgain.accepted).toBe(false);
    expect(freshAgain.rejected?.code).toBe(CLIENT_ORDER_ID_REUSE);
    expect(freshAgain.resting).toBeNull();
    reopened.close();
  });

  it('cancel still blocks clientOrderId reuse after recover', async () => {
    const { journal, engine } = build();
    const first = await engine.submit(MARKET, order({ id: CLID_FIRST, side: 'sell', qty: '1', price: '100', clientOrderId: 'desk-1' }));
    expect(first.accepted).toBe(true);
    const cancelled = await engine.cancel(MARKET, CLID_FIRST);
    expect(cancelled.cancelled).toBe(true);

    const recovered = new MatchingEngine({
      journal,
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    });
    await recovered.recover();
    expect(liveIds(recovered)).toEqual([]);

    const reuse = await recovered.submit(MARKET, order({ id: CLID_AGAIN, side: 'sell', qty: '1', price: '100', clientOrderId: 'desk-1' }));
    expect(reuse.accepted).toBe(false);
    expect(reuse.rejected?.code).toBe(CLIENT_ORDER_ID_REUSE);
    expect(reuse.sequence).toBeNull();
    expect(reuse.resting).toBeNull();
    expect(liveIds(recovered)).toEqual([]);
  });

  it('overlapping submits with one clientOrderId do not both rest', async () => {
    const { bus, engine } = build();
    let loser: ReturnType<MatchingEngine['submit']> | undefined;
    let other: ReturnType<MatchingEngine['submit']> | undefined;
    let bare: ReturnType<MatchingEngine['submit']> | undefined;
    let overlapped = false;

    const sub = await bus.subscribe(
      'orderAccepted',
      async (payload) => {
        if (payload.orderId !== RACE_WIN) return;
        overlapped = true;
        loser = engine.submit(
          MARKET,
          order({
            id: RACE_LOSE,
            side: 'sell',
            qty: '1',
            price: '101',
            clientOrderId: 'race-1',
            environment: 'paper',
          }),
        );
        other = engine.submit(
          MARKET,
          order({
            id: RACE_OTHER,
            side: 'sell',
            qty: '1',
            price: '102',
            clientOrderId: 'race-2',
            environment: 'paper',
          }),
        );
        bare = engine.submit(MARKET, order({ id: RACE_BARE, side: 'sell', qty: '1', price: '103' }));
        await Promise.all([loser, other, bare]);
      },
      { durable: 'l784-client-order-id-race' },
    );

    const winner = await engine.submit(
      MARKET,
      order({
        id: RACE_WIN,
        side: 'sell',
        qty: '1',
        price: '100',
        clientOrderId: 'race-1',
        environment: 'paper',
      }),
    );

    expect(overlapped).toBe(true);
    expect(winner.accepted).toBe(true);
    expect(winner.resting?.orderId).toBe(RACE_WIN);
    expect(winner.fills).toHaveLength(0);

    const lost = await loser;
    expect(lost).toBeDefined();
    expect(lost!.accepted).toBe(false);
    expect(lost!.rejected?.code).toBe(CLIENT_ORDER_ID_REUSE);
    expect(lost!.sequence).toBeNull();
    expect(lost!.resting).toBeNull();
    expect(lost!.fills).toHaveLength(0);

    const sibling = await other;
    expect(sibling?.accepted).toBe(true);
    expect(sibling?.resting?.orderId).toBe(RACE_OTHER);
    expect(sibling?.fills).toHaveLength(0);

    const untracked = await bare;
    expect(untracked?.accepted).toBe(true);
    expect(untracked?.resting?.orderId).toBe(RACE_BARE);
    expect(untracked?.fills).toHaveLength(0);

    expect(new Set(liveIds(engine))).toEqual(new Set([RACE_WIN, RACE_OTHER, RACE_BARE]));

    const stayed = await engine.submit(
      MARKET,
      order({
        id: RACE_LATER,
        side: 'sell',
        qty: '1',
        price: '104',
        clientOrderId: 'race-1',
        environment: 'paper',
      }),
    );
    expect(stayed.accepted).toBe(false);
    expect(stayed.rejected?.code).toBe(CLIENT_ORDER_ID_REUSE);
    expect(stayed.resting).toBeNull();
    expect(stayed.fills).toHaveLength(0);
    expect(liveIds(engine)).not.toContain(RACE_LATER);

    const bareAgain = await engine.submit(MARKET, order({ id: RACE_LATER, side: 'buy', qty: '1', price: '90' }));
    expect(bareAgain.accepted).toBe(true);
    expect(bareAgain.resting?.orderId).toBe(RACE_LATER);
    expect(bareAgain.fills).toHaveLength(0);

    await sub.unsubscribe();
  });

  it('a submit that does not accept releases the clientOrderId for a later retry', async () => {
    const { engine } = build(() => BEFORE);
    const refused = await engine.submit(
      MARKET,
      order({
        id: RETRY_BAD,
        side: 'sell',
        qty: '1',
        price: '100',
        tif: 'GTT',
        clientOrderId: 'retry-1',
        environment: 'paper',
      }),
    );
    expect(refused.accepted).toBe(false);
    expect(refused.rejected?.code).toBe('missing_expire_at');
    expect(refused.resting).toBeNull();
    expect(refused.fills).toHaveLength(0);
    expect(liveIds(engine)).toEqual([]);

    const retry = await engine.submit(
      MARKET,
      order({
        id: RETRY_OK,
        side: 'sell',
        qty: '1',
        price: '100',
        tif: 'GTT',
        expireAt: EXPIRE,
        clientOrderId: 'retry-1',
        environment: 'paper',
      }),
    );
    expect(retry.accepted).toBe(true);
    expect(retry.rejected?.code).not.toBe(CLIENT_ORDER_ID_REUSE);
    expect(retry.resting?.orderId).toBe(RETRY_OK);
    expect(retry.fills).toHaveLength(0);
    expect(liveIds(engine)).toEqual([RETRY_OK]);
  });

  it('closePosition flatten still works (IOC, not a GTC map)', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: LIQ, account: 'mm', side: 'sell', qty: '2', price: '100' }));
    await engine.submit(MARKET, order({ id: OPEN, side: 'buy', qty: '2', price: '100' }));
    await engine.submit(MARKET, order({ id: EXIT, account: 'liq', side: 'buy', qty: '2', price: '100' }));

    const book = engine.existingBook(MARKET)!;
    const net = netPositionOf(book, 'desk');
    const flatten = flattenCloseOrder({ orderId: CLOSE, accountId: 'desk' }, net);
    expect(flatten.tif).toBe('IOC');
    expect(flatten.tif).not.toBe('GTC');

    const result = await engine.closePosition(MARKET, { orderId: CLOSE, accountId: 'desk' });
    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(1);
    expect(result.rejected?.code).not.toBe(TIF_MISSING);
    expect(netPositionOf(engine.existingBook(MARKET)!, 'desk')).toBe(ZERO);
  });
});
