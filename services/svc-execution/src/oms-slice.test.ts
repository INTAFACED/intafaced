import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileApprovedAlgoParentStore } from './file-algo-store.js';
import { FileEmsOrderStore } from './file-ems-order-store.js';
import { fetchOmsOrder } from './oms-fetch.js';
import { cancelOmsOrder } from './oms-cancel.js';
import type { VenueOrder } from '@intafaced/venue-contracts';
import { formatAmount, parseAmount, sub, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { SubmitRequest, VenueExecution } from '@intafaced/venue-adapter';
import {
  InMemoryApprovedAlgoParentStore,
  type ApprovedAlgoParent,
  type ApprovedAlgoParentStore,
  type RetainedAlgoSchedule,
} from './oms-start.js';
import { sliceLiveAlgoParent as submitSlice } from './oms-slice.js';
import { InMemoryEmsOrderStore, type EmsOrderStore } from './oms-ems-store.js';
import type { OmsSubmitFn } from './oms-trade-submit.js';
import { InMemoryAlgoPauseStore } from './oms-pause.js';
import { createExecutionRouter } from './router.js';

const fixtureJournals = new WeakMap<ApprovedAlgoParentStore, EmsOrderStore>();
function sliceLiveAlgoParent(input: Parameters<typeof submitSlice>[0]) {
  let emsStore = input.emsStore;
  if (!emsStore && input.parentStore) {
    emsStore = fixtureJournals.get(input.parentStore);
    if (!emsStore) {
      emsStore = new InMemoryEmsOrderStore();
      fixtureJournals.set(input.parentStore, emsStore);
    }
  }
  return submitSlice({ ...input, emsStore });
}

const SECRET = 'a-execution-oms-slice-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: OP,
    userId: OP,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function hmacSigned(p: Principal = principal()) {
  return { ...signed(p), service: 'svc-execution' as const };
}

function retainedTwap(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function retainedVwap(): RetainedAlgoSchedule {
  return { durationMs: 120_000, sliceIntervalMs: 15_000, slicesPlanned: 8, participationBps: null };
}

function retainedPov(): RetainedAlgoSchedule {
  return { durationMs: 90_000, sliceIntervalMs: 5_000, slicesPlanned: 18, participationBps: 150 };
}

function live(
  over: Partial<ApprovedAlgoParent> &
    Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'> & {
      schedule?: RetainedAlgoSchedule;
    },
): ApprovedAlgoParent {
  const schedule = over.schedule ?? (over.kind === 'pov' ? retainedPov() : over.kind === 'vwap' ? retainedVwap() : retainedTwap());
  return {
    status: 'approved',
    startedAt: null,
    executionOwner: OP,
    ...over,
    schedule,
  };
}

function ack(req: SubmitRequest): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: 'v-slice-1',
    filledAmount: req.amount,
    averagePrice: req.limitPrice,
    feeAmount: ZERO,
    feeAsset: 'USDT',
    status: 'filled',
    executedAt: new Date('2026-08-25T00:00:00.000Z'),
  };
}

function trackingSubmit(): { calls: SubmitRequest[]; submit: OmsSubmitFn } {
  const calls: SubmitRequest[] = [];
  return {
    calls,
    submit: async (req) => {
      calls.push(req);
      return ack(req);
    },
  };
}

const sliceFields = {
  amount: '0.5',
  venueId: 'street',
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  limitPrice: '100',
  parentCap: '100',
};

const leftover = '10';
function withResidual(
  over: Partial<ApprovedAlgoParent> & Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'>,
  remaining = leftover,
): ApprovedAlgoParent {
  return live({ ...over, residual: { remaining } });
}

