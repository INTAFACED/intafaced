import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { VenueExecution } from '@intafaced/venue-adapter';
import { InMemoryEmsOrderStore, type EmsOrderStore } from './oms-ems-store.js';
import { confirmChildFill, InMemoryFillConfirmStore, type FillConfirmStore } from './oms-fill-confirm.js';
import {
  InMemoryApprovedAlgoParentStore,
  type ApprovedAlgoParent,
  type ApprovedAlgoParentStore,
  type RetainedAlgoSchedule,
} from './oms-start.js';
import { claimLiveAlgoParent, readLiveAlgoParentOwnership, unclaimLiveAlgoParent } from './oms-claim.js';
import { acceptLiveAlgoParentPass, passLiveAlgoParent, rejectLiveAlgoParentPass, timeoutLiveAlgoParentPass } from './oms-pass.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-pass-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const THIRD = '55555555-5555-4555-8555-555555555555';
const EXPIRE_AT = '2026-08-25T18:00:00.000Z';
const BEFORE = new Date('2026-08-25T17:59:59.000Z');
const AFTER = new Date('2026-08-25T18:00:00.000Z');
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

function live(
  over: Partial<ApprovedAlgoParent> &
    Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'> & {
      schedule?: RetainedAlgoSchedule;
    },
): ApprovedAlgoParent {
  return {
    status: 'approved',
    startedAt: null,
    ...over,
    schedule: over.schedule ?? retainedTwap(),
  };
}

function claimedStore(id = 'parent-twap'): InMemoryApprovedAlgoParentStore {
  const parentStore = new InMemoryApprovedAlgoParentStore();
  parentStore.seed(live({ parentClientOrderId: id, kind: 'twap' }));
  claimLiveAlgoParent({ parentClientOrderId: id, operatorId: OP, parentStore });
  return parentStore;
}

function books() {
  return {
    emsStore: new InMemoryEmsOrderStore(),
    fillConfirmStore: new InMemoryFillConfirmStore(),
  };
}

function execution(over: Partial<VenueExecution> = {}): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: 'v-1',
    filledAmount: parseAmount('0.5'),
    averagePrice: parseAmount('100'),
    feeAmount: ZERO,
    feeAsset: 'USDT',
    status: 'filled',
    executedAt: new Date('2026-08-25T00:00:00.000Z'),
    ...over,
  };
}

function seedFill(
  store: InMemoryEmsOrderStore,
  over: {
    clientOrderId?: string;
    parentClientOrderId?: string;
    state?: 'ACKNOWLEDGED' | 'REJECTED' | 'UNWIRED' | 'SUBMIT_UNKNOWN' | 'OUTCOME_UNKNOWN';
    execution?: VenueExecution | null;
  } = {},
) {
  store.record({
    clientOrderId: over.clientOrderId ?? 'child-1',
    parentClientOrderId: over.parentClientOrderId ?? 'parent-twap',
    executionGroupId: 'parent-twap',
    childOrderId: over.clientOrderId ?? 'child-1',
    legIndex: 0,
    venueId: 'street',
    symbol: 'BTC/USDT',
    side: 'buy',
    execution: over.execution === undefined ? execution() : over.execution,
    state: over.state ?? 'ACKNOWLEDGED',
    reconciliationKey: null,
  });
}

