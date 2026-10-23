import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Position } from '@intafaced/exchange-contract/schemas';
import type { ApiResult } from '../../../shared/api';
import { pendingKey, readPending, type Pending } from '../buy/write-lock';
import type { FuturesApi, FuturesOrder, FuturesSplit, OpenInput, PlaceOrderInput } from './api';
import { checkPending, intentId, loadIntent, runIntent, type Intent } from './write';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', {
    locks: { request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => callback({ name: 'lock' }) },
  });
});
afterEach(() => vi.unstubAllGlobals());

const USER = 'u1';
const intentKeyFor = (id: string) => `futures-intent:${USER}:${id}`;

function position(over: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    symbol: 'BTC/USDT:USDT',
    timestamp: Date.now(),
    datetime: new Date().toISOString(),
    side: 'long',
    status: 'open',
    closingReason: null,
    contracts: '1',
    contractSize: null,
    entryPrice: '100',
    markPrice: '100',
    notional: '100',
    leverage: '5',
    collateral: '20',
    initialMargin: '20',
    maintenanceMargin: null,
    unrealizedPnl: null,
    realizedPnl: null,
    liquidationPrice: null,
    marginMode: 'isolated',
    percentage: null,
    ...over,
  };
}

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const failure = (reason: 'uncertain' | 'rejected', code?: string, status?: number) =>
  ({ ok: false, reason, message: 'test', ...(code ? { code } : {}), ...(status ? { status } : {}) }) as ApiResult<never>;

function order(over: Partial<FuturesOrder> = {}): FuturesOrder {
  return {
    orderId: 'ord-1',
    marketId: 'mkt-1',
    side: 'buy',
    type: 'market',
    qty: '1',
    limitPrice: '101',
    markPrice: '100',
    bandLow: '99',
    bandHigh: '101',
    holdAmount: '20',
    filledQty: '1',
    appliedAmount: '20',
    releasedAmount: '0',
    status: 'filled',
    refusalCode: null,
    reduceOnly: false,
    positionId: 'pos-1',
    bankruptcyPrice: null,
    ...over,
  };
}

/** A fake service: every write is a counted spy, answers are queued per call. */
function fakeApi() {
  const api = {
    placeOrder: vi.fn<(input: PlaceOrderInput) => Promise<ApiResult<FuturesOrder>>>(),
    placeSplit: vi.fn<(input: PlaceOrderInput) => Promise<ApiResult<FuturesSplit>>>(),
    setLeverage:
      vi.fn<
        (input: { symbol: string; positionId: string; leverage: string; clientAdjustmentId: string }) => Promise<ApiResult<Position>>
      >(),
    addMargin:
      vi.fn<(input: { symbol: string; positionId: string; amount: string; clientAdjustmentId: string }) => Promise<ApiResult<Position>>>(),
    reduceMargin:
      vi.fn<(input: { symbol: string; positionId: string; amount: string; clientAdjustmentId: string }) => Promise<ApiResult<Position>>>(),
    orders: vi.fn<(scope: 'open' | 'all') => Promise<ApiResult<FuturesOrder[]>>>(),
    ordersOn: vi.fn<(symbol: string) => Promise<ApiResult<FuturesOrder[]>>>(),
    position: vi.fn<(id: string) => Promise<ApiResult<Position>>>(),
    positions: vi.fn<() => Promise<ApiResult<Position[]>>>(),
  };
  return { api, typed: api as unknown as FuturesApi };
}

const openInput: OpenInput = { symbol: 'BTC/USDT:USDT', side: 'long', size: '1', leverage: '5', type: 'market', clientOpenId: 'open-abc' };
const openIntent: Intent = { op: 'open', input: openInput };
const closeIntent: Intent = {
  op: 'close',
  positionId: 'pos-1',
  symbol: 'BTC/USDT:USDT',
  side: 'long',
  size: '1.250',
  clientCloseId: 'close-intent-1',
};

