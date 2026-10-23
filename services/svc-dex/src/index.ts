import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { buildEdgeContext } from './edge-context.js';
import { env } from './env.js';
import { createDexRouter } from './router.js';
import { OrderBook } from './order/order-book.js';
import { unwiredFillPort, unwiredPricePort } from './order/trigger-ports.js';
import { startTriggerKeeper } from './order/trigger-keeper.js';
import { dexHealthHonesty, dexReadyHonesty } from './quote/door-honesty.js';
import { venuesFor as venuesForEnv } from './quote/venue-set.js';
import { clobCostsFromOptional } from './quote/clob-costs.js';
import { createHideListReader } from './quote/hide-list.js';
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
 * svc-dex — the Protocol Plane's front door (§8.6, §17.5).
 *
 * `custody-scan` fails the build if this service imports a ledger write recipe,
 * and its environment carries no `INTERNAL_SERVICE_SECRET`, so it could not
 * reach `ledger.post` even if an import slipped past the scanner. That is a
 * property of THIS PROCESS, not of a quote: the internal book is custodial
 * (`custodial: true`), unpublished `DEX_EXTERNAL_VENUES` is not a live
 * external venue, and ranking is not certified best execution.
 */

/**
 * WHERE PRICES COME FROM, WIRED — the §27 venue set.
 *
 * Three kinds of venue, one interface. `LiquiditySource`'s header states why
 * that matters: the internal book implements the same type as everyone else, so
 * the router has no notion of "ours" versus "theirs" and cannot quietly favour
 * us. svc-dex ranks on effective price alone.
 *
 *   · `intachain-clob`  — on-chain, self-custody. Attached only when CLOB fee
 *     knobs are explicit (S-I3). Default shipped config omits it rather than
 *     quoting 0 bps / 0 settlement.
 *   · `internal-book`   — our engine. Custodial, and disclosed as such.
 *   · external venues   — operator configuration, none by default.
 */
clobCostsFromOptional(env.DEX_CLOB_FEE_BPS, env.DEX_CLOB_SETTLEMENT_COST);

const venuesFor = (region: string) => venuesForEnv(env, region);

const ammVenueWired = env.DEX_EXTERNAL_VENUES.some((v) => v.kind === 'amm');
const externalVenueWired = env.DEX_EXTERNAL_VENUES.length > 0;

// One book for the router and the keeper. Ports stay unwired: no key, no node, no service call.
// The directory holds orders and attempts, not a balance. Blank uses a stable temp path so a restart resumes.
const triggerStoreDir = env.DEX_ORDER_STORE_DIR ?? join(tmpdir(), 'intafaced-svc-dex-orders');
mkdirSync(triggerStoreDir, { recursive: true });
const triggerBook = new OrderBook(triggerStoreDir);
const triggerSettings = {
  minSize: env.DEX_ORDER_MIN_SIZE,
  restrictedTokens: env.DEX_ORDER_RESTRICTED_TOKENS,
  warnTokens: env.DEX_ORDER_WARN_TOKENS,
  slippageBps: env.DEX_ORDER_SLIPPAGE_BPS,
  oracleMaxAgeMs: env.DEX_ORDER_ORACLE_MAX_AGE_MS,
  orderDomain: env.DEX_ORDER_DOMAIN,
};

export const appRouter = createDexRouter({
  venues: venuesFor,
  maxAgeMs: env.QUOTE_MAX_AGE_MS,
  depth: env.DEX_QUOTE_DEPTH,
  // The hide list is read with the same published bound as a venue fetch; unset bound or URL leaves quote refusing.
  ...(env.OPS_URL && env.QUOTE_MAX_AGE_MS
    ? { hideList: createHideListReader({ baseUrl: env.OPS_URL, timeoutMs: env.QUOTE_MAX_AGE_MS }) }
    : {}),
  internalBookEnabled: env.DEX_INTERNAL_BOOK_ENABLED,
  ammVenueWired,
  externalVenueWired,
  triggerOrders: { settings: triggerSettings, price: unwiredPricePort, fill: unwiredFillPort, book: triggerBook },
});
export type AppRouter = typeof appRouter;

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

// Blank interval does not start a loop and does not invent one. The ports never broadcast.
const stopKeeper = startTriggerKeeper({
  book: triggerBook,
  deps: { now: () => new Date(), settings: triggerSettings, price: unwiredPricePort, fill: unwiredFillPort },
  intervalMs: env.DEX_ORDER_KEEPER_INTERVAL_MS,
  onError: (err) => app.log.error({ err }, 'trigger keeper tick failed'),
});

// Built before the listener opens. The edge secret is required: quote may
// ignore a principal, but limitOrder requires one, and a signed principal
// must be verified rather than believed.
const edgeContext = buildEdgeContext(env);

app.get('/health', async () =>
  dexHealthHonesty({
    internalBookEnabled: env.DEX_INTERNAL_BOOK_ENABLED,
    ammVenueWired,
    externalVenueWired,
  }),
);
app.get('/ready', async () =>
  dexReadyHonesty({
    internalBookEnabled: env.DEX_INTERNAL_BOOK_ENABLED,
    ammVenueWired,
    externalVenueWired,
  }),
);

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  {
    port: env.HTTP_PORT,
    internalBookEnabled: env.DEX_INTERNAL_BOOK_ENABLED,
    internalBookCustodial: env.DEX_INTERNAL_BOOK_ENABLED ? true : undefined,
    ammVenueWired,
    externalVenueWired,
  },
  'svc-dex ready',
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    stopKeeper();
    void (async () => {
      await app.close();
      process.exit(0);
    })();
  });
}
