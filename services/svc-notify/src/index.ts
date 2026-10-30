import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import { retainRawBody, s2sFromEnv, type StatusPage } from '@intafaced/contracts';
import { createGuestIngressContext } from './guests/context.js';
import { GuestNotificationService } from './guests/service.js';
import { GuestVerificationService } from './guests/verification.js';
import { JetStreamEventBus } from '@intafaced/events';
import { env } from './env.js';
import { PostgresNotifyStore } from './store.js';
import { PostgresRecipientHealthStore } from './recipient-health.js';
import { claimLeaseMsFromGatewayTimeout, DELIVERY_REAP_INTERVAL_MS, PostgresDeliveryStore, PostgresTargetStore } from './channel-store.js';
import { channelsFromEnv } from './channels/registry.js';
import { NotificationDispatcher } from './dispatch.js';
import { publishedMaxDeliveryAttempts } from './max-delivery-attempts.js';
import { PostgresMuteStore } from './preferences/mute-store.js';
import { AccountPrefs } from './preferences/account.js';
import { PostgresCommandLog, PostgresDigestPrefStore, PostgresHoldStore, PostgresTopicPrefStore } from './preferences/account.pg.js';
import { planOutOfApp } from './preferences/gate.js';
import { CategoryPrefs } from './preferences/categories.js';
import { PostgresCategoryPrefStore } from './preferences/categories.pg.js';
import { DIGEST_RELEASE_INTERVAL_MS } from './preferences/digest.js';
import { releaseDueHolds } from './preferences/release.js';
import { NoticeBoard } from './notices/board.js';
import { PostgresNoticeStore } from './notices/board.pg.js';
import { SqlStatusPageBook } from './status-page/book.js';
import { statusBadge, statusBadgeCacheControl, statusBadgeSvg } from './status-page/badge.js';
import { readStatusPage } from './status-page/router.js';
import { registerPublicReadApi } from './public-api.js';
import { SqlNavMetricStore } from './nav-metrics/counts.js';
import { openStatusMailer } from './status-page/mailer.js';
import { StatusSubscriptions } from './status-page/subscriptions.js';
import { SqlSubscriptionStore } from './status-page/subscriptions.pg.js';
import { IncidentTemplates } from './status-page/templates.js';
import { SqlTemplateStore } from './status-page/templates.pg.js';
import { Postmortems } from './status-page/postmortems.js';
import { MAINTENANCE_SWEEP_INTERVAL_MS, MaintenanceLifecycle } from './notices/maintenance.js';
import { SqlMaintenanceStore } from './notices/maintenance.pg.js';
import { SqlPostmortemStore } from './status-page/postmortems.pg.js';
import { audienceMembershipFromEnv } from './notices/audiences.js';
import { noticeApprovalConsumerFromProcessEnv } from './notices/approval.js';
import { ChannelSettings } from './ops-config/channel-settings.js';
import { PostgresChannelSettingsStore } from './ops-config/channel-settings.pg.js';
import { MessageTemplates } from './ops-config/templates.js';
import { PostgresTemplateStore } from './ops-config/templates.pg.js';
import { ContactPolicy } from './ops-config/contact-policy.js';
import { PostgresContactPolicyStore } from './ops-config/contact-policy.pg.js';
import { PostgresTargetRateLimiter } from './target-rate-limit.js';
import { NotifyService } from './notify-service.js';
import { createNotifyRouter, type NotifyRouter } from './router.js';
import { subscribeNotificationEvents } from './events.js';
import { ALERT_SWEEP_INTERVAL_MS, AlertService, type AlertSweepReport } from './alerts/service.js';
import { runAlertSweepPass } from './alerts/sweep-driver.js';
import { PostgresAlertStore } from './alerts/store.js';
import { PostgresAlertTriggerLog } from './alerts/trigger-log.js';
import { createTradeHttpMarkSource } from './alerts/trade-http-mark.js';
import { createDarkWhaleMarkSource, createTradeHttpWhaleMarkSource, parseWhaleFlowAllowlist } from './alerts/whale-mark.js';
import { ALERT_KIND_UNPUBLISHED, UNPUBLISHED_ALERT_KINDS, type MarkSource } from './alerts/types.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { loadMatchingVenueIncident } from './matching-venue-incident.js';
import { presentVenueIncident } from './venue-incident-truth.js';

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
 * svc-notify — event-driven fan-out (ops.notifications).
 *
 * Phase 5. In-app inbox, plus email / push / SMS behind one internal adapter
 * interface (§0.4). This process holds no balance (§0.6) and posts no ledger
 * transaction: it moves messages, not money.
 *
 * WHAT AN OPERATOR SHOULD READ ON BOOT
 *
 * `/ready` reports two things that are easy to get wrong and expensive to
 * discover late:
 *
 *   channels          which transports have credentials (`configured`), which
 *                     ones this deployment declared it DEPENDS ON, and the env
 *                     vars each missing one needs. URL+token is unprobed, not
 *                     available — this process does not POST at boot. A channel
 *                     with none is not "off" — it refuses every message with a
 *                     code that lands on the delivery record.
 *   pendingConsumers  subjects whose stream does not exist yet because the
 *                     producing service has not connected a bus. Nothing is
 *                     lost — the durable consumer attaches on a later boot and
 *                     JetStream replays the stream from the start — but it is
 *                     stated rather than left to be noticed.
 *
 * WHAT AN OPERATOR WILL NEVER READ HERE
 *
 * A required channel that is not wired. `env.ts` refuses to load in that state,
 * so this file is not reached — see NOTIFY_REQUIRED_CHANNELS. The unavailable
 * warnings below are therefore only ever about channels the operator chose not
 * to depend on.
 */

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'notify,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM notify.notifications LIMIT 1`.catch(() => {
  throw new Error('notify schema is missing — run migrations before starting svc-notify');
});
await sql`SELECT 1 FROM notify.deliveries LIMIT 1`.catch(() => {
  throw new Error('notify.deliveries is missing — run migration 0001_notify_channels before starting svc-notify');
});
await sql`SELECT 1 FROM notify.channel_mutes LIMIT 1`.catch(() => {
  throw new Error('notify.channel_mutes is missing — run migration 0003_notify_mute_prefs before starting svc-notify');
});
await sql`SELECT 1 FROM notify.target_rate_windows LIMIT 1`.catch(() => {
  throw new Error('notify.target_rate_windows is missing — run migration 0005_notify_target_rate_windows before starting svc-notify');
});
await sql`SELECT 1 FROM notify.price_alerts LIMIT 1`.catch(() => {
  throw new Error('notify.price_alerts is missing — run migration 0006_notify_price_alerts before starting svc-notify');
});
await sql`SELECT 1 FROM notify.topic_prefs LIMIT 1`.catch(() => {
  throw new Error('notify.topic_prefs is missing — run migration 0010_notify_topic_digest before starting svc-notify');
});
await sql`SELECT 1 FROM notify.category_prefs LIMIT 1`.catch(() => {
  throw new Error('notify.category_prefs is missing — run migration 0012_notify_category_prefs before starting svc-notify');
});
await sql`SELECT 1 FROM notify.digest_holds LIMIT 1`.catch(() => {
  throw new Error('notify.digest_holds is missing — run migration 0010_notify_topic_digest before starting svc-notify');
});
await sql`SELECT 1 FROM notify.notices LIMIT 1`.catch(() => {
  throw new Error('notify.notices is missing — run migration 0011_notify_public_notices before starting svc-notify');
});
await sql`SELECT impact, components, parent_id, resolves FROM notify.notices LIMIT 1`.catch(() => {
  throw new Error('notify.notices has no status feed columns — run migration 0013_notify_status_feed before starting svc-notify');
});