function pendingFor(id: string): Pending {
  const note = readPending(USER);
  if (note.state !== 'pending') throw new Error(`expected a device note for ${id}`);
  expect(note.pending.id).toBe(id);
  return note.pending;
}

describe('runIntent: orders through the book', () => {
  it('an open is one market order on the long side, keyed by the open id', async () => {
    const { api, typed } = fakeApi();
    api.placeOrder.mockResolvedValue(ok(order()));
    const outcome = await runIntent(typed, USER, openIntent);
    expect(outcome).toMatchObject({ kind: 'done', order: { orderId: 'ord-1' } });
    expect(api.placeOrder).toHaveBeenCalledTimes(1);
    expect(api.placeOrder.mock.calls[0]![0]).toEqual({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      amount: '1',
      leverage: '5',
      clientOrderId: 'open-abc',
    });
    expect(readPending(USER)).toEqual({ state: 'none' });
  });

  it('a limit open carries its price; a short sells', async () => {
    const { api, typed } = fakeApi();
    api.placeOrder.mockResolvedValue(ok(order({ status: 'open', filledQty: '0' })));
    const intent: Intent = { op: 'open', input: { ...openInput, side: 'short', type: 'limit', price: '99.5' } };
    const outcome = await runIntent(typed, USER, intent);
    expect(outcome.kind).toBe('done'); // a resting order is a placed order, not a refusal
    expect(api.placeOrder.mock.calls[0]![0]).toMatchObject({ side: 'sell', type: 'limit', price: '99.5' });
  });

  it('an order the book rejected with nothing filled is a refusal with its own code', async () => {
    const { api, typed } = fakeApi();
    api.placeOrder.mockResolvedValue(ok(order({ status: 'rejected', filledQty: '0', refusalCode: 'trade.hold_unconfirmed' })));
    const outcome = await runIntent(typed, USER, openIntent);
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'trade.hold_unconfirmed' } });
    expect(readPending(USER)).toEqual({ state: 'none' });
    expect(storage.data.has(intentKeyFor('open-abc'))).toBe(false);
  });

  it('a close is a reduce-only market order on the other side, then a read of the position', async () => {
    const { api, typed } = fakeApi();
    api.placeOrder.mockResolvedValue(ok(order({ side: 'sell', reduceOnly: true })));
    api.position.mockResolvedValue(ok(position({ contracts: '0.75' })));
    const outcome = await runIntent(typed, USER, closeIntent);
    expect(outcome).toMatchObject({ kind: 'done', position: { contracts: '0.75' }, order: { reduceOnly: true } });
    expect(api.placeOrder.mock.calls[0]![0]).toEqual({
      symbol: 'BTC/USDT:USDT',
      side: 'sell',
      type: 'market',
      amount: '1.250',
      reduceOnly: true,
      clientOrderId: 'close-intent-1',
    });
    expect(api.position).toHaveBeenCalledWith('pos-1');
  });
});

describe('runIntent: unknown outcomes', () => {
  it('a 5xx answer to an open is uncertain and keeps the device note and the saved intent', async () => {
    const { api, typed } = fakeApi();
    api.placeOrder.mockResolvedValue(failure('uncertain', undefined, 503));
    const outcome = await runIntent(typed, USER, openIntent);
    expect(outcome).toEqual({ kind: 'uncertain', id: 'open-abc' });
    expect(readPending(USER).state).toBe('pending');
    expect(storage.data.has(pendingKey(USER))).toBe(true);
    expect(loadIntent(USER, 'open-abc')).toEqual(openIntent);
    expect(api.placeOrder).toHaveBeenCalledTimes(1);
  });

  it.each(['trade.mark_missing', 'trade.mark_unusable'])('%s is a definite refusal and clears the note', async (code) => {
    const { api, typed } = fakeApi();
    api.placeOrder.mockResolvedValue(failure('uncertain', code, 503));
    const outcome = await runIntent(typed, USER, openIntent);
    expect(outcome.kind).toBe('refused');
    expect(readPending(USER)).toEqual({ state: 'none' });
    expect(storage.data.has(intentKeyFor('open-abc'))).toBe(false);
  });

  it('an unrelated 5xx code stays uncertain', async () => {
    const { api, typed } = fakeApi();
    api.placeOrder.mockResolvedValue(failure('uncertain', 'trade.internal', 500));
    expect((await runIntent(typed, USER, openIntent)).kind).toBe('uncertain');
    expect(readPending(USER).state).toBe('pending');
  });

  it('a request that throws is uncertain and keeps the note', async () => {
    const { api, typed } = fakeApi();
    api.placeOrder.mockRejectedValue(new Error('network'));
    expect(await runIntent(typed, USER, openIntent)).toEqual({ kind: 'uncertain', id: 'open-abc' });
    expect(readPending(USER).state).toBe('pending');
  });
});

