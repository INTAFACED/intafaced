import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createEdgeContext } from '@intafaced/contracts';
import { missingLake } from './backtest/lake.js';
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
const venueVaultSet = env.QUANT_VENUE_VAULT !== undefined;
const strategies = openStrategyRepository({ DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX });
const runs = openRunRepository({ DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX });

export const appRouter = createQuantRouter({
  wired: isolateWired,
  venueVaultSet,
  limits: { maxOps: env.SANDBOX_MAX_OPS, maxSource: env.SANDBOX_MAX_SOURCE },
  lake,
  strategies: strategies.repository,
  runs: runs.repository,
});
export type AppRouter = typeof appRouter;

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, serviceName: env.SERVICE_NAME });

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
      process.exit(0);
    })();
  });
}
