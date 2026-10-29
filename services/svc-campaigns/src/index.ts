import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext, s2sFromEnv } from '@intafaced/contracts';
import { JetStreamEventBus } from '@intafaced/events';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { CampaignService, parseTimeZone } from './campaigns.js';
import { parseRuleLimit } from './rules.js';
import { createLedgerClient } from './ledger-client.js';
import { createMarketNames } from './markets.js';
import { createParticipantClient } from './participants.js';
import { PayoutSaga } from './payouts.js';
import { TaskService } from './tasks.js';
import { DropService } from './drops.js';
import { env } from './env.js';
import { createCampaignsRouter, type CampaignsRouter } from './router.js';
import { parseTgeSchedule } from './tge.js';

registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-campaigns: campaigns and joining them, task campaigns and their rewards, seasons, limited drops and the TGE claim.
 * Holds no balance. Value moves only in the reward saga (`payouts.ts`: `rewardPay` and `sweepFeesToRewards`). A blank CAMPAIGNS_TGE_SCHEDULE_JSON boots and refuses every TGE claim `launch.schedule_unset`; a blank
 * CAMPAIGNS_PLATFORM_TIME_ZONE boots and refuses every activation and join `campaigns.timezone_unset`.
 */
const tgeSchedule = parseTgeSchedule(env.CAMPAIGNS_TGE_SCHEDULE_JSON);
const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  onnotice: () => undefined,
});
const drops = new DropService({ sql, tgeSchedule: () => tgeSchedule });
const timeZone = parseTimeZone(env.CAMPAIGNS_PLATFORM_TIME_ZONE);
const s2s = s2sFromEnv(env, 'svc-campaigns');
const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
const participantsWired = Boolean(env.IDENTITY_URL && env.INTERNAL_SERVICE_SECRET);
const participants = participantsWired
  ? createParticipantClient(env.IDENTITY_URL!, env.INTERNAL_SERVICE_SECRET!, s2sKey)
  : { read: async () => null };
const ruleLimits = {
  depth: parseRuleLimit('CAMPAIGNS_RULE_DEPTH_LIMIT', env.CAMPAIGNS_RULE_DEPTH_LIMIT),
  size: parseRuleLimit('CAMPAIGNS_RULE_SIZE_LIMIT', env.CAMPAIGNS_RULE_SIZE_LIMIT),
};
const campaigns = new CampaignService({ sql, timeZone: () => timeZone, participants, ruleLimits: () => ruleLimits });
const ledger =
  env.LEDGER_URL && env.INTERNAL_SERVICE_SECRET ? createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) : null;
const reconcileAfterSeconds = env.CAMPAIGNS_RECONCILE_AFTER_SECONDS ?? null;
const saga = ledger ? new PayoutSaga({ sql, ledger, reconcileAfterSeconds }) : null;
const markets = env.TRADE_URL ? createMarketNames({ tradeUrl: env.TRADE_URL }) : null;
const tasks = new TaskService({
  sql,
  participants,
  saga,
  markets,
  timeZone: () => timeZone,
  rollbackWindowSeconds: env.CAMPAIGNS_ROLLBACK_WINDOW_SECONDS ?? null,
});

const appRouter = createCampaignsRouter(drops, campaigns, tasks);
const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });

let bus: JetStreamEventBus | null = null;
const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async (_req, reply) => {
  try {
    await sql`SELECT 1`;
    return {
      ok: true,
      service: env.SERVICE_NAME,
      database: 'ok',
      tgeSchedule: tgeSchedule ? 'set' : 'launch.schedule_unset',
      timeZone: timeZone ?? 'campaigns.timezone_unset',
      ruleLimits: ruleLimits.depth && ruleLimits.size ? 'set' : 'campaigns.rule_limits_unset',
      ledger: saga ? 'set' : 'campaigns.reward_saga_unwired',
      reconciler: saga && reconcileAfterSeconds ? 'set' : 'campaigns.reconcile_unset',
      bus: bus ? 'attached' : 'unreachable',
    };
  } catch {
    return reply.code(503).send({ ok: false, service: env.SERVICE_NAME, database: 'unavailable' });
  }
});

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<CampaignsRouter>['trpcOptions'],
});

/**
 * Task progress reads settled spot fills. svc-campaigns owns no stream: svc-trade creates `trade`'s. A failed connect or
 * attach is logged, not fatal, and tried again: the durable consumer picks the events up from the stream once it attaches.
 */
const BUS_RETRY_MS = 15_000;
let busRetry: NodeJS.Timeout | null = null;
let stopping = false;
async function attachBus(): Promise<void> {
  let connected: JetStreamEventBus | null = null;
  try {
    connected = await JetStreamEventBus.connect({
      servers: env.NATS_URL,
      producer: env.SERVICE_NAME,
      streamPrefix: env.NATS_STREAM_PREFIX,
    });
    await connected.subscribe(
      'fillSettled',
      async (fill) => {
        await tasks.onFill(fill);
      },
      { durable: 'campaigns-task-fill-settled' },
    );
    bus = connected;
  } catch (err) {
    app.log.error({ err }, 'svc-campaigns could not attach to trade.fill.settled: task progress waits, trying again');
    await connected?.close().catch(() => undefined);
    if (!stopping) {
      busRetry = setTimeout(() => void attachBus(), BUS_RETRY_MS);
      busRetry.unref();
    }
  }
}
await attachBus();

// The reconciler: releases held rewards whose hold ended, decides locked rewards and bonuses that are due, then posts
// open rewards, outcomes and fundings again under their own keys. Blank owner value: none runs, and a held reward stays
// held and a locked one locked.
const reconciler =
  saga && reconcileAfterSeconds
    ? setInterval(() => {
        tasks
          .releaseHolds()
          .catch((err: unknown) => app.log.error({ err }, 'reward hold release failed'))
          .then(() => tasks.settleLocks())
          .catch((err: unknown) => app.log.error({ err }, 'locked reward settle failed'))
          .then(() => saga.reconcile())
          .catch((err: unknown) => app.log.error({ err }, 'reward reconcile failed'));
      }, reconcileAfterSeconds * 1000)
    : null;
reconciler?.unref();

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
if (!participantsWired) {
  app.log.warn('IDENTITY_URL or INTERNAL_SERVICE_SECRET is unset: campaigns with exclusions or a region list read unread');
}
if (!markets) app.log.warn('TRADE_URL is unset: a task step that names a market counts no fill');
if (!saga) app.log.warn('LEDGER_URL or INTERNAL_SERVICE_SECRET is unset: every claim refuses campaigns.reward_saga_unwired');
app.log.info({ port: env.HTTP_PORT, participants: participantsWired, ledger: Boolean(saga) }, 'svc-campaigns ready');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      stopping = true;
      if (reconciler) clearInterval(reconciler);
      if (busRetry) clearTimeout(busRetry);
      await app.close();
      await bus?.close();
      await sql.end({ timeout: 2 });
      process.exit(0);
    })();
  });
}