describe('sliceLiveAlgoParent', () => {
  it('overlapping native journal slices reserve one child identity until its response is known', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'execution-overlap-'));
    try {
      const parentStore = new FileApprovedAlgoParentStore(join(dir, 'parents.jsonl'));
      const emsStore = new FileEmsOrderStore(join(dir, 'ems.jsonl'));
      parentStore.approve(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }, '10'));
      let release!: (value: VenueExecution) => void;
      const response = new Promise<VenueExecution>((resolve) => {
        release = resolve;
      });
      const accepted: SubmitRequest[] = [];
      const first = submitSlice({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        amount: '6',
        parentStore,
        emsStore,
        submit: async (req) => {
          accepted.push(req);
          return response;
        },
      });
      const second = await submitSlice({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        amount: '3',
        parentStore,
        emsStore,
        submit: async (req) => {
          accepted.push(req);
          return ack(req);
        },
      });
      expect(second).toMatchObject({ ok: false, reason: 'children_unknown' });
      expect(accepted).toHaveLength(1);
      expect(emsStore.list()[0]?.clientOrderId).toBe(accepted[0]!.clientOrderId);
      expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('4');
      release(ack(accepted[0]!));
      expect(await first).toMatchObject({ ok: true, residual: { remaining: '4' } });
      const next = await submitSlice({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        amount: '3',
        parentStore,
        emsStore,
        submit: async (req) => {
          accepted.push(req);
          return ack(req);
        },
      });
      expect(next).toMatchObject({ ok: true, residual: { remaining: '1' } });
      expect(new Set(accepted.map((req) => req.clientOrderId)).size).toBe(2);
      expect(new FileEmsOrderStore(join(dir, 'ems.jsonl')).list()).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('lost acknowledgement survives a native journal restart with its original terms and reserved size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'execution-intent-'));
    try {
      const parentPath = join(dir, 'parents.jsonl');
      const emsPath = join(dir, 'ems.jsonl');
      const parentStore = new FileApprovedAlgoParentStore(parentPath);
      const emsStore = new FileEmsOrderStore(emsPath);
      parentStore.approve(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }, '10'));
      const accepted: SubmitRequest[] = [];
      await expect(
        submitSlice({
          parentClientOrderId: 'parent-twap',
          ...sliceFields,
          amount: '6',
          parentStore,
          emsStore,
          submit: async (req) => {
            accepted.push(req);
            throw new Error('accepted remotely; acknowledgement lost');
          },
        }),
      ).rejects.toThrow('acknowledgement lost');
      const reloadedParents = new FileApprovedAlgoParentStore(parentPath);
      const reloadedEms = new FileEmsOrderStore(emsPath);
      const original = reloadedEms.list()[0]!;
      expect(original.clientOrderId).toBe(accepted[0]!.clientOrderId);
      expect(original.reconciliationKey).toBe(original.clientOrderId);
      expect(JSON.parse(original.requestFingerprint!)).toEqual({
        kind: 'slice',
        parentClientOrderId: 'parent-twap',
        executionOwner: OP,
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: '6',
        limitPrice: '100',
      });
      expect(reloadedParents.get('parent-twap')?.residual?.remaining).toBe('4');
      expect(
        await submitSlice({
          parentClientOrderId: 'parent-twap',
          ...sliceFields,
          amount: '4',
          symbol: 'ETH/USDT',
          limitPrice: '200',
          parentCap: '200',
          parentStore: reloadedParents,
          emsStore: reloadedEms,
          submit: async (req) => {
            accepted.push(req);
            return ack(req);
          },
        }),
      ).toMatchObject({ ok: false, reason: 'children_unknown' });
      expect(accepted).toHaveLength(1);
      expect(reloadedEms.get(original.clientOrderId)?.requestFingerprint).toBe(original.requestFingerprint);
      const observed: VenueOrder = {
        venueId: 'street',
        venueOrderId: 'actual-fill',
        clientOrderId: original.clientOrderId,
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: parseAmount('100'),
        amount: parseAmount('6'),
        filled: parseAmount('6'),
        remaining: ZERO,
        averagePrice: parseAmount('99'),
        status: 'filled',
        feePaid: ZERO,
        feeAsset: 'USDT',
        createdAt: new Date(),
        observedAt: new Date(),
      };
      for (const changed of [
        { clientOrderId: 'foreign' },
        { venueId: 'other' },
        { symbol: 'ETH/USDT' },
        { side: 'sell' as const },
        { amount: parseAmount('3') },
        { price: parseAmount('200') },
      ]) {
        const foreign = { ...observed, ...changed };
        expect(
          await fetchOmsOrder({
            venueId: 'street',
            symbol: 'BTC/USDT',
            clientOrderId: original.clientOrderId,
            emsStore: reloadedEms,
            fetchByVenue: { street: async () => foreign },
          }),
        ).toMatchObject({ ok: false, reason: 'fetch_failed' });
        expect(
          await cancelOmsOrder({
            venueId: 'street',
            symbol: 'BTC/USDT',
            clientOrderId: original.clientOrderId,
            emsStore: reloadedEms,
            cancelByVenue: { street: async () => foreign },
          }),
        ).toMatchObject({ ok: false, reason: 'cancel_failed' });
        expect(new FileEmsOrderStore(emsPath).get(original.clientOrderId)?.state).toBe('SUBMIT_UNKNOWN');
      }
      expect(
        await fetchOmsOrder({
          venueId: 'street',
          symbol: 'BTC/USDT',
          clientOrderId: original.clientOrderId,
          emsStore: reloadedEms,
          fetchByVenue: { street: async () => observed },
        }),
      ).toMatchObject({ ok: true });
      expect(new FileEmsOrderStore(emsPath).get(original.clientOrderId)).toMatchObject({
        state: 'ACKNOWLEDGED',
        execution: { filledAmount: parseAmount('6'), averagePrice: parseAmount('99') },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('live parent + explicit slice qty → submit called once and remaining falls by qty', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    parentStore.seed(
      withResidual({
        parentClientOrderId: 'parent-vwap',
        kind: 'vwap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
      }),
    );
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-pov', kind: 'pov' }));

    const twapSubmit = trackingSubmit();
    const twap = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore,
      submit: twapSubmit.submit,
    });
    const twapLeft = formatAmount(sub(parseAmount(leftover), parseAmount('0.5')));
    expect(twap).toMatchObject({
      ok: true,
      sliced: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
      child: { venueId: 'street' },
      residual: { remaining: twapLeft },
    });
    expect(twapSubmit.calls).toHaveLength(1);
    expect(twapSubmit.calls[0]).toEqual({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: parseAmount('0.5'),
      limitPrice: parseAmount('100'),
      clientOrderId: twapSubmit.calls[0]!.clientOrderId,
    });
    if (!twap.ok) return;
    expect(twap.child.clientOrderId).toBe(twapSubmit.calls[0]!.clientOrderId);
    expect(twap.execution.venueOrderId).toBe('v-slice-1');
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(twapLeft);

    const vwapSubmit = trackingSubmit();
    const vwap = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-vwap',
      ...sliceFields,
      amount: '1.25',
      parentStore,
      submit: vwapSubmit.submit,
    });
    const vwapLeft = formatAmount(sub(parseAmount(leftover), parseAmount('1.25')));
    expect(vwap).toMatchObject({ ok: true, parent: { kind: 'vwap' }, residual: { remaining: vwapLeft } });
    expect(vwapSubmit.calls).toHaveLength(1);
    expect(vwapSubmit.calls[0]?.amount).toBe(parseAmount('1.25'));
    expect(parentStore.get('parent-vwap')?.residual?.remaining).toBe(vwapLeft);

    const povSubmit = trackingSubmit();
    const pov = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-pov',
      ...sliceFields,
      side: 'sell',
      parentStore,
      submit: povSubmit.submit,
    });
    const povLeft = formatAmount(sub(parseAmount(leftover), parseAmount('0.5')));
    expect(pov).toMatchObject({ ok: true, parent: { kind: 'pov' }, residual: { remaining: povLeft } });
    expect(povSubmit.calls).toHaveLength(1);
    expect(povSubmit.calls[0]?.side).toBe('sell');
    expect(parentStore.get('parent-pov')?.residual?.remaining).toBe(povLeft);
  });

  it('paper parent refuses — submit is not called', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-paper', kind: 'twap', status: 'paper' }));
    const street = trackingSubmit();
    const out = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-paper',
      ...sliceFields,
      parentStore,
      submit: street.submit,
    });
    expect(out).toMatchObject({ ok: false, reason: 'paper' });
    expect(street.calls).toEqual([]);
  });

  it('staged parent refuses — submit is not called', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-staged', kind: 'twap', status: 'staged' }));
    const street = trackingSubmit();
    const out = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-staged',
      ...sliceFields,
      parentStore,
      submit: street.submit,
    });
    expect(out).toMatchObject({ ok: false, reason: 'staged' });
    expect(street.calls).toEqual([]);
  });

  it('not-live (stopped/expired/undeployed) refuses — submit is not called', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-stop', kind: 'twap', status: 'stopped' }));
    parentStore.seed(live({ parentClientOrderId: 'parent-exp', kind: 'twap', status: 'expired' }));
    parentStore.seed(live({ parentClientOrderId: 'parent-und', kind: 'twap', status: 'undeployed' }));
    const street = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-stop',
        ...sliceFields,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-exp',
        ...sliceFields,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-und',
        ...sliceFields,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(street.calls).toEqual([]);
  });

  it('missing qty refuses — never invents size from duration or slicesPlanned', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        schedule: { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null },
      }),
    );
    const street = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        limitPrice: '100',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        amount: '   ',
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        limitPrice: '100',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        amount: 'not-an-amount',
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        limitPrice: '100',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        amount: '0',
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        limitPrice: '100',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(street.calls).toEqual([]);
  });

  it('missing parent / not_found', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const street = trackingSubmit();
    expect(await sliceLiveAlgoParent({ parentStore, submit: street.submit, ...sliceFields })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: '   ',
        parentStore,
        submit: street.submit,
        ...sliceFields,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'missing',
        parentStore,
        submit: street.submit,
        ...sliceFields,
      }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(street.calls).toEqual([]);
  });

  it('refuses inventing venue or price', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        amount: '0.5',
        symbol: 'BTC/USDT',
        side: 'buy',
        limitPrice: '100',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_venue' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        amount: '0.5',
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_price' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        amount: '0.5',
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        limitPrice: 'not-a-price',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_price' });
    expect(street.calls).toEqual([]);
  });

  it('unwired store / unwired submit', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    expect(await sliceLiveAlgoParent({ parentClientOrderId: 'parent-twap', ...sliceFields })).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'submit_unwired' });
    const unwired: ApprovedAlgoParentStore = {
      get: () => parentStore.get('parent-twap'),
      approve: (parent) => parent,
      start: () => null,
      stop: () => null,
      undeploy: () => null,
      expire: () => null,
    };
    const street = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        parentStore: unwired,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(leftover);
  });

  it('missing residual refuses — never invents leftover from duration or slicesPlanned', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-none', kind: 'twap' }));
    parentStore.seed(live({ parentClientOrderId: 'parent-null', kind: 'twap', residual: null }));
    parentStore.seed(live({ parentClientOrderId: 'parent-empty', kind: 'twap', residual: { remaining: '   ' } }));
    parentStore.seed(live({ parentClientOrderId: 'parent-bad', kind: 'twap', residual: { remaining: 'not-an-amount' } }));
    parentStore.seed(live({ parentClientOrderId: 'parent-released', kind: 'twap', residual: { remaining: leftover, released: true } }));
    const street = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-none',
        ...sliceFields,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-null',
        ...sliceFields,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-empty',
        ...sliceFields,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-bad',
        ...sliceFields,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-released',
        ...sliceFields,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-none')?.residual).toBeUndefined();
  });

  it('slice larger than remaining refuses — leftover unchanged, submit not called', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }, '0.25'));
    const street = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        amount: '0.5',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'exceeds_remaining' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('0.25');
  });

  it('buy limit worse than parentCap refuses — leftover unchanged, submit not called', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        limitPrice: '101',
        parentCap: '100',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'worse_than_cap' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(leftover);
  });

  it('sell limit worse than parentCap refuses — leftover unchanged, submit not called', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-pov', kind: 'pov' }));
    const street = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-pov',
        ...sliceFields,
        side: 'sell',
        limitPrice: '99',
        parentCap: '100',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'worse_than_cap' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-pov')?.residual?.remaining).toBe(leftover);
  });

  it('missing parentCap refuses — never invents ticks', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        amount: '0.5',
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        limitPrice: '100',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_price_cap' });
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        parentCap: 'not-a-cap',
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_price_cap' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(leftover);
  });

  it('buy limit inside parentCap submits; equal cap is not worse', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-sell', kind: 'twap' }));
    const better = trackingSubmit();
    const betterOut = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      limitPrice: '99',
      parentCap: '100',
      parentStore,
      submit: better.submit,
    });
    expect(betterOut).toMatchObject({ ok: true, sliced: true });
    expect(better.calls).toHaveLength(1);
    const sellBetter = trackingSubmit();
    const sellOut = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-sell',
      ...sliceFields,
      side: 'sell',
      limitPrice: '101',
      parentCap: '100',
      parentStore,
      submit: sellBetter.submit,
    });
    expect(sellOut).toMatchObject({ ok: true, sliced: true });
    expect(sellBetter.calls).toHaveLength(1);
  });

  it('exact remaining slice leaves zero leftover', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }, '0.5'));
    const street = trackingSubmit();
    const out = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore,
      submit: street.submit,
    });
    expect(out).toMatchObject({
      ok: true,
      residual: { remaining: formatAmount(parseAmount('0')) },
    });
    expect(street.calls).toHaveLength(1);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(formatAmount(parseAmount('0')));
  });

  it('paused live parent refuses a new child', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const pauseStore = new InMemoryAlgoPauseStore();
    pauseStore.pause({ kind: 'parent', id: 'parent-twap' });
    const street = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        parentStore,
        pauseStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'algo_paused' });
    expect(street.calls).toEqual([]);
  });

  it('submitByVenue uses the named venue once — never a second invented child', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    const other = trackingSubmit();
    const out = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore,
      submitByVenue: { street: street.submit, other: other.submit },
    });
    expect(out.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
    expect(other.calls).toEqual([]);
  });

  it('overlapping slices that both capped the same remaining leave one child and one subtraction', async () => {
    const inner = new InMemoryApprovedAlgoParentStore();
    inner.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }, '10'));
    let reads = 0;
    const parentStore: ApprovedAlgoParentStore = {
      get(id) {
        reads += 1;
        const row = inner.get(id);
        if (!row?.residual || reads > 2) return row;
        return { ...row, residual: { ...row.residual, remaining: '10' } };
      },
      approve: (row) => row,
      start: () => null,
      stop: () => null,
      undeploy: () => null,
      expire: () => null,
      consumeResidual: (id, remaining, expected) => inner.consumeResidual(id, remaining, expected),
    };
    const calls: SubmitRequest[] = [];
    const submit: OmsSubmitFn = async (req) => {
      calls.push(req);
      return ack(req);
    };

    const [first, second] = await Promise.all([
      sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        amount: '6',
        parentStore,
        submit,
      }),
      sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        amount: '7',
        parentStore,
        submit,
      }),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.amount).toBe(parseAmount('6'));
    expect(inner.get('parent-twap')?.residual?.remaining).toBe('4');
    expect(first).toMatchObject({
      ok: true,
      sliced: true,
      residual: { remaining: '4' },
      execution: { status: 'filled', venueOrderId: 'v-slice-1' },
    });
    expect(second.ok).toBe(false);
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('a consume that does not stick does not submit, and no live child is dropped', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }, '10'));
    const refusing: ApprovedAlgoParentStore = {
      get: (id) => parentStore.get(id),
      approve: (row) => row,
      start: () => null,
      stop: () => null,
      undeploy: () => null,
      expire: () => null,
      consumeResidual: () => null,
    };
    const street = trackingSubmit();
    const out = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore: refusing,
      submit: street.submit,
    });
    expect(out).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(out).not.toHaveProperty('execution');
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('10');
  });

  it('puts the previous remaining back when the venue rejects the child, and returns that execution', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }, '10'));
    const calls: SubmitRequest[] = [];
    const submit: OmsSubmitFn = async (req) => {
      calls.push(req);
      return { ...ack(req), status: 'rejected', filledAmount: ZERO };
    };
    const out = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore,
      submit,
    });
    expect(calls).toHaveLength(1);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('10');
    expect(out).toMatchObject({
      ok: true,
      sliced: true,
      execution: { status: 'rejected', venueOrderId: 'v-slice-1' },
      residual: { remaining: '10' },
    });
  });

  it('a rejected slice with a partial fill leaves that fill out of the leftover so the next slice does not submit the old remaining', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }, '10'));
    const calls: SubmitRequest[] = [];
    const submit: OmsSubmitFn = async (req) => {
      calls.push(req);
      return { ...ack(req), status: 'rejected', filledAmount: parseAmount('2') };
    };
    const out = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      amount: '6',
      parentStore,
      submit,
    });
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('8');
    expect(out).toMatchObject({
      ok: true,
      sliced: true,
      execution: { status: 'rejected', filledAmount: parseAmount('2') },
      residual: { remaining: '8' },
    });

    const next = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      amount: '10',
      parentStore,
      submit,
    });
    expect(next).toMatchObject({ ok: false, reason: 'exceeds_remaining' });
    expect(calls.map((call) => call.amount)).toEqual([parseAmount('6')]);
  });

  it('retains the reservation when submit throws after accepting the child', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }, '10'));
    const submit: OmsSubmitFn = async () => {
      throw new Error('venue down');
    };
    await expect(
      sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        parentStore,
        submit,
      }),
    ).rejects.toThrow('venue down');
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('9.5');
    expect(fixtureJournals.get(parentStore)?.list()[0]?.state).toBe('SUBMIT_UNKNOWN');
  });

  it('lost acknowledgement blocks a later child and keeps the original identity', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }, '10'));
    const accepted: SubmitRequest[] = [];
    await expect(
      sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        amount: '6',
        parentStore,
        submit: async (req) => {
          accepted.push(req);
          throw new Error('lost ACK');
        },
      }),
    ).rejects.toThrow('lost ACK');
    const original = fixtureJournals.get(parentStore)!.list()[0]!;
    expect(original.clientOrderId).toBe(accepted[0]!.clientOrderId);
    expect(original.state).toBe('SUBMIT_UNKNOWN');
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('4');
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        amount: '4',
        parentStore,
        submit: async (req) => {
          accepted.push(req);
          return ack(req);
        },
      }),
    ).toMatchObject({ ok: false, reason: 'children_unknown' });
    expect(accepted).toHaveLength(1);
    expect(fixtureJournals.get(parentStore)!.get(original.clientOrderId)?.state).toBe('SUBMIT_UNKNOWN');
  });
});

