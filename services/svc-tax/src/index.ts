import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createEdgeContext } from '@intafaced/contracts';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { env } from './env.js';
import { createTaxLedgerReads } from './ledger-reads.js';
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
const tax = new TaxService({
  mapRaw: env.TAX_JURISDICTION_MAP_JSON,
  reads: createTaxLedgerReads(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET),
  lake: lakeStatusFromUrl(env.CONNECT_DATA_LAKE_TSDB_URL),
  indexer: indexerStatusFromUrl(env.INDEXER_URL),
  historyYears: env.TAX_HISTORY_YEARS,
});

const appRouter = createTaxRouter(tax);
const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_PUBLIC_KEY ?? env.EDGE_PRINCIPAL_SECRET, serviceName: env.SERVICE_NAME });

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
      process.exit(0);
    })();
  });
}
