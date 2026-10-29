import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { buildEdgeContext } from './edge-context.js';
import { retainRawBody, s2sFromEnv } from '@intafaced/contracts';
import { JetStreamEventBus } from '@intafaced/events';
import { env } from './env.js';
import { ModelGateway } from './gateway/gateway.js';
import { userAvailable } from '@intafaced/ledger-client';
import { DEFAULT_ROUTING_TABLE, parseRoutingTable, unpricedTable, type RoutingTable } from './gateway/routing.js';
import { createLedgerClient } from './ledger-client.js';
import { createAffiliateAccrueClient } from './affiliate-accrue.js';
import { createAffiliatePayoutClient } from './affiliate-payout.js';
import { UsageMeter } from './metering/meter.js';
import { MockModelProvider } from './providers/mock.js';
import { UpstreamModelProvider } from './providers/upstream.js';
import type { ModelProvider } from './providers/provider.js';
import { AgentRuntime } from './runtime.js';
import { UserSpendStore } from './spend/store.js';
import { registerProductAgentsAtBoot } from './fleet/boot-register.js';
import { serialiseGuardrail } from './fleet/guardrails.js';
import { coachAgentGuardrail } from './coach/coach-run.js';
import { fleetMatrixBoardCard } from './fleet/matrix.js';
import { agentsReadiness } from './readiness.js';
import { describeAgentsLivePlanes } from './live-planes.js';
import { createAcademyCurriculumSource } from './coach/academy-curriculum-source.js';
import { createHttpSupportDeskPort } from './support-agent/desk-port.js';
import { createHttpSpotTickersPort } from './scanner/trade-tickers-http-port.js';
import { createHttpPayMetricsPort } from './merchant/pay-metrics-http-port.js';
import { createHttpCopyLeaderFixturesPort } from './copy-intel/copy-leader-fixtures-http-port.js';
import { createHttpNavigatorTradeDataPort } from './navigator/trade-data-http-port.js';
import { createHttpNavigatorIdentitySessionPort } from './navigator/identity-session-http-port.js';
import { tradeTickerPrices } from './portfolio-agent/trade-prices.js';
import { createAgentsRouter, type AgentsRouter } from './router.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';

// §9 — register the TracerProvider before the first span is created.
// `@opentelemetry/api` alone is a no-op: without this call every span in
// ./tracing.ts is built, tagged and then discarded before it reaches the
// collector. Tracers grabbed at module scope resolve lazily through the proxy
// provider, so registering here still captures them.
registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-agents — the agent fleet runtime and model gateway (§8.2).
 *
 * Stage-1 product factories (navigator / support / scanner / merchant /
 * copy-intel) are registered into `agent_definitions` at boot so metered
 * `runSession` paths can open without a separate deploy-side seed. `coach` and
 * `growth` are refuse/proposal doors (not factories). Portfolio / launch remain
 * doctrine names only until product law.
 */

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'agents,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM agents.agent_definitions LIMIT 1`.catch(() => {
  throw new Error('agents schema is missing — run migrations before starting svc-agents');
});

/**
 * The provider registered as `primary`.
 *
 * Which one that is comes from configuration, and the default is the
 * deterministic mock: a developer should be able to run the fleet without an
 * upstream credential, and starting this service by accident must not be able
 * to spend money.
 */
function buildPrimaryProvider(): ModelProvider {
  if (env.AGENTS_PROVIDER === 'mock') return new MockModelProvider({ id: 'primary' });

  if (!env.AGENTS_UPSTREAM_BASE_URL || !env.AGENTS_UPSTREAM_API_KEY) {
    throw new Error('AGENTS_PROVIDER=upstream requires AGENTS_UPSTREAM_BASE_URL and AGENTS_UPSTREAM_API_KEY');
  }

  return new UpstreamModelProvider({
    id: 'primary',
    baseUrl: env.AGENTS_UPSTREAM_BASE_URL,
    apiKey: env.AGENTS_UPSTREAM_API_KEY,
    authHeader: env.AGENTS_UPSTREAM_AUTH_HEADER,
    authPrefix: env.AGENTS_UPSTREAM_AUTH_PREFIX,
    headers: env.AGENTS_UPSTREAM_HEADERS,
    completionsPath: env.AGENTS_UPSTREAM_COMPLETIONS_PATH,
    ...(env.AGENTS_UPSTREAM_EMBEDDINGS_PATH ? { embeddingsPath: env.AGENTS_UPSTREAM_EMBEDDINGS_PATH } : {}),
    models: env.AGENTS_UPSTREAM_MODELS,
    timeoutMs: env.AGENTS_UPSTREAM_TIMEOUT_MS,
  });
}

