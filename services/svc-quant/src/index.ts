import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext } from '@intafaced/contracts';
import { missingLake } from './backtest/lake.js';
import { missingFees, missingHistory, tradeFeePort, tradeHistoryPort } from './engine/ports.js';
import { openDisclosureRepository } from './disclosure/open.js';
import { openShareRepository } from './share/open.js';
import { openTemplateRepository } from './templates/open.js';
import { openQuotaStore } from './quota/open.js';
import { postgresQuotaHold } from './quota/postgres-store.js';
import { env } from './env.js';
import { quantReadyHonesty } from './ready-honesty.js';
import { createQuantRouter } from './router.js';
import { openRunRepository } from './runs/open.js';
import { openStrategyRepository } from './studio/open.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';

registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-quant — sandboxed strategy runtime (§29).
 *
 * Paper book — no INTERNAL_SERVICE_SECRET. Saved strategies are keyed by the
 * session account in Postgres when DATABASE_URL and DATABASE_POOL_MAX are set.
 * Otherwise studio and backtest refuse by naming the missing key.
 * That is not a certified non-custodial plane.
 * Isolate is the restricted VM in ./sandbox — user code never reaches Node
 * eval, fetch, or the network. Unwired → named refuse, never a fake PnL.
 */
const isolateWired = true;
const lake = missingLake();
const history = env.TRADE_URL ? tradeHistoryPort({ tradeUrl: env.TRADE_URL, now: () => Date.now() }) : missingHistory();
const fees = env.TRADE_URL ? tradeFeePort({ tradeUrl: env.TRADE_URL }) : missingFees();
const venueVaultSet = env.QUANT_VENUE_VAULT !== undefined;
// Quotas by plan (AL-limits-01): every new strategy, version and run is counted against the account's profile in the
// transaction that writes it. The default profile is the owner's; blank refuses every create of an unassigned account.
const defaultQuotaProfile = env.QUANT_DEFAULT_QUOTA_PROFILE ?? null;
const quotaHold = postgresQuotaHold('quant', defaultQuotaProfile);
const strategies = openStrategyRepository({ DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX }, quotaHold);
const runs = openRunRepository({ DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX }, quotaHold);
const quota = openQuotaStore({ DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX }, defaultQuotaProfile);
const disclosure = openDisclosureRepository({ DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX });
const templates = openTemplateRepository({ DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX });
const shares = openShareRepository({ DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX });

function embedOrigins(raw: string | undefined): readonly string[] | null {
  if (!raw) return null;
  const origins = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return origins.length === 0 ? null : origins;
}

export const appRouter = createQuantRouter({
  wired: isolateWired,
  venueVaultSet,
  limits: { maxOps: env.SANDBOX_MAX_OPS, maxSource: env.SANDBOX_MAX_SOURCE },
  lake,
  history,
  fees,
  judgement: {
    criteria: {
      minTrades: env.QUANT_OOS_MIN_TRADES ?? null,
      minReturnPercent: env.QUANT_OOS_MIN_RETURN_PERCENT ?? null,
      maxDrawdownPercent: env.QUANT_OOS_MAX_DRAWDOWN_PERCENT ?? null,
      maxShortfallPercent: env.QUANT_OOS_MAX_SHORTFALL_PERCENT ?? null,
    },
    holdoutStart: env.QUANT_HOLDOUT_START ?? null,
    checks: {
      maxSampleGapPercent: env.QUANT_CHECK_MAX_SAMPLE_GAP_PERCENT ?? null,
      maxVariants: env.QUANT_CHECK_MAX_VARIANTS ?? null,
      maxOffsetShiftPercent: env.QUANT_CHECK_MAX_OFFSET_SHIFT_PERCENT ?? null,
    },
    account: {
      mode: 'netting',
      maxLeverage: env.QUANT_ACCOUNT_MAX_LEVERAGE ?? null,
      marginCallPercent: env.QUANT_ACCOUNT_MARGIN_CALL_PERCENT ?? null,
      stopOutPercent: env.QUANT_ACCOUNT_STOP_OUT_PERCENT ?? null,
    },
  },
  strategies: strategies.repository,
  runs: runs.repository,
  disclosure: disclosure.repository,
  templates: templates.repository,
  quota: quota.store,
  releaseNoteMax: env.QUANT_RELEASE_NOTE_MAX === undefined ? null : Number(env.QUANT_RELEASE_NOTE_MAX),
  share: {
    repository: shares.repository,
    rate: env.QUANT_SHARE_RATE === undefined ? null : Number(env.QUANT_SHARE_RATE),
    windowSec: env.QUANT_SHARE_WINDOW_SEC === undefined ? null : Number(env.QUANT_SHARE_WINDOW_SEC),
    embedOrigins: embedOrigins(env.QUANT_EMBED_ORIGINS),
  },
});
export type AppRouter = typeof appRouter;

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });

const ready = quantReadyHonesty({ isolateWired, lakeWired: lake.wired, venueVaultSet });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async () => ready);

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  { port: env.HTTP_PORT, isolate: ready.isolate, lake: ready.lake, refuse: ready.refuse, venueVault: venueVaultSet },
  'svc-quant ready',
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await strategies.close();
      await runs.close();
      await disclosure.close();
      await templates.close();
      await quota.close();
      process.exit(0);
    })();
  });
}