await sql`SELECT changelog FROM notify.notices LIMIT 1`.catch(() => {
  throw new Error('notify.notices has no changelog column — run migration 0015_notify_changelog_fields before starting svc-notify');
});
await sql`SELECT audience FROM notify.notices LIMIT 1`.catch(() => {
  throw new Error('notify.notices has no audience column — run migration 0034_notify_notice_audiences before starting svc-notify');
});

// Consumer only — trade / p2p / identity / token / bank own their streams.
// `ownedStreams: []` matches svc-ws: we never create a stream for subjects we do
// not publish, because a stream we created would accept publishes from nobody
// and quietly look healthy.
const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: [],
});

const store = new PostgresNotifyStore(sql);
const targets = new PostgresTargetStore(sql);
const recipientHealth = new PostgresRecipientHealthStore(sql);
const quarantineThreshold = env.NOTIFY_QUARANTINE_FAILURE_THRESHOLD ?? null;
// The claim lease has to outlast one gateway attempt and stay under the bus
// `ack_wait`. `claimLeaseMsFromGatewayTimeout` keeps both bounds when an
// operator raises NOTIFY_GATEWAY_TIMEOUT_MS toward MAX_GATEWAY_TIMEOUT_MS.
const deliveries = new PostgresDeliveryStore(sql, {
  leaseMs: claimLeaseMsFromGatewayTimeout(env.NOTIFY_GATEWAY_TIMEOUT_MS),
});
/** Last sweep result — surface on /ready so "is the stuck-pending reaper running?" is observable without log diving. */
let lastReapRetired = 0;
let lastReapAt: string | null = null;
const channels = channelsFromEnv(env);
if (env.NOTIFY_OPS_SERVICE_SECRET) {
  if (env.NOTIFY_OPS_SERVICE_SECRET === env.EDGE_PRINCIPAL_SECRET || env.NOTIFY_OPS_SERVICE_SECRET === process.env.INTERNAL_SERVICE_SECRET)
    throw new Error('Guest ops ingress requires a dedicated secret');
  await sql`SELECT 1 FROM notify.guest_notifications LIMIT 1`.catch(() => {
    throw new Error('Guest notification schema is missing — apply migration 0009_guest_notifications');
  });
}
if (env.NOTIFY_SUPPORT_SERVICE_SECRET) {
  const shared = [env.EDGE_PRINCIPAL_SECRET, process.env.INTERNAL_SERVICE_SECRET, env.NOTIFY_OPS_SERVICE_SECRET];
  if (shared.includes(env.NOTIFY_SUPPORT_SERVICE_SECRET)) throw new Error('Guest verification ingress requires a dedicated secret');
  await sql`SELECT 1 FROM notify.guest_verifications LIMIT 1`.catch(() => {
    throw new Error('Guest verification schema is missing — apply migration 0037_notify_guest_verifications');
  });
}
const guests = new GuestNotificationService(sql, channels.get('email'), {
  enabled: env.NOTIFY_FANOUT_ENABLED && env.NOTIFY_OUT_OF_APP_ENABLED,
  timeoutMs: env.NOTIFY_GATEWAY_TIMEOUT_MS,
  addressMaxPerWindow: env.NOTIFY_GUEST_ADDRESS_MAX_PER_WINDOW,
  addressWindowMs: env.NOTIFY_GUEST_ADDRESS_WINDOW_MS,
});
const muteStore = new PostgresMuteStore(sql);
const topicStore = new PostgresTopicPrefStore(sql);
const digestStore = new PostgresDigestPrefStore(sql);
const commandLog = new PostgresCommandLog(sql);
const holdStore = new PostgresHoldStore(sql);
const account = new AccountPrefs(topicStore, digestStore, commandLog, () => channels.status());
const categories = new CategoryPrefs(new PostgresCategoryPrefStore(sql), commandLog, () => channels.status());
// Per-service keys (S2S v3): with no S2S_AUTH_MODE the producer door and the approval call stay on the shared secrets alone.
const s2s = s2sFromEnv(env, 'svc-notify');
const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
const statusBook = new SqlStatusPageBook(sql);
// One email transport for status mail and the guest verification door: the owner's gateway, the LOCAL TEST outbox, or none.
const mailer = openStatusMailer({
  appEnv: env.APP_ENV,
  transport: env.NOTIFY_STATUS_MAIL_TRANSPORT,
  outboxPath: env.NOTIFY_STATUS_MAIL_OUTBOX,
  email: channels.get('email'),
  publicOrigin: env.NOTIFY_PUBLIC_ORIGIN,
});
const statusSubscriptions = new StatusSubscriptions({
  store: new SqlSubscriptionStore(sql),
  page: statusBook,
  mailer,
  secret: env.NOTIFY_STATUS_LINK_SECRET ?? null,
  linkTtlMinutes: env.NOTIFY_VERIFY_TTL_MINUTES ?? null,
  webhookTimeoutMs: env.NOTIFY_GATEWAY_TIMEOUT_MS,
});
const maintenanceStore = new SqlMaintenanceStore(sql);
const notices = new NoticeBoard(
  new PostgresNoticeStore(sql),
  noticeApprovalConsumerFromProcessEnv(s2sKey),
  commandLog,
  undefined,
  async () => (await statusBook.definition()).components.map((component) => component.id),
  (row) => statusSubscriptions.fanOut(row),
  (ids) => maintenanceStore.closedAmong(ids),
  async () => (await statusBook.definition()).noticeCategories,
  audienceMembershipFromEnv(env, s2sKey),
);
const maintenance = new MaintenanceLifecycle({
  store: maintenanceStore,
  notice: (id) => notices.maintenanceNotice(id),
  upcoming: (at, limit) => notices.upcomingMaintenance(at, limit),
  remind: (notice, offset) => statusSubscriptions.remind(notice, offset),
});
const opsApprovals = noticeApprovalConsumerFromProcessEnv(s2sKey);
const channelSettings = new ChannelSettings(new PostgresChannelSettingsStore(sql), opsApprovals, commandLog, () => channels.status());
const templates = new MessageTemplates(new PostgresTemplateStore(sql), opsApprovals, commandLog, {
  verifiedAddress: async (userId, channel) => {
    const target = (await targets.verified(userId)).find((row) => row.channel === channel);
    return target ? { address: target.address, locale: target.locale } : null;
  },
  channel: (channel) => channels.get(channel),
  status: () => channels.status(),
  disabled: () => channelSettings.disabled(),
});
const contactPolicy = new ContactPolicy(new PostgresContactPolicyStore(sql), opsApprovals, commandLog);
const maxAttempts = publishedMaxDeliveryAttempts(env.NOTIFY_MAX_DELIVERY_ATTEMPTS);
const dispatcher = new NotificationDispatcher(channels, targets, deliveries, {
  maxAttempts,
  outOfAppEnabled: env.NOTIFY_OUT_OF_APP_ENABLED,
  disabledChannels: () => channelSettings.disabled(),
  mutePrefsOf: (userId) => muteStore.get(userId),
  planOutOfApp: planOutOfApp({ account, holds: holdStore, now: () => new Date(), categories }),
  loadNotification: (userId, notificationId) => store.findById(userId, notificationId),
  recipientHealth: {
    quarantineOf: async (userId, channel, address) =>
      quarantineThreshold === null ? null : recipientHealth.quarantineOf(userId, channel, address),
    record: async (input) => {
      await recipientHealth.record({ ...input, code: input.code ?? undefined, threshold: quarantineThreshold, now: new Date() });
    },
  },
});

