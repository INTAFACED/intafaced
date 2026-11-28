import { describe, expect, it } from 'vitest';
import { createPreviewRouter } from './preview/preview.js';
import { createQuantRouter, type QuantRouterDeps } from './router.js';
import { alertRoutes } from './routes/alert.js';
import { approvalRoutes } from './routes/approval.js';
import { backtestRoutes } from './routes/backtest.js';
import { createQuantCore, type QuantCore } from './routes/core.js';
import { disclosureRoutes } from './routes/disclosure.js';
import { healthRoutes } from './routes/health.js';
import { lakeRoutes } from './routes/lake.js';
import { libraryRoutes } from './routes/library.js';
import { lifecycleRoutes } from './routes/lifecycle.js';
import { limitsRoutes } from './routes/limits.js';
import { liveRoutes } from './routes/live.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { notifyRoutes } from './routes/notify.js';
import { opsRoutes } from './routes/ops.js';
import { paperRoutes } from './routes/paper.js';
import { quickStartRoutes } from './routes/quick-start.js';
import { quotaRoutes } from './routes/quota.js';
import { resultRoutes } from './routes/result.js';
import { riskRoutes } from './routes/risk.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { studioRoutes } from './routes/studio.js';
import { teamRoutes } from './routes/team.js';
import { templateRoutes } from './routes/template.js';
import { tierRoutes } from './routes/tier.js';
import { createMemoryStrategyRepository } from './studio/memory-repository.js';

/**
 * Weed project-state#2731: router.ts held every procedure of every area (4,007 lines), so every algo-dev
 * journey edited it and parallel builds collided there (16 merged PRs in 7 days). Now each area's
 * procedures live in routes/<area>.ts and router.ts only composes the areas: the composed router serves exactly the
 * procedures its area files make, under the area's name, and nothing of its own.
 */
type AnyRouter = { _def: { procedure?: boolean; procedures: Record<string, unknown>; record: Record<string, unknown> } };

const AREAS: Record<string, (core: QuantCore) => unknown> = {
  health: healthRoutes,
  studio: studioRoutes,
  quickStart: quickStartRoutes,
  quota: quotaRoutes,
  limits: limitsRoutes,
  library: libraryRoutes,
  team: teamRoutes,
  notify: notifyRoutes,
  risk: riskRoutes,
  alert: alertRoutes,
  tier: tierRoutes,
  paper: paperRoutes,
  lifecycle: lifecycleRoutes,
  live: liveRoutes,
  backtest: backtestRoutes,
  result: resultRoutes,
  approval: approvalRoutes,
  lake: lakeRoutes,
  sandbox: sandboxRoutes,
  marketplace: marketplaceRoutes,
  template: templateRoutes,
  disclosure: disclosureRoutes,
  ops: opsRoutes,
  preview: () => createPreviewRouter(),
};

const deps: QuantRouterDeps = {
  wired: true,
  venueVaultSet: false,
  limits: { maxOps: 5_000, maxSource: 8_000 },
  strategies: createMemoryStrategyRepository(),
};

/** Every procedure path a router (or one procedure) serves, under the area `name`. */
function paths(r: unknown, name = ''): string[] {
  const def = (r as AnyRouter)._def;
  if (def.procedure) return [name];
  return Object.keys(def.procedures)
    .map((path) => (name ? `${name}.${path}` : path))
    .sort();
}

describe('router.ts only composes the areas', () => {
  const composed = createQuantRouter(deps);

  it("every top-level entry is one area's, none written in router.ts", () => {
    // A procedure written into router.ts is an entry no area file made: put it in its area's file, routes/<area>.ts.
    expect(Object.keys(composed._def.record).sort()).toEqual(Object.keys(AREAS).sort());
  });

  it("serves exactly the procedures its area files make, under each area's name", () => {
    const core = createQuantCore(deps);
    const fromAreas = Object.entries(AREAS)
      .flatMap(([name, area]) => paths(area(core), name))
      .sort();
    expect(fromAreas.length).toBeGreaterThan(Object.keys(AREAS).length);
    expect(paths(composed)).toEqual(fromAreas);
  });
});
