import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Fastify from 'fastify';
import { JetStreamEventBus } from '@intafaced/events';
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

// Replay before listening — not after, and never lazily on first request.
const recovered = await engine.recover();

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
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });

// The boot line carries the resting count too. Recovery previously reported
// records and markets, which say how much was replayed and not what is now
// standing — and what is now standing is the part another system has to agree
// with.
//
// BOOT CHECK, NOT BOOT REPAIR — deliberately. This service cannot reconcile by
// itself: it has no `DATABASE_URL` (`env.ts` says so, and why), so it does not
// know whether anyone is holding funds against these orders. Comparing requires
// the counterpart's view, which arrives over `POST /reconcile`. What boot CAN
// do honestly is refuse to be quiet about the condition, and that is this.
//
// It does not exit non-zero. An engine that replayed orders is still the only
// thing that can cancel them, and a process that dies on the way up cannot be
// asked anything — including "what are you holding".
const restingAtBoot = engine.restingOrderCount;
app.log.info({ port: env.HTTP_PORT, ...recovered, restingOrders: restingAtBoot }, 'svc-matching ready — books replayed from journal');

if (restingAtBoot > 0) {
  app.log.warn(
    { restingOrders: restingAtBoot, markets: engine.markets.length },
    'engine replayed live orders from the journal — nothing here has checked that anyone still holds funds for them. ' +
      'The journal survives a database reset, so these books can outlive the orders that justified them. ' +
      'Compare before trusting them: GET /markets/:marketId/orders for this side, POST /reconcile with the ' +
      "order owner's view for both (service credentials required; see services/svc-matching/README.md).",
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