const targetRateLimiter = new PostgresTargetRateLimiter(sql);
const notify = new NotifyService(
  store,
  {
    fanoutEnabled: env.NOTIFY_FANOUT_ENABLED,
    verifyTtlMinutes: env.NOTIFY_VERIFY_TTL_MINUTES,
    verifyCodePepper: env.NOTIFY_VERIFY_CODE_PEPPER,
    targetRateLimiter,
  },
  {
    targets,
    deliveries,
    channels,
    dispatcher,
    muteStore,
    account,
    categories,
    holds: holdStore,
    notices,
    channelSettings,
    templates,
    contactPolicy,
    recipientHealth,
    quarantineThreshold,
  },
);

/**
 * v22.alerts mark port.
 *
 * Dark when TRADE_URL is unset — refuse rather than invent. Live when TRADE_URL
 * points at svc-trade's public REST (same ticker bank already uses for loan
 * marks). The live claim is never written as a literal on this entrypoint —
 * only createTradeHttpMarkSource does that, and only when a base URL is set.
 */
const darkMarks: MarkSource = {
  kind: 'dark',
  async quote() {
    return {
      kind: 'unavailable',
      reason: 'dark',
      detail: 'no mark source configured — refuse rather than invent',
    };
  },
};
const alertMarks: MarkSource = env.TRADE_URL
  ? createTradeHttpMarkSource({ baseUrl: env.TRADE_URL, marketsLimit: env.NOTIFY_MARKETS_LIST_LIMIT })
  : darkMarks;
