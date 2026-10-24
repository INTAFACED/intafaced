import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext } from '@intafaced/contracts';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
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
 * svc-campaigns: seasons, limited drops and the TGE claim. Holds no balance and imports no ledger recipe.
 * A blank CAMPAIGNS_TGE_SCHEDULE_JSON boots and refuses every TGE claim `launch.schedule_unset`.
 */
const tgeSchedule = parseTgeSchedule(env.CAMPAIGNS_TGE_SCHEDULE_JSON);
const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  onnotice: () => undefined,
});
const drops = new DropService({ sql, tgeSchedule: () => tgeSchedule });

const appRouter = createCampaignsRouter(drops);
const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async (_req, reply) => {
  try {
    await sql`SELECT 1`;
    return { ok: true, service: env.SERVICE_NAME, database: 'ok', tgeSchedule: tgeSchedule ? 'set' : 'launch.schedule_unset' };
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
app.log.info({ port: env.HTTP_PORT }, 'svc-campaigns ready');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await sql.end({ timeout: 2 });
      process.exit(0);
    })();
  });
}
