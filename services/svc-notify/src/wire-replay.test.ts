import Fastify from 'fastify';
import type { AnyRouter } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Principal, Scope } from '@intafaced/auth';
import {
  createIdentityWatchlistsClient,
  encodePrincipal,
  procedureCallers,
  retainRawBody,
  serviceAuthHeadersForBody,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createGuestIngressContext } from './guests/context.js';
import { GuestNotificationService } from './guests/service.js';
import { channelGuestMailSender, GuestVerificationService, outboxGuestMailSender } from './guests/verification.js';
import { PostgresNotifyStore } from './store.js';
import { PostgresRecipientHealthStore } from './recipient-health.js';
import { claimLeaseMsFromGatewayTimeout, PostgresDeliveryStore, PostgresTargetStore } from './channel-store.js';
import { channelsFromEnv } from './channels/registry.js';
import { NotificationDispatcher } from './dispatch.js';
import { publishedMaxDeliveryAttempts } from './max-delivery-attempts.js';
import { PostgresMuteStore } from './preferences/mute-store.js';
import { AccountPrefs } from './preferences/account.js';
import { PostgresCommandLog, PostgresDigestPrefStore, PostgresHoldStore, PostgresTopicPrefStore } from './preferences/account.pg.js';
import { planOutOfApp } from './preferences/gate.js';
import { CategoryPrefs } from './preferences/categories.js';
import { PostgresCategoryPrefStore } from './preferences/categories.pg.js';
import { NoticeBoard } from './notices/board.js';
import { PostgresNoticeStore } from './notices/board.pg.js';
import { SqlStatusPageBook } from './status-page/book.js';
import { readStatusPage } from './status-page/router.js';
import { registerPublicReadApi } from './public-api.js';
import { SqlNavMetricStore } from './nav-metrics/counts.js';
import { openStatusMailer } from './status-page/mailer.js';
import { StatusSubscriptions } from './status-page/subscriptions.js';
import { SqlSubscriptionStore } from './status-page/subscriptions.pg.js';
import { IncidentTemplates } from './status-page/templates.js';
import { SqlTemplateStore } from './status-page/templates.pg.js';
import { Postmortems } from './status-page/postmortems.js';
import { MaintenanceLifecycle } from './notices/maintenance.js';
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
import { createNotifyRouter } from './router.js';
import { SqlReconAlertFeedStore } from './reconciliation-alert-feed/feed.js';
import { AlertService } from './alerts/service.js';
import { AlertOpsReader } from './alerts/ops-health.js';
import { AlertOwnerValues, parseAccountPlans } from './alerts/owner-values.js';
import { PostgresAlertStore } from './alerts/store.js';
import { PostgresWatchRuleStore, WatchRuleService } from './alerts/watch-rules.js';
import { PostgresAlertTriggerLog } from './alerts/trigger-log.js';
import { parseNumberList, PostgresAlertWebhookStore, webhookTestLoopback, type AlertWebhookPolicy } from './alerts/webhook.js';
import { createDarkWhaleMarkSource } from './alerts/whale-mark.js';
import type { MarkSource } from './alerts/types.js';
import { loadMatchingVenueIncident } from './matching-venue-incident.js';
import { presentVenueIncident } from './venue-incident-truth.js';

