import postgres from 'postgres';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext, s2sFromEnv } from '@intafaced/contracts';
import { env } from './env.js';
import { createAccountStateClient } from './account-state.js';
import { createTicketOrderClient, DarkTicketOrderSource } from './ticket-order.js';
import { createSupportHttpApp } from './http-app.js';
import { SqlContactBook } from './contact-channels.js';
import { SqlAttachmentSettingsBook } from './attachment-settings.js';
import { SqlSurveyBook } from './survey-settings.js';
import { SqlHelpCentreBook } from './help-centre.js';
import { RequestForms, SqlFormsStore } from './request-forms.js';
import { SqlKbLibraryBook } from './kb-library.js';
import { KbAuthoring } from './kb-authoring.js';
import { SqlKbReviewBook } from './kb-review.js';
import { createIdentityApprovalClient } from './action-approval-consume.js';
import { SqlGroupBook } from './desk-groups.js';
import { SqlViewBook } from './desk-views.js';
import { DeskMacros, SqlMacroBook } from './desk-macros.js';
import { SqlPropertiesBook } from './desk-properties.js';
import { SqlLifecycleBook } from './ticket-lifecycle.js';
import { JetStreamEventBus } from '@intafaced/events';
import { eventRatingRequestSink, RatingRequestOutbox, SqlRatingRequestBook } from './rating-request.js';
import { SqlStaffBook } from './desk-staff.js';
import { UNCONFIGURED_ATTACHMENTS } from './attachments.js';
import { openLocalTestAttachments } from './local-test-attachments.js';
import { SupportService } from './support-service.js';
import { PostgresSupportStore } from './store.js';
import { createSupportRouter } from './router.js';
import { createTicketKbLoopObserver } from './ticket-kb-loop-observation.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';

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
 * svc-support — tickets + KB + operator queue (ops.support).
 * Durable Postgres store. No ledger. No balances.
 */
const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'support,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM support.tickets LIMIT 1`.catch(() => {
  throw new Error('support schema is missing — run migrations before starting svc-support');
});

// Migration 0001 is checked separately from 0000. A desk booting on 0000 alone
// would serve tickets and silently record no history — the audit trail would be
// permanently empty and nothing would say why, which is the failure mode this
// whole slice exists to remove.
await sql`SELECT 1 FROM support.ticket_events LIMIT 1`.catch(() => {
  throw new Error('support.ticket_events is missing — apply migration 0001 before starting svc-support');
});

await sql`SELECT 1 FROM support.kb_articles LIMIT 1`.catch(() => {
  throw new Error('support.kb_articles is missing — apply migration 0003 before starting svc-support');
});

await sql`SELECT 1 FROM support.staff LIMIT 1`.catch(() => {
  throw new Error('support.staff is missing — apply migration 0012 before starting svc-support');
});

await sql`SELECT 1 FROM support.contact_channels LIMIT 1`.catch(() => {
  throw new Error('support.contact_channels is missing — apply migration 0020 before starting svc-support');
});

await sql`SELECT audience FROM support.kb_article_versions LIMIT 1`.catch(() => {
  throw new Error('support.kb_article_versions.audience is missing — apply migration 0022 before starting svc-support');
});

await sql`SELECT scan_state FROM support.ticket_attachments LIMIT 1`.catch(() => {
  throw new Error('support.ticket_attachments.scan_state is missing — apply migration 0024 before starting svc-support');
});

await sql`SELECT uploaded_by FROM support.ticket_attachments LIMIT 1`.catch(() => {
  throw new Error('support.ticket_attachments.uploaded_by is missing — apply migration 0025 before starting svc-support');
});

