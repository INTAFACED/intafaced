import { createArchiveClient } from './outreach/archive-publication.js';
import Fastify from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { migrateOutreach } from './db/migrate.js';
import { OutreachCrm } from './outreach/crm.js';
import { OutreachError } from './outreach/config.js';
import { createFounderAuthority } from './outreach/authority.js';
import { createClientIpResolver } from './outreach/client-ip.js';
import { SqlConsoleModeStore } from './console-mode/store.js';
import { StaffHoldDesk } from './staff-holds/desk.js';
import { createStaffHoldLedger } from './staff-holds/ledger.js';
import { SqlStaffHoldStore } from './staff-holds/store.js';
import { SqlAnnouncementStore } from './console-announcements/store.js';
import { SqlPreferenceStore } from './console-preferences/store.js';
import { SqlServiceRecordStore } from './service-records/store.js';
import { SqlPublicSettingsBook } from './outreach/public-settings.js';
import { createFeeRevenueClient } from './fee-revenue-client.js';
import { createOutreachNotificationClient } from './outreach/notification-client.js';
import { OutreachNotificationWorker } from './outreach/notification-worker.js';
import { createPgAlertRuleStore } from './alerts/rule-store.js';
import { createPgComplianceStore } from './compliance/store.js';
import { AlertRules } from './alerts/rules.js';
import { AlertEvaluator } from './alerts/runner.js';
import { warehouseSignalReader } from './alerts/signals.js';
import { createPgAlertState } from './alerts/state-store.js';
import { createPgAlertDesk } from './alerts/desk-store.js';
import { createPgRestoreStore } from './restore-store.js';
import { probeRestoreArchive } from './restore/archive-probe.js';
import { createRestoreDesk } from './restore/desk.js';
import { createPgRestoreRunStore } from './restore/run-store.js';
import { createWatermarkReader } from './restore/watermark-reader.js';
import { createPgVenueCostStore } from './venue-cost-store.js';
import { createListingDesk } from './protocol-listing/wiring.js';
import { createPgListingStore } from './protocol-listing/store.js';
import { createPgReasonCodeStore, createReasonCodes } from './protocol-listing/reason-codes.js';
import { reapplyCompletedErasures } from './outreach/restore-privacy.js';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { buildEdgeContext } from './edge-context.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { s2sFromEnv } from '@intafaced/contracts';
import { env } from './env.js';
import { createOpsRouter, type OpsRouter } from './router.js';
import { createOpsApprovalClient } from './operator-desks.js';
import { OpsService } from './ops-service.js';
import { OPS_IDENTITY_UNWIRED, OPS_SUPPORT_UNWIRED, OpsError } from './codes.js';
import { opsReadyUrlHonesty } from './ready-honesty.js';
import { homeConfigFromEnv } from './home-config.js';
import { createEvaluationFeedClient } from './reconciliation-alerts/feed-client.js';
import { ingestReconciliationEvaluations } from './reconciliation-alerts/ingest.js';
import { ReconciliationAlertStore } from './reconciliation-alerts/store.js';
import { createCorrectiveTxClient } from './reconciliation-alerts/transactions-client.js';
import { relayAlertEvents, subscribeRunFailed } from './reconciliation-alerts/events.js';
import { JetStreamEventBus } from '@intafaced/events';

if (process.env.OPS_OUTREACH_RESTORE_QUARANTINED === '1') throw new Error('ops.crm.restore_quarantined');

registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-ops — CRM / team / warehouse revenue / projects / fundraising records.
 * No balances of its own. That is not a certified non-custodial plane.
 * Unwired warehouse refuses ops.warehouse_unwired.
 * Payroll is never invented. Fundraising fund/escrow refuses ops.fundraising_chain_unwired.
 * Custody wrap blank refuses ops.custody_wrap_unset. Keys stay empty — never invented.
 * Freeze policy blank/unknown refuses ops.custody_freeze_unset; frozen refuses ops.custody_frozen.
 */