/**
 * The wire replay for svc-notify: every call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden/` holds what svc-notify answered (main 2026-11-19, as it is, bugs included) to a matrix of
 * requests: every tRPC procedure of the router `index.ts` mounts and the three `/v1` read routes it registers, six
 * inputs, six people and two signed producers (svc-ops on the guest door's secret, svc-support on its own), sent
 * through the production Fastify adapter with the context `index.ts` builds. A later move of these calls must answer
 * each one byte for byte the same; a wrong scope, a changed refusal code, a widened input or a reshaped envelope shows
 * here as a difference.
 *
 * The service is put together exactly as `index.ts` puts it together, from `envSchema` parsed over each set-up's
 * environment (`SETUPS`), on the real Postgres stores of a freshly migrated database per set-up. No trade, matching,
 * identity or p2p address is set and no bus is connected, so nothing leaves the process. The calls run in path order,
 * so a write's row is what the reads after it answer with.
 *
 * Each call's own inputs are made from its input schema (`sample`) and kept in the recording, so a changed schema
 * cannot change its own requests. Ids and times the database makes are new on every run, so each is recorded by its
 * place: a uuid the replay did not choose becomes `<uuid-N>` in order of first appearance, an ISO time `<time>`, a
 * cursor `<cursor>`, tRPC's stack `<stack>`.
 *
 * `/health`, `/ready` and `/status/badge.svg` are written inline in `index.ts`, which connects to a database and a bus
 * and listens when imported; they are not in this recording.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the recording. Only for a change that is meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/** One recorded JSON file in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
/** One review part holds 400 KB and a new file is one hunk, so each recorded file stays under this. */
const SHARD_BYTES = 350_000;
const SECRET = 'a-notify-wire-replay-edge-secret-long-enough';
const OPS_SECRET = 'a-notify-wire-replay-ops-producer-secret';
const SUPPORT_SECRET = 'a-notify-wire-replay-support-producer-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const ID = '22222222-2222-4222-8222-222222222222';
const SID = '44444444-4444-4444-8444-444444444444';
const FIXED_IDS = new Set([USER, OPERATOR, ID, SID]);

/** What every set-up runs on: the settings `env.ts` requires and the two producer secrets. */
const BASE: Record<string, string> = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://svc_notify:svc_notify@localhost:5432/intafaced_notify_test',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  SERVICE_NAME: 'svc-notify',
  NOTIFY_OPS_SERVICE_SECRET: OPS_SECRET,
  NOTIFY_SUPPORT_SERVICE_SECRET: SUPPORT_SECRET,
};

/**
 * Two set-ups. `boot`: only the two owner values svc-notify refuses to boot without, every other one blank. `set`: the
 * labelled TEST owner values the local test stack runs on (`tooling/scripts/local-stack-services/notify.mjs`), with no
 * trade, matching, identity or p2p address, so marks stay dark and nothing leaves the process. The status mail goes to
 * the LOCAL TEST outbox, in the machine's temp folder.
 */
const SETUPS: ReadonlyArray<[string, Record<string, string>]> = [
  ['boot', { ...BASE, NOTIFY_MAX_DELIVERY_ATTEMPTS: '3', NOTIFY_VERIFY_TTL_MINUTES: '15' }],
  [
    'set',
    {
      ...BASE,
      NOTIFY_REQUIRED_CHANNELS: 'none',
      NOTIFY_MAX_DELIVERY_ATTEMPTS: '3',
      NOTIFY_VERIFY_TTL_MINUTES: '15',
      NOTIFY_ALERT_MAX_ACTIVE_PRICE: '20',
      BANK_PLANS_JSON: JSON.stringify({
        defaultPlanId: 'standard',
        plans: [
          { id: 'standard', name: 'TEST Standard', tier: 'standard', price: '0', assetId: 'USDT', period: 'month' },
          { id: 'plus', name: 'TEST Plus', tier: 'plus', price: '4.99', assetId: 'USDT', period: 'month' },
        ],
      }),
      NOTIFY_ALERT_MAX_EXPIRY_DAYS: '30',
      NOTIFY_ALERT_TEXT_MAX_LENGTH: '200',
      NOTIFY_ALERT_MAX_CONDITIONS: '3',
      NOTIFY_ALERT_TRIGGER_LOG_DAYS: '7',
      NOTIFY_ALERT_FREQUENCIES: 'every_crossing',
      NOTIFY_ALERT_BURST_WINDOW_MINUTES: '10',
      NOTIFY_ALERT_BURST_MAX_TRIGGERS: '5',
      NOTIFY_ALERT_WEBHOOK_PORTS: '443,8443',
      NOTIFY_ALERT_WEBHOOK_RETRY_SECONDS: '5,5,5',
      NOTIFY_ALERT_WEBHOOK_TEST_LOOPBACK: 'on',
      NOTIFY_MARKETS_LIST_LIMIT: '500',
      NOTIFY_INBOX_PAGE_SIZE: '20',
      NOTIFY_INBOX_UNREAD_CAP: '99',
      NOTIFY_STATUS_LINK_SECRET: 'a-notify-wire-replay-status-link-key-long-enough',
      NOTIFY_STATUS_MAIL_TRANSPORT: 'local-outbox',
      NOTIFY_STATUS_MAIL_OUTBOX: join(tmpdir(), 'notify-wire-replay-status-mail.log'),
      NOTIFY_PUBLIC_ORIGIN: 'http://localhost:5173',
    },
  ],
];