function buildRoutingTable(): RoutingTable {
  // Unpublished rates stay blank: the default table's prices are test placeholders (OWNER 107).
  if (!env.AGENTS_ROUTING_TABLE) return unpricedTable(DEFAULT_ROUTING_TABLE);
  return parseRoutingTable(JSON.parse(env.AGENTS_ROUTING_TABLE));
}

const primaryProvider = buildPrimaryProvider();
const providers: readonly ModelProvider[] = [primaryProvider];
const gateway = new ModelGateway(providers, buildRoutingTable());

const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: ['agents'],
});

// Metered usage moves value, and value moves through svc-ledger — never
// through this service's own tables (Doctrine §0.6). LEDGER_URL is required
// with no localhost default — unset refuses boot rather than guessing a book.
// Per-service keys (S2S v3): with no S2S_AUTH_MODE the ledger, academy, identity, pay and trade calls stay on the shared secret alone.
const s2s = s2sFromEnv(env, 'svc-agents');
const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
const ledger = createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, s2sKey);

const meter = new UsageMeter(sql, ledger, {
  assetId: env.AGENTS_FEE_ASSET_ID,
  windowMinutes: env.AGENTS_USAGE_WINDOW_MINUTES,
  affiliateAccrue: env.IDENTITY_URL ? createAffiliateAccrueClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) : undefined,
  affiliatePayout: env.IDENTITY_URL ? createAffiliatePayoutClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) : undefined,
});

const spend = new UserSpendStore(sql);
const runtime = new AgentRuntime(sql, gateway, meter, bus, {
  feeAssetId: env.AGENTS_FEE_ASSET_ID,
  meteringEnabled: env.AGENTS_METERING_ENABLED,
  spend,
  // The person's available balance, read from the ledger before each metered run (OWNER 107).
  funds: { available: async (userId, assetId) => (await ledger.balance(userAvailable(userId, assetId))).amount },
});

// Upsert product guardrails before the listener opens — openSession binds from
// agent_definitions; a process with zero rows makes every runSession 404.
const bootAgents = await registerProductAgentsAtBoot(runtime);
// The Coach is not a fleet product agent (it holds no tools), but its runs open sessions the same way (RC-agents-02).
await runtime.registerAgent(serialiseGuardrail(coachAgentGuardrail()), { enabled: true });

const academyUrl = env.ACADEMY_URL;
const loadCoachGrounding = academyUrl
  ? () => createAcademyCurriculumSource(academyUrl, env.INTERNAL_SERVICE_SECRET, fetch, s2sKey).load()
  : undefined;

const supportDesk = env.SUPPORT_URL
  ? createHttpSupportDeskPort({
      supportUrl: env.SUPPORT_URL,
      ...(env.IDENTITY_URL ? { identityUrl: env.IDENTITY_URL } : {}),
      internalSecret: env.INTERNAL_SERVICE_SECRET,
      ...(s2sKey ? { s2s: s2sKey } : {}),
    })
  : undefined;

const spotTickersPort = env.TRADE_URL ? createHttpSpotTickersPort({ tradeUrl: env.TRADE_URL }) : undefined;

const payMetricsPort = env.PAY_URL
  ? createHttpPayMetricsPort({ payUrl: env.PAY_URL, internalSecret: env.INTERNAL_SERVICE_SECRET, ...(s2sKey ? { s2s: s2sKey } : {}) })
  : undefined;

const copyLeaderFixturesPort = env.TRADE_URL
  ? createHttpCopyLeaderFixturesPort({
      tradeUrl: env.TRADE_URL,
      internalSecret: env.INTERNAL_SERVICE_SECRET,
      ...(s2sKey ? { s2s: s2sKey } : {}),
    })
  : undefined;

