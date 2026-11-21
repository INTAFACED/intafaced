import { router } from '@intafaced/contracts';
import type { CampaignService } from './campaigns.js';
import type { CompetitionService } from './competitions.js';
import type { DistributionService } from './distributions.js';
import type { DrawService } from './draws.js';
import type { DropService } from './drops.js';
import type { PoolService } from './pools.js';
import type { ReferralService } from './referrals.js';
import type { RiskService } from './risk.js';
import type { TaskService } from './tasks.js';
import type { TrialPassService } from './trial-passes.js';
import type { VoucherService } from './vouchers.js';
import type { WatchService } from './watch.js';
import { campaignRoutes } from './routes/campaigns.js';
import { competitionRoutes } from './routes/competitions.js';
import { distributionRoutes } from './routes/distributions.js';
import { drawRoutes } from './routes/draws.js';
import { dropRoutes } from './routes/drops.js';
import { health } from './routes/kit.js';
import { pointsRoutes } from './routes/points.js';
import { poolRoutes } from './routes/pools.js';
import { referralRoutes } from './routes/referrals.js';
import { riskRoutes } from './routes/risk.js';
import { taskRoutes } from './routes/tasks.js';
import { trialPassRoutes } from './routes/trial-passes.js';
import { voucherRoutes } from './routes/vouchers.js';
import { watchRoutes } from './routes/watch.js';

/**
 * The services the router serves, by name. A new service is one more named field here and one in `wiring.ts`, never a
 * position in an argument list.
 */
export interface CampaignServices {
  drops: DropService;
  campaigns: CampaignService;
  tasks: TaskService;
  vouchers: VoucherService;
  watch: WatchService;
  referrals?: ReferralService;
  competitions?: CompetitionService;
  draws?: DrawService;
  distributions?: DistributionService;
  pools?: PoolService;
  trialPasses?: TrialPassService;
  risk?: RiskService;
}

/**
 * svc-campaigns' tRPC router, composed only. Each feature's procedures (its customer doors, its `ops.*` and its
 * `ops.campaigns.*` doors) live in its own `routes/<feature>.ts`; a change to a feature edits that file, and only a new
 * feature adds its line here.
 * `router.test.ts` refuses a procedure written here.
 */
export function createCampaignsRouter(services: CampaignServices) {
  const campaigns = campaignRoutes(services);
  const referrals = referralRoutes(services);
  const competitions = competitionRoutes(services);
  const draws = drawRoutes(services);
  const distributions = distributionRoutes(services);
  const pools = poolRoutes(services);
  const trialPasses = trialPassRoutes(services);
  const tasks = taskRoutes(services);
  const vouchers = voucherRoutes(services);
  const watch = watchRoutes(services);
  const drops = dropRoutes(services);
  const points = pointsRoutes();
  const risk = riskRoutes(services);
  return router({
    health,
    ...campaigns.customer,
    ...referrals.customer,
    ...competitions.customer,
    ...draws.customer,
    ...distributions.customer,
    ...pools.customer,
    ...tasks.customer,
    ...vouchers.customer,
    ...drops.customer,
    ...points.customer,
    ...risk.customer,
    ops: router({
      ...risk.ops,
      campaigns: router({
        ...campaigns.opsCampaigns,
        ...draws.opsCampaigns,
        ...distributions.opsCampaigns,
        ...trialPasses.opsCampaigns,
        ...pools.opsCampaigns,
        ...vouchers.opsCampaigns,
        ...watch.opsCampaigns,
      }),
      ...campaigns.ops,
      ...tasks.ops,
      ...drops.ops,
    }),
  });
}

export type CampaignsRouter = ReturnType<typeof createCampaignsRouter>;