/** Process settings a module reads at call time: blank here, whatever the machine running the test holds. */
const PROCESS_SETTINGS = [
  'INTERNAL_SERVICE_SECRET',
  'IDENTITY_URL',
  'TRADE_URL',
  'MATCHING_URL',
  'P2P_URL',
  'S2S_AUTH_MODE',
  'BANK_PLANS_JSON',
] as const;

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

/** One freshly migrated database per set-up. */
const dbs = new Map<string, TestDatabase>();

beforeAll(async () => {
  for (const name of PROCESS_SETTINGS) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(SETUPS[0]![1])) vi.stubEnv(name, value);
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is required (database name must end with _test)');
  for (const [setup] of SETUPS) dbs.set(setup, await createTestDatabase({ service: 'notify', url, migrations }));
}, 240_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  for (const db of dbs.values()) await db.drop();
}, 60_000);

/** The service as `index.ts` composes it, on a test database, from one set-up's environment. */
async function build(sql: TestDatabase['sql'], values: Record<string, string>) {
  // `env.ts` parses `process.env` when imported; the first set-up's environment is stubbed in by then.
  const { envSchema } = await import('./env.js');
  const env = envSchema.parse(values) as typeof import('./env.js').env;

  const store = new PostgresNotifyStore(sql);
  const targets = new PostgresTargetStore(sql);
  const recipientHealth = new PostgresRecipientHealthStore(sql);
  const quarantineThreshold = env.NOTIFY_QUARANTINE_FAILURE_THRESHOLD ?? null;
  const deliveries = new PostgresDeliveryStore(sql, { leaseMs: claimLeaseMsFromGatewayTimeout(env.NOTIFY_GATEWAY_TIMEOUT_MS) });
  const channels = channelsFromEnv(env);
  const guests = new GuestNotificationService(sql, channels.get('email'), {
    enabled: env.NOTIFY_FANOUT_ENABLED && env.NOTIFY_OUT_OF_APP_ENABLED,
    timeoutMs: env.NOTIFY_GATEWAY_TIMEOUT_MS,
    addressMaxPerWindow: env.NOTIFY_GUEST_ADDRESS_MAX_PER_WINDOW,
    addressWindowMs: env.NOTIFY_GUEST_ADDRESS_WINDOW_MS,
  });
  const muteStore = new PostgresMuteStore(sql);
  const commandLog = new PostgresCommandLog(sql);
  const holdStore = new PostgresHoldStore(sql);
  const account = new AccountPrefs(new PostgresTopicPrefStore(sql), new PostgresDigestPrefStore(sql), commandLog, () => channels.status());
  const categories = new CategoryPrefs(new PostgresCategoryPrefStore(sql), commandLog, () => channels.status());
  // No S2S_AUTH_MODE: no per-service keys, as `index.ts` builds it from this environment.
  const s2sKey = undefined;
  const statusBook = new SqlStatusPageBook(sql);
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
  const notify = new NotifyService(
    store,
    {
      fanoutEnabled: env.NOTIFY_FANOUT_ENABLED,
      verifyTtlMinutes: env.NOTIFY_VERIFY_TTL_MINUTES,
      verifyCodePepper: env.NOTIFY_VERIFY_CODE_PEPPER,
      targetRateLimiter: new PostgresTargetRateLimiter(sql),
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
  // No TRADE_URL: the dark mark source `index.ts` writes inline, and the dark whale source.
  const darkMarks: MarkSource = {
    kind: 'dark',
    async quote() {
      return { kind: 'unavailable', reason: 'dark', detail: 'no mark source configured — refuse rather than invent' };
    },
  };
  const webhookPolicy: AlertWebhookPolicy = {
    ports: parseNumberList(env.NOTIFY_ALERT_WEBHOOK_PORTS, 'NOTIFY_ALERT_WEBHOOK_PORTS', 1, 65535),
    retrySeconds: parseNumberList(env.NOTIFY_ALERT_WEBHOOK_RETRY_SECONDS, 'NOTIFY_ALERT_WEBHOOK_RETRY_SECONDS', 1, 86_400),
    testLoopback: webhookTestLoopback(env.NOTIFY_ALERT_WEBHOOK_TEST_LOOPBACK, env.APP_ENV),
    timeoutMs: env.NOTIFY_GATEWAY_TIMEOUT_MS,
  };
  const alerts = new AlertService(
    new PostgresAlertStore(sql),
    darkMarks,
    notify,
    createDarkWhaleMarkSource(),
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
    { webhooks: new PostgresAlertWebhookStore(sql), policy: webhookPolicy },
  );
  const watchRules = new WatchRuleService(
    alerts,
    new PostgresWatchRuleStore(sql),
    createIdentityWatchlistsClient({ identityUrl: process.env.IDENTITY_URL, secret: process.env.INTERNAL_SERVICE_SECRET, s2s: s2sKey }),
    async () => (darkMarks.marketIdsBySymbol ? darkMarks.marketIdsBySymbol() : null),
  );
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
  alerts.attachOpsReader(new AlertOpsReader(sql));
  alerts.attachOwnerValues(
    new AlertOwnerValues(
      sql,
      { maxActivePrice: env.NOTIFY_ALERT_MAX_ACTIVE_PRICE ?? null, triggerLogDays: env.NOTIFY_ALERT_TRIGGER_LOG_DAYS ?? null },
      parseAccountPlans(env.BANK_PLANS_JSON),
    ),
  );
  // No bus in the replay: the recon feed's consumers never attach, as on a boot whose streams are pending.
  const router = createNotifyRouter(
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
    new GuestVerificationService(
      sql,
      mailer.kind === 'local-outbox' ? outboxGuestMailSender(mailer) : channelGuestMailSender(channels.get('email')),
      {
        origin: env.NOTIFY_PUBLIC_ORIGIN ?? null,
        enabled: env.NOTIFY_FANOUT_ENABLED && env.NOTIFY_OUT_OF_APP_ENABLED,
        timeoutMs: env.NOTIFY_GATEWAY_TIMEOUT_MS,
        addressMaxPerWindow: env.NOTIFY_GUEST_ADDRESS_MAX_PER_WINDOW,
        addressWindowMs: env.NOTIFY_GUEST_ADDRESS_WINDOW_MS,
      },
    ),
    watchRules,
    { store: new SqlReconAlertFeedStore(sql), attached: () => false },
  );
  const context = createGuestIngressContext({
    edgeSecret: env.EDGE_PRINCIPAL_SECRET,
    opsSecret: env.NOTIFY_OPS_SERVICE_SECRET,
    supportSecret: env.NOTIFY_SUPPORT_SERVICE_SECRET,
  });
  return { router, context, notices, statusPage: () => readStatusPage(statusPageDeps, new Date()) };
}

type Built = Awaited<ReturnType<typeof build>>;

/** One app as `index.ts` builds it: the raw-body parser, the `/v1` read routes, then the tRPC mount. */
async function serve(built: Built) {
  // Fastify counts request ids; one fixed id keeps an added call from shifting every later answer.
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  retainRawBody(app);
  registerPublicReadApi(app, { notices: built.notices, statusPage: built.statusPage });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: built.router, createContext: ({ req }: { req: unknown }) => built.context(req as never) },
  });
  await app.ready();
  return app;
}