describe('checkPending: open', () => {
  async function startUncertainOpen() {
    const fake = fakeApi();
    fake.api.placeOrder.mockResolvedValue(failure('uncertain', undefined, 504));
    await runIntent(fake.typed, USER, openIntent);
    return fake;
  }

  it('finds nothing: says "not found", sends no write, keeps the note', async () => {
    const { api, typed } = await startUncertainOpen();
    api.orders.mockResolvedValue(ok([order({ clientOrderId: 'someone-else' })]));
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'));
    expect(outcome).toEqual({ kind: 'uncertain', id: 'open-abc', notFound: true });
    expect(api.placeOrder).toHaveBeenCalledTimes(1); // only the original attempt
    expect(readPending(USER).state).toBe('pending');
    expect(loadIntent(USER, 'open-abc')).toEqual(openIntent);
  });

  it('the order found by its request id is the answer: done, nothing re-sent, note cleared', async () => {
    const { api, typed } = await startUncertainOpen();
    api.orders.mockResolvedValue(ok([order({ orderId: 'ord-9', clientOrderId: 'open-abc' })]));
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'), { resend: false });
    expect(outcome).toMatchObject({ kind: 'done', order: { orderId: 'ord-9' } });
    expect(api.placeOrder).toHaveBeenCalledTimes(1);
    expect(readPending(USER)).toEqual({ state: 'none' });
    expect(loadIntent(USER, 'open-abc')).toBeNull();
  });

  it('a found order the book rejected with nothing filled is a refusal, and nothing is re-sent', async () => {
    const { api, typed } = await startUncertainOpen();
    api.orders.mockResolvedValue(
      ok([order({ clientOrderId: 'open-abc', status: 'rejected', filledQty: '0', refusalCode: 'trade.futures_price_outside_band' })]),
    );
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'));
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'trade.futures_price_outside_band' } });
    expect(api.placeOrder).toHaveBeenCalledTimes(1);
    expect(readPending(USER)).toEqual({ state: 'none' });
  });

  it('a failed order read is uncertain (not "not found"), sends nothing and keeps the note', async () => {
    const { api, typed } = await startUncertainOpen();
    api.orders.mockResolvedValue(failure('uncertain', undefined, 503));
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'));
    expect(outcome).toEqual({ kind: 'uncertain', id: 'open-abc' });
    expect(api.placeOrder).toHaveBeenCalledTimes(1);
    expect(readPending(USER).state).toBe('pending');
  });

  it('resend sends exactly one more order with the SAME client order id', async () => {
    const { api, typed } = await startUncertainOpen();
    api.placeOrder.mockResolvedValue(ok(order()));
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'), { resend: true });
    expect(outcome).toMatchObject({ kind: 'done', order: { orderId: 'ord-1' } });
    expect(api.placeOrder).toHaveBeenCalledTimes(2);
    expect(api.placeOrder.mock.calls[1]![0]).toEqual(api.placeOrder.mock.calls[0]![0]);
    expect(api.placeOrder.mock.calls[1]![0].clientOrderId).toBe('open-abc');
    expect(api.orders).not.toHaveBeenCalled();
    expect(readPending(USER)).toEqual({ state: 'none' });
    expect(loadIntent(USER, 'open-abc')).toBeNull();
  });

  it('a resend that is still unknown keeps the note and the saved intent', async () => {
    const { api, typed } = await startUncertainOpen();
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'), { resend: true });
    expect(outcome).toEqual({ kind: 'uncertain', id: 'open-abc' });
    expect(api.placeOrder).toHaveBeenCalledTimes(2);
    expect(readPending(USER).state).toBe('pending');
    expect(loadIntent(USER, 'open-abc')).toEqual(openIntent);
  });
});