await sql`SELECT 1 FROM support.attachment_settings_log LIMIT 1`.catch(() => {
  throw new Error('support.attachment_settings_log is missing — apply migration 0023 before starting svc-support');
});
await sql`SELECT 1 FROM support.survey_log LIMIT 1`.catch(() => {
  throw new Error('support.survey_log is missing — apply migration 0027 before starting svc-support');
});
await sql`SELECT 1 FROM support.help_centre_log LIMIT 1`.catch(() => {
  throw new Error('support.help_centre_log is missing — apply migration 0031 before starting svc-support');
});
await sql`SELECT 1 FROM support.request_definitions LIMIT 1`.catch(() => {
  throw new Error('support.request_definitions is missing — apply migration 20261024072429_request_forms before starting svc-support');
});
await sql`SELECT 1 FROM support.kb_library_log LIMIT 1`.catch(() => {
  throw new Error('support.kb_library_log is missing — apply migration 0032 before starting svc-support');
});

await sql`SELECT shortcode, title FROM support.desk_macros LIMIT 1`.catch(() => {
  throw new Error('support.desk_macros is missing — apply migration 20261029161000_desk_macros before starting svc-support');
});
await sql`SELECT 1 FROM support.desk_macro_log LIMIT 1`.catch(() => {
  throw new Error('support.desk_macro_log is missing — apply migration 20261029161000_desk_macros before starting svc-support');
});
await sql`SELECT 1 FROM support.staff_signatures LIMIT 1`.catch(() => {
  throw new Error('support.staff_signatures is missing — apply migration 20261029161000_desk_macros before starting svc-support');
});
await sql`SELECT visibility FROM support.comments LIMIT 1`.catch(() => {
  throw new Error('support.comments.visibility is missing — apply migration 20261029180000_internal_notes before starting svc-support');
});

await sql`SELECT 1 FROM support.rating_requests LIMIT 1`.catch(() => {
  throw new Error('support.rating_requests is missing — apply migration 0021 before starting svc-support');
});

/**
 * `ownedStreams: ['support']` — this process creates `INTAFACED_SUPPORT`. The one subject
 * on it says a request was resolved, so svc-notify can ask the customer to rate it. The bus
 * is connected on first need and again on each sweep until it answers: a bus that cannot be
 * reached leaves the asks pending in `support.rating_requests`, the desk still serves, and
 * they go out once it is back, with no restart.
 */