interface Person {
  readonly user: string;
  readonly scopes: readonly Scope[] | null;
  readonly mfa: boolean;
  readonly region: string;
  readonly signed: boolean;
}

/** Nobody; a signed-in person with no scope; a customer, in a served and an unserved region; an operator with MFA; and an operator's principal with no signature. */
const PEOPLE: ReadonlyArray<[string, Person]> = [
  ['anon', { user: USER, scopes: null, mfa: false, region: 'DE', signed: false }],
  ['no-scope', { user: USER, scopes: [], mfa: false, region: 'DE', signed: true }],
  ['customer', { user: USER, scopes: ['notify:read', 'notify:write'], mfa: false, region: 'DE', signed: true }],
  ['customer-US', { user: USER, scopes: ['notify:read', 'notify:write'], mfa: false, region: 'US', signed: true }],
  ['ops', { user: OPERATOR, scopes: ['admin:read', 'admin:write'], mfa: true, region: 'DE', signed: true }],
  ['forged', { user: OPERATOR, scopes: ['admin:read', 'admin:write'], mfa: true, region: 'DE', signed: false }],
];

/** The two producers `index.ts`'s context admits, each on its own secret, body-bound. */
const PRODUCERS: ReadonlyArray<[string, string]> = [
  ['svc-ops', OPS_SECRET],
  ['svc-support', SUPPORT_SECRET],
];