const ops = new OpsService({
  warehouseEnv: process.env,
  custodyWrap: env.OPS_CUSTODY_WRAP,
  custodyFreezePolicy: env.OPS_CUSTODY_FREEZE_POLICY,
  // Hardcoded absent — IDENTITY_URL / SUPPORT_URL are not clients. Do not fetch.
  identitySource: async () => ({ status: 'absent', code: OPS_IDENTITY_UNWIRED, rows: [] }),
  supportSource: async () => ({ status: 'absent', code: OPS_SUPPORT_UNWIRED, rows: [] }),
  identityTeamSource: async () => ({ status: 'absent', code: OPS_IDENTITY_UNWIRED, rows: [] }),
});

const archivePublisher = createArchiveClient({
  environment: env.APP_ENV,
  url: env.OPS_ERASURE_ARCHIVE_URL,
  secret: env.OPS_ERASURE_ARCHIVE_SECRET,
  fleetSecrets: [env.INTERNAL_SERVICE_SECRET, env.EDGE_PRINCIPAL_SECRET, env.OPS_NOTIFY_SERVICE_SECRET],
});
let crmSql: ReturnType<typeof postgres> | null = null;
const poolMax = Number(process.env.OPS_DATABASE_POOL_MAX);
if (process.env.DATABASE_URL && Number.isInteger(poolMax) && poolMax > 0) {
  const candidate = postgres(process.env.DATABASE_URL, {
    max: poolMax,
    onnotice: () => undefined,
    connection: { application_name: 'ops', statement_timeout: 15000 },
  });
  try {
    await migrateOutreach(candidate);
    await reapplyCompletedErasures(candidate, archivePublisher);
    crmSql = candidate;
  } catch {
    await candidate.end({ timeout: 1 });
  }
}
const alertRuleStore = crmSql ? createPgAlertRuleStore(crmSql) : null;
const alertState = crmSql ? createPgAlertState(crmSql) : null;
const alertDesk = crmSql ? createPgAlertDesk(crmSql) : undefined;
let outreachConfiguration: unknown = null;
try {
  outreachConfiguration = JSON.parse(process.env.OPS_OUTREACH_CONFIG ?? 'null');
} catch {
  /* Invalid configuration refuses intake. */
}
// Per-service keys (S2S v3): with no S2S_AUTH_MODE every call stays on its shared secret.
const s2s = s2sFromEnv(env, 'svc-ops');
const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
const evaluationFeed = createEvaluationFeedClient({
  ledgerUrl: env.LEDGER_URL,
  secret: env.INTERNAL_SERVICE_SECRET,
  ...(s2sKey ? { s2s: s2sKey } : {}),
});
const notificationPort = createOutreachNotificationClient({
  notifyUrl: env.NOTIFY_URL,
  secret: env.OPS_NOTIFY_SERVICE_SECRET,
  ...(s2sKey ? { s2s: s2sKey } : {}),
});

const crm = new OutreachCrm(crmSql, outreachConfiguration, undefined, notificationPort, archivePublisher);
const notificationWorker = crmSql ? new OutreachNotificationWorker(crmSql, notificationPort) : null;
const approvalConsumer =
  env.IDENTITY_URL && env.INTERNAL_SERVICE_SECRET
    ? createOpsApprovalClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey)
    : undefined;
// Reconciliation alerts (OPS-reconciliation-03, -04): the store, the ledger's settled evaluations it reads, the ledger door
// a fix's corrective transactions are checked against, and identity's approvals an acceptance spends.
const reconciliationAlerts = crmSql
  ? new ReconciliationAlertStore(crmSql, {
      repeatSeconds: env.OPS_RECON_ALERT_REPEAT_SECONDS ?? null,
      approvals: approvalConsumer,
      correctiveTx: createCorrectiveTxClient({
        ledgerUrl: env.LEDGER_URL,
        secret: env.INTERNAL_SERVICE_SECRET,
        ...(s2sKey ? { s2s: s2sKey } : {}),
      }),
    })
  : null;
