import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { SubmitRequest, VenueExecution } from '@intafaced/venue-adapter';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { executeOmsRoute, type OmsSubmitFn } from './oms-execute.js';
import { InMemoryAlgoPauseStore, pauseInFlightAlgo } from './oms-pause.js';
import { resumeInFlightAlgo } from './oms-resume.js';
import { createExecutionRouter } from './router.js';
import { latencyGradeWire, type OmsPlanVenue } from './oms-plan.js';

const SECRET = 'a-execution-oms-resume-test-edge-secret';
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

function completeVenue(over: Partial<OmsPlanVenue> & Pick<OmsPlanVenue, 'id' | 'price'>): OmsPlanVenue {
  return {
    kind: 'external-cex',
    amount: '1',
    feeBps: 10,
    costTerms: {
      feeBps: 10,
      expectedImpactBps: 5,
      transferCostBps: 2,
      latencyGrade: latencyGradeWire(over.id),
    },
    ...over,
  };
}

class FakeSource {
  readonly calls: SubmitRequest[] = [];
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  submit: OmsSubmitFn = async (req) => {
    this.calls.push(req);
    return {
      venueId: this.id,
      venueOrderId: `v-${this.id}`,
      filledAmount: req.amount,
      averagePrice: req.limitPrice,
      feeAmount: parseAmount('0'),
      feeAsset: 'USDT',
      status: 'partial',
      executedAt: new Date('2026-08-25T00:00:00.000Z'),
    };
  };
}

function execution(over: Partial<VenueExecution> = {}): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: 'v-1',
    filledAmount: ZERO,
    averagePrice: parseAmount('100'),
    feeAmount: ZERO,
    feeAsset: 'USDT',
    status: 'partial',
    executedAt: new Date('2026-08-25T00:00:00.000Z'),
    ...over,
  };
}

function seedAck(
  store: InMemoryEmsOrderStore,
  over: {
    clientOrderId?: string;
    parentClientOrderId?: string;
    executionGroupId?: string;
    venueId?: string;
    state?: 'ACKNOWLEDGED' | 'REJECTED' | 'UNWIRED' | 'SUBMIT_UNKNOWN' | 'OUTCOME_UNKNOWN';
    execution?: VenueExecution | null;
  } = {},
) {
  store.record({
    clientOrderId: over.clientOrderId ?? 'child-1',
    parentClientOrderId: over.parentClientOrderId ?? 'parent-1',
    executionGroupId: over.executionGroupId ?? 'algo-1',
    childOrderId: over.clientOrderId ?? 'child-1',
    legIndex: 0,
    venueId: over.venueId ?? 'street',
    symbol: 'BTC/USDT',
    side: 'buy',
    execution: over.execution === undefined ? null : over.execution,
    state: over.state ?? 'ACKNOWLEDGED',
    reconciliationKey: null,
  });
}