function personHeaders(p: Person): Record<string, string> {
  if (p.scopes === null) return { 'x-intafaced-region': p.region };
  const principal = {
    sub: p.user,
    userId: p.user,
    sid: SID,
    scopes: p.scopes,
    tier: 'none',
    mfa: p.mfa,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    ...(p.signed ? { 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, p.region) } : {}),
    'x-intafaced-region': p.region,
  };
}

type Json = { [k: string]: unknown };

/** Strings tried against a schema's pattern, in order: the first that matches is the sample. */
const PATTERN_TRIES = [
  '1.50',
  '1',
  '1.5',
  'BTC',
  'BTC-USD',
  'USDC',
  'DE',
  'placeholder',
  ID,
  '2026-01-01',
  '2026-01-01T00:00:00Z',
  '12:00',
  'a-b',
  'a',
  'A',
  '#000000',
  '0x' + 'a'.repeat(40),
  '123456',
  `support:guest-verify:${ID}:1`,
];

/** A plain sample of what an input's own JSON schema asks for. Not always accepted (custom checks are not in the schema): that answer is recorded too. */
function sample(schema: unknown, depth = 0): unknown {
  if (typeof schema !== 'object' || schema === null || depth > 8) return null;
  const s = schema as Json;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(s[k])) {
      const options = (s[k] as Json[]).filter((o) => o.type !== 'null');
      if (k === 'allOf') return Object.assign({}, ...options.map((o) => sample(o, depth + 1)));
      return sample(options[0] ?? s[k][0], depth + 1);
    }
  }
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const out: Json = {};
      for (const key of (s.required ?? []) as string[]) out[key] = sample(props[key], depth + 1);
      return out;
    }
    case 'array':
      return typeof s.minItems === 'number' && s.minItems > 0 ? Array.from({ length: s.minItems }, () => sample(s.items, depth + 1)) : [];
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 1;
    case 'boolean':
      return true;
    case 'string': {
      if (s.format === 'uuid') return ID;
      if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (s.format === 'date') return '2026-01-01';
      if (s.format === 'email') return 'a@example.com';
      if (s.format === 'uri' || s.format === 'url') return 'https://example.com/';
      if (typeof s.pattern === 'string') {
        const re = new RegExp(s.pattern as string, 'u');
        return PATTERN_TRIES.find((t) => re.test(t)) ?? 'x';
      }
      // A sample says it is a placeholder, so the secret scan never reads a sample value as a committed credential.
      const min = typeof s.minLength === 'number' ? s.minLength : 1;
      const max = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
      return 'placeholder'.length <= max ? 'placeholder'.padEnd(min, 'x') : 'x'.repeat(Math.max(1, min));
    }
    default:
      return null;
  }
}

