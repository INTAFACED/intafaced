import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext, s2sFromEnv } from '@intafaced/contracts';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { env } from './env.js';
import { VendorService } from './vendor-service.js';
import { createStakeSource } from './stake-source.js';
import { createMarketRouter, type MarketRouter } from './router.js';
import { createIdentityApprovalClient, unwiredApprovalConsumer } from './action-approval-consume.js';
import { CommerceService } from './commerce/commerce-service.js';
import { ReviewsService } from './reviews/reviews-service.js';
import { createLedgerClient } from './ledger-client.js';
import { createAffiliateAccrueClient } from './affiliate-accrue.js';
import { createAffiliatePayoutClient } from './affiliate-payout.js';
import { PerpProposalService } from './perp-proposal-service.js';
import { marketReadyHonesty } from './ready-honesty.js';

// §9 — register the TracerProvider before the first span is created.
registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-market — vendor lifecycle (Stages 1–3) + market.commerce listings and
 * one-time purchase with house commission (§8.7).
 *
 * Balances live in svc-ledger only. Commission bps is owner-gated: unset env
 * refuses createListing + purchase and empties the public catalogue rather
 * than inventing a rate (D26-P1-M1 / M2). Compose wires LEDGER_URL to
 * svc-ledger; MARKET_HOUSE_COMMISSION_BPS is owner-published (0 = explicit
 * free-cut in `.env.example`); compose pass-through, no in-code default.
 */

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'market,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM market.vendors LIMIT 1`.catch(() => {
  throw new Error('market schema is missing — run migrations before starting svc-market');
});
await sql`SELECT 1 FROM market.vendor_slots LIMIT 1`.catch(() => {
  throw new Error('market.vendor_slots is missing — run migrations before starting svc-market');
});
await sql`SELECT 1 FROM market.listings LIMIT 1`.catch(() => {
  throw new Error('market.listings is missing — run migrations before starting svc-market');
});
await sql`SELECT 1 FROM market.purchases LIMIT 1`.catch(() => {
  throw new Error('market.purchases is missing — run migrations before starting svc-market');
});
await sql`SELECT 1 FROM market.subscription_state LIMIT 1`.catch(() => {
  throw new Error('market.subscription_state is missing — run migrations before starting svc-market');
});
await sql`SELECT 1 FROM market.perp_proposals LIMIT 1`.catch(() => {
  throw new Error('market.perp_proposals is missing — run migrations before starting svc-market');
});
await sql`SELECT 1 FROM market.perp_proposal_status_events LIMIT 1`.catch(() => {
  throw new Error('market.perp_proposal_status_events is missing — run migrations before starting svc-market');
});
await sql`SELECT 1 FROM market.listing_takedowns LIMIT 1`.catch(() => {
  throw new Error('market.listing_takedowns is missing — run migrations before starting svc-market');
});
await sql`SELECT 1 FROM market.reviews LIMIT 1`.catch(() => {
  throw new Error('market.reviews is missing — run migrations before starting svc-market');
});
await sql`SELECT 1 FROM market.listing_category_events LIMIT 1`.catch(() => {
  throw new Error('market.listing_category_events is missing — run migrations before starting svc-market');
});

// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves every outgoing call on the shared secret alone.
const s2s = s2sFromEnv(env, 'svc-market');
const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
const vendors = new VendorService(sql, createStakeSource(env.TOKEN_URL, env.INTERNAL_SERVICE_SECRET, s2sKey));
const ledger = createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, s2sKey);
const commerce = new CommerceService(sql, vendors, ledger, {
  commissionBps: env.MARKET_HOUSE_COMMISSION_BPS ?? null,
  affiliateAccrue: env.IDENTITY_URL ? createAffiliateAccrueClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) : undefined,
  affiliatePayout: env.IDENTITY_URL ? createAffiliatePayoutClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) : undefined,
  hold: {
    on: env.MARKET_PURCHASE_HOLD === 'on',
    refundWindowSeconds: env.MARKET_REFUND_WINDOW_SECONDS ?? null,
    releaseSweepSeconds: env.MARKET_RELEASE_SWEEP_SECONDS ?? null,
  },
  onSweepError: (purchaseId, err) => app.log.error({ err, purchaseId }, 'held purchase release sweep could not finish a row'),
});
const perpProposals = new PerpProposalService(sql, vendors);
const actionApprovals = env.IDENTITY_URL
  ? createIdentityApprovalClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET)
  : unwiredApprovalConsumer();
const reviews = new ReviewsService(sql);
const appRouter = createMarketRouter(vendors, commerce, perpProposals, actionApprovals, reviews);

const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));

app.get('/ready', async () =>
  marketReadyHonesty({
    databaseUrl: env.DATABASE_URL,
    ledgerUrl: env.LEDGER_URL,
    tokenUrl: env.TOKEN_URL,
    identityUrl: env.IDENTITY_URL,
    commissionConfigured: env.MARKET_HOUSE_COMMISSION_BPS !== undefined,
  }),
);

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<MarketRouter>['trpcOptions'],
});

// The release sweep: held purchases whose refund window ended are released to the seller, and an outcome a crash left
// claimed is posted again under its own key. Blank owner value: none runs, and no new purchase is held
// (market.release_sweep_unset).
// A tick that finds the last sweep still running skips, so slow sweeps never overlap.
let sweeping = false;
const releaseSweep = env.MARKET_RELEASE_SWEEP_SECONDS
  ? setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      commerce.held
        .sweep()
        .catch((err: unknown) => app.log.error({ err }, 'held purchase release sweep failed'))
        .finally(() => {
          sweeping = false;
        });
    }, env.MARKET_RELEASE_SWEEP_SECONDS * 1000)
  : null;
releaseSweep?.unref();

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  {
    port: env.HTTP_PORT,
    stage: 'commerce-subscriptions',
    commissionConfigured: env.MARKET_HOUSE_COMMISSION_BPS !== undefined,
    purchaseHold: env.MARKET_PURCHASE_HOLD === 'on',
    refundWindowConfigured: env.MARKET_REFUND_WINDOW_SECONDS !== undefined,
    releaseSweep: Boolean(releaseSweep),
    trpc: true,
  },
  'svc-market ready',
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      if (releaseSweep) clearInterval(releaseSweep);
      await app.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
