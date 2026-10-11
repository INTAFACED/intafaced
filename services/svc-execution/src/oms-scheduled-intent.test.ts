import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { TradeAdapter, VenueOrder } from '@intafaced/venue-contracts';
import type { SubmitRequest, VenueExecution } from '@intafaced/venue-adapter';
import { FileApprovedAlgoParentStore } from './file-algo-store.js';
import { FileEmsOrderStore } from './file-ems-order-store.js';
import type { EmsOrderStore } from './oms-ems-store.js';
import { scheduleSliceLiveAlgoParent } from './oms-schedule-slice.js';
import { sliceLiveAlgoParent } from './oms-slice.js';
import { tradeAdapterSubmit } from './oms-trade-submit.js';
import { fetchOmsOrder } from './oms-fetch.js';
import { cancelOmsOrder } from './oms-cancel.js';
import { drainInFlightAlgo } from './oms-drain.js';
import { fillFacts } from './oms-fill-confirm.js';

const NOW = new Date('2099-01-01T00:00:00.000Z');
const fields = {
  parentClientOrderId: 'parent',
  amount: '1',
  venueId: 'street',
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  limitPrice: '100',
  parentCap: '100',
  now: NOW,
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'execution-scheduled-intent-'));
  const parentPath = join(dir, 'parent.jsonl');
  const emsPath = join(dir, 'ems.jsonl');
  const parentStore = new FileApprovedAlgoParentStore(parentPath);
  const emsStore = new FileEmsOrderStore(emsPath);
  parentStore.approve({
    parentClientOrderId: 'parent',
    kind: 'twap',
    status: 'approved',
    startedAt: null,
    executionOwner: 'original-operator',
    residual: { remaining: '10' },
    schedule: { durationMs: 60000, sliceIntervalMs: 10000, slicesPlanned: 6, participationBps: null },
  });
  parentStore.start('parent', NOW.toISOString(), 'original-operator');
  return { dir, parentPath, emsPath, parentStore, emsStore };
}

function ack(req: SubmitRequest, overrides: Partial<VenueExecution> = {}): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: 'venue-child',
    filledAmount: req.amount,
    averagePrice: req.limitPrice,
    feeAmount: ZERO,
    feeAsset: 'USDT',
    status: 'filled',
    executedAt: NOW,
    ...overrides,
  };
}

function order(clientOrderId: string, overrides: Partial<VenueOrder> = {}): VenueOrder {
  return {
    venueId: 'street',
    venueOrderId: 'venue-child',
    clientOrderId,
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    amount: parseAmount('1'),
    price: parseAmount('100'),
    filled: ZERO,
    remaining: parseAmount('1'),
    averagePrice: null,
    feePaid: ZERO,
    feeAsset: 'USDT',
    status: 'open',
    createdAt: NOW,
    observedAt: NOW,
    ...overrides,
  };
}