/**
 * Whale flow mark. Dark unless TRADE_URL and a non-empty allow-list both exist.
 * Live claims live only inside createTradeHttpWhaleMarkSource — never here.
 * A live price print is not a volume.
 */
const whaleAllow = parseWhaleFlowAllowlist(env.NOTIFY_WHALE_FLOW_ALLOWLIST);
const whaleMarks: MarkSource =
  env.TRADE_URL && whaleAllow.length > 0
    ? createTradeHttpWhaleMarkSource({
        baseUrl: env.TRADE_URL,
        allowlist: whaleAllow,
        marketsLimit: env.NOTIFY_MARKETS_LIST_LIMIT,
      })
    : createDarkWhaleMarkSource();
const alerts = new AlertService(
  new PostgresAlertStore(sql),
  alertMarks,
  notify,
  whaleMarks,
  {
    maxExpiryDays: env.NOTIFY_ALERT_MAX_EXPIRY_DAYS ?? null,
    textMaxLength: env.NOTIFY_ALERT_TEXT_MAX_LENGTH ?? null,
    maxConditions: env.NOTIFY_ALERT_MAX_CONDITIONS ?? null,
    triggerLogDays: env.NOTIFY_ALERT_TRIGGER_LOG_DAYS ?? null,
    maxActivePrice: env.NOTIFY_ALERT_MAX_ACTIVE_PRICE ?? null,
    repeatFrequencies: env.NOTIFY_ALERT_FREQUENCIES ?? [],
    burstWindowMinutes: env.NOTIFY_ALERT_BURST_WINDOW_MINUTES ?? null,
    burstMaxTriggers: env.NOTIFY_ALERT_BURST_MAX_TRIGGERS ?? null,
  },
  new PostgresAlertTriggerLog(sql),
);
/** Last alert sweep — see the interval below. Null until the first pass completes. */
let lastAlertSweep: AlertSweepReport | null = null;
let lastAlertSweepAt: string | null = null;