describe('resumeInFlightAlgo', () => {
  it('resumes a paused parent — child stays, never canceled', () => {
    const store = new InMemoryEmsOrderStore();
    const pauseStore = new InMemoryAlgoPauseStore();
    seedAck(store);
    expect(pauseInFlightAlgo({ parentClientOrderId: 'parent-1', emsStore: store, pauseStore }).ok).toBe(true);
    const result = resumeInFlightAlgo({
      parentClientOrderId: 'parent-1',
      emsStore: store,
      pauseStore,
    });
    expect(result).toMatchObject({
      ok: true,
      algo: { parentClientOrderId: 'parent-1' },
      paused: false,
    });
    if (!result.ok) return;
    expect(result.children).toEqual([{ clientOrderId: 'child-1', venueId: 'street', outcome: 'unknown', reason: 'ACKNOWLEDGED' }]);
    expect(result.children.some((c) => c.status === 'canceled')).toBe(false);
    expect(pauseStore.isPaused({ parentClientOrderId: 'parent-1' })).toBe(false);
  });

  it('resumes by execution group — does not resume another algo', () => {
    const store = new InMemoryEmsOrderStore();
    const pauseStore = new InMemoryAlgoPauseStore();
    seedAck(store, { executionGroupId: 'algo-1' });
    seedAck(store, { clientOrderId: 'child-other', parentClientOrderId: 'parent-2', executionGroupId: 'algo-2' });
    expect(pauseInFlightAlgo({ executionGroupId: 'algo-1', emsStore: store, pauseStore }).ok).toBe(true);
    expect(pauseInFlightAlgo({ executionGroupId: 'algo-2', emsStore: store, pauseStore }).ok).toBe(true);
    const result = resumeInFlightAlgo({
      executionGroupId: 'algo-1',
      emsStore: store,
      pauseStore,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children.map((c) => c.clientOrderId)).toEqual(['child-1']);
    expect(pauseStore.isPaused({ executionGroupId: 'algo-1' })).toBe(false);
    expect(pauseStore.isPaused({ executionGroupId: 'algo-2' })).toBe(true);
  });

  it('refuses both or neither algo identity', () => {
    const store = new InMemoryEmsOrderStore();
    const pauseStore = new InMemoryAlgoPauseStore();
    expect(resumeInFlightAlgo({ emsStore: store, pauseStore })).toMatchObject({ ok: false, reason: 'missing_algo' });
    expect(resumeInFlightAlgo({ parentClientOrderId: 'p', executionGroupId: 'g', emsStore: store, pauseStore })).toMatchObject({
      ok: false,
      reason: 'ambiguous_algo',
    });
  });

  it('refuses an algo that is not paused — does not invent a resume', () => {
    const store = new InMemoryEmsOrderStore();
    const pauseStore = new InMemoryAlgoPauseStore();
    seedAck(store);
    expect(resumeInFlightAlgo({ parentClientOrderId: 'parent-1', emsStore: store, pauseStore })).toMatchObject({
      ok: false,
      reason: 'not_paused',
    });
    expect(pauseStore.isPaused({ parentClientOrderId: 'parent-1' })).toBe(false);
  });

  it('second resume is not_paused — still no cancel', () => {
    const store = new InMemoryEmsOrderStore();
    const pauseStore = new InMemoryAlgoPauseStore();
    seedAck(store);
    expect(pauseInFlightAlgo({ parentClientOrderId: 'parent-1', emsStore: store, pauseStore }).ok).toBe(true);
    expect(resumeInFlightAlgo({ parentClientOrderId: 'parent-1', emsStore: store, pauseStore }).ok).toBe(true);
    expect(resumeInFlightAlgo({ parentClientOrderId: 'parent-1', emsStore: store, pauseStore })).toMatchObject({
      ok: false,
      reason: 'not_paused',
    });
  });

  it('an acknowledged child whose execution is rejected is already stopped', () => {
    const store = new InMemoryEmsOrderStore();
    const pauseStore = new InMemoryAlgoPauseStore();
    seedAck(store, {
      clientOrderId: 'child-rejected',
      state: 'ACKNOWLEDGED',
      execution: execution({ status: 'rejected', venueOrderId: 'v-rej' }),
    });
    seedAck(store, { clientOrderId: 'child-null', state: 'ACKNOWLEDGED' });
    seedAck(store, { clientOrderId: 'child-submit', state: 'SUBMIT_UNKNOWN' });
    seedAck(store, { clientOrderId: 'child-outcome', state: 'OUTCOME_UNKNOWN' });
    seedAck(store, {
      clientOrderId: 'child-filled',
      execution: execution({ status: 'filled', venueOrderId: 'v-filled' }),
    });
    seedAck(store, {
      clientOrderId: 'child-partial',
      execution: execution({ status: 'partial', venueOrderId: 'v-partial' }),
    });
    seedAck(store, { clientOrderId: 'child-state-rejected', state: 'REJECTED' });
    seedAck(store, { clientOrderId: 'child-unwired', state: 'UNWIRED' });
    expect(pauseInFlightAlgo({ parentClientOrderId: 'parent-1', emsStore: store, pauseStore }).ok).toBe(true);
    const result = resumeInFlightAlgo({
      parentClientOrderId: 'parent-1',
      emsStore: store,
      pauseStore,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children).toEqual([
      { clientOrderId: 'child-rejected', venueId: 'street', outcome: 'already_stopped', status: 'rejected' },
      { clientOrderId: 'child-null', venueId: 'street', outcome: 'unknown', reason: 'ACKNOWLEDGED' },
      { clientOrderId: 'child-submit', venueId: 'street', outcome: 'unknown', reason: 'SUBMIT_UNKNOWN' },
      { clientOrderId: 'child-outcome', venueId: 'street', outcome: 'unknown', reason: 'OUTCOME_UNKNOWN' },
      { clientOrderId: 'child-filled', venueId: 'street', outcome: 'live', status: 'filled' },
      { clientOrderId: 'child-partial', venueId: 'street', outcome: 'live', status: 'partial' },
      { clientOrderId: 'child-state-rejected', venueId: 'street', outcome: 'already_stopped', reason: 'REJECTED' },
      { clientOrderId: 'child-unwired', venueId: 'street', outcome: 'already_stopped', reason: 'UNWIRED' },
    ]);
  });

  it('missing EMS or pause store is refused', () => {
    const store = new InMemoryEmsOrderStore();
    const pauseStore = new InMemoryAlgoPauseStore();
    expect(resumeInFlightAlgo({ parentClientOrderId: 'parent-1', pauseStore })).toMatchObject({
      ok: false,
      reason: 'ems_store_unwired',
    });
    expect(resumeInFlightAlgo({ parentClientOrderId: 'parent-1', emsStore: store })).toMatchObject({
      ok: false,
      reason: 'pause_store_unwired',
    });
  });
});

describe('resumed algo may take new children', () => {
  it('execute takes a new child after resume and does not cancel', async () => {
    const store = new InMemoryEmsOrderStore();
    const pauseStore = new InMemoryAlgoPauseStore();
    const street = new FakeSource('street');
    expect(pauseInFlightAlgo({ parentClientOrderId: 'parent-resume', emsStore: store, pauseStore }).ok).toBe(true);
    const paused = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-resume',
      venues: [completeVenue({ id: 'street', price: '100' })],
      submitByVenue: { street: street.submit },
      emsStore: store,
      pauseStore,
    });
    expect(paused).toMatchObject({ ok: false, reason: 'algo_paused' });
    expect(street.calls).toHaveLength(0);

    const resumed = resumeInFlightAlgo({
      parentClientOrderId: 'parent-resume',
      emsStore: store,
      pauseStore,
    });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.children.some((c) => c.status === 'canceled')).toBe(false);

    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-resume',
      venues: [completeVenue({ id: 'street', price: '100' })],
      submitByVenue: { street: street.submit },
      emsStore: store,
      pauseStore,
    });
    expect(result.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
  });
});