let reconciliationBus: JetStreamEventBus | null = null;
const staffHolds = new StaffHoldDesk({
  store: crmSql ? new SqlStaffHoldStore(crmSql) : undefined,
  ledger: createStaffHoldLedger({ ledgerUrl: env.LEDGER_URL, secret: env.INTERNAL_SERVICE_SECRET, ...(s2sKey ? { s2s: s2sKey } : {}) }),
  approvals: approvalConsumer,
  settings: {
    confirmAccount: env.OPS_STAFF_HOLD_CONFIRM_ACCOUNT ?? null,
    expiryMaxHours: env.OPS_STAFF_HOLD_EXPIRY_MAX_HOURS ?? null,
  },
  now: () => new Date(),
  // Runs only from the hold timer below, after the server exists.
  onWorkerError: (holdNo, error) => {
    const code = error instanceof OpsError ? error.code : 'ops.hold_worker_unavailable';
    app.log.warn({ code, holdNo }, 'Staff hold worker skipped one hold; it retries on the next tick');
  },
});
const protocolReasonCodes = env.OPS_PROTOCOL_REASON_CODES
  ? env.OPS_PROTOCOL_REASON_CODES.split(',')
      .map((code) => code.trim())
      .filter(Boolean)
  : null;
const appRouter = createOpsRouter(
  ops,
  {
    crm,
    ...(crmSql ? { publicSettings: new SqlPublicSettingsBook(crmSql) } : {}),
    authority: createFounderAuthority({
      identityUrl: env.IDENTITY_URL,
      serviceSecret: process.env.INTERNAL_SERVICE_SECRET,
    }),
  },
  {
    restoreArchiveUrl: env.OPS_RESTORE_ARCHIVE_URL,
    restoreArchiveProbe: (url) => probeRestoreArchive(url),
    restoreStamps: crmSql ? createPgRestoreStore(crmSql) : undefined,
    restoreDesk: crmSql
      ? createRestoreDesk({
          store: createPgRestoreRunStore(crmSql),
          stamps: createPgRestoreStore(crmSql),
          reader: createWatermarkReader({
            urls: { ledger: env.LEDGER_URL, identity: env.IDENTITY_URL, bank: env.BANK_URL, pay: env.PAY_URL },
            secret: env.INTERNAL_SERVICE_SECRET,
            ...(s2sKey ? { s2s: s2sKey } : {}),
          }),
          approvals: approvalConsumer,
          archiveUrl: () => env.OPS_RESTORE_ARCHIVE_URL,
          target: () => env.OPS_RESTORE_TARGET ?? null,
          now: () => new Date().toISOString(),
        })
      : undefined,
    venueCosts: crmSql ? createPgVenueCostStore(crmSql) : undefined,
    feeRevenue: createFeeRevenueClient({
      ledgerUrl: env.LEDGER_URL,
      secret: env.INTERNAL_SERVICE_SECRET,
      ...(s2sKey ? { s2s: s2sKey } : {}),
    }),
    alertRules: alertRuleStore ? new AlertRules(alertRuleStore, () => new Date().toISOString(), randomUUID, alertDesk) : undefined,
    alertState: alertState ?? undefined,
    alertDesk,
    alertHeartbeatMaxAgeSeconds: env.OPS_ALERT_HEARTBEAT_MAX_AGE_SECONDS ?? null,
    compliance: crmSql ? createPgComplianceStore(crmSql) : undefined,
    consoleMode: crmSql ? new SqlConsoleModeStore(crmSql) : undefined,
    announcements: crmSql ? new SqlAnnouncementStore(crmSql) : undefined,
    preferences: crmSql ? new SqlPreferenceStore(crmSql) : undefined,
    serviceRecords: crmSql ? new SqlServiceRecordStore(crmSql) : undefined,
    staffHolds,
    homeConfig: homeConfigFromEnv(env),
    reconciliationAlerts: reconciliationAlerts ?? undefined,
    reconciliationBus: () => (reconciliationBus ? 'attached' : 'detached'),
    approvals: approvalConsumer,
    protocolListing: crmSql
      ? createListingDesk({
          store: createPgListingStore(crmSql),
          approvals: approvalConsumer,
          reasonCodes: createReasonCodes({
            store: createPgReasonCodeStore(crmSql),
            envCodes: protocolReasonCodes,
            now: () => new Date().toISOString(),
          }),
          now: () => new Date().toISOString(),
        })
      : undefined,
  },
);
const edgeContext = buildEdgeContext(env);