describe('checkPending: close', () => {
  async function startUncertainClose() {
    const fake = fakeApi();
    fake.api.placeOrder.mockResolvedValue(failure('uncertain', undefined, 502));
    await runIntent(fake.typed, USER, closeIntent);
    return fake;
  }

  it('a position already closed is done, with no second close', async () => {
    const { api, typed } = await startUncertainClose();
    api.position.mockResolvedValue(ok(position({ status: 'closed' })));
    const outcome = await checkPending(typed, USER, pendingFor('close:pos-1'));
    expect(outcome).toMatchObject({ kind: 'done', position: { status: 'closed' } });
    expect(api.placeOrder).toHaveBeenCalledTimes(1); // only the original attempt
    expect(readPending(USER)).toEqual({ state: 'none' });
    expect(loadIntent(USER, 'close:pos-1')).toBeNull();
  });

  it('a failed position read is uncertain and keeps the note', async () => {
    const { api, typed } = await startUncertainClose();
    api.position.mockResolvedValue(failure('uncertain', undefined, 503));
    const outcome = await checkPending(typed, USER, pendingFor('close:pos-1'));
    expect(outcome).toEqual({ kind: 'uncertain', id: 'close:pos-1' });
    expect(api.placeOrder).toHaveBeenCalledTimes(1);
    expect(readPending(USER).state).toBe('pending');
    expect(loadIntent(USER, 'close:pos-1')).toEqual(closeIntent);
  });

  it('two sends of the same close intent pass the same client order id', async () => {
    const { api, typed } = await startUncertainClose();
    api.position.mockResolvedValue(ok(position({ status: 'open' })));
    api.placeOrder.mockResolvedValue(ok(order({ side: 'sell', reduceOnly: true })));
    const outcome = await checkPending(typed, USER, pendingFor('close:pos-1'));
    expect(outcome.kind).toBe('done');
    expect(api.placeOrder).toHaveBeenCalledTimes(2);
    expect(api.placeOrder.mock.calls[0]![0]).toMatchObject({ reduceOnly: true, amount: '1.250', clientOrderId: 'close-intent-1' });
    expect(api.placeOrder.mock.calls[1]).toEqual(api.placeOrder.mock.calls[0]);
    expect(readPending(USER)).toEqual({ state: 'none' });
  });
});

describe('checkPending: margin and leverage replays', () => {
  const cases: Array<{ name: string; intent: Intent; method: 'addMargin' | 'reduceMargin' | 'setLeverage' }> = [
    {
      name: 'add margin',
      method: 'addMargin',
      intent: { op: 'margin-add', input: { symbol: 'BTC/USDT:USDT', positionId: 'pos-1', amount: '5', clientAdjustmentId: 'adj-add-1' } },
    },
    {
      name: 'remove margin',
      method: 'reduceMargin',
      intent: {
        op: 'margin-reduce',
        input: { symbol: 'BTC/USDT:USDT', positionId: 'pos-1', amount: '2', clientAdjustmentId: 'adj-red-1' },
      },
    },
    {
      name: 'leverage',
      method: 'setLeverage',
      intent: { op: 'leverage', input: { symbol: 'BTC/USDT:USDT', positionId: 'pos-1', leverage: '3', clientAdjustmentId: 'adj-lev-1' } },
    },
  ];

  it.each(cases)('$name replays the saved request with the same clientAdjustmentId', async ({ intent, method }) => {
    const { api, typed } = fakeApi();
    api[method].mockResolvedValueOnce(failure('uncertain', undefined, 503));
    const first = await runIntent(typed, USER, intent);
    expect(first).toEqual({ kind: 'uncertain', id: intentId(intent) });

    api[method].mockResolvedValueOnce(ok(position()));
    const replay = await checkPending(typed, USER, pendingFor(intentId(intent)));
    expect(replay.kind).toBe('done');
    expect(api[method]).toHaveBeenCalledTimes(2);
    expect(api[method].mock.calls[1]![0]).toEqual(api[method].mock.calls[0]![0]);
    expect((api[method].mock.calls[1]![0] as { clientAdjustmentId: string }).clientAdjustmentId).toBe(
      (intent as { input: { clientAdjustmentId: string } }).input.clientAdjustmentId,
    );
    expect(api.position).not.toHaveBeenCalled(); // no read first: the request id makes the replay safe
    expect(api.positions).not.toHaveBeenCalled();
    expect(readPending(USER)).toEqual({ state: 'none' });
    expect(loadIntent(USER, intentId(intent))).toBeNull();
  });
});

