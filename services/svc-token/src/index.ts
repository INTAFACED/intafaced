import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { retainRawBody, s2sFromEnv } from '@intafaced/contracts';
import { buildEdgeContext } from './edge-context.js';
import { JetStreamEventBus } from '@intafaced/events';
import { formatAmount } from '@intafaced/ledger-client';
import { env } from './env.js';
import { TokenError, TokenService } from './token-service.js';
import { createLedgerClient } from './ledger-client.js';
import { createIdentityApprovalClient, unwiredApprovalConsumer } from './action-approval-consume.js';
import { createTokenRouter, type TokenRouter } from './router.js';
import { registerInternalStake } from './internal-stake.js';
import { registerInternalEmissions } from './internal-emissions.js';
import { registerInternalYield } from './internal-yield.js';
import { registerInternalBuyback } from './internal-buyback.js';
import { defaultEmissionsTickMs, requireEmissionsTickMsForAutoTick } from './emissions-tick.js';
import { tokenReadyHonesty } from './ready-honesty.js';
import { readYieldDistributionCronHours, runYieldWindow } from './yield-job.js';
import { runBuybackWindow } from './buyback-job.js';
import { createTradeIocMarketBuy } from './buyback-trade-client.js';
import { readGovernanceParams } from './governance-close.js';
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
 * svc-token — the native economy (§4.3).
 *
 * Graph W1-C: mount tRPC with edge-signed principal; keep /internal/stake for S2S.
 *
 * Emissions: HMAC job `mintEpoch` (svc-token), or enable
 * EMISSIONS_AUTO_TICK to mint the next sequential epoch on an interval.
 * Both paths refuse when EMISSIONS_ENABLED=false. Session admin:treasury
 * is not a job back door.
 */

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'token,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM token.token_params LIMIT 1`.catch(() => {
  throw new Error('token schema is missing — run migrations before starting svc-token');
});

const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: ['token'],
});

// Value moves through svc-ledger, never through this service's own tables
// (Doctrine §0.6). This client is the only path.
// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves the ledger calls on the shared secret alone.
const s2s = s2sFromEnv(env, 'svc-token');
const ledger = createLedgerClient(
  env.LEDGER_URL,
  env.INTERNAL_SERVICE_SECRET,
  s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined,
);

const governanceBps = readGovernanceParams({
  TOKEN_GOVERNANCE_QUORUM_BPS: env.TOKEN_GOVERNANCE_QUORUM_BPS,
  TOKEN_GOVERNANCE_THRESHOLD_BPS: env.TOKEN_GOVERNANCE_THRESHOLD_BPS,
});

const token = new TokenService(sql, ledger, bus, {
  assetId: env.TOKEN_ASSET_ID,
  // T-02: buyback + emission from token_params, not code defaults.
  loadParamsFromDb: true,
  // Blank env stays undefined — close refuses token.governance_quorum_unset.
  governanceQuorumBps: governanceBps.quorumBps,
  governanceThresholdBps: governanceBps.thresholdBps,
  // One-day default (owner-present 2026-10-14): a new epoch cannot start sooner than this after the last claim.
  emissionEpochMs: env.EMISSIONS_EPOCH_MS,
  // Blank stays undefined — a vote refuses token.vote_rule_unset.
  voteRule: env.TOKEN_VOTE_RULE,
});

const yieldJob = {
  yieldJobEnabled: env.YIELD_JOB_ENABLED,
  yieldDistributionCronHours: readYieldDistributionCronHours(env.YIELD_DISTRIBUTION_CRON_HOURS),
  assetId: env.TOKEN_ASSET_ID,
  ledger,
  distributeRevenue: (input: Parameters<typeof token.distributeRevenue>[0]) => token.distributeRevenue(input),
};

const buybackJob = {
  buybackJobEnabled: env.BUYBACK_JOB_ENABLED,
  assetId: env.TOKEN_ASSET_ID,
  quoteAssetId: env.BUYBACK_QUOTE_ASSET,
  ledger,
  buybackParams: () => token.buybackParams(),
  placeIocMarketBuy: createTradeIocMarketBuy({
    tradeUrl: env.TRADE_URL,
    symbol: env.BUYBACK_SYMBOL,
    internalSecret: env.INTERNAL_SERVICE_SECRET,
  }),
  settleBuyback: (input: Parameters<typeof token.settleBuybackFill>[0]) => token.settleBuybackFill(input),
};

const actionApprovals = env.IDENTITY_URL
  ? createIdentityApprovalClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET)
  : unwiredApprovalConsumer();

export const appRouter = createTokenRouter(token, {
  emissionsEnabled: env.EMISSIONS_ENABLED,
  runYieldWindow: (input) => runYieldWindow(yieldJob, input),
  runBuybackWindow: (input) => runBuybackWindow(buybackJob, input),
  approvals: actionApprovals,
});
export type AppRouter = typeof appRouter;

