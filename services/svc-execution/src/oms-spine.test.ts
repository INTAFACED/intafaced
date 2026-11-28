import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { createExecutionRouter } from './router.js';
import { describeExecutionSpine, EXECUTION_SPINE_DOORS } from './oms-spine.js';
import { executionSorMountVsTrackerBoardCard, executionSorTrackerBackendDoneBarMet } from './mount-vs-tracker.js';

const SECRET = 'a-execution-spine-test-edge-secret-long-x';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });

/** An operator with `admin:read`, signed the way the edge signs. */
function operator() {
  const raw = encodePrincipal({
    sub: OP,
    userId: OP,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-spine',
  });
}

/** What the router answers on its spine doors, and the procedures it mounts. */
async function mounted() {
  const router = createExecutionRouter(new SealedHouseTenantRegistry());
  const caller = router.createCaller(operator());
  return {
    policy: await caller.execution.policy(),
    spine: await caller.execution.spine(undefined),
    procedures: Object.keys(router._def.procedures),
  };
}

describe('describeExecutionSpine — execution.sor spine catalog', () => {
  it('lists OMS plan, arb scan, and MM doors', () => {
    const spine = describeExecutionSpine();
    expect(spine.externalOnly).toBe(true);
    expect(spine.houseInternalRefuse).toBe(true);
    expect(spine.doors.map((d) => d.id)).toEqual(EXECUTION_SPINE_DOORS.map((d) => d.id));
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
  });

  it('execute door requires caller submit map', () => {
    const execute = describeExecutionSpine().doors.find((d) => d.id === 'execution.oms.execute');
    expect(execute?.callerSubmit).toBe(true);
    expect(execute?.module).toBe('execution.sor');
  });
});

describe('execution.policy route (execution spine honesty door)', () => {
  it('router mounts describeExecutionSpine on execution.policy', async () => {
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D76 denon complete', () => {
  it('spine catalog honesty and mount-vs-tracker cert both green on tip', async () => {
    const spine = describeExecutionSpine();
    expect(spine.externalOnly).toBe(true);
    expect(spine.houseInternalRefuse).toBe(true);
    expect(spine.sorUsesVenueAdapterPlanRoute).toBe(true);
    expect(spine.doors.filter((d) => d.module === 'execution.sor').every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D78 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D80 denon complete', () => {
  it('spine catalog, router mounts, and mount-vs-tracker cert all green on tip', async () => {
    const spine = describeExecutionSpine();
    expect(spine.externalOnly).toBe(true);
    expect(spine.houseInternalRefuse).toBe(true);
    expect(spine.sorUsesVenueAdapterPlanRoute).toBe(true);
    expect(spine.doors.map((d) => d.id)).toEqual(EXECUTION_SPINE_DOORS.map((d) => d.id));
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).procedures).toContain('execution.oms.plan');
    expect((await mounted()).procedures).toContain('execution.oms.execute');
  });
});

describe('execution.sor spine — D82 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D84 denon complete', () => {
  it('spine catalog, router mounts, and mount-vs-tracker cert all green on tip', async () => {
    const spine = describeExecutionSpine();
    expect(spine.externalOnly).toBe(true);
    expect(spine.houseInternalRefuse).toBe(true);
    expect(spine.sorUsesVenueAdapterPlanRoute).toBe(true);
    expect(spine.doors.map((d) => d.id)).toEqual(EXECUTION_SPINE_DOORS.map((d) => d.id));
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).procedures).toContain('execution.oms.plan');
    expect((await mounted()).procedures).toContain('execution.oms.execute');
  });
});

describe('execution.sor spine — D86 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D88 denon complete', () => {
  it('spine catalog, router mounts, and mount-vs-tracker cert all green on tip', async () => {
    const spine = describeExecutionSpine();
    expect(spine.externalOnly).toBe(true);
    expect(spine.houseInternalRefuse).toBe(true);
    expect(spine.sorUsesVenueAdapterPlanRoute).toBe(true);
    expect(spine.doors.map((d) => d.id)).toEqual(EXECUTION_SPINE_DOORS.map((d) => d.id));
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).procedures).toContain('execution.oms.plan');
    expect((await mounted()).procedures).toContain('execution.oms.execute');
  });
});

describe('execution.sor spine — D90 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D92 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D94 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D96 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D98 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D100 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D102 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D104 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D106 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D108 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D110 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D112 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D114 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D116 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D118 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});

describe('execution.sor spine — D120 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', async () => {
    const spine = describeExecutionSpine();
    expect(spine.doors).toEqual(EXECUTION_SPINE_DOORS);
    expect(spine.doors.every((d) => d.inventsQuotes === false)).toBe(true);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect((await mounted()).policy).toEqual(describeExecutionSpine());
    expect((await mounted()).spine).toEqual(describeExecutionSpine());
  });
});
