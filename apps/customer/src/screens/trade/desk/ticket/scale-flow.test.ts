import { describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../../../shared/api';
import type { Draft, Order, Preview, TradeApi } from '../../../../features/trade/trade-api';
import { CONFLICT_CODE } from '../resend';
import {
  batchPrefix,
  buildDrafts,
  checkAll,
  clearWaitLeft,
  findByPrefix,
  findPlaced,
  MIN_CLEAR_WAIT_MS,
  samePreviews,
  scaleOrderId,
  scaleSlotId,
  sendBatch,
  settleResend,
  totalsOf,
  type BatchOutcome,
} from './scale-flow';

const rows = [
  { price: '100', amount: '0.1', value: '10' },
  { price: '101', amount: '0.2', value: '20.2' },
  { price: '102', amount: '0.3', value: '30.6' },
];
const drafts = buildDrafts({ symbol: 'BTC/USDT', side: 'buy', rows, postOnly: false, batchId: 'b1' });

const preview = (draft: Draft, patch: Partial<Preview> = {}): Preview => ({
  symbol: draft.symbol,
  side: draft.side,
  type: 'limit',
  amount: draft.amount,
  price: draft.price ?? null,
  timeInForce: draft.postOnly ? 'PO' : draft.timeInForce,
  holdAsset: 'USDT',
  holdAmount: String(Number(draft.price) * Number(draft.amount)),
  protectionPrice: null,
  estimatedFee: '0.001',
  feeAsset: 'BTC',
  feeBps: 10,
  feeRole: 'taker',
  orderable: true,
  refusals: [],
  ...patch,
});

const wireOrder = (draft: Draft, patch: Partial<Order> = {}): Order =>
  ({
    id: `id-${draft.clientOrderId}`,
    clientOrderId: draft.clientOrderId,
    timestamp: 1,
    datetime: new Date(1).toISOString(),
    lastTradeTimestamp: null,
    symbol: draft.symbol,
    type: 'limit',
    side: draft.side,
    timeInForce: 'GTC',
    postOnly: false,
    reduceOnly: false,
    price: draft.price ?? null,
    stopPrice: null,
    average: null,
    amount: draft.amount,
    filled: '0',
    remaining: draft.amount,
    cost: '0',
    status: 'open',
    fee: null,
    trades: [],
    recoveryRequired: false,
    recoveryReason: null,
    reconciliationKey: null,
    ...patch,
  }) as Order;

const apiWith = (
  previewFn: (draft: Draft) => Promise<ApiResult<Preview>>,
  orders?: (kind: 'open' | 'closed') => Promise<ApiResult<Order[]>>,
) =>
  ({
    preview: vi.fn(previewFn),
    orders: vi.fn((kind: 'open' | 'closed') => (orders ? orders(kind) : Promise.resolve({ ok: true as const, data: [] }))),
  }) as unknown as TradeApi;
const clientWith = (answer: ApiResult<unknown>) => {
  const rest = vi.fn(async () => answer);
  return { client: { rest } as unknown as ApiClient, rest };
};

describe('building the orders', () => {
  it('gives every order its own number under the 64 character limit, all limit GTC', () => {
    expect(drafts.map((d) => d.clientOrderId)).toEqual([scaleOrderId('b1', 0), scaleOrderId('b1', 1), scaleOrderId('b1', 2)]);
    const long = scaleOrderId('0b4b0a3c-2a1f-4d3c-9c1e-0123456789ab', 19);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(new Set(drafts.map((d) => d.clientOrderId)).size).toBe(3);
    expect(drafts.every((d) => d.type === 'limit' && d.timeInForce === 'GTC' && d.postOnly === false)).toBe(true);
    expect(scaleSlotId('b1')).toBe('scale:b1');
  });

  it('carries post-only to every order when asked', () => {
    const po = buildDrafts({ symbol: 'BTC/USDT', side: 'sell', rows, postOnly: true, batchId: 'b2' });
    expect(po.every((d) => d.postOnly === true && d.side === 'sell')).toBe(true);
  });
});

describe('checking every order with the service', () => {
  it('returns the answers in order', async () => {
    const api = apiWith(async (d) => ({ ok: true, data: preview(d) }));
    const result = await checkAll(api, drafts, () => undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.previews.map((p) => p.price)).toEqual(['100', '101', '102']);
    expect((api.preview as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it('stops on the first order the service refuses, naming it', async () => {
    const api = apiWith(async (d) => ({
      ok: true,
      data: preview(
        d,
        d.price === '101' ? { orderable: false, refusals: [{ code: 'trade.invalid_price', field: 'price', message: 'x' }] } : {},
      ),
    }));
    const result = await checkAll(api, drafts, () => undefined);
    expect(result).toMatchObject({ ok: false, index: 1 });
  });

  it('reports a failed call as a failure, not as an orderable plan', async () => {
    const api = apiWith(async () => ({ ok: false, reason: 'unreachable', message: 'down' }));
    const result = await checkAll(api, drafts, () => undefined);
    expect(result.ok).toBe(false);
  });

  it('a preview that is orderable in name but has no fee or hold is not orderable', async () => {
    const api = apiWith(async (d) => ({ ok: true, data: preview(d, { estimatedFee: null }) }));
    expect((await checkAll(api, drafts, () => undefined)).ok).toBe(false);
  });

  it('stops asking once the screen is gone', async () => {
    const api = apiWith(async (d) => ({ ok: true, data: preview(d) }));
    const result = await checkAll(
      api,
      drafts,
      () => undefined,
      () => false,
    );
    expect(result.ok).toBe(false);
    expect((api.preview as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe('totals', () => {
  it('adds up what the service says it will hold and charge', () => {
    const previews = drafts.map((d, i) =>
      preview(d, { holdAmount: ['10', '20.2', '30.6'][i]!, estimatedFee: ['0.0001', '0.0002', '0.0003'][i]! }),
    );
    expect(totalsOf(previews)).toEqual({ holdAsset: 'USDT', hold: '60.8', feeAsset: 'BTC', fee: '0.0006', feeBps: 10 });
  });

  it('never adds two assets together', () => {
    const previews = drafts.map((d, i) => preview(d, i === 1 ? { holdAsset: 'BTC' } : {}));
    expect(totalsOf(previews)).toBeNull();
    expect(totalsOf(drafts.map((d, i) => preview(d, i === 2 ? { feeAsset: 'USDT' } : {})))).toBeNull();
  });

  it('refuses totals for anything not orderable, or nothing', () => {
    expect(totalsOf([])).toBeNull();
    expect(totalsOf([preview(drafts[0]!, { orderable: false })])).toBeNull();
  });

  it('shows no single rate when the orders carry different ones', () => {
    const previews = drafts.map((d, i) => preview(d, { feeBps: i === 0 ? 5 : 10 }));
    expect(totalsOf(previews)?.feeBps).toBeNull();
  });

  it('notices any change between the reviewed answers and the fresh ones', () => {
    const a = drafts.map((d) => preview(d));
    expect(
      samePreviews(
        a,
        drafts.map((d) => preview(d)),
      ),
    ).toBe(true);
    expect(
      samePreviews(
        a,
        drafts.map((d, i) => preview(d, i === 2 ? { estimatedFee: '0.002' } : {})),
      ),
    ).toBe(false);
    expect(samePreviews(a, a.slice(1))).toBe(false);
  });
});

describe('sending the batch', () => {
  const item = (index: number, status: 'success' | 'refused' | 'unknown', extra: Record<string, unknown> = {}) => ({
    index,
    clientOrderId: drafts[index]!.clientOrderId,
    status,
    ...extra,
  });

  it('is one POST with the exact orders and no retry', async () => {
    const { client, rest } = clientWith({ ok: true, data: { results: drafts.map((d, i) => item(i, 'success', { order: wireOrder(d) })) } });
    await sendBatch(client, drafts);
    expect(rest).toHaveBeenCalledTimes(1);
    expect(rest).toHaveBeenCalledWith('/orders/batch', expect.anything(), { method: 'POST', body: { orders: drafts } });
  });

  it('reports each order on its own: some in, some refused, some unknown', async () => {
    const { client } = clientWith({
      ok: true,
      data: {
        results: [
          item(0, 'success', { order: wireOrder(drafts[0]!) }),
          item(1, 'refused', { error: { intafacedCode: 'trade.invalid_price' } }),
          item(2, 'unknown', { evidence: { x: 1 } }),
        ],
      },
    });
    const outcome = await sendBatch(client, drafts);
    expect(outcome.request).toBe('answered');
    expect(outcome.items.map((i) => i.kind)).toEqual(['placed', 'refused', 'unknown']);
    expect(outcome.items[1]).toEqual({ kind: 'refused', code: 'trade.invalid_price' });
  });

  it('an order the service says is a different request under that number is not a refusal', async () => {
    const { client } = clientWith({
      ok: true,
      data: { results: drafts.map((_, i) => item(i, 'refused', { error: { intafacedCode: CONFLICT_CODE } })) },
    });
    const outcome = await sendBatch(client, drafts);
    expect(outcome.items.every((i) => i.kind === 'unknown')).toBe(true);
  });

  it('a success that names another order or market is unknown, not placed', async () => {
    const other = { ...wireOrder(drafts[0]!), clientOrderId: 'someone-else' };
    const wrongMarket = { ...wireOrder(drafts[1]!), symbol: 'ETH/USDT' };
    const { client } = clientWith({
      ok: true,
      data: {
        results: [
          item(0, 'success', { order: other }),
          item(1, 'success', { order: wrongMarket }),
          item(2, 'success', { order: { junk: true } }),
        ],
      },
    });
    const outcome = await sendBatch(client, drafts);
    expect(outcome.items.map((i) => i.kind)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('a success that still needs recovery is unknown', async () => {
    const recovering = { ...wireOrder(drafts[0]!), recoveryRequired: true, recoveryReason: 'x' };
    const { client } = clientWith({
      ok: true,
      data: {
        results: [
          item(0, 'success', { order: recovering }),
          item(1, 'success', { order: wireOrder(drafts[1]!) }),
          item(2, 'success', { order: wireOrder(drafts[2]!) }),
        ],
      },
    });
    expect((await sendBatch(client, drafts)).items.map((i) => i.kind)).toEqual(['unknown', 'placed', 'placed']);
  });

  it('results that do not line up with the orders sent are unknown, never guessed', async () => {
    const { client } = clientWith({
      ok: true,
      data: {
        results: [
          item(0, 'success', { order: wireOrder(drafts[0]!) }),
          { ...item(1, 'success', { order: wireOrder(drafts[1]!) }), index: 5 },
        ],
      },
    });
    expect((await sendBatch(client, drafts)).items.map((i) => i.kind)).toEqual(['placed', 'unknown', 'unknown']);
  });

  it('a lost or unreadable answer leaves every order unknown', async () => {
    const { client } = clientWith({ ok: false, reason: 'uncertain', message: 'lost' });
    const outcome = await sendBatch(client, drafts);
    expect(outcome.request).toBe('unsure');
    expect(outcome.items.every((i) => i.kind === 'unknown')).toBe(true);
  });

  it('a request the service turned away before looking at any order means nothing was placed', async () => {
    const { client } = clientWith({ ok: false, reason: 'forbidden', message: 'no', code: 'scope.denied' });
    const outcome = await sendBatch(client, drafts);
    expect(outcome.request).toBe('refused');
    expect(outcome.items.every((i) => i.kind === 'refused')).toBe(true);
  });
});

describe('finding out afterwards', () => {
  it('matches orders by their own number, in this market only', async () => {
    const open = [wireOrder(drafts[0]!)];
    const closed = [wireOrder(drafts[1]!, { status: 'closed' }), { ...wireOrder(drafts[2]!), symbol: 'ETH/USDT' }];
    const api = apiWith(
      async () => ({ ok: false, reason: 'error', message: '' }),
      async (kind) => ({ ok: true, data: kind === 'open' ? open : closed }),
    );
    const found = await findPlaced(
      api,
      'BTC/USDT',
      drafts.map((d) => d.clientOrderId),
      () => undefined,
    );
    expect(found.ok).toBe(true);
    if (found.ok) expect([...found.found.keys()]).toEqual([drafts[0]!.clientOrderId, drafts[1]!.clientOrderId]);
  });

  it('does not count an order still recovering as found', async () => {
    const api = apiWith(
      async () => ({ ok: false, reason: 'error', message: '' }),
      async (kind) => ({ ok: true, data: kind === 'open' ? [{ ...wireOrder(drafts[0]!), recoveryRequired: true }] : [] }),
    );
    const found = await findPlaced(api, 'BTC/USDT', [drafts[0]!.clientOrderId], () => undefined);
    expect(found.ok && found.found.size).toBe(0);
  });

  it('a failed read is not "nothing found"', async () => {
    const api = apiWith(
      async () => ({ ok: false, reason: 'error', message: '' }),
      async (kind) => (kind === 'open' ? { ok: true, data: [] } : { ok: false, reason: 'unreachable', message: '' }),
    );
    expect((await findPlaced(api, 'BTC/USDT', ['x'], () => undefined)).ok).toBe(false);
  });
});

describe('what "success" means for each order', () => {
  const item = (index: number, order: Order) => ({ index, clientOrderId: drafts[index]!.clientOrderId, status: 'success', order });
  it('counts only open and filled orders as in; a rejected post-only order is not placed', async () => {
    const { client } = clientWith({
      ok: true,
      data: {
        results: [
          item(0, wireOrder(drafts[0]!)),
          item(1, wireOrder(drafts[1]!, { status: 'rejected', postOnly: true })),
          item(2, wireOrder(drafts[2]!, { status: 'closed', filled: drafts[2]!.amount, remaining: '0' })),
        ],
      },
    });
    const outcome = await sendBatch(client, drafts);
    expect(outcome.items.map((i) => i.kind)).toEqual(['placed', 'rejected', 'placed']);
  });

  it('a cancelled or expired order is "ended", not in', async () => {
    const { client } = clientWith({
      ok: true,
      data: {
        results: [
          item(0, wireOrder(drafts[0]!, { status: 'canceled' })),
          item(1, wireOrder(drafts[1]!, { status: 'expired' })),
          item(2, wireOrder(drafts[2]!)),
        ],
      },
    });
    expect((await sendBatch(client, drafts)).items.map((i) => i.kind)).toEqual(['ended', 'ended', 'placed']);
  });
});

describe('after sending the missing orders again', () => {
  const refusedAll: BatchOutcome = { request: 'refused', items: drafts.map(() => ({ kind: 'refused' as const, code: 'rate.limited' })) };
  const unsureAll: BatchOutcome = { request: 'unsure', items: drafts.map(() => ({ kind: 'unknown' as const })) };
  const noRead = () => apiWith(async () => ({ ok: false, reason: 'error', message: '' }));
  const reading = (open: Order[], closed: Order[] = []) =>
    apiWith(
      async () => ({ ok: false, reason: 'error', message: '' }),
      async (kind) => ({ ok: true, data: kind === 'open' ? open : closed }),
    );

  it('a refused request (expired sign-in, rate limit, kill switch) clears nothing, and does not even look', async () => {
    const api = noRead();
    const settled = await settleResend(api, 'BTC/USDT', drafts, refusedAll, () => undefined);
    expect(settled.left).toEqual(drafts);
    expect(settled.refused).toEqual([]);
    expect((api.orders as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('a lost answer clears nothing', async () => {
    expect((await settleResend(noRead(), 'BTC/USDT', drafts, unsureAll, () => undefined)).left).toEqual(drafts);
  });

  it('orders the service shows (placed, rejected or ended) are cleared without a lookup', async () => {
    const api = noRead();
    const answered: BatchOutcome = {
      request: 'answered',
      items: [
        { kind: 'placed', order: wireOrder(drafts[0]!) },
        { kind: 'rejected', order: wireOrder(drafts[1]!, { status: 'rejected' }) },
        { kind: 'ended', order: wireOrder(drafts[2]!, { status: 'canceled' }) },
      ],
    };
    expect(await settleResend(api, 'BTC/USDT', drafts, answered, () => undefined)).toEqual({ left: [], refused: [] });
    expect((api.orders as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('an order the service refused is cleared only after a lookup that worked finds nothing under its id', async () => {
    const answered: BatchOutcome = {
      request: 'answered',
      items: [{ kind: 'refused', code: 'trade.spot_disabled' }, { kind: 'placed', order: wireOrder(drafts[1]!) }, { kind: 'unknown' }],
    };
    const settled = await settleResend(reading([]), 'BTC/USDT', drafts, answered, () => undefined);
    expect(settled.left).toEqual([drafts[2]]); // unknown stays
    expect(settled.refused).toEqual([{ draft: drafts[0], code: 'trade.spot_disabled' }]);
  });

  it('a refused order that the lookup DOES find is cleared as found, never as refused', async () => {
    const answered: BatchOutcome = {
      request: 'answered',
      items: [{ kind: 'refused', code: 'x' }, { kind: 'unknown' }, { kind: 'unknown' }],
    };
    const settled = await settleResend(reading([wireOrder(drafts[0]!)]), 'BTC/USDT', drafts, answered, () => undefined);
    expect(settled.refused).toEqual([]);
    expect(settled.left).toEqual([drafts[1], drafts[2]]);
  });

  it('an order still recovering is kept, even if the service had refused it', async () => {
    const answered: BatchOutcome = {
      request: 'answered',
      items: [
        { kind: 'refused', code: 'x' },
        { kind: 'placed', order: wireOrder(drafts[1]!) },
        { kind: 'placed', order: wireOrder(drafts[2]!) },
      ],
    };
    const settled = await settleResend(
      reading([{ ...wireOrder(drafts[0]!), recoveryRequired: true }]),
      'BTC/USDT',
      drafts,
      answered,
      () => undefined,
    );
    expect(settled.left).toEqual([drafts[0]]);
    expect(settled.refused).toEqual([]);
  });

  it('when the lookup itself fails, nothing is cleared', async () => {
    const api = apiWith(
      async () => ({ ok: false, reason: 'error', message: '' }),
      async () => ({ ok: false, reason: 'unreachable', message: '' }),
    );
    const answered: BatchOutcome = {
      request: 'answered',
      items: [
        { kind: 'refused', code: 'x' },
        { kind: 'refused', code: 'x' },
        { kind: 'refused', code: 'x' },
      ],
    };
    expect((await settleResend(api, 'BTC/USDT', drafts, answered, () => undefined)).left).toEqual(drafts);
  });
});

describe('looking up a batch by its number', () => {
  it('finds open and closed orders of that batch only, in that market', async () => {
    const other = buildDrafts({ symbol: 'BTC/USDT', side: 'buy', rows, postOnly: false, batchId: 'other' });
    const api = apiWith(
      async () => ({ ok: false, reason: 'error', message: '' }),
      async (kind) => ({
        ok: true,
        data:
          kind === 'open'
            ? [wireOrder(drafts[0]!), wireOrder(other[0]!)]
            : [wireOrder(drafts[1]!, { status: 'closed' }), { ...wireOrder(drafts[2]!), symbol: 'ETH/USDT' }],
      }),
    );
    const found = await findByPrefix(api, 'BTC/USDT', batchPrefix('b1'), () => undefined);
    expect(found.ok && found.orders.map((o) => o.clientOrderId)).toEqual([drafts[0]!.clientOrderId, drafts[1]!.clientOrderId]);
  });

  it('a failed read is not "found nothing"', async () => {
    const api = apiWith(
      async () => ({ ok: false, reason: 'error', message: '' }),
      async () => ({ ok: false, reason: 'unreachable', message: '' }),
    );
    expect((await findByPrefix(api, 'BTC/USDT', batchPrefix('b1'), () => undefined)).ok).toBe(false);
  });

  it('clearing waits a minimum time after the send', () => {
    expect(clearWaitLeft(1000, 1000)).toBe(MIN_CLEAR_WAIT_MS);
    expect(clearWaitLeft(1000, 1000 + MIN_CLEAR_WAIT_MS - 1)).toBe(1);
    expect(clearWaitLeft(1000, 1000 + MIN_CLEAR_WAIT_MS)).toBe(0);
    expect(clearWaitLeft(1000, 10 ** 12)).toBe(0);
  });
});