describe('guards', () => {
  it('a second write is blocked while a note is pending, and sends nothing', async () => {
    const { api, typed } = fakeApi();
    api.placeOrder.mockResolvedValue(failure('uncertain', undefined, 503));
    await runIntent(typed, USER, openIntent);
    const other: Intent = {
      op: 'close',
      positionId: 'pos-2',
      symbol: 'BTC/USDT:USDT',
      side: 'short',
      size: '2',
      clientCloseId: 'close-intent-2',
    };
    const outcome = await runIntent(typed, USER, other);
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'pending' });
    expect(api.placeOrder).toHaveBeenCalledTimes(1);
    expect(loadIntent(USER, 'close:pos-2')).toBeNull();
  });

  it('checkPending with no saved intent is blocked as unreadable and sends nothing', async () => {
    const { api, typed } = fakeApi();
    const outcome = await checkPending(typed, USER, { kind: 'position', id: 'ghost', symbol: 'BTC/USDT:USDT', startedAt: Date.now() });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'unreadable' });
    expect(api.placeOrder).not.toHaveBeenCalled();
  });
});

describe('a split open (D-orders-06): above the max-order, placed as children keyed by the open id', () => {
  const splitIntent: Intent = {
    op: 'open',
    input: { ...openInput, size: '2', type: 'limit', price: '120', priceCorrection: 'adjust', split: true },
  };
  const child = (n: number, over: Partial<FuturesOrder> = {}) =>
    order({ orderId: `ord-${n}`, clientOrderId: `open-abc:${n}:0a1b2c3d`, qty: '1', status: 'open', filledQty: '0', ...over });

  it('goes to the split door once with the same body as one order, and answers every child', async () => {
    const { api, typed } = fakeApi();
    api.placeSplit.mockResolvedValue(ok({ parts: 2, orders: [child(1), child(2)], stopped: null }));
    const outcome = await runIntent(typed, USER, splitIntent);
    expect(outcome).toMatchObject({ kind: 'done', order: { orderId: 'ord-1' }, orders: [{ orderId: 'ord-1' }, { orderId: 'ord-2' }] });
    expect(outcome).not.toHaveProperty('stopped');
    expect(api.placeOrder).not.toHaveBeenCalled();
    expect(api.placeSplit.mock.calls[0]![0]).toEqual({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'limit',
      amount: '2',
      price: '120',
      priceCorrection: 'adjust',
      leverage: '5',
      clientOrderId: 'open-abc',
    });
  });

  it('the margin tier the trader confirmed goes with the order, on both doors; none confirmed sends none', async () => {
    const { api, typed } = fakeApi();
    api.placeSplit.mockResolvedValue(ok({ parts: 2, orders: [child(1), child(2)], stopped: null }));
    api.placeOrder.mockResolvedValue(ok(child(1)));
    await runIntent(typed, USER, { op: 'open', input: { ...splitIntent.input, confirmTier: 3 } } as Intent);
    expect(api.placeSplit.mock.calls[0]![0]).toMatchObject({ clientOrderId: 'open-abc', confirmTier: 3 });
    await runIntent(typed, USER, { op: 'open', input: { ...openInput, clientOpenId: 'open-t2', confirmTier: 2 } });
    expect(api.placeOrder.mock.calls[0]![0]).toMatchObject({ clientOrderId: 'open-t2', confirmTier: 2 });
    await runIntent(typed, USER, { op: 'open', input: { ...openInput, clientOpenId: 'open-t0' } });
    expect(api.placeOrder.mock.calls[1]![0]).not.toHaveProperty('confirmTier');
  });

  it('children that all did nothing are the first one’s refusal; a split stopped early is done with what is live', async () => {
    const { api, typed } = fakeApi();
    const dead = { status: 'cancelled', refusalCode: 'trade.futures_order_unfilled' };
    api.placeSplit.mockResolvedValueOnce(ok({ parts: 2, orders: [child(1, dead), child(2, dead)], stopped: null }));
    expect(await runIntent(typed, USER, splitIntent)).toMatchObject({ kind: 'refused', refusal: { code: 'trade.futures_order_unfilled' } });
    const stopped = { child: 2, code: 'trade.limit_max_order', message: 'over' };
    api.placeSplit.mockResolvedValueOnce(ok({ parts: 2, orders: [child(1)], stopped }));
    expect(await runIntent(typed, USER, splitIntent)).toMatchObject({ kind: 'done', orders: [{ orderId: 'ord-1' }], stopped });
    expect(readPending(USER)).toEqual({ state: 'none' });
  });

  it('an unknown split reads its children on the contract and sends nothing until the trader asks', async () => {
    const { api, typed } = fakeApi();
    api.placeSplit.mockResolvedValueOnce(failure('uncertain', undefined, 504));
    await runIntent(typed, USER, splitIntent);
    // Another key that shares the prefix is not a child.
    api.ordersOn.mockResolvedValueOnce(ok([order({ clientOrderId: 'open-abc:x:1' }), order({ clientOrderId: 'open-abcd:1:0a1b2c3d' })]));
    expect(await checkPending(typed, USER, pendingFor('open-abc'))).toEqual({ kind: 'uncertain', id: 'open-abc', notFound: true });
    expect(api.ordersOn).toHaveBeenLastCalledWith('BTC/USDT:USDT');

    // Some of the size found: still nothing sent, the children found are named.
    api.ordersOn.mockResolvedValueOnce(ok([child(1)]));
    expect(await checkPending(typed, USER, pendingFor('open-abc'))).toMatchObject({
      kind: 'uncertain',
      notFound: true,
      found: [{ orderId: 'ord-1' }],
    });
    expect(api.placeSplit).toHaveBeenCalledTimes(1);

    // The whole size found, in key order: done, nothing sent, the note cleared.
    api.ordersOn.mockResolvedValueOnce(ok([child(2), child(1)]));
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'));
    expect(outcome).toMatchObject({ kind: 'done', orders: [{ orderId: 'ord-1' }, { orderId: 'ord-2' }] });
    expect(api.placeSplit).toHaveBeenCalledTimes(1);
    expect(readPending(USER)).toEqual({ state: 'none' });
  });

  it('the trader’s second step sends the same split request again', async () => {
    const { api, typed } = fakeApi();
    api.placeSplit.mockResolvedValueOnce(failure('uncertain', undefined, 504));
    await runIntent(typed, USER, splitIntent);
    api.placeSplit.mockResolvedValueOnce(ok({ parts: 2, orders: [child(1), child(2)], stopped: null }));
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'), { resend: true });
    expect(outcome).toMatchObject({ kind: 'done', orders: [{ orderId: 'ord-1' }, { orderId: 'ord-2' }] });
    expect(api.placeSplit.mock.calls[1]![0]).toEqual(api.placeSplit.mock.calls[0]![0]);
  });
});