const resolveClientIp = createClientIpResolver(process.env.OPS_TRUSTED_PROXY_CIDRS);
const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000, trustProxy: false });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async () => ({
  ready: true,
  // Env URL is configured, not a live probe. Sources stay hardcoded-absent. This process does not fetch.
  ...opsReadyUrlHonesty(env),
  outreach: {
    storage: crmSql ? 'configured' : 'unavailable',
    notifications: { ingress: notificationPort.configured ? 'configured' : 'unconfigured', gateway: 'unverified' },
    engagement: { status: 'disabled', reason: 'api_access_unavailable' },
  },
  alerts: {
    storage: crmSql ? 'configured' : 'unavailable',
    evaluator: crmSql ? 'running' : 'unavailable',
    reconciliationFeed: reconciliationAlerts ? (evaluationFeed.configured ? 'configured' : 'unconfigured') : 'unavailable',
    // Rule-alert events stay in their outbox; reconciliation alert events are published from theirs while the bus is attached.
    events: 'outbox_only',
    reconciliationEvents: !reconciliationAlerts
      ? 'unavailable'
      : reconciliationBus
        ? 'attached'
        : env.NATS_URL
          ? 'detached'
          : 'unconfigured',
  },
}));

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: async ({ req }) => ({
      ...(await edgeContext(req)),
      outreachAbuseKey: createHash('sha256')
        .update(resolveClientIp(req.raw.socket.remoteAddress, req.headers['x-intafaced-client-ip']))
        .digest('hex'),
    }),
  } satisfies FastifyTRPCPluginOptions<OpsRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info({ port: env.HTTP_PORT }, 'svc-ops ready');

let notificationRun: Promise<void> | null = null;
const notificationTimer = setInterval(() => {
  if (!notificationWorker || notificationRun) return;
  notificationRun = (async () => {
    for (let count = 0; count < 5; count++) if (!(await notificationWorker.runOnce())) break;
  })()
    .catch(() => {
      app.log.warn({ code: 'ops.crm.notification_worker_unavailable' }, 'Outreach queue remains pending');
    })
    .finally(() => {
      notificationRun = null;
    });
}, 1000);
notificationTimer.unref();

// Alert evaluation. Each rule runs on its own stored interval; this tick only asks which rules are due. Events wait in the durable
// outbox: no bus is wired from this process yet, so nothing is published and /ready says so.
const alertEvaluator =
  alertRuleStore && alertState
    ? new AlertEvaluator({
        rules: alertRuleStore,
        state: alertState,
        signals: warehouseSignalReader(ops),
        ...(alertDesk ? { desk: alertDesk } : {}),
      })
    : null;
let alertRun: Promise<void> | null = null;
const alertTimer = setInterval(() => {
  if (!alertEvaluator || alertRun) return;
  alertRun = alertEvaluator
    .tick()
    .then(() => undefined)
    .catch(() => {
      app.log.warn({ code: 'ops.alert_evaluator_unavailable' }, 'Alert evaluation will retry on the next tick');
    })
    .finally(() => {
      alertRun = null;
    });
}, 5000);
alertTimer.unref();

// Reconciliation alerts: read the ledger's settled evaluations from the stored cursor. A failed read is kept as the source
// being unavailable, which every alert answer shows; the next tick reads the same rows again.
let reconciliationRun: Promise<void> | null = null;
const reconciliationTimer = setInterval(() => {
  if (!reconciliationAlerts || reconciliationRun) return;
  reconciliationRun = ingestReconciliationEvaluations(reconciliationAlerts, evaluationFeed)
    .then(() => undefined)
    .catch(() => {
      app.log.warn({ code: 'ops.reconciliation_feed_unavailable' }, 'Reconciliation alerts will read again on the next tick');
    })
    .finally(() => {
      reconciliationRun = null;
      // Not wired: the first tick recorded why, and nothing changes until a restart with the ledger set.
      if (!evaluationFeed.configured) clearInterval(reconciliationTimer);
    });
}, 5000);
reconciliationTimer.unref();

