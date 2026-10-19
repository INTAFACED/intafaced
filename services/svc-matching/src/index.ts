import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { edgeTrustFromEnv } from '@intafaced/config';
import { JetStreamEventBus } from '@intafaced/events';
import { createHttpLedgerClient } from '@intafaced/ledger-client';
import { env } from './env.js';
import { MatchingEngine, MemorySnapshotSink } from './engine/engine.js';
import { installCodFence } from './engine/cod-fence.js';
import { installAuctionUncross } from './engine/auction-uncross.js';
import { installCollars } from './engine/collars.js';
import { installHaltLaw } from './engine/halt-law.js';
import { installBulkItems } from './engine/bulk-items.js';
import { installCoreTif } from './engine/core-tif.js';
import { installIfmCrash } from './engine/ifm-crash.js';
import { installL3Queue } from './engine/l3-queue.js';
import { installCertRefuse } from './engine/cert-refuse.js';
import { installComboBook } from './engine/combo-book.js';
import { installMassQuote } from './engine/mass-quote.js';
import { installMmp } from './engine/mmp.js';
import { installSurveillancePersist } from './engine/surveillance-persist.js';
import { installRulebookRefuse } from './engine/rulebook-refuse.js';
import { installLiquidity } from './engine/liquidity.js';
import { FileJournal } from './engine/journal.js';
import { shutdownMatching } from './shutdown.js';
import { registerHealth } from './health.js';
import { registerMetrics } from './metrics.js';
import { registerRoutes } from './router.js';
import { createIdentityApprovalClient, parseOperatorIds, unwiredApprovalConsumer } from './action-approval-consume.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { openAfterReplay } from './open-after-replay.js';
import { createReplayHoldLookup, unwiredReplayHoldLookup } from './replay-hold.js';

installCodFence();
installAuctionUncross();
installCollars();
installHaltLaw();
installBulkItems();
installCoreTif();
installIfmCrash();
installL3Queue();
installCertRefuse();
installComboBook();
installMassQuote();
installMmp();
installSurveillancePersist();
installRulebookRefuse();
installLiquidity();

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
 * svc-matching — THE ENGINE (§5.1).
 *
 * Boot order matters and it is not the same order as svc-ledger's: the journal
 * comes first, and the books are replayed from it before anything can reach a
 * port. §5.1's recovery guarantee is only a guarantee if the process refuses to
 * accept an order until it has finished remembering the ones it already took.
 */

mkdirSync(dirname(env.MATCHING_JOURNAL_PATH), { recursive: true });
const journal = new FileJournal(env.MATCHING_JOURNAL_PATH);

const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: ['matching'],
});

const snapshotSink = new MemorySnapshotSink();
const engine = new MatchingEngine({
  journal,
  bus,
  clock: () => new Date(),
  snapshotEvery: env.MATCHING_SNAPSHOT_EVERY,
  snapshotSink,
  enabled: env.MATCHING_ENGINE_ENABLED,
});

const app = Fastify({ logger: { level: env.LOG_LEVEL } });

/**
 * §14.5 — the engine's scrape surface. Not the user SLO (that is svc-edge);
 * this is this process's HTTP latency. Registered before listen so the
 * `onResponse` hook is in place for every reply the process sends.
 *
 * `tooling/infra/prometheus.yaml` scrapes this at `svc-matching:4005/metrics`.
 * `observability-wiring.test.ts` asserts that host, port and path against the
 * real compose file. `metrics.boot.e2e.test.ts` fails if this call is deleted.
 */
registerMetrics(app, { service: env.SERVICE_NAME });

registerHealth(app, env.SERVICE_NAME, engine, journal);

/**
 * Readiness is stricter than liveness. A disabled engine is alive — it still
 * serves depth and still answers health — but it must not receive orders, so
 * the load balancer takes it out of rotation rather than letting every
 * submission come back rejected.
 */
app.get('/ready', async (_req, reply) => {
  if (!engine.isEnabled) return reply.code(503).send({ ready: false, reason: 'matching.engine flag is off' });
  if (!engine.admissionOpen) {
    return reply.code(503).send({ ready: false, reason: engine.admissionReason ?? 'matching.hold_check_unreachable' });
  }
  return { ready: true, sequence: engine.markets.length };
});

const actionApprovals = env.IDENTITY_URL
  ? createIdentityApprovalClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET)
  : unwiredApprovalConsumer();

registerRoutes(app, engine, env.INTERNAL_SERVICE_SECRET, {
  // Fleet compose still defaults INTERNAL_SERVICE_BODY_BIND to accept-both
  // (compose-pin tests are law). Order writes are money instructions: unbound
  // v1 HMAC must 401 here. Callers already send serviceAuthHeadersForBody.
  bodyBind: 'require',
  rulebookVersion: env.MATCHING_RULEBOOK_VERSION,
  approvals: actionApprovals,
  operatorIds: parseOperatorIds(env.MATCHING_OPERATOR_IDS),
  ...(env.EDGE_PRINCIPAL_SECRET ? { edgePrincipalSecret: env.EDGE_PRINCIPAL_SECRET } : {}),
  ...edgeTrustFromEnv(env),
});

const holds = env.LEDGER_URL
  ? createReplayHoldLookup(
      createHttpLedgerClient({
        baseUrl: env.LEDGER_URL,
        sign: (payload) => serviceAuthHeadersForBody('svc-matching', env.INTERNAL_SERVICE_SECRET, payload),
        timeoutMs: 4_000,
        retries: 1,
        retryBaseDelayMs: 200,
      }),
    )
  : unwiredReplayHoldLookup();

// Replay, confirm holds, then listen. A startup publish that keeps timing out
// exits here — the process has not called listen, so it is not a half-started
// engine. A hold service that cannot be asked still listens, with /ready 503
// and the reason on /health, and submit refuses. The book does not open.
const boot = await openAfterReplay({
  engine,
  holds,
  listen: async () => {
    await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
  },
});
if (boot.exit !== 0) {
  const message = boot.message ?? 'svc-matching startup publish failed';
  app.log.error(message);
  console.error(message);
  try {
    await bus.close();
  } catch {
    // The bus is why we are leaving. Closing it must not hide the timeout.
  }
  journal.close();
  process.exit(boot.exit);
}

const restingAtBoot = engine.restingOrderCount;
app.log.info(
  {
    port: env.HTTP_PORT,
    ...boot.recovered,
    restingOrders: restingAtBoot,
    holdCheck: boot.gate,
  },
  boot.gate?.open
    ? 'svc-matching ready — books replayed from journal'
    : 'svc-matching up — replay hold check failed closed, market stays closed',
);

if (boot.gate && !boot.gate.open) {
  app.log.error(
    { reason: boot.gate.reason, restingOrders: restingAtBoot },
    'replayed resting orders were not confirmed against ledger holds — market stays closed',
  );
} else if (boot.gate && (boot.gate.pulled.length > 0 || boot.gate.halted.length > 0)) {
  app.log.warn(
    { pulled: boot.gate.pulled, halted: boot.gate.halted },
    'replayed orders whose holds were missing, short, or unreadable were pulled or their markets halted',
  );
}

// Drain rather than drop: an in-flight submission finishes, its events publish,
// and the journal file descriptor closes cleanly before the process exits.
// A rejected app.close() or bus.close() still closes the journal and exits.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdownMatching({
      engine,
      app,
      bus,
      journal,
      exit: process.exit,
    });
  });
}
