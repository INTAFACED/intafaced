import { describe, expect, it } from 'vitest';
import type { Order } from '../../../features/trade/trade-api';
import type { ParentRead } from '../execution/data';
import type { RfqBoard } from '../rooms/api';
import { BRANCHES, buildTree, exposureOf } from './tree';

const order = (over: Partial<Order>): Order =>
  ({
    id: 'o1',
    clientOrderId: null,
    timestamp: 1,
    datetime: '2026-11-06T00:00:00.000Z',
    lastTradeTimestamp: null,
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    timeInForce: 'GTC',
    postOnly: false,
    reduceOnly: false,
    price: '100',
    stopPrice: null,
    average: null,
    amount: '2',
    filled: '0',
    remaining: '2',
    cost: '0',
    status: 'open',
    fee: null,
    trades: [],
    recoveryRequired: false,
    recoveryReason: null,
    reconciliationKey: null,
    ...over,
  }) as Order;

const parent = (over: Record<string, unknown> = {}): ParentRead =>
  ({
    id: 'a1',
    ok: true,
    parent: {
      id: 'a1',
      symbol: 'BTC/USDT',
      side: 'buy',
      kind: 'twap',
      totalQty: '0.002',
      durationMs: 1,
      sliceIntervalMs: 1,
      limitPrice: '70000',
      status: 'active',
      slicesPlanned: 2,
      nextSliceIndex: 1,
      childrenEmitted: 1,
      missesRecorded: 0,
      haltReason: null,
      createdAt: '2026-11-06T00:00:00.000Z',
      projectedEndsAt: '2026-11-06T02:00:00.000Z',
      children: [{ orderId: 'c1', sliceIndex: 0, qty: '0.001' }],
      ...over,
    },
    progress: { filledQty: '0.0005' },
    result: null,
  }) as unknown as ParentRead;

const board: RfqBoard = {
  more: false,
  groups: [
    {
      status: 'open',
      count: 1,
      requests: [
        {
          rfqId: 'r1',
          status: 'open',
          side: 'sell',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          qty: '1',
          createdAt: '2026-11-06T00:00:00.000Z',
          quotes: [
            { quoteId: 'q2', makerId: null, rfqSeq: 2, quotedPrice: '99', userNotional: '99', spreadBps: 5, lifecycle: 'quoted', test: true, rank: 2, best: false, expiresAt: 'x' },
            { quoteId: 'q1', makerId: null, rfqSeq: 1, quotedPrice: '101', userNotional: '101', spreadBps: 5, lifecycle: 'quoted', test: true, rank: 1, best: true, expiresAt: 'x' },
          ],
        },
      ],
    },
    { status: 'settled', count: 1, requests: [{ rfqId: 'r0', status: 'settled', side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1', createdAt: 'x', quotes: [] }] },
  ],
};

describe('buildTree', () => {
  it('has one branch per kind, in order, and the kinds the platform does not run say why', () => {
    const tree = buildTree({ open: [], closed: [], parents: [], rfq: null });
    expect(tree.map((b) => b.kind)).toEqual([...BRANCHES]);
    expect(tree.find((b) => b.kind === 'care')).toMatchObject({ parents: [], notRun: 'care_desk_not_open' });
    expect(tree.find((b) => b.kind === 'routed')).toMatchObject({ parents: [], notRun: 'no_second_book' });
    expect(tree.filter((b) => b.notRun === null).every((b) => b.parents.length === 0)).toBe(true);
  });

  it('hangs each slice under its schedule, with the book state of the child order and the exposure still to fill', () => {
    const child = order({ id: 'c1', amount: '0.001', price: '70000', status: 'closed', filled: '0.001', remaining: '0' });
    const [, , algo] = buildTree({ open: [], closed: [child], parents: [parent()], rfq: null });
    const [p] = algo!.parents;
    expect(p).toMatchObject({ ref: 'a1', type: 'twap', owner: 'you', state: 'active' });
    // 0.002 - 0.0005 left at the 70000 limit.
    expect(p!.exposure).toEqual({ amount: '105', asset: 'USDT' });
    expect(p!.children).toEqual([{ id: 'slice:c1', ref: 'c1', kind: 'slice', index: 0, qty: '0.001', price: '70000', state: 'filled' }]);
  });

  it('leaves out finished schedules and unreadable ones', () => {
    const done = parent({ status: 'completed' });
    const broken = { id: 'a9', ok: false, code: 'trade.algo_not_found' } as ParentRead;
    expect(buildTree({ open: [], closed: [], parents: [done, broken], rfq: null })[2]!.parents).toEqual([]);
  });

  it('lists stops and OCOs as synthetic, not plain limits, and not a schedule child', () => {
    const open = [
      order({ id: 's1', type: 'stop_limit', price: '90', remaining: '1' }),
      order({ id: 'oco', type: 'limit', exit: { kind: 'oco', takeProfit: '120', stopLoss: '80', stopLossLimit: null } }),
      order({ id: 'plain' }),
      order({ id: 'c1', type: 'stop' }),
    ];
    const synthetic = buildTree({ open, closed: [], parents: [parent()], rfq: null })[1]!.parents;
    expect(synthetic.map((p) => [p.ref, p.type])).toEqual([
      ['s1', 'stop_limit'],
      ['oco', 'oco'],
    ]);
    expect(synthetic[0]!.exposure).toEqual({ amount: '90', asset: 'USDT' });
  });

  it('shows live RFQ requests with their quotes as children, priced at the best quote', () => {
    const rfq = buildTree({ open: [], closed: [], parents: [], rfq: board })[3]!.parents;
    expect(rfq).toHaveLength(1);
    expect(rfq[0]).toMatchObject({ ref: 'r1', symbol: 'BTC/USDT', side: 'sell', exposure: { amount: '101', asset: 'USDT' } });
    expect(rfq[0]!.children.map((c) => c.ref)).toEqual(['q2', 'q1']);
  });
});

describe('exposureOf', () => {
  it('prices at the limit, falls back to the base asset, and never goes below zero', () => {
    expect(exposureOf('0.5', '10', 'ETH/USDC')).toEqual({ amount: '5', asset: 'USDC' });
    expect(exposureOf('0.5', null, 'ETH/USDC')).toEqual({ amount: '0.5', asset: 'ETH' });
    expect(exposureOf('-1', '10', 'ETH/USDC')).toEqual({ amount: '0', asset: 'USDC' });
    expect(exposureOf(null, '10', 'ETH/USDC')).toBeNull();
  });
});
