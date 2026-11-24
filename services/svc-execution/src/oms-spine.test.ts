import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeExecutionSpine, EXECUTION_SPINE_DOORS } from './oms-spine.js';
import { executionSorMountVsTrackerBoardCard, executionSorTrackerBackendDoneBarMet } from './mount-vs-tracker.js';

const here = dirname(fileURLToPath(import.meta.url));
const routerSource = readFileSync(join(here, 'router.ts'), 'utf8');

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
  it('router mounts describeExecutionSpine on execution.policy', () => {
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
  });
});

describe('execution.sor spine — D76 denon complete', () => {
  it('spine catalog honesty and mount-vs-tracker cert both green on tip', () => {
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
    expect(routerSource).toMatch(/describeExecutionSpine/);
  });
});

describe('execution.sor spine — D78 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D80 denon complete', () => {
  it('spine catalog, router mounts, and mount-vs-tracker cert all green on tip', () => {
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
    expect(routerSource).toMatch(/describeExecutionSpine/);
    expect(routerSource).toMatch(/execution\.oms\.plan/);
    expect(routerSource).toMatch(/execution\.oms\.execute/);
  });
});

describe('execution.sor spine — D82 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D84 denon complete', () => {
  it('spine catalog, router mounts, and mount-vs-tracker cert all green on tip', () => {
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
    expect(routerSource).toMatch(/describeExecutionSpine/);
    expect(routerSource).toMatch(/execution\.oms\.plan/);
    expect(routerSource).toMatch(/execution\.oms\.execute/);
  });
});

describe('execution.sor spine — D86 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D88 denon complete', () => {
  it('spine catalog, router mounts, and mount-vs-tracker cert all green on tip', () => {
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
    expect(routerSource).toMatch(/describeExecutionSpine/);
    expect(routerSource).toMatch(/execution\.oms\.plan/);
    expect(routerSource).toMatch(/execution\.oms\.execute/);
  });
});

describe('execution.sor spine — D90 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D92 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D94 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D96 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D98 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D100 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D102 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D104 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D106 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D108 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D110 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D112 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D114 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D116 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D118 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});

describe('execution.sor spine — D120 denon complete', () => {
  it('spine catalog, router policy mount, and mount-vs-tracker cert all green', () => {
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
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeExecutionSpine\(\)\)/);
    expect(routerSource).toMatch(/spine:\s*mountRecord\(EXECUTION_SPINE,/);
  });
});