describe('passLiveAlgoParent', () => {
  it('owner pass to named target keeps owner until accept', () => {
    const parentStore = claimedStore();
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        ...books(),
      }),
    ).toMatchObject({
      ok: true,
      passed: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
      executionOwner: OP,
      pendingPassTo: OTHER,
      pendingPassExpireAt: EXPIRE_AT,
    });
    expect(parentStore.get('parent-twap')).toMatchObject({
      executionOwner: OP,
      pendingPassTo: OTHER,
      pendingPassExpireAt: EXPIRE_AT,
    });
    expect(readLiveAlgoParentOwnership({ parentClientOrderId: 'parent-twap', parentStore })).toMatchObject({
      ok: true,
      claimed: true,
      executionOwner: OP,
      pendingPassTo: OTHER,
      pendingPassExpireAt: EXPIRE_AT,
    });
  });

  it('target accept becomes owner; target reject stays with passer', () => {
    const acceptStore = claimedStore('parent-accept');
    const acceptBooks = books();
    passLiveAlgoParent({
      parentClientOrderId: 'parent-accept',
      operatorId: OP,
      targetOperatorId: OTHER,
      expireAt: EXPIRE_AT,
      parentStore: acceptStore,
      ...acceptBooks,
    });
    expect(
      acceptLiveAlgoParentPass({
        parentClientOrderId: 'parent-accept',
        operatorId: OTHER,
        parentStore: acceptStore,
        ...acceptBooks,
      }),
    ).toMatchObject({
      ok: true,
      accepted: true,
      executionOwner: OTHER,
      pendingPassTo: null,
    });
    expect(acceptStore.get('parent-accept')).toMatchObject({
      executionOwner: OTHER,
      pendingPassTo: null,
    });
    expect(claimLiveAlgoParent({ parentClientOrderId: 'parent-accept', operatorId: OP, parentStore: acceptStore })).toMatchObject({
      ok: false,
      reason: 'already_claimed',
    });

    const rejectStore = claimedStore('parent-reject');
    passLiveAlgoParent({
      parentClientOrderId: 'parent-reject',
      operatorId: OP,
      targetOperatorId: OTHER,
      expireAt: EXPIRE_AT,
      parentStore: rejectStore,
      ...books(),
    });
    expect(
      rejectLiveAlgoParentPass({
        parentClientOrderId: 'parent-reject',
        operatorId: OTHER,
        parentStore: rejectStore,
      }),
    ).toMatchObject({
      ok: true,
      rejected: true,
      executionOwner: OP,
      pendingPassTo: null,
    });
    expect(rejectStore.get('parent-reject')).toMatchObject({
      executionOwner: OP,
      pendingPassTo: null,
    });
  });

  it('missing target / operator refuse — never invents a user', () => {
    const parentStore = claimedStore();
    expect(passLiveAlgoParent({ parentClientOrderId: 'parent-twap', operatorId: OP, parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_target',
    });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: '   ',
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_target' });
    expect(passLiveAlgoParent({ parentClientOrderId: 'parent-twap', targetOperatorId: OTHER, parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_operator',
    });
    expect(acceptLiveAlgoParentPass({ parentClientOrderId: 'parent-twap', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_operator',
    });
    expect(rejectLiveAlgoParentPass({ parentClientOrderId: 'parent-twap', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_operator',
    });
    expect(parentStore.get('parent-twap')).toMatchObject({
      executionOwner: OP,
    });
    expect(parentStore.get('parent-twap')?.pendingPassTo).toBeUndefined();
  });

  it('missing expireAt refuses — never invents a night-desk duration', () => {
    const parentStore = claimedStore();
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: '   ',
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: 'not-an-iso',
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(parentStore.get('parent-twap')?.pendingPassTo).toBeUndefined();
    expect(parentStore.get('parent-twap')?.pendingPassExpireAt).toBeUndefined();
  });

  it('non-owner pass / non-target accept-reject refuse — no steal', () => {
    const parentStore = claimedStore();
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OTHER,
        targetOperatorId: THIRD,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_owner' });
    passLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      targetOperatorId: OTHER,
      expireAt: EXPIRE_AT,
      parentStore,
      ...books(),
    });
    expect(
      acceptLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        operatorId: THIRD,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_target' });
    expect(
      acceptLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_target' });
    expect(
      rejectLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        operatorId: THIRD,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_target' });
    expect(parentStore.get('parent-twap')).toMatchObject({
      executionOwner: OP,
      pendingPassTo: OTHER,
    });
  });

  it('unowned / self / already-passing / no-pending / unclaim-during-pass refuse', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'unowned' });

    claimLiveAlgoParent({ parentClientOrderId: 'parent-twap', operatorId: OP, parentStore });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OP,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'self_pass' });

    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        ...books(),
      }),
    ).toMatchObject({ ok: true, pendingPassTo: OTHER, pendingPassExpireAt: EXPIRE_AT });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        ...books(),
      }),
    ).toMatchObject({ ok: true, pendingPassTo: OTHER, pendingPassExpireAt: EXPIRE_AT });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: THIRD,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'already_passing' });
    expect(unclaimLiveAlgoParent({ parentClientOrderId: 'parent-twap', operatorId: OP, parentStore })).toMatchObject({
      ok: false,
      reason: 'pass_pending',
    });
    expect(parentStore.get('parent-twap')?.executionOwner).toBe(OP);

    const idle = claimedStore('parent-idle');
    expect(acceptLiveAlgoParentPass({ parentClientOrderId: 'parent-idle', operatorId: OTHER, parentStore: idle })).toMatchObject({
      ok: false,
      reason: 'no_pass_pending',
    });
    expect(rejectLiveAlgoParentPass({ parentClientOrderId: 'parent-idle', operatorId: OTHER, parentStore: idle })).toMatchObject({
      ok: false,
      reason: 'no_pass_pending',
    });
  });

  it('paper / not-live / missing parent refuse', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-paper', kind: 'twap', status: 'paper', executionOwner: OP }));
    parentStore.seed(live({ parentClientOrderId: 'parent-stop', kind: 'twap', status: 'stopped', executionOwner: OP }));
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-paper',
        operatorId: OP,
        targetOperatorId: OTHER,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'paper' });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-stop',
        operatorId: OP,
        targetOperatorId: OTHER,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(passLiveAlgoParent({ operatorId: OP, targetOperatorId: OTHER, parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'missing',
        operatorId: OP,
        targetOperatorId: OTHER,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('unwired store / missing pass methods', () => {
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
      }),
    ).toMatchObject({ ok: false, reason: 'parent_store_unwired' });
    const unwired: ApprovedAlgoParentStore = {
      get: () => live({ parentClientOrderId: 'parent-twap', kind: 'twap', executionOwner: OP }),
      approve: (parent) => parent,
      start: () => null,
      stop: () => null,
      undeploy: () => null,
      expire: () => null,
    };
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore: unwired,
      }),
    ).toMatchObject({ ok: false, reason: 'parent_store_unwired' });
    const pendingUnwired: ApprovedAlgoParentStore = {
      ...unwired,
      get: () =>
        live({
          parentClientOrderId: 'parent-twap',
          kind: 'twap',
          executionOwner: OP,
          pendingPassTo: OTHER,
        }),
    };
    expect(
      acceptLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        operatorId: OTHER,
        parentStore: pendingUnwired,
      }),
    ).toMatchObject({ ok: false, reason: 'parent_store_unwired' });
    expect(
      rejectLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        operatorId: OTHER,
        parentStore: pendingUnwired,
      }),
    ).toMatchObject({ ok: false, reason: 'parent_store_unwired' });
    expect(
      timeoutLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        parentStore: {
          ...pendingUnwired,
          get: () =>
            live({
              parentClientOrderId: 'parent-twap',
              kind: 'twap',
              executionOwner: OP,
              pendingPassTo: OTHER,
              pendingPassExpireAt: EXPIRE_AT,
            }),
        },
        now: AFTER,
      }),
    ).toMatchObject({ ok: false, reason: 'parent_store_unwired' });
  });

  it('unconfirmed EMS filled|partial refuse pass — ownership stays; empty or confirmed allow pass', () => {
    const parentStore = claimedStore();
    const emsStore = new InMemoryEmsOrderStore();
    const fillConfirmStore = new InMemoryFillConfirmStore();
    seedFill(emsStore, { clientOrderId: 'child-filled' });
    seedFill(emsStore, {
      clientOrderId: 'child-partial',
      execution: execution({ status: 'partial', filledAmount: parseAmount('0.25'), venueOrderId: 'v-partial' }),
    });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        ...books(),
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'unconfirmed_fills' });
    expect(parentStore.get('parent-twap')).toMatchObject({ executionOwner: OP });
    expect(parentStore.get('parent-twap')?.pendingPassTo).toBeUndefined();
    expect(fillConfirmStore.get('child-filled')).toBeNull();
    expect(fillConfirmStore.get('child-partial')).toBeNull();

    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-filled',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
        now: new Date('2026-08-25T12:00:00.000Z'),
      }),
    ).toMatchObject({ ok: true, confirmed: true });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        ...books(),
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'unconfirmed_fills' });

    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-partial',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
        now: new Date('2026-08-25T12:00:01.000Z'),
      }),
    ).toMatchObject({ ok: true, confirmed: true });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        ...books(),
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({
      ok: true,
      passed: true,
      executionOwner: OP,
      pendingPassTo: OTHER,
    });
  });

  it('fill after a clean offer refuses accept — owner stays, pending target stays', () => {
    const parentStore = claimedStore();
    const emsStore = new InMemoryEmsOrderStore();
    const fillConfirmStore = new InMemoryFillConfirmStore();
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({
      ok: true,
      passed: true,
      executionOwner: OP,
      pendingPassTo: OTHER,
      pendingPassExpireAt: EXPIRE_AT,
    });
    seedFill(emsStore, { clientOrderId: 'child-late' });
    expect(
      acceptLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        operatorId: OTHER,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'unconfirmed_fills',
      detail: 'parent parent-twap has unconfirmed EMS child fills — confirm them before accept',
    });
    expect(parentStore.get('parent-twap')).toMatchObject({
      executionOwner: OP,
      pendingPassTo: OTHER,
      pendingPassExpireAt: EXPIRE_AT,
    });
    expect(fillConfirmStore.get('child-late')).toBeNull();
  });

  it('rejected / unknown / no execution / other-parent fills do not block pass', () => {
    const parentStore = claimedStore();
    const emsStore = new InMemoryEmsOrderStore();
    seedFill(emsStore, { clientOrderId: 'unknown-1', execution: null, state: 'SUBMIT_UNKNOWN' });
    seedFill(emsStore, {
      clientOrderId: 'rejected-1',
      execution: execution({ status: 'rejected' }),
      state: 'REJECTED',
    });
    seedFill(emsStore, { clientOrderId: 'other-1', parentClientOrderId: 'parent-other' });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        ...books(),
        emsStore,
        fillConfirmStore: new InMemoryFillConfirmStore(),
      }),
    ).toMatchObject({ ok: true, passed: true, pendingPassTo: OTHER });
  });

  it('unwired ems / fill stores refuse-closed — never invent a confirm', () => {
    const parentStore = claimedStore();
    const emsStore = new InMemoryEmsOrderStore();
    seedFill(emsStore);
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        emsStore: { record: () => undefined, get: () => null, getByReconciliationKey: () => null } as unknown as EmsOrderStore,
      }),
    ).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'fill_store_unwired' });
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        emsStore,
        fillConfirmStore: { confirm: () => null } as unknown as FillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'fill_store_unwired' });
    expect(parentStore.get('parent-twap')?.pendingPassTo).toBeUndefined();
  });
});

