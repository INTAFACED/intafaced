import { router } from '@intafaced/contracts';
import { createPreviewRouter } from './preview/preview.js';
import { createQuantCore, type QuantRouterDeps } from './routes/core.js';
import { healthRoutes } from './routes/health.js';
import { studioRoutes } from './routes/studio.js';
import { quickStartRoutes } from './routes/quick-start.js';
import { quotaRoutes } from './routes/quota.js';
import { limitsRoutes } from './routes/limits.js';
import { libraryRoutes } from './routes/library.js';
import { teamRoutes } from './routes/team.js';
import { notifyRoutes } from './routes/notify.js';
import { riskRoutes } from './routes/risk.js';
import { alertRoutes } from './routes/alert.js';
import { tierRoutes } from './routes/tier.js';
import { paperRoutes } from './routes/paper.js';
import { lifecycleRoutes } from './routes/lifecycle.js';
import { liveRoutes } from './routes/live.js';
import { backtestRoutes } from './routes/backtest.js';
import { resultRoutes } from './routes/result.js';
import { approvalRoutes } from './routes/approval.js';
import { lakeRoutes } from './routes/lake.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { templateRoutes } from './routes/template.js';
import { disclosureRoutes } from './routes/disclosure.js';
import { opsRoutes } from './routes/ops.js';

export type { QuantRouterDeps } from './routes/core.js';

/**
 * svc-quant's tRPC router: only the composition of its areas.
 * A procedure lives in its area's file under routes/; a new area is a new file there and one line here.
 * router.shape.test.ts keeps this file that way.
 */
export function createQuantRouter(deps: QuantRouterDeps) {
  const core = createQuantCore(deps);
  return router({
    health: healthRoutes(core),
    studio: studioRoutes(core),
    quickStart: quickStartRoutes(core),
    quota: quotaRoutes(core),
    limits: limitsRoutes(core),
    library: libraryRoutes(core),
    team: teamRoutes(core),
    notify: notifyRoutes(core),
    risk: riskRoutes(core),
    alert: alertRoutes(core),
    tier: tierRoutes(core),
    paper: paperRoutes(core),
    lifecycle: lifecycleRoutes(core),
    live: liveRoutes(core),
    backtest: backtestRoutes(core),
    result: resultRoutes(core),
    approval: approvalRoutes(core),
    lake: lakeRoutes(core),
    sandbox: sandboxRoutes(core),
    marketplace: marketplaceRoutes(core),
    template: templateRoutes(core),
    disclosure: disclosureRoutes(core),
    preview: createPreviewRouter(),
    ops: opsRoutes(core),
  });
}

export type QuantRouter = ReturnType<typeof createQuantRouter>;