let bus: JetStreamEventBus | null = null;
let connecting: Promise<JetStreamEventBus | null> | null = null;
const connectBus = (): Promise<JetStreamEventBus | null> => {
  if (bus) return Promise.resolve(bus);
  connecting ??= JetStreamEventBus.connect({
    servers: env.NATS_URL,
    producer: env.SERVICE_NAME,
    streamPrefix: env.NATS_STREAM_PREFIX,
    ownedStreams: ['support'],
  })
    .then((connected) => (bus = connected))
    .catch((err: unknown) => {
      console.error('svc-support: event bus unreachable, rating requests stay pending', err);
      return null;
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
};
const attachmentSettings = new SqlAttachmentSettingsBook(sql);
const ratingRequests = new RatingRequestOutbox(new SqlRatingRequestBook(sql), async () => {
  const connected = await connectBus();
  return connected ? eventRatingRequestSink(connected) : null;
});

const store = new PostgresSupportStore(sql);
// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves the outgoing reads on the shared secret alone.
const s2s = s2sFromEnv(env, 'svc-support');
const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
// Account state is READ from svc-identity per request, never cached here.
const accounts = createAccountStateClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey);
// Order status is READ from svc-trade per request. Unset TRADE_URL stays unknown.
const orders = env.TRADE_URL ? createTicketOrderClient(env.TRADE_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) : new DarkTicketOrderSource();
// Both adapters stay blank unless a LOCAL-TEST name is set, and that is refused outside dev and test (attach then refuses).
const testAttachments = openLocalTestAttachments({
  appEnv: process.env.APP_ENV,
  store: env.SUPPORT_ATTACHMENT_STORE,
  scanner: env.SUPPORT_MALWARE_SCANNER,
});
// Third argument is the attachment desk; its size and type limits come from the owner's settings. Staff is fourth, orders fifth, then the blank-by-default staff heartbeat window.
const support = new SupportService(
  store,
  accounts,
  { ...UNCONFIGURED_ATTACHMENTS, store: testAttachments.store, scanner: testAttachments.scanner },
  new SqlStaffBook(sql),
  orders,
  env.STAFF_HEARTBEAT_WINDOW_SECONDS ?? null,
  undefined,
  new SqlGroupBook(sql),
  env.SUPPORT_ALL_GROUPS_ROLES,
  new SqlPropertiesBook(sql),
  new SqlLifecycleBook(sql),
  ratingRequests,
  attachmentSettings,
  env.SUPPORT_BULK_CAP ?? null,
  {
    feedbackRateLimit: env.SUPPORT_FEEDBACK_RATE_LIMIT ?? null,
    feedbackRateWindowSeconds: env.SUPPORT_FEEDBACK_RATE_WINDOW_SECONDS ?? null,
    assistantModel: env.SUPPORT_ASSISTANT_MODEL ?? null,
    searchQueryMax: env.SUPPORT_SEARCH_QUERY_MAX ?? null,
  },
  env.SUPPORT_COMMENT_CAP ?? null,
  new SqlViewBook(sql, {
    personal: env.SUPPORT_VIEW_PERSONAL_CAP ?? null,
    shared: env.SUPPORT_VIEW_SHARED_CAP ?? null,
  }),
  env.SUPPORT_FRAUD_GROUP ?? null,
  env.SUPPORT_CUSTOMER_SEES ?? null,
);
const loop = createTicketKbLoopObserver();
const appRouter = createSupportRouter(
  support,
  loop,
  env.INTERNAL_SERVICE_SECRET,
  support,
  new SqlContactBook(sql),
  attachmentSettings,
  new SqlSurveyBook(sql, undefined, env.SUPPORT_SURVEY_CAP ?? null),
  createIdentityApprovalClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET),
  new SqlHelpCentreBook(sql),
  new SqlKbLibraryBook(sql),
  new RequestForms(new SqlFormsStore(sql), { forms: env.SUPPORT_FORM_CAP ?? null, fields: env.SUPPORT_FIELD_CAP ?? null }),
  new DeskMacros(new SqlMacroBook(sql), support, env.SUPPORT_MACRO_SHORTCODE_MIN ?? null),
  new KbAuthoring(store, new SqlKbReviewBook(sql)),
  env.SUPPORT_KB_SEGMENT_CAP ?? null,
);
const edgeContext = createEdgeContext({
  secret: env.EDGE_PRINCIPAL_SECRET,
  ...edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
});

const app = await createSupportHttpApp({
  router: appRouter,
  edgeContext,
  serviceName: env.SERVICE_NAME,
  identitySecret: env.INTERNAL_SERVICE_SECRET,
  loop,
  logLevel: env.LOG_LEVEL,
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info({ port: env.HTTP_PORT }, 'svc-support ready');

// Publish asks a crash or a bus outage left pending: once now, then each minute.
const sweep = (): void => void ratingRequests.flush().catch((err: unknown) => app.log.warn({ err }, 'rating request sweep failed'));
sweep();
const sweepTimer = setInterval(sweep, 60_000);
sweepTimer.unref();

// Held attachments: scanned again only when the owner has set both the interval and the batch. Blank runs no pass.
let rescanTimer: NodeJS.Timeout | null = null;
if (env.SUPPORT_ATTACHMENT_RESCAN_SECONDS && env.SUPPORT_ATTACHMENT_RESCAN_BATCH) {
  const batch = env.SUPPORT_ATTACHMENT_RESCAN_BATCH;
  const rescan = (): void =>
    void support.rescanHeldAttachments(batch).catch((err: unknown) => app.log.warn({ err }, 'attachment rescan failed'));
  rescanTimer = setInterval(rescan, env.SUPPORT_ATTACHMENT_RESCAN_SECONDS * 1000);
  rescanTimer.unref();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      clearInterval(sweepTimer);
      if (rescanTimer) clearInterval(rescanTimer);
      await app.close();
      await bus?.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