describe('timeoutLiveAlgoParentPass', () => {
  it('injected clock past expireAt clears the pass and keeps the passer', () => {
    const parentStore = claimedStore();
    expect(
      passLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
        parentStore,
        ...books(),
      }),
    ).toMatchObject({ ok: true, pendingPassTo: OTHER, pendingPassExpireAt: EXPIRE_AT });
    expect(
      timeoutLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        parentStore,
        now: AFTER,
      }),
    ).toMatchObject({
      ok: true,
      timedOut: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
      executionOwner: OP,
      pendingPassTo: null,
      expireAt: EXPIRE_AT,
    });
    expect(parentStore.get('parent-twap')).toMatchObject({
      executionOwner: OP,
      pendingPassTo: null,
      pendingPassExpireAt: null,
    });
    expect(readLiveAlgoParentOwnership({ parentClientOrderId: 'parent-twap', parentStore })).toMatchObject({
      ok: true,
      claimed: true,
      executionOwner: OP,
      pendingPassTo: null,
      pendingPassExpireAt: null,
    });
    expect(
      acceptLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        operatorId: OTHER,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'no_pass_pending' });
  });

  it('clock before deadline refuses not_due — passer still owner, pass still pending', () => {
    const parentStore = claimedStore();
    passLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      targetOperatorId: OTHER,
      expireAt: EXPIRE_AT,
      parentStore,
      ...books(),
    });
    expect(
      timeoutLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        parentStore,
        now: BEFORE,
      }),
    ).toMatchObject({ ok: false, reason: 'not_due' });
    expect(parentStore.get('parent-twap')).toMatchObject({
      executionOwner: OP,
      pendingPassTo: OTHER,
      pendingPassExpireAt: EXPIRE_AT,
    });
  });

  it('missing clock / missing stored deadline refuse — never invents wall clock or duration', () => {
    const parentStore = claimedStore();
    passLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      targetOperatorId: OTHER,
      expireAt: EXPIRE_AT,
      parentStore,
      ...books(),
    });
    expect(timeoutLiveAlgoParentPass({ parentClientOrderId: 'parent-twap', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_clock',
    });
    expect(
      timeoutLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        parentStore,
        now: new Date('not-a-date'),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_clock' });
    expect(parentStore.get('parent-twap')?.pendingPassTo).toBe(OTHER);

    const legacy = claimedStore('parent-legacy');
    passLiveAlgoParent({
      parentClientOrderId: 'parent-legacy',
      operatorId: OP,
      targetOperatorId: OTHER,
      expireAt: EXPIRE_AT,
      parentStore: legacy,
      ...books(),
    });
    const row = legacy.get('parent-legacy');
    if (row) legacy.seed({ ...row, pendingPassExpireAt: null });
    expect(
      timeoutLiveAlgoParentPass({
        parentClientOrderId: 'parent-legacy',
        parentStore: legacy,
        now: AFTER,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(legacy.get('parent-legacy')).toMatchObject({
      executionOwner: OP,
      pendingPassTo: OTHER,
    });
  });

  it('no pending pass refuses', () => {
    const parentStore = claimedStore();
    expect(
      timeoutLiveAlgoParentPass({
        parentClientOrderId: 'parent-twap',
        parentStore,
        now: AFTER,
      }),
    ).toMatchObject({ ok: false, reason: 'no_pass_pending' });
  });
});

describe('execution.oms.pass tRPC', () => {
  it('door exists (admin:write) and refuses anonymous pass', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(hmacSigned());
    expect(typeof caller.execution.oms.pass).toBe('function');
    expect(typeof caller.execution.oms.accept).toBe('function');
    expect(typeof caller.execution.oms.reject).toBe('function');
    expect(typeof caller.execution.oms.timeoutPass).toBe('function');
    const out = await caller.execution.oms.pass({
      parentClientOrderId: 'parent-1',
      targetOperatorId: OTHER,
      expireAt: EXPIRE_AT,
    });
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(
      router.createCaller(anon).execution.oms.pass({
        parentClientOrderId: 'parent-1',
        targetOperatorId: OTHER,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('owner pass then target accept; other operator cannot steal', async () => {
    const parentStore = claimedStore('parent-1');
    const router = createExecutionRouter(
      new SealedHouseTenantRegistry(),
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
      {},
      new InMemoryEmsOrderStore(),
      undefined,
      undefined,
      parentStore,
    );
    const owner = router.createCaller(hmacSigned());
    const target = router.createCaller(hmacSigned(principal({ sub: OTHER, userId: OTHER })));
    const thief = router.createCaller(hmacSigned(principal({ sub: THIRD, userId: THIRD })));

    expect(
      await owner.execution.oms.pass({
        parentClientOrderId: 'parent-1',
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
      }),
    ).toMatchObject({
      ok: true,
      passed: true,
      executionOwner: OP,
      pendingPassTo: OTHER,
      pendingPassExpireAt: EXPIRE_AT,
    });
    expect(await thief.execution.oms.accept({ parentClientOrderId: 'parent-1' })).toMatchObject({
      ok: false,
      reason: 'not_target',
    });
    expect(await thief.execution.oms.pass({ parentClientOrderId: 'parent-1', targetOperatorId: THIRD })).toMatchObject({
      ok: false,
      reason: 'not_owner',
    });
    expect(await target.execution.oms.accept({ parentClientOrderId: 'parent-1' })).toMatchObject({
      ok: true,
      accepted: true,
      executionOwner: OTHER,
      pendingPassTo: null,
    });
    expect(parentStore.get('parent-1')?.executionOwner).toBe(OTHER);
    expect(await owner.execution.oms.ownership({ parentClientOrderId: 'parent-1' })).toMatchObject({
      ok: true,
      claimed: true,
      executionOwner: OTHER,
      pendingPassTo: null,
    });
  });

  it('target reject keeps passer; signed principal is the actor', async () => {
    const parentStore = claimedStore('parent-1');
    const callerRouter = createExecutionRouter(
      new SealedHouseTenantRegistry(),
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
      {},
      new InMemoryEmsOrderStore(),
      undefined,
      undefined,
      parentStore,
    );
    const owner = callerRouter.createCaller(hmacSigned());
    const target = callerRouter.createCaller(hmacSigned(principal({ sub: OTHER, userId: OTHER })));
    expect(
      await owner.execution.oms.pass({
        parentClientOrderId: 'parent-1',
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
      }),
    ).toMatchObject({
      ok: true,
      pendingPassTo: OTHER,
      pendingPassExpireAt: EXPIRE_AT,
    });
    const rejected = await target.execution.oms.reject({
      parentClientOrderId: 'parent-1',
      operatorId: THIRD,
    } as { parentClientOrderId: string });
    expect(rejected).toMatchObject({ ok: true, rejected: true, executionOwner: OP, pendingPassTo: null });
    expect(parentStore.get('parent-1')?.executionOwner).toBe(OP);
  });

  it('timeoutPass expires a due pass; missing clock and missing expireAt refuse', async () => {
    const parentStore = claimedStore('parent-1');
    const router = createExecutionRouter(
      new SealedHouseTenantRegistry(),
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
      {},
      new InMemoryEmsOrderStore(),
      undefined,
      undefined,
      parentStore,
    );
    const owner = router.createCaller(hmacSigned());
    const target = router.createCaller(hmacSigned(principal({ sub: OTHER, userId: OTHER })));
    expect(await owner.execution.oms.pass({ parentClientOrderId: 'parent-1', targetOperatorId: OTHER })).toMatchObject({
      ok: false,
      reason: 'missing_expire_at',
    });
    expect(
      await owner.execution.oms.pass({
        parentClientOrderId: 'parent-1',
        targetOperatorId: OTHER,
        expireAt: EXPIRE_AT,
      }),
    ).toMatchObject({ ok: true, pendingPassTo: OTHER });
    expect(await owner.execution.oms.timeoutPass({ parentClientOrderId: 'parent-1' })).toMatchObject({
      ok: false,
      reason: 'missing_clock',
    });
    expect(await owner.execution.oms.timeoutPass({ parentClientOrderId: 'parent-1', now: BEFORE })).toMatchObject({
      ok: false,
      reason: 'not_due',
    });
    expect(await owner.execution.oms.timeoutPass({ parentClientOrderId: 'parent-1', now: AFTER })).toMatchObject({
      ok: true,
      timedOut: true,
      executionOwner: OP,
      pendingPassTo: null,
      expireAt: EXPIRE_AT,
    });
    expect(parentStore.get('parent-1')).toMatchObject({
      executionOwner: OP,
      pendingPassTo: null,
      pendingPassExpireAt: null,
    });
    expect(await target.execution.oms.accept({ parentClientOrderId: 'parent-1' })).toMatchObject({
      ok: false,
      reason: 'no_pass_pending',
    });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(
      router.createCaller(anon).execution.oms.timeoutPass({ parentClientOrderId: 'parent-1', now: AFTER }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