describe('execution.oms.slice tRPC', () => {
  it('door exists (admin:write) and refuses anonymous slice', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(hmacSigned());
    expect(typeof caller.execution.oms.slice).toBe('function');
    const out = await caller.execution.oms.slice({ parentClientOrderId: 'parent-1', ...sliceFields });
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.slice({ parentClientOrderId: 'parent-1', ...sliceFields })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('slices a live parent through the injected store and submit bridge', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const street = trackingSubmit();
    const caller = createExecutionRouter(
      new SealedHouseTenantRegistry(),
      { street: street.submit },
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      new InMemoryEmsOrderStore(),
      undefined,
      undefined,
      parentStore,
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.slice({
      parentClientOrderId: 'parent-1',
      ...sliceFields,
    });
    const left = formatAmount(sub(parseAmount(leftover), parseAmount('0.5')));
    expect(out).toMatchObject({
      ok: true,
      sliced: true,
      parent: { parentClientOrderId: 'parent-1', kind: 'twap' },
      child: { venueId: 'street' },
      residual: { remaining: left },
    });
    expect(street.calls).toHaveLength(1);
    expect(street.calls[0]?.amount).toBe(parseAmount('0.5'));
    expect(parentStore.get('parent-1')?.status).toBe('approved');
    expect(parentStore.get('parent-1')?.residual?.remaining).toBe(left);
  });
});