/**
 * Matching GET /markets + incident-silence latch.
 * `ok` / `ready` stay process liveness — venue allFine lives on venueIncident.
 */
const loadVenueIncident = async () =>
  presentVenueIncident({
    load: await loadMatchingVenueIncident({ matchingUrl: env.MATCHING_URL }),
    incidentSilence: env.NOTIFY_INCIDENT_SILENCE || !env.NOTIFY_OUT_OF_APP_ENABLED,
    allClear: env.NOTIFY_INCIDENT_ALL_CLEAR,
  });

const incidentTemplates = new IncidentTemplates(new SqlTemplateStore(sql), async () =>
  (await statusBook.definition()).components.map((component) => component.id),
);
const postmortems = new Postmortems(new SqlPostmortemStore(sql), (id) => notices.incidentState(id), opsApprovals);
const statusPageDeps = {
  book: statusBook,
  notices,
  subscriptions: statusSubscriptions,
  templates: incidentTemplates,
  postmortems,
  maintenance,
  publicOrigin: env.NOTIFY_PUBLIC_ORIGIN ?? null,
};
export const appRouter = createNotifyRouter(
  notify,
  alerts,
  loadVenueIncident,
  guests,
  {
    pageSize: env.NOTIFY_INBOX_PAGE_SIZE ?? null,
    unreadCap: env.NOTIFY_INBOX_UNREAD_CAP ?? null,
    retentionDays: env.NOTIFY_INBOX_RETENTION_DAYS ?? null,
  },
  statusPageDeps,
  new SqlNavMetricStore(sql),
  // The guest verification door (ADR 2026-10-22 §3.5): links must open NOTIFY_PUBLIC_ORIGIN; blank refuses every send.
  new GuestVerificationService(sql, mailer, {
    origin: env.NOTIFY_PUBLIC_ORIGIN ?? null,
    enabled: env.NOTIFY_FANOUT_ENABLED && env.NOTIFY_OUT_OF_APP_ENABLED,
    timeoutMs: env.NOTIFY_GATEWAY_TIMEOUT_MS,
    addressMaxPerWindow: env.NOTIFY_GUEST_ADDRESS_MAX_PER_WINDOW,
    addressWindowMs: env.NOTIFY_GUEST_ADDRESS_WINDOW_MS,
  }),
);
export type AppRouter = typeof appRouter;

