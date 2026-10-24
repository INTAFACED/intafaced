import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext, s2sFromEnv } from '@intafaced/contracts';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { CampaignService, parseTimeZone } from './campaigns.js';
import { createParticipantClient } from './participants.js';
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
 * svc-campaigns: campaigns and joining them, seasons, limited drops and the TGE claim. Holds no balance and imports no
 * ledger recipe. A blank CAMPAIGNS_TGE_SCHEDULE_JSON boots and refuses every TGE claim `launch.schedule_unset`; a blank
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
const campaigns = new CampaignService({ sql, timeZone: () => timeZone, participants });

const appRouter = createCampaignsRouter(drops, campaigns);
const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });

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

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
if (!participantsWired) {
  app.log.warn('IDENTITY_URL or INTERNAL_SERVICE_SECRET is unset: campaigns with exclusions or a region list read unread');
}
app.log.info({ port: env.HTTP_PORT, participants: participantsWired }, 'svc-campaigns ready');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await sql.end({ timeout: 2 });
      process.exit(0);
    })();
  });
}
