import Fastify from 'fastify';
import postgres from 'postgres';
import { JetStreamEventBus } from '@intafaced/events';
import { s2sFromEnv } from '@intafaced/contracts';
import { clockSkewBoundMs, env, idempotencyConflictMode, railStatementUrls } from './env.js';
import { ledgerPostgresOptions } from './db/connection-options.js';
import { LedgerService } from './service.js';
import { createLedgerRouter } from './router.js';
import { runScheduledReconciliation } from './ledger/reconcile.js';
import { createReconcileTickState, runScheduledReconciliationTick } from './ledger/scheduled-reconcile-tick.js';
import { registerS2sHttp } from './s2s-http.js';
import { reconcileGauges, registerMetrics } from './metrics.js';
import { registerOperatorHttp } from './operator-http.js';
import { reconciliationSourcesFrom } from './ledger/reconciliation-sources.js';
import { createIdentityApprovalClient, unwiredApprovalConsumer } from './ledger/action-approval-consume.js';
import { registerLedgerStatusHttp } from './status-http.js';
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
 * svc-ledger — THE BALANCE (§4.2).
 *
 * Graph W1-C: S2S money plane via registerS2sHttp (plain /trpc/* for clients).
 * Network policy must keep these off the public internet until holds + service
 * auth land for real deploy.
 */

const sql = postgres(env.DATABASE_URL, ledgerPostgresOptions(env));

const [tip] = await sql<Array<{ seq: string }>>`SELECT seq FROM chain_tip WHERE id = true`;
if (!tip) throw new Error('chain_tip is missing — run migrations before starting svc-ledger');

const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: ['ledger'],
});

// Blank snapshot URL: an outside-balance control's outside side is unset. Set but unreadable: that run is ERROR.
const reconciliationSources = reconciliationSourcesFrom(env.LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL, railStatementUrls);

const ledger = new LedgerService(sql, bus, {
  postingEnabled: env.LEDGER_POSTING_ENABLED,
  idempotencyConflict: idempotencyConflictMode,
  reconcileStatementTimeoutMs: env.LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS,
  clockSkewBoundMs,
  reconciliationSources,
});

// Before the first request, never after: a frozen database stays frozen, and
// LEDGER_POSTING_ENABLED=false becomes a durable freeze that also reaches the
// replicas nobody reconfigured. See LedgerService.applyStartupPolicy — the
// flag can freeze, and can never thaw.
const freezeAtBoot = await ledger.applyStartupPolicy();

const actionApprovals = env.IDENTITY_URL
  ? createIdentityApprovalClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET)
  : unwiredApprovalConsumer();

export const appRouter = createLedgerRouter(ledger, undefined, actionApprovals);
export type AppRouter = typeof appRouter;

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

/**
 * §14.5 — the book's scrape surface. Not the user SLO (that is svc-edge);
 * this is this process's HTTP latency. Registered before listen so the
 * `onResponse` hook is in place for every reply the process sends.
 *
 * `tooling/infra/prometheus.yaml` scrapes this at `svc-ledger:4001/metrics`.
 * `observability-wiring.test.ts` asserts that host, port and path against the
 * real compose file. `metrics.boot.e2e.test.ts` fails if this call is deleted.
 */
registerMetrics(app, { service: env.SERVICE_NAME, gauges: async () => reconcileGauges(await ledger.lastVerified()) });

registerLedgerStatusHttp(app, ledger, env.SERVICE_NAME);

// Body digest is required on the live money plane. Isolated tests may still
// mount accept-both; compose / config default stays accept-both.
// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves every door on the
// shared secret alone, and each door still names the services that may call it.
const s2s = s2sFromEnv(env, 'svc-ledger');
registerS2sHttp(app, ledger, env.INTERNAL_SERVICE_SECRET, {
  bodyBind: 'require',
  ...(s2s.serviceVerifier && s2s.s2sMode ? { s2s: { verifier: s2s.serviceVerifier, mode: s2s.s2sMode } } : {}),
});

/**
 * §14.6 — the operator surface: freeze, unfreeze, on-demand reconcile, and
 * reconciliation controls (list, define, update, run).
 *
 * `appRouter` above is exported for its TYPE and served on no port. It includes
 * `post`, so it is not mounted. `registerOperatorHttp` is the served door:
 * GET/POST `/operator/freeze`, POST `/operator/unfreeze`, POST `/operator/reconcile`,
 * and `/operator/reconciliation/controls` (list, define, update, run) behind
 * `admin:treasury` + MFA. Run also takes a reason and an approval. Compliance may list.
 * See `operator-http.ts`.
 */
registerOperatorHttp(
  app,
  ledger,
  {
    secret: env.JWT_ACCESS_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
  },
  actionApprovals,
  reconciliationSources,
);

// Outbox recover is NOT inside applyStartupPolicy. That path is freeze-only
// (must not call identity). Crash-after-commit `ledgerTxPosted` and
// `ledgerFreezeUpdated` intents drain here, then again on the tick below.
try {
  await ledger.recoverUnpublishedOutbox();
} catch (err) {
  app.log.error({ err }, 'ledger outbox recover at boot failed');
}

// One state object for the life of the timer: backoff after an incomplete run spans ticks.
const reconcileTickState = createReconcileTickState();
const reconcileTimer = setInterval(() => {
  void runScheduledReconciliationTick(
    () => runScheduledReconciliation(sql, ledger, { statementTimeoutMs: env.LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS }),
    ledger,
    app.log,
    {
      maxStaleHours: env.LEDGER_RECONCILE_MAX_STALE_HOURS,
      maxConsecutiveIncomplete: env.RECONCILE_MAX_CONSECUTIVE_INCOMPLETE,
      state: reconcileTickState,
    },
  ).catch((err) => {
    app.log.fatal({ err }, 'LEDGER RECONCILIATION TICK FAILED — a freeze that was due did not land');
  });
}, env.RECONCILE_CRON_MINUTES * 60_000);
reconcileTimer.unref();

/** Operational drain, not an owner money magnitude — unpublished intents retry here. */
const OUTBOX_RECOVER_MS = 5_000;
const outboxTimer = setInterval(() => {
  void ledger.recoverUnpublishedOutbox().catch((err) => {
    app.log.error({ err }, 'ledger outbox recover failed');
  });
}, OUTBOX_RECOVER_MS);
outboxTimer.unref();

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  { port: env.HTTP_PORT, chainSeq: tip.seq, s2sTrpcPaths: true, frozen: freezeAtBoot.frozen, frozenBy: freezeAtBoot.actor },
  'svc-ledger ready',
);

// Loud, at the top level, because a process that came up frozen looks identical
// to a healthy one in every graph except the one nobody is watching.
if (freezeAtBoot.frozen) {
  app.log.fatal({ reason: freezeAtBoot.reason, actor: freezeAtBoot.actor }, 'LEDGER POSTING IS FROZEN — no value can move');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      clearInterval(reconcileTimer);
      clearInterval(outboxTimer);
      await app.close();
      await bus.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