const edgeContext = createGuestIngressContext({
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  edgeTrust: edgeTrustFromEnv(env),
  opsSecret: env.NOTIFY_OPS_SERVICE_SECRET,
  supportSecret: env.NOTIFY_SUPPORT_SERVICE_SECRET,
  ...(s2s.serviceVerifier && s2s.s2sMode ? { s2s: { verifier: s2s.serviceVerifier, mode: s2s.s2sMode } } : {}),
});

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });
retainRawBody(app);

const { subscriptions, pending } = await subscribeNotificationEvents(bus, notify);

// The status badge as an image another page can show (SP-status-05). Public through Edge; no script, no personal data.
// Hot-linked pages can ask often, so one page read serves every badge for a few seconds.
let badgePage: { at: number; page: Promise<StatusPage> } | null = null;
const badgeRead = () => {
  const at = Date.now();
  if (!badgePage || at - badgePage.at > 5_000) {
    const page = readStatusPage(statusPageDeps, new Date(at));
    badgePage = { at, page };
    page.catch(() => {
      if (badgePage?.page === page) badgePage = null;
    });
  }
  return badgePage.page;
};
app.get<{ Querystring: { component?: unknown } }>('/status/badge.svg', async (request, reply) => {
  const raw = request.query.component;
  reply.header('cache-control', 'no-store');
  if (raw !== undefined && typeof raw !== 'string') return reply.code(404).send({ code: 'status.component_unknown' });
  let page: StatusPage;
  try {
    page = await badgeRead();
  } catch {
    return reply.code(503).send({ code: 'notify.status_page_unavailable' });
  }
  const badge = statusBadge(page, raw === undefined || raw === '' ? null : raw);
  if (!badge) return reply.code(404).send({ code: 'status.component_unknown' });
  return reply
    .header('content-type', 'image/svg+xml; charset=utf-8')
    .header('cache-control', statusBadgeCacheControl(badge))
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
    .send(statusBadgeSvg(badge));
});

// The documented read API for status and notices (SP-api-01): what the site reads, as plain GETs under /v1.
// Polled by unsigned callers, so it shares the badge's few-second read.
registerPublicReadApi(app, { notices, statusPage: badgeRead });