const navigatorTradeDataPort = env.TRADE_URL ? createHttpNavigatorTradeDataPort({ tradeUrl: env.TRADE_URL }) : undefined;

const navigatorIdentitySessionPort = env.IDENTITY_URL
  ? createHttpNavigatorIdentitySessionPort({
      identityUrl: env.IDENTITY_URL,
      internalSecret: env.INTERNAL_SERVICE_SECRET,
      ...(s2sKey ? { s2s: s2sKey } : {}),
    })
  : undefined; // blank / unset IDENTITY_URL → live identity.session.read refuses, never a caller fixture

const portfolioPrices =
  env.TRADE_URL && env.PORTFOLIO_QUOTE_ASSET
    ? tradeTickerPrices({ baseUrl: env.TRADE_URL, quoteAssetId: env.PORTFOLIO_QUOTE_ASSET })
    : undefined;

const appRouter = createAgentsRouter({
  runtime,
  gateway,
  meter,
  feeAssetId: env.AGENTS_FEE_ASSET_ID,
  meteringEnabled: env.AGENTS_METERING_ENABLED,
  ...(loadCoachGrounding ? { loadCoachGrounding } : {}),
  ...(supportDesk ? { supportDesk } : {}),
  ...(spotTickersPort ? { spotTickersPort } : {}),
  ...(payMetricsPort ? { payMetricsPort } : {}),
  ...(copyLeaderFixturesPort ? { copyLeaderFixturesPort } : {}),
  ...(env.TRADE_URL ? { navigatorTradeUrl: env.TRADE_URL } : {}),
  ...(navigatorTradeDataPort ? { navigatorTradeDataPort } : {}),
  ...(navigatorIdentitySessionPort ? { navigatorIdentitySessionPort } : {}),
  sql,
  portfolioLedger: { balances: (ownerType, ownerId) => ledger.balances(ownerType, ownerId) },
  ...(portfolioPrices ? { portfolioPrices } : {}),
});

// Built before the listener opens: a service that cannot authenticate the edge
// must fail to start, not start and serve every request as anonymous.
const edgeContext = buildEdgeContext(
  env,
  s2s.serviceVerifier && s2s.s2sMode ? { verifier: s2s.serviceVerifier, mode: s2s.s2sMode } : undefined,
);

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

// A key-signed call binds its body bytes; /trpc reads them from here.
retainRawBody(app);

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));

/**
 * Honest readiness (Board Clear A-P5-AGENTS).
 *
 * Process ready stays true after boot: sessions, logs and settlement still
 * work when the engine is down. What an operator must not misread:
 *   · `providerMode: mock` is not production inference
 *   · `usefulPath.available` is whether a completion can leave the process now
 *   · productAgentsRegistered is the boot upsert count (not live inference)
 *   · fleet is the Stage-1 matrix card (mounts + boot flags), not live inference
 *   · meteringEnabled=false is D26-P1-A6 audit-only (`meteringMode: audit_only`,
 *     meteringAllowsFeeCharge=false) — process-ready is not a silent feeCharge
 * Never a vendor name (Doctrine §0.7).
 */
app.get('/ready', async () =>
  agentsReadiness({
    providerMode: env.AGENTS_PROVIDER,
    providers,
    table: gateway.routingTable,
    meteringEnabled: env.AGENTS_METERING_ENABLED,
    productAgentsRegistered: bootAgents.count,
    fleet: fleetMatrixBoardCard(),
    livePlanes: describeAgentsLivePlanes(process.env),
  }),
);

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    // The edge terminates auth and forwards the resolved principal; this
    // service never parses a token itself (§4.1 owns that). It does verify the
    // edge's signature over that principal — see packages/contracts/src/edge.ts
    // for why an unsigned header makes every scope check decorative.
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<AgentsRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  {
    port: env.HTTP_PORT,
    provider: env.AGENTS_PROVIDER,
    metering: env.AGENTS_METERING_ENABLED,
    tasks: gateway.routingTable.routes.length,
    productAgents: bootAgents.registered,
  },
  'svc-agents ready',
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      // Draining, not dropping: an in-flight settlement finishes before exit.
      await app.close();
      await bus.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