describe('scheduled native slice intent', () => {
  it('a late resting ACK cannot erase a terminal cancel observed while the scheduled submit was pending', async () => {
    const f = fixture();
    try {
      let release!: (value: VenueOrder) => void;
      const response = new Promise<VenueOrder>((resolve) => {
        release = resolve;
      });
      const adapter: TradeAdapter = {
        venue: { id: 'street', displayName: 'Street fixture', kind: 'external-cex', sequencedDepth: true },
        placeOrder: async () => response,
        fetchOrder: async (_symbol, id) => order(id),
        cancelOrder: async (_symbol, id) => order(id, { status: 'canceled' }),
        openOrders: async () => [],
      };
      const first = scheduleSliceLiveAlgoParent({ ...fields, ...f, submit: tradeAdapterSubmit(adapter) });
      const original = new FileEmsOrderStore(f.emsPath).list()[0]!;
      expect(original.state).toBe('SUBMIT_UNKNOWN');
      expect(
        await drainInFlightAlgo({ parentClientOrderId: 'parent', emsStore: f.emsStore, cancelByVenue: { street: adapter.cancelOrder } }),
      ).toMatchObject({ children: [{ outcome: 'stopped' }], residual: { filled: '0', remaining: '1' } });
      const terminal = new FileEmsOrderStore(f.emsPath).get(original.clientOrderId)!;
      release(order(original.clientOrderId));
      expect((await first).ok).toBe(true);
      expect(new FileEmsOrderStore(f.emsPath).get(original.clientOrderId)).toEqual({ ...terminal, recordedAtMs: NOW.getTime() });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it.each(['fetch', 'cancel'] as const)('retains original terms across scheduling and reload before %s observations', async (port) => {
    const f = fixture();
    try {
      const scheduled = await scheduleSliceLiveAlgoParent({
        ...fields,
        ...f,
        submit: async (req) => ack(req, { filledAmount: parseAmount('0.1'), status: 'partial' }),
      });
      expect(scheduled.ok).toBe(true);
      if (!scheduled.ok) throw new Error('slice was refused');
      const store = new FileEmsOrderStore(f.emsPath);
      const original = store.get(scheduled.child.clientOrderId)!;
      for (const changed of [
        { venueId: 'foreign' },
        { clientOrderId: 'foreign' },
        { symbol: 'ETH/USDT' },
        { side: 'sell' as const },
        { amount: parseAmount('77') },
        { price: parseAmount('45') },
        { averagePrice: null },
        { remaining: parseAmount('77') },
      ]) {
        const foreign = order(original.clientOrderId, {
          status: 'filled',
          filled: parseAmount('1'),
          remaining: ZERO,
          averagePrice: parseAmount('99'),
          ...changed,
        });
        const input = { venueId: 'street', symbol: 'BTC/USDT', clientOrderId: original.clientOrderId, emsStore: store };
        const observed =
          port === 'fetch'
            ? await fetchOmsOrder({ ...input, fetchByVenue: { street: async () => foreign } })
            : await cancelOmsOrder({ ...input, cancelByVenue: { street: async () => foreign } });
        expect(observed).toMatchObject({ ok: false, reason: port === 'fetch' ? 'fetch_failed' : 'cancel_failed' });
        expect(new FileEmsOrderStore(f.emsPath).get(original.clientOrderId)).toEqual(original);
      }
      expect(JSON.parse(original.requestFingerprint!)).toMatchObject({
        kind: 'slice',
        executionOwner: 'original-operator',
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: '1',
        limitPrice: '100',
      });
      expect(original.recordedAtMs).toBe(NOW.getTime());
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('only updates the scheduling timestamp, preserving the actual rejected outcome and extra observed quantity', async () => {
    const f = fixture();
    try {
      const emsStore: EmsOrderStore = {
        record: (row) => f.emsStore.record(row.state === 'REJECTED' ? { ...row, drainedRemaining: parseAmount('0.9') } : row),
        get: (id) => f.emsStore.get(id),
        getByReconciliationKey: (id) => f.emsStore.getByReconciliationKey(id),
        list: (filter) => f.emsStore.list(filter),
      };
      const result = await scheduleSliceLiveAlgoParent({
        ...fields,
        ...f,
        emsStore,
        submit: async (req) => ack(req, { status: 'rejected', filledAmount: parseAmount('0.1') }),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('slice was refused');
      const row = new FileEmsOrderStore(f.emsPath).get(result.child.clientOrderId)!;
      expect(row).toMatchObject({
        state: 'REJECTED',
        drainedRemaining: parseAmount('0.9'),
        recordedAtMs: NOW.getTime(),
        execution: { status: 'rejected', filledAmount: parseAmount('0.1') },
      });
      expect(row.requestFingerprint).toBeDefined();
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('lost scheduled ACK retains original terms and size across reload and refuses a mutated overdue retry', async () => {
    const f = fixture();
    try {
      const accepted: SubmitRequest[] = [];
      await expect(
        scheduleSliceLiveAlgoParent({
          ...fields,
          ...f,
          submit: async (req) => {
            accepted.push(req);
            throw new Error('remote accepted; ACK lost');
          },
        }),
      ).rejects.toThrow('ACK lost');
      const store = new FileEmsOrderStore(f.emsPath);
      const original = store.list()[0]!;
      const retry = await scheduleSliceLiveAlgoParent({
        ...fields,
        amount: '2',
        symbol: 'ETH/USDT',
        side: 'sell',
        limitPrice: '45',
        parentCap: '45',
        now: new Date(NOW.getTime() + 60000),
        parentStore: new FileApprovedAlgoParentStore(f.parentPath),
        emsStore: store,
        submit: async (req) => {
          accepted.push(req);
          return ack(req);
        },
      });
      expect(retry).toMatchObject({ ok: false, reason: 'children_unknown' });
      expect(accepted).toHaveLength(1);
      expect(new FileEmsOrderStore(f.emsPath).get(original.clientOrderId)).toEqual(original);
      expect(new FileApprovedAlgoParentStore(f.parentPath).get('parent')?.residual?.remaining).toBe('9');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('overlapping schedules keep one unresolved identity and later allocate a distinct original child', async () => {
    const f = fixture();
    try {
      const accepted: SubmitRequest[] = [];
      let release!: (value: VenueExecution) => void;
      const response = new Promise<VenueExecution>((resolve) => {
        release = resolve;
      });
      const first = scheduleSliceLiveAlgoParent({
        ...fields,
        ...f,
        submit: async (req) => {
          accepted.push(req);
          return response;
        },
      });
      const second = await scheduleSliceLiveAlgoParent({
        ...fields,
        ...f,
        amount: '2',
        submit: async (req) => {
          accepted.push(req);
          return ack(req);
        },
      });
      expect(second).toMatchObject({ ok: false, reason: 'children_unknown' });
      release(ack(accepted[0]!));
      expect(await first).toMatchObject({ ok: true });
      const next = await scheduleSliceLiveAlgoParent({
        ...fields,
        ...f,
        now: new Date(NOW.getTime() + 10000),
        submit: async (req) => {
          accepted.push(req);
          return ack(req);
        },
      });
      expect(next.ok).toBe(true);
      expect(new Set(accepted.map((req) => req.clientOrderId)).size).toBe(2);
      expect(new FileEmsOrderStore(f.emsPath).list().every((row) => row.requestFingerprint !== undefined)).toBe(true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('actual trade adapter resting limits in native EMS', () => {
  it('matched resting lookup resolves a lost ACK after reload and permits a distinct child within the retained quantity', async () => {
    const f = fixture();
    try {
      let placed = 0;
      let accepted!: VenueOrder;
      const adapter: TradeAdapter = {
        venue: { id: 'street', displayName: 'Street fixture', kind: 'external-cex', sequencedDepth: true },
        placeOrder: async (request) => {
          placed += 1;
          accepted = order(request.clientOrderId, { amount: request.amount, remaining: request.amount, price: request.price ?? null });
          if (placed === 1) throw new Error('accepted resting order; ACK lost');
          return accepted;
        },
        fetchOrder: async () => accepted,
        cancelOrder: async () => accepted,
        openOrders: async () => [],
      };
      await expect(scheduleSliceLiveAlgoParent({ ...fields, ...f, submit: tradeAdapterSubmit(adapter) })).rejects.toThrow('ACK lost');
      const store = new FileEmsOrderStore(f.emsPath);
      const original = store.list()[0]!;
      expect(original.state).toBe('SUBMIT_UNKNOWN');
      expect(
        await fetchOmsOrder({
          venueId: 'street',
          symbol: 'BTC/USDT',
          clientOrderId: original.clientOrderId,
          emsStore: store,
          fetchByVenue: { street: adapter.fetchOrder },
        }),
      ).toMatchObject({ ok: true, order: { status: 'open', filled: ZERO, averagePrice: null } });
      const matched = new FileEmsOrderStore(f.emsPath).get(original.clientOrderId)!;
      expect(matched).toMatchObject({ state: 'ACKNOWLEDGED', execution: { filledAmount: ZERO, averagePrice: null } });
      expect(matched.requestFingerprint).toBe(original.requestFingerprint);
      const next = await scheduleSliceLiveAlgoParent({
        ...fields,
        amount: '2',
        now: new Date(NOW.getTime() + 60000),
        parentStore: new FileApprovedAlgoParentStore(f.parentPath),
        emsStore: new FileEmsOrderStore(f.emsPath),
        submit: tradeAdapterSubmit(adapter),
      });
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error('distinct child refused');
      expect(next.child.clientOrderId).not.toBe(original.clientOrderId);
      expect(placed).toBe(2);
      expect(new FileApprovedAlgoParentStore(f.parentPath).get('parent')?.residual?.remaining).toBe('7');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('a new rejected adapter response retains its actual remaining quantity for a native drain after reload', async () => {
    const f = fixture();
    try {
      let cancelCalls = 0;
      const adapter: TradeAdapter = {
        venue: { id: 'street', displayName: 'Street fixture', kind: 'external-cex', sequencedDepth: true },
        placeOrder: async (request) => order(request.clientOrderId, { status: 'rejected', remaining: parseAmount('1') }),
        fetchOrder: async (_symbol, id) => order(id, { status: 'rejected' }),
        cancelOrder: async (_symbol, id) => {
          cancelCalls += 1;
          return order(id, { status: 'rejected' });
        },
        openOrders: async () => [],
      };
      expect(await scheduleSliceLiveAlgoParent({ ...fields, ...f, submit: tradeAdapterSubmit(adapter) })).toMatchObject({
        ok: true,
        execution: { status: 'rejected' },
      });
      const store = new FileEmsOrderStore(f.emsPath);
      const result = await drainInFlightAlgo({
        parentClientOrderId: 'parent',
        emsStore: store,
        cancelByVenue: { street: adapter.cancelOrder },
      });
      expect(result).toMatchObject({ children: [{ outcome: 'already_stopped' }], residual: { filled: '0', remaining: '1' } });
      expect(store.list()[0]).toMatchObject({
        state: 'REJECTED',
        drainedRemaining: parseAmount('1'),
        execution: { averagePrice: null, filledAmount: ZERO },
      });
      expect(new FileApprovedAlgoParentStore(f.parentPath).get('parent')?.residual?.remaining).toBe('10');
      expect(cancelCalls).toBe(0);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it.each(['direct', 'scheduled'] as const)(
    '%s slice retains honest null average and can be fetched/drained after reload',
    async (mode) => {
      const f = fixture();
      try {
        let placed = 0;
        const adapter: TradeAdapter = {
          venue: { id: 'street', displayName: 'Street fixture', kind: 'external-cex', sequencedDepth: true },
          placeOrder: async (request) => {
            placed += 1;
            return order(request.clientOrderId);
          },
          fetchOrder: async (_symbol, id) => order(id),
          cancelOrder: async (_symbol, id) => order(id, { status: 'canceled' }),
          openOrders: async () => [],
        };
        const submit = tradeAdapterSubmit(adapter);
        const result = await (mode === 'direct' ? sliceLiveAlgoParent : scheduleSliceLiveAlgoParent)({ ...fields, ...f, submit });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('resting limit was refused');
        expect(result.execution).toMatchObject({ status: 'partial', filledAmount: ZERO, averagePrice: null });
        const row = new FileEmsOrderStore(f.emsPath).get(result.child.clientOrderId)!;
        expect(row).toMatchObject({ state: 'ACKNOWLEDGED', execution: { filledAmount: ZERO, averagePrice: null } });
        expect(fillFacts(row)).toBeNull();
        const lines = readFileSync(f.emsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(lines.at(-1).execution.averagePrice).toBeNull();
        const store = new FileEmsOrderStore(f.emsPath);
        expect(
          await fetchOmsOrder({
            venueId: 'street',
            symbol: 'BTC/USDT',
            clientOrderId: row.clientOrderId,
            emsStore: store,
            fetchByVenue: { street: adapter.fetchOrder },
          }),
        ).toMatchObject({ ok: true, order: { averagePrice: null, filled: ZERO } });
        expect(
          await drainInFlightAlgo({ parentClientOrderId: 'parent', emsStore: store, cancelByVenue: { street: adapter.cancelOrder } }),
        ).toMatchObject({
          children: [{ outcome: 'stopped' }],
          residual: { filled: '0', remaining: '1' },
        });
        expect(new FileEmsOrderStore(f.emsPath).get(row.clientOrderId)).toMatchObject({
          state: 'CANCELED',
          drainedRemaining: parseAmount('1'),
        });
        const next = await scheduleSliceLiveAlgoParent({
          ...fields,
          now: new Date(NOW.getTime() + 60000),
          parentStore: new FileApprovedAlgoParentStore(f.parentPath),
          emsStore: new FileEmsOrderStore(f.emsPath),
          submit,
        });
        expect(next.ok).toBe(true);
        expect(placed).toBe(2);
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    },
  );

  it('the actual adapter still refuses a positive fill with missing average rather than inventing a price', async () => {
    const f = fixture();
    try {
      const adapter: TradeAdapter = {
        venue: { id: 'street', displayName: 'Street fixture', kind: 'external-cex', sequencedDepth: true },
        placeOrder: async (request) =>
          order(request.clientOrderId, { status: 'filled', filled: parseAmount('1'), remaining: ZERO, averagePrice: null }),
        fetchOrder: async (_symbol, id) => order(id),
        cancelOrder: async (_symbol, id) => order(id),
        openOrders: async () => [],
      };
      await expect(sliceLiveAlgoParent({ ...fields, ...f, submit: tradeAdapterSubmit(adapter) })).rejects.toThrow(
        'filled venue order has null averagePrice',
      );
      expect(new FileEmsOrderStore(f.emsPath).list()[0]).toMatchObject({ state: 'SUBMIT_UNKNOWN', execution: null });
      expect(new FileApprovedAlgoParentStore(f.parentPath).get('parent')?.residual?.remaining).toBe('9');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('retained slice terminal finality', () => {
  async function resting(f: ReturnType<typeof fixture>) {
    const adapter: TradeAdapter = {
      venue: { id: 'street', displayName: 'Street fixture', kind: 'external-cex', sequencedDepth: true },
      placeOrder: async (request) => order(request.clientOrderId),
      fetchOrder: async (_symbol, id) => order(id),
      cancelOrder: async (_symbol, id) => order(id),
      openOrders: async () => [],
    };
    const result = await scheduleSliceLiveAlgoParent({ ...fields, ...f, submit: tradeAdapterSubmit(adapter) });
    if (!result.ok) throw new Error('resting slice refused');
    return result.child.clientOrderId;
  }

  it.each(['fetch', 'cancel'] as const)('delayed %s partial cannot reopen a terminal cancel after native reload', async (port) => {
    const f = fixture();
    try {
      const id = await resting(f);
      const store = new FileEmsOrderStore(f.emsPath);
      let release!: (value: VenueOrder) => void;
      const response = new Promise<VenueOrder>((resolve) => {
        release = resolve;
      });
      const input = { venueId: 'street', symbol: 'BTC/USDT', clientOrderId: id, emsStore: store };
      const pending =
        port === 'fetch'
          ? fetchOmsOrder({ ...input, fetchByVenue: { street: async () => response } })
          : cancelOmsOrder({ ...input, cancelByVenue: { street: async () => response } });
      expect(
        await drainInFlightAlgo({
          parentClientOrderId: 'parent',
          emsStore: store,
          cancelByVenue: {
            street: async () =>
              order(id, { status: 'canceled', filled: parseAmount('0.4'), remaining: parseAmount('0.6'), averagePrice: parseAmount('99') }),
          },
        }),
      ).toMatchObject({ residual: { filled: '0.4', remaining: '0.6' } });
      const terminal = new FileEmsOrderStore(f.emsPath).get(id)!;
      release(
        order(id, {
          status: 'partially_filled',
          filled: parseAmount('0.1'),
          remaining: parseAmount('0.9'),
          averagePrice: parseAmount('99'),
          observedAt: new Date(NOW.getTime() + 90000),
        }),
      );
      expect((await pending).ok).toBe(true);
      expect(new FileEmsOrderStore(f.emsPath).get(id)).toEqual(terminal);
      for (let repeat = 0; repeat < 2; repeat += 1) {
        expect(await drainInFlightAlgo({ parentClientOrderId: 'parent', emsStore: new FileEmsOrderStore(f.emsPath) })).toMatchObject({
          residual: { filled: '0.4', remaining: '0.6' },
        });
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it.each(['fetch', 'cancel'] as const)('delayed %s OPEN cannot erase a matched full fill after native reload', async (port) => {
    const f = fixture();
    try {
      const id = await resting(f);
      const store = new FileEmsOrderStore(f.emsPath);
      let release!: (value: VenueOrder) => void;
      const response = new Promise<VenueOrder>((resolve) => {
        release = resolve;
      });
      const input = { venueId: 'street', symbol: 'BTC/USDT', clientOrderId: id, emsStore: store };
      const pending =
        port === 'fetch'
          ? fetchOmsOrder({ ...input, fetchByVenue: { street: async () => response } })
          : cancelOmsOrder({ ...input, cancelByVenue: { street: async () => response } });
      expect(
        (
          await fetchOmsOrder({
            ...input,
            fetchByVenue: {
              street: async () =>
                order(id, { status: 'filled', filled: parseAmount('1'), remaining: ZERO, averagePrice: parseAmount('99') }),
            },
          })
        ).ok,
      ).toBe(true);
      const terminal = new FileEmsOrderStore(f.emsPath).get(id)!;
      expect(terminal).toMatchObject({ state: 'ACKNOWLEDGED', execution: { status: 'filled' }, drainedRemaining: ZERO });
      release(order(id, { observedAt: new Date(NOW.getTime() + 90000) }));
      expect((await pending).ok).toBe(true);
      expect(new FileEmsOrderStore(f.emsPath).get(id)).toEqual(terminal);
      for (let repeat = 0; repeat < 2; repeat += 1) {
        expect(await drainInFlightAlgo({ parentClientOrderId: 'parent', emsStore: new FileEmsOrderStore(f.emsPath) })).toMatchObject({
          residual: { filled: '1', remaining: '0' },
        });
        expect(new FileEmsOrderStore(f.emsPath).get(id)).toEqual(terminal);
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it.each(['partial-after-cancel', 'cancel-after-filled'] as const)(
    'a delayed drain %s consumes fresh terminal evidence instead of rewriting it',
    async (mode) => {
      const f = fixture();
      try {
        const id = await resting(f);
        const store = new FileEmsOrderStore(f.emsPath);
        let release!: (value: VenueOrder) => void;
        const response = new Promise<VenueOrder>((resolve) => {
          release = resolve;
        });
        const pending = drainInFlightAlgo({
          parentClientOrderId: 'parent',
          emsStore: store,
          cancelByVenue: { street: async () => response },
        });
        const input = { venueId: 'street', symbol: 'BTC/USDT', clientOrderId: id, emsStore: store };
        if (mode === 'partial-after-cancel') {
          expect(
            (
              await cancelOmsOrder({
                ...input,
                cancelByVenue: {
                  street: async () =>
                    order(id, {
                      status: 'canceled',
                      filled: parseAmount('0.4'),
                      remaining: parseAmount('0.6'),
                      averagePrice: parseAmount('99'),
                    }),
                },
              })
            ).ok,
          ).toBe(true);
        } else {
          expect(
            (
              await fetchOmsOrder({
                ...input,
                fetchByVenue: {
                  street: async () =>
                    order(id, { status: 'filled', filled: parseAmount('1'), remaining: ZERO, averagePrice: parseAmount('99') }),
                },
              })
            ).ok,
          ).toBe(true);
        }
        const terminal = new FileEmsOrderStore(f.emsPath).get(id)!;
        release(
          order(id, {
            status: mode === 'partial-after-cancel' ? 'partially_filled' : 'canceled',
            filled: parseAmount('0.1'),
            remaining: parseAmount('0.9'),
            averagePrice: parseAmount('99'),
          }),
        );
        const expected = mode === 'partial-after-cancel' ? { filled: '0.4', remaining: '0.6' } : { filled: '1', remaining: '0' };
        expect(await pending).toMatchObject({ residual: expected });
        expect(new FileEmsOrderStore(f.emsPath).get(id)).toEqual(terminal);
        expect(await drainInFlightAlgo({ parentClientOrderId: 'parent', emsStore: new FileEmsOrderStore(f.emsPath) })).toMatchObject({
          residual: expected,
        });
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    },
  );

  it('matched OPEN then partial then terminal progresses normally and survives repeated native drain', async () => {
    const f = fixture();
    try {
      const id = await resting(f);
      const store = new FileEmsOrderStore(f.emsPath);
      const input = { venueId: 'street', symbol: 'BTC/USDT', clientOrderId: id, emsStore: store };
      for (const observation of [
        order(id),
        order(id, {
          status: 'partially_filled',
          filled: parseAmount('0.1'),
          remaining: parseAmount('0.9'),
          averagePrice: parseAmount('99'),
        }),
      ]) {
        expect((await fetchOmsOrder({ ...input, fetchByVenue: { street: async () => observation } })).ok).toBe(true);
        expect(new FileEmsOrderStore(f.emsPath).get(id)?.execution?.filledAmount).toBe(observation.filled);
      }
      expect(
        (
          await cancelOmsOrder({
            ...input,
            cancelByVenue: {
              street: async () =>
                order(id, {
                  status: 'canceled',
                  filled: parseAmount('0.4'),
                  remaining: parseAmount('0.6'),
                  averagePrice: parseAmount('99'),
                }),
            },
          })
        ).ok,
      ).toBe(true);
      const terminal = new FileEmsOrderStore(f.emsPath).get(id)!;
      for (let repeat = 0; repeat < 2; repeat += 1) {
        expect(await drainInFlightAlgo({ parentClientOrderId: 'parent', emsStore: new FileEmsOrderStore(f.emsPath) })).toMatchObject({
          residual: { filled: '0.4', remaining: '0.6' },
        });
        expect(new FileEmsOrderStore(f.emsPath).get(id)).toEqual(terminal);
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('actual filled ACK terminal quantity', () => {
  it.each(['direct', 'scheduled'] as const)(
    '%s actual filled ACK retains observed quantity through native reload and repeated drain',
    async (mode) => {
      const f = fixture();
      try {
        let cancelCalls = 0;
        const observed = (id: string) =>
          order(id, { status: 'filled', filled: parseAmount('1'), remaining: ZERO, averagePrice: parseAmount('99') });
        const adapter: TradeAdapter = {
          venue: { id: 'street', displayName: 'Street fixture', kind: 'external-cex', sequencedDepth: true },
          placeOrder: async (request) => observed(request.clientOrderId),
          fetchOrder: async (_symbol, id) => observed(id),
          cancelOrder: async (_symbol, id) => {
            cancelCalls += 1;
            return observed(id);
          },
          openOrders: async () => [],
        };
        const result = await (mode === 'direct' ? sliceLiveAlgoParent : scheduleSliceLiveAlgoParent)({
          ...fields,
          ...f,
          submit: tradeAdapterSubmit(adapter),
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('actual filled ACK refused');
        const terminal = new FileEmsOrderStore(f.emsPath).get(result.child.clientOrderId)!;
        expect(terminal).toMatchObject({
          execution: { status: 'filled', filledAmount: parseAmount('1'), remainingAmount: ZERO },
          drainedRemaining: ZERO,
        });
        const wire = JSON.parse(readFileSync(f.emsPath, 'utf8').trim().split('\n').at(-1)!);
        expect(wire.execution.remainingAmount).toBe('0');
        expect(wire.drainedRemaining).toBe('0');
        for (let repeat = 0; repeat < 2; repeat += 1) {
          expect(
            await drainInFlightAlgo({
              parentClientOrderId: 'parent',
              emsStore: new FileEmsOrderStore(f.emsPath),
              cancelByVenue: { street: adapter.cancelOrder },
            }),
          ).toMatchObject({ residual: { filled: '1', remaining: '0' } });
          expect(new FileEmsOrderStore(f.emsPath).get(result.child.clientOrderId)).toEqual(terminal);
        }
        expect(
          (
            await fetchOmsOrder({
              venueId: 'street',
              symbol: 'BTC/USDT',
              clientOrderId: result.child.clientOrderId,
              emsStore: new FileEmsOrderStore(f.emsPath),
              fetchByVenue: { street: adapter.fetchOrder },
            })
          ).ok,
        ).toBe(true);
        expect(new FileEmsOrderStore(f.emsPath).get(result.child.clientOrderId)).toEqual(terminal);
        expect(cancelCalls).toBe(0);
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    },
  );

  it('filled status without observed remaining quantity stays unknown on direct and scheduled reload', async () => {
    for (const mode of ['direct', 'scheduled'] as const) {
      const f = fixture();
      try {
        const result = await (mode === 'direct' ? sliceLiveAlgoParent : scheduleSliceLiveAlgoParent)({
          ...fields,
          ...f,
          submit: async (request) => ack(request),
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('older submit port refused');
        const terminal = new FileEmsOrderStore(f.emsPath).get(result.child.clientOrderId)!;
        expect(terminal.execution?.remainingAmount).toBeUndefined();
        expect(terminal.drainedRemaining).toBeUndefined();
        for (let repeat = 0; repeat < 2; repeat += 1) {
          expect(await drainInFlightAlgo({ parentClientOrderId: 'parent', emsStore: new FileEmsOrderStore(f.emsPath) })).toMatchObject({
            residual: { filled: '1', remaining: null },
          });
          expect(new FileEmsOrderStore(f.emsPath).get(result.child.clientOrderId)).toEqual(terminal);
        }
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    }
  });
});