const doorS2s = s2s.serviceVerifier && s2s.s2sMode ? { verifier: s2s.serviceVerifier, mode: s2s.s2sMode } : undefined;
const edgeContext = buildEdgeContext(env, doorS2s);

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

// Keep the exact request bytes so S2S verifiers can check the signed digest
// (L2-6). Installed once here; the four internal registers pass
// `installRawBody: false` so a second parser does not throw at boot.
retainRawBody(app);
// GET stake follows compose. Mutate jobs hardcode require — do not mill the
// fleet INTERNAL_SERVICE_BODY_BIND default off accept-both.
const bodyBind = env.INTERNAL_SERVICE_BODY_BIND;

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async () =>
  tokenReadyHonesty({
    ledgerUrl: env.LEDGER_URL,
    emissionsEnabled: env.EMISSIONS_ENABLED,
    emissionsAutoTick: env.EMISSIONS_AUTO_TICK,
    yieldJobEnabled: env.YIELD_JOB_ENABLED,
    buybackJobEnabled: env.BUYBACK_JOB_ENABLED,
  }),
);

// The S2S stake gate. Lives in its own module so it can be tested — see
// internal-stake.ts for what breaks when money is serialised wrong here.
registerInternalStake(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  accessOf: (userId) => token.accessOf(userId),
  bodyBind,
  installRawBody: false,
});

// Cron mint. Lives in its own module so the kill-switch has a unit test —
// see internal-emissions.ts (same extract pattern as internal-stake).
registerInternalEmissions(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  emissionsEnabled: env.EMISSIONS_ENABLED,
  mintNextEpoch: () => token.mintNextEpoch(),
  bodyBind: 'require',
  installRawBody: false,
});

registerInternalYield(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  yieldJobEnabled: env.YIELD_JOB_ENABLED,
  runWindow: (input) => runYieldWindow(yieldJob, input),
  bodyBind: 'require',
  installRawBody: false,
});

registerInternalBuyback(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  buybackJobEnabled: env.BUYBACK_JOB_ENABLED,
  runWindow: (input) => runBuybackWindow(buybackJob, input),
  bodyBind: 'require',
  installRawBody: false,
});

// ── Optional emissions auto-tick ─────────────────────────────────────────────

let minting = false;

async function emissionsTick(): Promise<void> {
  if (!env.EMISSIONS_ENABLED) return;
  if (minting) return;
  minting = true;
  try {
    const result = await token.mintNextEpoch();
    app.log.info({ epoch: result.epoch, minted: formatAmount(result.minted) }, 'emission epoch minted (auto-tick)');
  } catch (err) {
    // Never let a tick failure kill the interval. Closed/exhausted epochs are
    // expected once the schedule ends; log and wait for the next tick.
    if (err instanceof TokenError && err.code === 'token.epoch_too_early') {
      // Normal between epochs: the time gate says the next one is not due yet. A wait LONGER than one epoch cannot
      // happen on a sane clock (database clock stepped back, or a row with a future created_at): minting would stop
      // silently, so that case is a warning.
      if (err.retryAfterMs !== undefined && err.retryAfterMs > env.EMISSIONS_EPOCH_MS) {
        app.log.warn(
          { retryAfterMs: err.retryAfterMs, epochMs: env.EMISSIONS_EPOCH_MS },
          'emission auto-tick: gate wait exceeds one epoch (clock step or future-dated epoch row?)',
        );
      } else {
        app.log.debug({ retryAfterMs: err.retryAfterMs }, 'emission auto-tick: next epoch not due yet');
      }
    } else {
      app.log.error({ err }, 'emission auto-tick failed');
    }
  } finally {
    minting = false;
  }
}

let emissionsTimer: ReturnType<typeof setInterval> | undefined;
if (env.EMISSIONS_AUTO_TICK) {
  const emissionsTickMs = requireEmissionsTickMsForAutoTick(true, env.EMISSIONS_TICK_MS, defaultEmissionsTickMs(env.EMISSIONS_EPOCH_MS));
  if (env.EMISSIONS_ENABLED) {
    emissionsTimer = setInterval(() => void emissionsTick(), emissionsTickMs);
    emissionsTimer.unref();
    app.log.info({ tickMs: emissionsTickMs, epochMs: env.EMISSIONS_EPOCH_MS }, 'emission auto-tick enabled');
  }
}

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<TokenRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  {
    port: env.HTTP_PORT,
    asset: env.TOKEN_ASSET_ID,
    emissionsEnabled: env.EMISSIONS_ENABLED,
    emissionsAutoTick: env.EMISSIONS_AUTO_TICK,
    trpc: true,
  },
  'svc-token ready',
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      if (emissionsTimer) clearInterval(emissionsTimer);
      await app.close();
      await bus.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
