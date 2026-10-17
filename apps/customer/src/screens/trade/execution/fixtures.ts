/**
 * Labelled TEST data for the harness and the unit tests. Nothing here is a real schedule, order or balance, and no
 * screen imports it: the room only ever shows what the service answered.
 */
import type { Order } from '../../../features/trade/trade-api';
import type { AlgoParent, AlgoPolicy, AlgoProgress, BatchItem } from '../rooms/api';
import type { AlgoWindow } from './blotter';
import type { ExecMarket, Spine } from './data';

export const TEST_NOW = 1_760_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

export const TEST_POLICY_ON: AlgoPolicy = {
  productKind: 'TEST algo',
  capability: { createEnabled: true, jobsEnabled: true, icebergs: 'out' },
  immatureKinds: ['vwap', 'pov'],
  volumeImmatureCode: 'trade.algo_volume_immature',
  cancelIncompleteCode: 'trade.algo_cancel_incomplete',
};
export const TEST_POLICY_OFF: AlgoPolicy = { ...TEST_POLICY_ON, capability: { ...TEST_POLICY_ON.capability, jobsEnabled: false } };

export const TEST_MARKET: ExecMarket = {
  symbol: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  tickSize: '0.01',
  lotSize: '0.0001',
  minAmount: '0.0001',
  minCost: '5',
  open: true,
  taker: '0.001',
  maker: '0.0005',
};

function parent(id: string, over: Partial<AlgoParent>): AlgoParent {
  return {
    id,
    symbol: 'BTC/USDT',
    side: 'buy',
    kind: 'twap',
    totalQty: '0.12',
    durationMs: 3_600_000,
    sliceIntervalMs: 300_000,
    limitPrice: null,
    status: 'active',
    slicesPlanned: 12,
    nextSliceIndex: 4,
    childrenEmitted: 4,
    missesRecorded: 0,
    haltReason: null,
    createdAt: iso(TEST_NOW - 1_200_000),
    projectedEndsAt: iso(TEST_NOW + 2_400_000),
    participationBps: null,
    startedAt: iso(TEST_NOW - 1_200_000),
    nextDueAt: iso(TEST_NOW + 120_000),
    scheduleStretchReason: null,
    ...over,
  };
}
function progress(p: AlgoParent, filledQty: string): AlgoProgress {
  return {
    parentId: p.id,
    status: p.status,
    haltReason: p.haltReason,
    childrenEmitted: p.childrenEmitted,
    missesRecorded: p.missesRecorded,
    slicesPlanned: p.slicesPlanned,
    nextSliceIndex: p.nextSliceIndex,
    filledQty,
    totalQty: p.totalQty,
  };
}

const running = parent('TEST-algo-running', {});
const partial = parent('TEST-algo-partial', {
  side: 'sell',
  childrenEmitted: 8,
  nextSliceIndex: 9,
  missesRecorded: 2,
  scheduleStretchReason: 'two slices missed, schedule stretched',
});
const halted = parent('TEST-algo-halted', {
  status: 'halted',
  haltReason: 'cancel_incomplete',
  childrenEmitted: 6,
  nextSliceIndex: 6,
  nextDueAt: null,
});

/** TEST parents: running, partial (misses) and halted, with their progress reads. */
export const TEST_PARENTS: ReadonlyArray<{ parent: AlgoParent; progress: AlgoProgress }> = [
  { parent: running, progress: progress(running, '0.04') },
  { parent: partial, progress: progress(partial, '0.07') },
  { parent: halted, progress: progress(halted, '0.06') },
];

export const TEST_WINDOWS: AlgoWindow[] = [{ symbol: 'BTC/USDT', side: 'buy', fromMs: TEST_NOW - 1_200_000, toMs: TEST_NOW + 2_400_000 }];

/** TEST scaled results: two placed, one refused, one unknown. */
export const TEST_BATCH: BatchItem[] = [
  { index: 0, clientOrderId: 'scl-tst1-1', status: 'success', order: { id: 'o-1', status: 'open' } },
  { index: 1, clientOrderId: 'scl-tst1-2', status: 'success', order: { id: 'o-2', status: 'open' } },
  {
    index: 2,
    clientOrderId: 'scl-tst1-3',
    status: 'refused',
    error: { message: 'Price is too far from the market', intafacedCode: 'trade.price_band' },
  },
  { index: 3, clientOrderId: 'scl-tst1-4', status: 'unknown' },
];

function order(id: string, over: Partial<Order>): Order {
  return {
    id,
    clientOrderId: null,
    timestamp: TEST_NOW - 600_000,
    datetime: iso(TEST_NOW - 600_000),
    lastTradeTimestamp: null,
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    timeInForce: 'GTC',
    postOnly: false,
    reduceOnly: false,
    price: '59000',
    stopPrice: null,
    average: null,
    amount: '0.0025',
    filled: '0',
    remaining: '0.0025',
    cost: '0',
    status: 'open',
    fee: null,
    trades: [],
    recoveryRequired: false,
    recoveryReason: null,
    reconciliationKey: null,
    ...over,
  };
}

export const TEST_ORDERS = {
  scaledOpen: order('o-1', { clientOrderId: 'scl-tst1-1' }),
  scaledClosed: order('o-2', { clientOrderId: 'scl-tst1-2', status: 'canceled', timestamp: TEST_NOW - 590_000 }),
  algoChild: order('o-9', { clientOrderId: null, type: 'market', price: null, timestamp: TEST_NOW - 300_000 }),
  manual: order('o-8', { clientOrderId: 'man-1', side: 'sell', timestamp: TEST_NOW - 5_000_000 }),
};

export const TEST_SPINE: Spine = {
  doors: [
    { id: 'TEST-door-1', module: 'execution.plan', kind: 'plan', callerSubmit: false },
    { id: 'TEST-door-2', module: 'execution.route', kind: 'route', callerSubmit: true },
  ],
  externalOnly: true,
  houseInternalRefuse: true,
};