app.get('/health', async () => ({
  ok: true,
  service: env.SERVICE_NAME,
  fanoutEnabled: env.NOTIFY_FANOUT_ENABLED,
  venueIncident: await loadVenueIncident(),
}));
app.get('/ready', async () => ({
  ready: true,
  fanoutEnabled: env.NOTIFY_FANOUT_ENABLED,
  outOfAppEnabled: env.NOTIFY_OUT_OF_APP_ENABLED,
  venueIncident: await loadVenueIncident(),
  channels: channels.status(),
  guestNotifications: {
    ingressConfigured: Boolean(env.NOTIFY_OPS_SERVICE_SECRET),
    gatewayConfigured: channels.get('email').unavailableReason === null,
    deliveryEvidence: 'gateway_acceptance_only',
  },
  consumers: subscriptions.length,
  // Each entry carries its `socket` — the recorded reason it cannot attach, or
  // null. Null is the one worth paging on, so it gets its own count rather than
  // making a monitor parse the array to find out.
  pendingConsumers: pending,
  undeclaredPendingConsumers: pending.filter((c) => c.socket === null).length,
  // Observability for the stuck-pending reaper (#1187): last tick's retired count
  // and when it ran. Zero forever + null means the interval never completed.
  deliveryReap: { lastRetired: lastReapRetired, lastAt: lastReapAt },
  // v22.alerts honesty, both halves. `markSource: dark` means every evaluation
  // refuses rather than invents a price. `sweep` is the proof the evaluation job
  // RUNS: a null `lastAt` means the driver never completed a pass, which is the
  // state this service shipped in before the sweep was mounted — the surface
  // promised evaluation and nothing evaluated.
  alerts: {
    ...alerts.evaluationStatus(),
    unpublishedKinds: UNPUBLISHED_ALERT_KINDS,
    unpublishedCode: ALERT_KIND_UNPUBLISHED,
    sweep: { lastAt: lastAlertSweepAt, ...(lastAlertSweep ?? { markets: 0, fired: 0, held: 0, refused: 0, refusals: {} }) },
  },
}));

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<NotifyRouter>['trpcOptions'],
});

/**
 * The delivery sweep — see `DeliveryStore.reapExhausted`.
 *
 * The only writer of `abandoned` used to be `claim`, which needs a bus
 * redelivery to run. When the attempt ceiling and `max_deliver` are reached by
 * the same message, no redelivery follows and the row keeps saying `pending` on
 * a screen the user reads to find out whether their margin call went out.
 *
 * FAIL-SAFE, DELIBERATELY. A sweep that cannot run must never take the inbox
 * down with it: a database blip here costs a stale status line, and refusing to
 * serve notifications over it would be the larger outage. So it logs and waits
 * for the next tick. `unref` keeps it out of the way of shutdown.
 */
const digestRelease = setInterval(() => {
  void releaseDueHolds(holdStore, dispatcher, new Date()).catch((err) => {
    app.log.error({ err }, 'svc-notify digest release failed — held notices stay held until the next tick');
  });
}, DIGEST_RELEASE_INTERVAL_MS);
digestRelease.unref();

const reaper = setInterval(() => {
  void deliveries
    .reapExhausted(maxAttempts)
    .then((retired) => {
      // Always stamp the tick — zero is a successful run that found nothing, and
      // is how an operator distinguishes "reaper healthy" from "reaper never ran".
      lastReapRetired = retired;
      lastReapAt = new Date().toISOString();
      if (retired > 0) {
        app.log.info(
          { retired, maxAttempts },
          'svc-notify retired delivery rows that had run out of attempts — they now read as abandoned rather than pending',
        );
      }
    })
    .catch((err) => {
      app.log.error({ err }, 'svc-notify delivery sweep failed — finished rows may still read as pending until the next tick');
    });
}, DELIVERY_REAP_INTERVAL_MS);
reaper.unref();

/**
 * THE ALERT SWEEP — the job path the alert surface always claimed to have.
 *
 * `AlertService.evaluateMarket` shipped complete, tested, and with NO CALLER.
 * `router.ts` described it as "an internal job path"; there was no job. A user
 * created a price watch, got `status: 'active'` back, and nothing in this process
 * would ever look at that row again. That is D-S-13's Class B — a promise with no
 * delivery — and it is the same failure as `bankMarginCalled`, whose consumer sat
 * finished and parked while the borrowers it was written for went untold.
 *
 * WHAT IT DOES WHILE THE MARK SOURCE IS DARK: nothing, loudly. Every evaluation
 * refuses `alert.price_unavailable`, no watch is marked fired, and no inbox row
 * is written — a price the platform cannot source is never treated as zero and
 * never invented. The counts land on `/ready` so "no alerts fired" is a number
 * with a reason next to it instead of an absence.
 *
 * FAIL-SAFE, like the reaper. A sweep that cannot run must not take the inbox
 * down with it, so it logs and waits for the next tick.
 */
