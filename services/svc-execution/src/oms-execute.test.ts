import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { SubmitRequest, VenueExecution } from '@intafaced/venue-adapter';
import { executeOmsRoute, type OmsSubmitFn } from './oms-execute.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { InMemoryAlgoPauseStore } from './oms-pause.js';
import { latencyGradeWire, planOmsRoute, type OmsPlanVenue } from './oms-plan.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-execute-test-edge-secret';
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
    amount: '10',
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
  private readonly failWith?: Error;
  private readonly status: VenueExecution['status'];

  constructor(id: string, opts: { failWith?: Error; status?: VenueExecution['status'] } = {}) {
    this.id = id;
    this.failWith = opts.failWith;
    this.status = opts.status ?? 'filled';
  }

  submit: OmsSubmitFn = async (req) => {
    this.calls.push(req);
    if (this.failWith) throw this.failWith;
    return {
      venueId: this.id,
      venueOrderId: `v-${this.id}`,
      filledAmount: req.amount,
      averagePrice: req.limitPrice,
      feeAmount: parseAmount('0'),
      feeAsset: 'USDT',
      status: this.status,
      executedAt: new Date('2026-08-17T00:00:00.000Z'),
    };
  };
}

const venueBody = {
  id: 'street',
  kind: 'external-cex' as const,
  price: '100',
  amount: '10',
  feeBps: 10,
  costTerms: {
    feeBps: 10,
    expectedImpactBps: 5,
    transferCostBps: 2,
    latencyGrade: latencyGradeWire('street'),
  },
};