/**
 * The event bus for reconciliation alerts: svc-ops owns the `core-ops` stream, publishes each queued transition from its
 * outbox and stores each `ledger.reconciliation_run.failed` as one platform incident. A failed connect or attach is
 * logged, not fatal, and tried again; the outbox keeps every event and JetStream keeps the ledger's for the durable consumer.
 */
const BUS_RETRY_MS = 15_000;
async function attachReconciliationBus(): Promise<void> {
  if (!crmSql || !reconciliationAlerts || !env.NATS_URL) return;
  let connected: JetStreamEventBus | null = null;
  try {
    connected = await JetStreamEventBus.connect({
      servers: env.NATS_URL,
      producer: env.SERVICE_NAME,
      streamPrefix: env.NATS_STREAM_PREFIX,
      ownedStreams: ['core-ops'],
    });
    await subscribeRunFailed({ sql: crmSql, bus: connected, now: () => new Date() });
    reconciliationBus = connected;
  } catch (err) {
    app.log.warn({ err, code: 'ops.reconciliation_bus_unavailable' }, 'svc-ops could not attach to the event bus; trying again');
    await connected?.close().catch(() => undefined);
    setTimeout(() => void attachReconciliationBus(), BUS_RETRY_MS).unref();
  }
}
await attachReconciliationBus();
let relayRun: Promise<void> | null = null;
const relayTimer = setInterval(() => {
  const bus = reconciliationBus;
  if (!crmSql || !bus || relayRun) return;
  const sql = crmSql;
  relayRun = relayAlertEvents({ sql, bus, now: () => new Date() })
    .then(() => undefined)
    .catch(() => {
      app.log.warn({ code: 'ops.reconciliation_relay_unavailable' }, 'Reconciliation alert events stay queued for the next tick');
    })
    .finally(() => {
      relayRun = null;
    });
}, 3000);
relayTimer.unref();

// Explicit approved config enables this owned bounded scheduler; absent config does no work.
let retentionRun: Promise<void> | null = null;
const retentionTimer = setInterval(() => {
  if (!crmSql || retentionRun) return;
  retentionRun = (async () => {
    for (let count = 0; count < 5; count++) if (!(await crm.privacy.runRetentionOnce())) break;
  })()
    .catch((error: unknown) => {
      const code = error instanceof OutreachError ? error.code : 'ops.crm.retention_worker_unavailable';
      app.log.warn({ code }, 'Outreach erasure remains pending; inspect owner recovery status');
    })
    .finally(() => {
      retentionRun = null;
    });
}, 60000);
retentionTimer.unref();

// Staff holds (LC-9): release what is left of each hold whose stored expiry has passed, then settle any post whose answer
// was lost or that the posting freeze turned back, then read again the keys of posts declared lost in the last day. None
// ever sends anything but a stored request under its stored key. Each runs on its own, so a failing pass never stops the
// next.
const holdWarn = (step: string) => (error: unknown) => {
  const code = error instanceof OpsError ? error.code : 'ops.hold_worker_unavailable';
  app.log.warn({ code, step }, 'Staff hold worker will retry on the next tick');
};
let holdRun: Promise<void> | null = null;
const holdTimer = setInterval(() => {
  if (!staffHolds.active || holdRun) return;
  holdRun = (async () => {
    await staffHolds.expireDue().catch(holdWarn('expiry'));
    await staffHolds.resolve().catch(holdWarn('settle'));
    await staffHolds.recheckLost().catch(holdWarn('recheck'));
  })().finally(() => {
    holdRun = null;
  });
}, 5000);
holdTimer.unref();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      clearInterval(notificationTimer);
      clearInterval(retentionTimer);
      clearInterval(alertTimer);
      clearInterval(reconciliationTimer);
      clearInterval(holdTimer);
      clearInterval(relayTimer);
      await app.close();
      await notificationRun;
      await retentionRun;
      await alertRun;
      await reconciliationRun;
      await holdRun;
      await relayRun;
      await reconciliationBus?.close().catch(() => undefined);
      await crmSql?.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