type Proc = { _def: { type: 'query' | 'mutation' | 'subscription'; inputs: unknown[] } };

function sampleInput(proc: Proc): unknown {
  const input = proc._def.inputs[0];
  if (input === undefined) return undefined;
  try {
    return sample(z.toJSONSchema(input as z.ZodType, { io: 'input', unrepresentable: 'any' }));
  } catch {
    return {};
  }
}

/**
 * The two inputs made from a call's own schema, recorded in the golden file so a changed schema cannot change its own
 * requests. Kept as the JSON text that is sent, byte for byte.
 */
type Samples = { readonly sample: string; readonly 'sample-nulls': string };

function nulls(valid: unknown): unknown {
  return valid !== null && typeof valid === 'object' && !Array.isArray(valid)
    ? Object.fromEntries(Object.keys(valid).map((k) => [k, null]))
    : null;
}

function samplesOf(valid: unknown): Samples {
  return { sample: JSON.stringify(valid ?? null), 'sample-nulls': JSON.stringify(nulls(valid)) };
}

/** Each call gets: nothing; null; a wrong type; an object missing every field; a sample; the sample with every field null. */
function inputs(samples: Samples): Array<[string, unknown]> {
  return [
    ['absent', undefined],
    ['null', null],
    ['wrong-type', 7],
    ['empty', {}],
    ['sample', JSON.parse(samples.sample)],
    ['sample-nulls', JSON.parse(samples['sample-nulls'])],
  ];
}

/** The `/v1` read routes, each with the query strings that reach its own refusals. */
const REST: ReadonlyArray<[string, string]> = [
  ['GET /v1/notices', '/v1/notices'],
  ['GET /v1/notices', '/v1/notices?limit=10'],
  ['GET /v1/notices', '/v1/notices?limit=0'],
  ['GET /v1/notices', '/v1/notices?limit=10&after=nope'],
  ['GET /v1/notices', `/v1/notices?limit=10&after=${ID}`],
  ['GET /v1/notices', '/v1/notices?limit=10&kind=incident'],
  ['GET /v1/notices', '/v1/notices?limit=10&kind=a&kind=b'],
  ['GET /v1/notices/:id', `/v1/notices/${ID}`],
  ['GET /v1/notices/:id', '/v1/notices/nope'],
  ['GET /v1/status', '/v1/status'],
];

type Answer = { status: number; body: string };

interface Golden {
  readonly callers: unknown;
  /** The requests made from each call's schema when the recording was written: replayed as they are. */
  readonly inputs: Record<string, Samples>;
  /** Per call, per `<input> <caller>`: the answer. */
  readonly answers: Record<string, Record<string, Answer>>;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** Ids and times the database made, recorded by their place; the numbering carries over the whole run. */
function stable(body: string, ids: Map<string, string>, today: string): string {
  return (
    body
      .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
      .replace(/"(nextCursor|cursor)":"(?:[^"\\]|\\.)*"/g, '"$1":"<cursor>"')
      .replace(UUID, (id) => {
        if (FIXED_IDS.has(id)) return id;
        if (!ids.has(id)) ids.set(id, `<uuid-${ids.size + 1}>`);
        return ids.get(id)!;
      })
      .replace(ISO_TIME, '<time>')
      // A bare date the service read off its own clock (the status history's day) is the day the replay ran, not the recording's.
      .replaceAll(`"${today}"`, '"<today>"')
  );
}

/** The shard a call is kept in: its namespace (`notify`), or `rest`; `depth` adds one more part when a shard would pass SHARD_BYTES. */
function shardOf(call: string, depth: number): string {
  if (call.startsWith('GET ')) return 'rest';
  return call.split('.').slice(0, depth).join('.');
}