describe('executeOmsRoute', () => {
  it('calls submit on the chosen venue with decimal-string amounts from the plan', async () => {
    const cheap = new FakeSource('cheap');
    const dear = new FakeSource('dear');
    const emsStore = new InMemoryEmsOrderStore();
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-cheap',
      venues: [completeVenue({ id: 'dear', price: '101' }), completeVenue({ id: 'cheap', price: '100' })],
      submitByVenue: { cheap: cheap.submit, dear: dear.submit },
      emsStore,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.venues.map((v) => v.venueId)).toEqual(['cheap']);
    expect(cheap.calls).toHaveLength(1);
    expect(dear.calls).toHaveLength(0);
    expect(cheap.calls[0]).toMatchObject({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: parseAmount('1'),
      limitPrice: parseAmount('100'),
    });
    expect(result.executions[0]?.venueId).toBe('cheap');
    expect(result.executions[0]?.status).toBe('filled');
  });

  it('records EMS acks when emsStore is wired', async () => {
    const cheap = new FakeSource('cheap');
    const store = new InMemoryEmsOrderStore();
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-ack',
      venues: [completeVenue({ id: 'cheap', price: '100' })],
      submitByVenue: { cheap: cheap.submit },
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.get(result.children[0]!.clientOrderId)?.execution?.venueOrderId).toBe('v-cheap');
  });

  it('executes the internal book leg through the injected OMS adapter', async () => {
    const book = new FakeSource('book');
    const emsStore = new InMemoryEmsOrderStore();
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-book',
      venues: [completeVenue({ id: 'book', price: '90', kind: 'internal' })],
      submitByVenue: { book: book.submit },
      emsStore,
    });
    expect(result.ok).toBe(true);
    expect(book.calls).toHaveLength(1);
  });

  it('refuses a killed house tenant and does not submit', async () => {
    const street = new FakeSource('street');
    const emsStore = new InMemoryEmsOrderStore();
    const registry = new SealedHouseTenantRegistry();
    registry.register('house-1', 'seed');
    registry.kill('house-1', 'seed');
    const result = await executeOmsRoute(
      {
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: '1',
        parentClientOrderId: 'parent-killed',
        tenantId: 'house-1',
        venues: [completeVenue({ id: 'street', price: '100' })],
        submitByVenue: { street: street.submit },
        emsStore,
      },
      registry,
    );
    expect(result).toMatchObject({ ok: false, reason: 'kill_switch' });
    expect(street.calls).toHaveLength(0);
  });

  it('records venue acks in EMS store on successful execute', async () => {
    const emsStore = new InMemoryEmsOrderStore();
    const street = new FakeSource('street');
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-venue-ack',
      venues: [completeVenue({ id: 'street', price: '100' })],
      submitByVenue: { street: street.submit },
      emsStore,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ack = emsStore.get(result.children[0]!.clientOrderId);
    expect(ack?.execution?.venueOrderId).toBe('v-street');
  });

  it('surfaces submit throw as submit_failed, never a filled report', async () => {
    const street = new FakeSource('street', { failWith: new Error('venue 503') });
    const emsStore = new InMemoryEmsOrderStore();
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-503',
      venues: [completeVenue({ id: 'street', price: '100' })],
      submitByVenue: { street: street.submit },
      emsStore,
    });
    expect(result).toMatchObject({ ok: false, reason: 'submit_failed', detail: 'venue 503' });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'submit_failed') return;
    expect('report' in result).toBe(false);
    expect(street.calls).toHaveLength(1);
  });

  it('records a first-leg transport exception as SUBMIT_UNKNOWN and fences retry', async () => {
    const store = new InMemoryEmsOrderStore();
    const venue = new FakeSource('street', { failWith: new Error('connection reset after dispatch') });
    const input = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: '1',
      parentClientOrderId: 'parent-unknown-1',
      executionGroupId: 'group-unknown-1',
      venues: [completeVenue({ id: 'street', price: '100' })],
      submitByVenue: { street: venue.submit },
      emsStore: store,
    };
    const result = await executeOmsRoute(input);
    expect(result).toMatchObject({ ok: false, outcome: 'OUTCOME_UNKNOWN', state: 'SUBMIT_UNKNOWN' });
    if (result.ok || result.reason !== 'submit_failed') return;
    expect(result.executions).toHaveLength(0);
    expect(result.children).toMatchObject([{ outcome: 'OUTCOME_UNKNOWN', state: 'SUBMIT_UNKNOWN' }]);
    expect(result.reconciliationKey).toBe(`lookup:${result.children[0]!.clientOrderId}`);
    expect(store.get(result.children[0]!.clientOrderId)?.commandOutcome?.outcome).toBe('OUTCOME_UNKNOWN');

    const retryVenue = new FakeSource('street');
    const retry = await executeOmsRoute({ ...input, submitByVenue: { street: retryVenue.submit } });
    expect(retry).toMatchObject({ ok: false, outcome: 'OUTCOME_UNKNOWN', state: 'SUBMIT_UNKNOWN' });
    expect(retryVenue.calls).toHaveLength(0);
  });

  it('fences an idempotent retry when a child drain is already CANCELED and keeps the stored execution', async () => {
    const street = new FakeSource('street');
    const store = new InMemoryEmsOrderStore();
    const input = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: '1',
      parentClientOrderId: 'parent-canceled-retry',
      executionGroupId: 'group-canceled-retry',
      venues: [completeVenue({ id: 'street', price: '100' })],
      submitByVenue: { street: street.submit },
      emsStore: store,
    };
    const first = await executeOmsRoute(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const clientOrderId = first.children[0]!.clientOrderId;
    const stored = store.get(clientOrderId);
    expect(stored?.execution?.venueOrderId).toBe('v-street');
    expect(stored?.execution?.status).toBe('filled');
    store.record({ ...stored!, state: 'CANCELED' });

    const retry = await executeOmsRoute(input);
    expect(retry).toMatchObject({ ok: false, reason: 'submit_failed', outcome: 'OUTCOME_UNKNOWN' });
    if (retry.ok || retry.reason !== 'submit_failed') return;
    expect(retry.children[0]).toMatchObject({
      outcome: 'OUTCOME_UNKNOWN',
      state: 'CANCELED',
      clientOrderId,
    });
    expect(retry.children[0]?.execution).toEqual(stored!.execution);
    expect(street.calls).toHaveLength(1);
    expect(store.get(clientOrderId)?.state).toBe('CANCELED');
    expect(store.get(clientOrderId)?.execution?.venueOrderId).toBe('v-street');
  });

  it('retains the completed first leg when a later leg is unknown', async () => {
    const store = new InMemoryEmsOrderStore();
    const first = new FakeSource('first');
    const second = new FakeSource('second', { failWith: new Error('venue timeout') });
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '2',
      parentClientOrderId: 'parent-unknown-2',
      executionGroupId: 'group-unknown-2',
      venues: [completeVenue({ id: 'first', price: '100', amount: '1' }), completeVenue({ id: 'second', price: '100', amount: '1' })],
      submitByVenue: { first: first.submit, second: second.submit },
      emsStore: store,
    });
    expect(result).toMatchObject({ ok: false, outcome: 'OUTCOME_UNKNOWN' });
    if (result.ok || result.reason !== 'submit_failed') return;
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.venueId).toBe('first');
    expect(result.children.map((child) => child.outcome)).toEqual(['APPLIED', 'OUTCOME_UNKNOWN']);
    expect(result.children[1]?.reconciliationKey).toMatch(/^lookup:/);
  });

  it('reports a venue rejection as refusal while retaining its rejected execution', async () => {
    const venue = new FakeSource('street', { status: 'rejected' });
    const emsStore = new InMemoryEmsOrderStore();
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-rejected',
      venues: [completeVenue({ id: 'street', price: '100' })],
      submitByVenue: { street: venue.submit },
      emsStore,
    });
    expect(result).toMatchObject({ ok: false, outcome: 'REFUSED', state: 'ENGINE_REJECTED' });
    if (result.ok || result.reason !== 'submit_failed') return;
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.status).toBe('rejected');
    expect(result.commandOutcome.outcome).toBe('REFUSED');
  });

  it('reports an unwired later venue and keeps the earlier child execution', async () => {
    const first = new FakeSource('first');
    const emsStore = new InMemoryEmsOrderStore();
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '2',
      parentClientOrderId: 'parent-unwired',
      venues: [completeVenue({ id: 'first', price: '100', amount: '1' }), completeVenue({ id: 'later', price: '100', amount: '1' })],
      submitByVenue: { first: first.submit },
      emsStore,
    });
    expect(result).toMatchObject({ ok: false, outcome: 'REFUSED' });
    if (result.ok || result.reason !== 'submit_failed') return;
    expect(result.executions).toHaveLength(1);
    expect(result.children.map((child) => child.outcome)).toEqual(['APPLIED', 'UNWIRED']);
    expect(result.children[1]?.execution).toBeNull();
  });

  it('keeps legs already submitted when a later leg finds the algo paused', async () => {
    const pauseStore = new InMemoryAlgoPauseStore();
    const emsStore = new InMemoryEmsOrderStore();
    const first = new FakeSource('first');
    const later = new FakeSource('later');
    const parentClientOrderId = 'parent-pause-later';
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '2',
      parentClientOrderId,
      executionGroupId: 'group-pause-later',
      venues: [completeVenue({ id: 'first', price: '100', amount: '1' }), completeVenue({ id: 'later', price: '100', amount: '1' })],
      submitByVenue: {
        first: async (req) => {
          const execution = await first.submit(req);
          pauseStore.pause({ kind: 'parent', id: parentClientOrderId });
          return execution;
        },
        later: later.submit,
      },
      emsStore,
      pauseStore,
    });
    expect(result).toMatchObject({ ok: false, reason: 'algo_paused' });
    expect(later.calls).toHaveLength(0);
    expect(first.calls).toHaveLength(1);
    if (result.ok || result.reason !== 'algo_paused') return;
    expect(result.executions).toEqual([
      {
        venueId: 'first',
        venueOrderId: 'v-first',
        filledAmount: parseAmount('1'),
        averagePrice: parseAmount('100'),
        feeAmount: parseAmount('0'),
        feeAsset: 'USDT',
        status: 'filled',
        executedAt: new Date('2026-08-17T00:00:00.000Z'),
      },
    ]);
    expect(result.children).toMatchObject([{ venueId: 'first', outcome: 'APPLIED', execution: result.executions[0] }]);
    expect(emsStore.get(result.children[0]!.clientOrderId)?.execution?.venueOrderId).toBe('v-first');
  });

  it('binds deterministic child IDs to the parent and prevents venue collisions', async () => {
    const a = new FakeSource('same-venue');
    const b = new FakeSource('same-venue');
    const common = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: '1',
      venues: [completeVenue({ id: 'same-venue', price: '100' })],
    };
    const firstStore = new InMemoryEmsOrderStore();
    const secondStore = new InMemoryEmsOrderStore();
    const first = await executeOmsRoute({
      ...common,
      parentClientOrderId: 'parent-a',
      submitByVenue: { 'same-venue': a.submit },
      emsStore: firstStore,
    });
    const second = await executeOmsRoute({
      ...common,
      parentClientOrderId: 'parent-b',
      submitByVenue: { 'same-venue': b.submit },
      emsStore: secondStore,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.children[0]?.clientOrderId).not.toBe(second.children[0]?.clientOrderId);
    expect(first.children[0]?.clientOrderId).toContain('parent-a');
    const retryStore = new InMemoryEmsOrderStore();
    const firstRetry = await executeOmsRoute({
      ...common,
      parentClientOrderId: 'parent-a',
      submitByVenue: { 'same-venue': a.submit },
      emsStore: retryStore,
    });
    expect(firstRetry.ok).toBe(true);
    if (!firstRetry.ok) return;
    const beforeSecondRetry = b.calls.length;
    const secondRetry = await executeOmsRoute({
      ...common,
      parentClientOrderId: 'parent-a',
      submitByVenue: { 'same-venue': b.submit },
      emsStore: retryStore,
    });
    expect(secondRetry.ok).toBe(true);
    expect(b.calls).toHaveLength(beforeSecondRetry);
  });

  it('refuses a missing caller identity and a conflicting retry before submit', async () => {
    const venue = new FakeSource('same-venue');
    const store = new InMemoryEmsOrderStore();
    const missing = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      venues: [completeVenue({ id: 'same-venue', price: '100' })],
      submitByVenue: { 'same-venue': venue.submit },
      emsStore: store,
    });
    expect(missing).toMatchObject({ ok: false, reason: 'missing_identity' });
    expect(venue.calls).toHaveLength(0);

    const first = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'conflict-parent',
      venues: [completeVenue({ id: 'same-venue', price: '100' })],
      submitByVenue: { 'same-venue': venue.submit },
      emsStore: store,
    });
    expect(first.ok).toBe(true);
    const before = venue.calls.length;
    const conflict = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'sell',
      amount: '1',
      parentClientOrderId: 'conflict-parent',
      venues: [completeVenue({ id: 'same-venue', price: '100' })],
      submitByVenue: { 'same-venue': venue.submit },
      emsStore: store,
    });
    expect(conflict).toMatchObject({ ok: false, reason: 'identity_conflict' });
    expect(venue.calls).toHaveLength(before);
  });

  it('refuses an overlapping execute with the same parent and a different side', async () => {
    const buyVenue = new FakeSource('street');
    const sellVenue = new FakeSource('street');
    const store = new InMemoryEmsOrderStore();
    const shared = {
      symbol: 'BTC/USDT',
      amount: '1',
      parentClientOrderId: 'parent-overlap',
      executionGroupId: 'group-overlap',
      venues: [completeVenue({ id: 'street', price: '100' })],
      emsStore: store,
    };
    const buyPromise = executeOmsRoute({
      ...shared,
      side: 'buy',
      submitByVenue: { street: buyVenue.submit },
    });
    const sellPromise = executeOmsRoute({
      ...shared,
      side: 'sell',
      submitByVenue: { street: sellVenue.submit },
    });
    const [buyResult, sellResult] = await Promise.all([buyPromise, sellPromise]);
    const results = [buyResult, sellResult];
    const successes = results.filter((result) => result.ok);
    const conflicts = results.filter((result) => !result.ok && result.reason === 'identity_conflict');

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ ok: false, reason: 'identity_conflict', executions: [] });
    expect(buyVenue.calls.length + sellVenue.calls.length).toBe(1);
    if (buyVenue.calls.length === 1) {
      expect(buyVenue.calls[0]?.side).toBe('buy');
      expect(sellVenue.calls).toHaveLength(0);
      expect(buyResult.ok).toBe(true);
    } else {
      expect(sellVenue.calls[0]?.side).toBe('sell');
      expect(buyVenue.calls).toHaveLength(0);
      expect(sellResult.ok).toBe(true);
    }
  });
});

describe('plan door still does not submit', () => {
  it('planOmsRoute never calls an injected submit', async () => {
    const street = new FakeSource('street');
    const result = await planOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      venues: [completeVenue({ id: 'street', price: '100' })],
    });
    expect(result.ok).toBe(true);
    expect(street.calls).toHaveLength(0);
  });
});

describe('execution.oms.execute tRPC', () => {
  it('refuses anonymous execute', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(
      router.createCaller(anon).execution.oms.execute({
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: '1',
        venues: [venueBody],
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('submits the planned venue through the injected map', async () => {
    const street = new FakeSource('street');
    const emsStore = new InMemoryEmsOrderStore();
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
      emsStore,
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.execute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'router-parent',
      venues: [venueBody],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.executions[0]?.venueId).toBe('street');
    expect(street.calls).toHaveLength(1);
  });

  it('plan caller still does not submit', async () => {
    const street = new FakeSource('street');
    const caller = createExecutionRouter(new SealedHouseTenantRegistry(), { street: street.submit }).createCaller(hmacSigned());
    const out = await caller.execution.oms.plan({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      venues: [venueBody],
    });
    expect(out.ok).toBe(true);
    expect(street.calls).toHaveLength(0);
  });
});