describe('execution.oms.resume tRPC', () => {
  it('refuses anonymous resume', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.resume({ parentClientOrderId: 'parent-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('resumes through the injected stores and execute takes new', async () => {
    const store = new InMemoryEmsOrderStore();
    const pauseStore = new InMemoryAlgoPauseStore();
    const street = new FakeSource('street');
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
      store,
      undefined,
      pauseStore,
    ).createCaller(hmacSigned());
    const paused = await caller.execution.oms.pause({ parentClientOrderId: 'parent-slice' });
    expect(paused).toMatchObject({ ok: true, paused: true });
    const blocked = await caller.execution.oms.execute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-slice',
      venues: [
        {
          id: 'street',
          kind: 'external-cex',
          price: '100',
          amount: '1',
          feeBps: 10,
          costTerms: {
            feeBps: 10,
            expectedImpactBps: 5,
            transferCostBps: 2,
            latencyGrade: latencyGradeWire('street'),
          },
        },
      ],
    });
    expect(blocked).toMatchObject({ ok: false, reason: 'algo_paused' });
    expect(street.calls).toHaveLength(0);

    const out = await caller.execution.oms.resume({ parentClientOrderId: 'parent-slice' });
    expect(out).toMatchObject({ ok: true, paused: false });
    const exec = await caller.execution.oms.execute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-slice',
      venues: [
        {
          id: 'street',
          kind: 'external-cex',
          price: '100',
          amount: '1',
          feeBps: 10,
          costTerms: {
            feeBps: 10,
            expectedImpactBps: 5,
            transferCostBps: 2,
            latencyGrade: latencyGradeWire('street'),
          },
        },
      ],
    });
    expect(exec.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
  });
});