/** One shard file: each distinct body once, every answer a status and that body's index. One line per body and per call. */
function shardText(calls: string[], g: Golden): string {
  const bodies: string[] = [];
  const index = new Map<string, number>();
  const rows = calls.map((call) => {
    const answers = Object.entries(g.answers[call]!).map(([k, a]) => {
      if (!index.has(a.body)) index.set(a.body, bodies.push(a.body) - 1);
      return `${JSON.stringify(k)}: [${a.status}, ${index.get(a.body)}]`;
    });
    return `    ${JSON.stringify(call)}: { ${answers.join(', ')} }`;
  });
  // Each call's inputs open on a line of their own: the secret scan reads `"<call>": <value>` on one line as a password.
  const inputs = calls
    .filter((c) => g.inputs[c])
    .map(
      (c) =>
        `    ${JSON.stringify(c)}: {\n${Object.entries(g.inputs[c]!)
          .map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
          .join(',\n')}\n    }`,
    );
  return [
    '{',
    `  "inputs": {\n${inputs.join(',\n')}\n  },`,
    `  "bodies": [\n${bodies.map((b) => `    ${JSON.stringify(b)}`).join(',\n')}\n  ],`,
    `  "answers": {\n${rows.join(',\n')}\n  }`,
    '}',
    '',
  ].join('\n');
}

/** Writes the recording in the repo's own format (the format check reads JSON), each shard under SHARD_BYTES. */
async function writeGolden(g: Golden) {
  const prettier = await import('prettier');
  const format = async (name: string, text: string) => {
    const file = goldenJson(name).pathname;
    return prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file });
  };
  const files = new Map<string, string>();
  const place = async (calls: string[], depth: number) => {
    const groups = new Map<string, string[]>();
    for (const c of calls) groups.set(shardOf(c, depth), [...(groups.get(shardOf(c, depth)) ?? []), c]);
    for (const [name, group] of groups) {
      const text = await format(name, shardText(group, g));
      if (Buffer.byteLength(text) <= SHARD_BYTES) files.set(name, text);
      else if (depth < 4 && new Set(group.map((c) => shardOf(c, depth + 1))).size > 1) await place(group, depth + 1);
      else if (group.length > 1) {
        // One namespace with many calls (`notify`): cut it in path order into parts that each fit.
        const half = Math.ceil(group.length / 2);
        await placeNamed(`${name}-a`, group.slice(0, half), files, format);
        await placeNamed(`${name}-b`, group.slice(half), files, format);
      } else throw new Error(`shard ${name} is ${Buffer.byteLength(text)} bytes, over ${SHARD_BYTES}`);
    }
  };
  async function placeNamed(name: string, group: string[], out: Map<string, string>, fmt: typeof format) {
    const text = await fmt(name, shardText(group, g));
    if (Buffer.byteLength(text) <= SHARD_BYTES) return void out.set(name, text);
    if (group.length < 2) throw new Error(`shard ${name} is ${Buffer.byteLength(text)} bytes, over ${SHARD_BYTES}`);
    const half = Math.ceil(group.length / 2);
    await placeNamed(`${name}a`, group.slice(0, half), out, fmt);
    await placeNamed(`${name}b`, group.slice(half), out, fmt);
  }
  await place(Object.keys(g.answers), 1);
  rmSync(GOLDEN, { recursive: true, force: true });
  mkdirSync(GOLDEN);
  writeFileSync(goldenJson('callers'), await format('callers', JSON.stringify(g.callers)));
  for (const [name, text] of files) writeFileSync(goldenJson(name), text);
}

function readGolden(): Golden {
  const g: Golden = {
    callers: JSON.parse(readFileSync(new URL('./wire-replay.golden/callers.json', import.meta.url), 'utf8')),
    inputs: {},
    answers: {},
  };
  for (const file of readdirSync(GOLDEN).filter((f) => f !== 'callers.json')) {
    const shard = JSON.parse(readFileSync(goldenJson(file.replace(/\.json$/, '')), 'utf8')) as {
      inputs: Record<string, Samples>;
      bodies: string[];
      answers: Record<string, Record<string, [number, number]>>;
    };
    Object.assign(g.inputs, shard.inputs);
    for (const [call, answers] of Object.entries(shard.answers))
      g.answers[call] = Object.fromEntries(Object.entries(answers).map(([k, [status, i]]) => [k, { status, body: shard.bodies[i]! }]));
  }
  return g;
}

