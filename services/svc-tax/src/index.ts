import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext, s2sFromEnv } from '@intafaced/contracts';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { openChoices } from './choices.js';
import { env } from './env.js';
import { createTaxLedgerReads } from './ledger-reads.js';
import { createTradePrices } from './prices.js';
import { createTaxRouter, type TaxRouter } from './router.js';
import { taxReadyHonesty } from './ready-honesty.js';
import { indexerStatusFromUrl, lakeStatusFromUrl, TaxService } from './tax-service.js';

registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-tax — lot export over ledger reads. No balances of its own.
 * That is not a certified non-custodial plane.
 * Blank TAX_JURISDICTION_MAP_JSON boots and refuses by name at the door.
 * Blank TAX_HISTORY_YEARS boots and refuses `tax.history_years_unset` at export.
 */
// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves the ledger reads on the shared secret alone.
const s2s = s2sFromEnv(env, 'svc-tax');
const choices = openChoices({ DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX });
const tax = new TaxService({
  choices: choices.store,
  mapRaw: env.TAX_JURISDICTION_MAP_JSON,
  reads: createTaxLedgerReads(
    env.LEDGER_URL,
    env.INTERNAL_SERVICE_SECRET,
    s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined,
  ),
  lake: lakeStatusFromUrl(env.CONNECT_DATA_LAKE_TSDB_URL),
  indexer: indexerStatusFromUrl(env.INDEXER_URL),
  historyYears: env.TAX_HISTORY_YEARS,
  ...(env.TAX_DEPOSIT_BASIS === undefined ? {} : { depositBasis: env.TAX_DEPOSIT_BASIS }),
  ...(env.TRADE_URL === undefined ? {} : { prices: createTradePrices(env.TRADE_URL) }),
});

const appRouter = createTaxRouter(tax);
const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async () => taxReadyHonesty(env));

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<TaxRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info({ port: env.HTTP_PORT }, 'svc-tax ready');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await choices.close();
      process.exit(0);
    })();
  });
}