const alertSweepRecorder = {
  onComplete(report: AlertSweepReport) {
    lastAlertSweep = report;
    lastAlertSweepAt = new Date().toISOString();
    if (report.fired > 0) {
      app.log.info({ ...report }, 'svc-notify alert sweep fired price watches into the notification fan-out');
    }
  },
  onError(err: unknown) {
    app.log.error({ err }, 'svc-notify alert sweep failed — active price watches were not evaluated on this tick');
  },
};

// Boot pass — an interval-only driver made `/ready` read "never ran" and left
// watches blind until the first tick.
void runAlertSweepPass(alerts, alertSweepRecorder);

const alertSweep = setInterval(() => {
  void runAlertSweepPass(alerts, alertSweepRecorder);
}, ALERT_SWEEP_INTERVAL_MS);
alertSweep.unref();

/**
 * THE MAINTENANCE REMINDER SWEEP (SP-status-03): makes each published window's reminder rows and sends the due ones.
 * Fail-safe like the sweeps above: a tick that cannot run logs and waits for the next; a reminder it took and did not
 * settle is taken again when its lease runs out, and its delivery rows keep anyone from getting it twice.
 */
const maintenanceSweep = setInterval(() => {
  void maintenance.sweep().catch((err) => {
    app.log.error({ err }, 'svc-notify maintenance reminder sweep failed — due reminders wait for the next tick');
  });
}, MAINTENANCE_SWEEP_INTERVAL_MS);
maintenanceSweep.unref();

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });

app.log.info(
  {
    port: env.HTTP_PORT,
    fanoutEnabled: env.NOTIFY_FANOUT_ENABLED,
    outOfAppEnabled: env.NOTIFY_OUT_OF_APP_ENABLED,
    channels: channels.status(),
    consumers: subscriptions.length,
    trpc: true,
  },
  'svc-notify ready',
);

for (const consumer of pending) {
  // A pending consumer is a DECLARED SOCKET or a DEFECT, and never both — see
  // the `PendingConsumer` docstring in ./events.ts.
  //
  // Declared sockets log at info (known gap). Undeclared pending is an error —
  // notifications for that subject are dark and nothing in WIRING_SOCKETS admits it.
  if (consumer.socket !== null) {
    app.log.info(
      { subject: consumer.subject, durable: consumer.durable, socket: consumer.socket },
      'svc-notify consumer parked on a declared socket — its publisher does not exist yet, that is recorded in the event catalog with a reason, and the consumer attaches on the first boot after one appears',
    );
    continue;
  }
  app.log.error(
    { subject: consumer.subject, durable: consumer.durable, reason: consumer.reason },
    'svc-notify consumer cannot attach and NOTHING DECLARES WHY — notifications for this subject are dark. Wire its publisher, or record it in WIRING_SOCKETS with a reason (pnpm scan:events fails on an undeclared one, so this should never reach main)',
  );
}

for (const channel of channels.status()) {
  if (channel.available) continue;
  if (channel.reason === 'channel.unprobed') {
    app.log.info(
      { channel: channel.channel, reason: channel.reason, configured: channel.configured },
      'svc-notify channel configured, unprobed — URL+token set; this process has not POSTed',
    );
    continue;
  }
  app.log.warn(
    { channel: channel.channel, reason: channel.reason, requires: channel.requires },
    'svc-notify channel unavailable — it will refuse every message and record the refusal',
  );
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      clearInterval(reaper);
      clearInterval(alertSweep);
      for (const sub of subscriptions) await sub.unsubscribe().catch(() => undefined);
      await app.close();
      await bus.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