/** What a tRPC call sends as its body: nothing for a query, the input's JSON for a mutation. */
function payload(query: boolean, input: unknown): string | undefined {
  return query ? undefined : input === undefined ? '' : JSON.stringify(input);
}

async function replay(recorded: Golden['inputs'] | null): Promise<Golden> {
  const answers: Golden['answers'] = {};
  const samples: Golden['inputs'] = {};
  let callers: unknown;
  for (const [setup, values] of SETUPS) {
    const built = await build(dbs.get(setup)!.sql, values);
    callers ??= procedureCallers(built.router as never);
    await replaySetup(setup, built, recorded, samples, answers);
  }
  return { callers, inputs: samples, answers };
}

/** One set-up's answers, every call in path order, then the `/v1` reads. */
async function replaySetup(
  setup: string,
  built: Built,
  recorded: Golden['inputs'] | null,
  samples: Golden['inputs'],
  answers: Golden['answers'],
) {
  const ids = new Map<string, string>();
  const anyRouter: AnyRouter = built.router;
  const procedures: Record<string, Proc> = anyRouter._def.procedures;
  const app = await serve(built);
  const send = async (method: 'GET' | 'POST', url: string, body: string | undefined, h: Record<string, string>): Promise<Answer> => {
    const res = await app.inject({
      method,
      url,
      headers: body === undefined ? h : { ...h, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { payload: body }),
    });
    return { status: res.statusCode, body: stable(res.body, ids, new Date().toISOString().slice(0, 10)) };
  };
  try {
    for (const path of Object.keys(procedures).sort()) {
      const proc = procedures[path]!;
      if (proc._def.type === 'subscription') continue;
      // A call missing from the recording gets samples from its schema; its answers then match no recorded key and fail.
      samples[path] ??= recorded?.[path] ?? samplesOf(sampleInput(proc));
      const query = proc._def.type === 'query';
      for (const [inputName, input] of inputs(samples[path])) {
        const url = `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
        const body = payload(query, input);
        for (const [name, person] of PEOPLE)
          (answers[path] ??= {})[`${setup} ${inputName} ${name}`] = await send(query ? 'GET' : 'POST', url, body, personHeaders(person));
        for (const [service, secret] of PRODUCERS)
          (answers[path] ??= {})[`${setup} ${inputName} ${service}`] = await send(
            query ? 'GET' : 'POST',
            url,
            body,
            serviceAuthHeadersForBody(service, secret, body ?? ''),
          );
      }
    }
    // The `/v1` reads are public: the anonymous caller and a signed customer.
    for (const [route, url] of REST)
      for (const name of ['anon', 'customer'])
        (answers[route] ??= {})[`${setup} ${url} ${name}`] = await send(
          'GET',
          url,
          undefined,
          personHeaders(PEOPLE.find(([n]) => n === name)![1]),
        );
  } finally {
    await app.close();
  }
}

describe('the wire replay: svc-notify answers every call as main did on 2026-11-19', () => {
  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const write = process.env.WIRE_REPLAY_WRITE === '1';
    const now = await replay(write ? null : readGolden().inputs);
    if (write) await writeGolden(now);
    const golden = readGolden();
    expect(now.callers).toEqual(golden.callers);
    expect(now.inputs).toEqual(golden.inputs);
    const flat = (g: Golden) =>
      Object.fromEntries(Object.entries(g.answers).flatMap(([call, a]) => Object.entries(a).map(([k, v]) => [`${call} ${k}`, v])));
    const was = flat(golden);
    const is = flat(now);
    expect(Object.keys(is).sort()).toEqual(Object.keys(was).sort());
    const diffs = Object.entries(was)
      .filter(([key, a]) => is[key]?.status !== a.status || is[key]?.body !== a.body)
      .map(([key, a]) => `${key}: ${a.status} ${a.body.slice(0, 160)} != ${is[key]?.status} ${is[key]?.body.slice(0, 160)}`);
    expect(diffs).toEqual([]);
  }, 600_000);
});
