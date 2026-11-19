import Fastify from 'fastify';
import type { AnyRouter } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SCOPES, type Principal, type Scope } from '@intafaced/auth';
import { encodePrincipal, parseIncidentSeverities, procedureCallers, s2sFromEnv, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { OpsEnv } from './env.js';
import { createArchiveClient } from './outreach/archive-publication.js';
import { migrateOutreach } from './db/migrate.js';
import { OutreachCrm } from './outreach/crm.js';
import { createFounderAuthority, operatorAuthorityFrom } from './outreach/authority.js';
import { createClientIpResolver } from './outreach/client-ip.js';
import { SqlConsoleModeStore } from './console-mode/store.js';
import { StaffHoldDesk } from './staff-holds/desk.js';
import { createStaffHoldLedger } from './staff-holds/ledger.js';
import { SqlStaffHoldStore } from './staff-holds/store.js';
import { SqlAnnouncementStore } from './console-announcements/store.js';
import { SqlPreferenceStore } from './console-preferences/store.js';
import { SqlServiceRecordStore } from './service-records/store.js';
import { SqlIncidentStore } from './incidents/store.js';
import { SqlPublicSettingsBook } from './outreach/public-settings.js';
import { createCapitalSources } from './capital/sources.js';
import { SqlCapitalStore } from './capital/store.js';
import { testVenuesFor } from './capital/test-venue.js';
import { createVenueReader } from './capital/venues.js';
import { createFeeRevenueClient } from './fee-revenue-client.js';
import { createOutreachNotificationClient } from './outreach/notification-client.js';
import { createPgAlertRuleStore } from './alerts/rule-store.js';
import { createPgComplianceStore } from './compliance/store.js';
import { AlertRules } from './alerts/rules.js';
import { createPgAlertState } from './alerts/state-store.js';
import { createPgAlertDesk } from './alerts/desk-store.js';
import { createPgRestoreStore } from './restore-store.js';
import { probeRestoreArchive } from './restore/archive-probe.js';
import { createRestoreDesk } from './restore/desk.js';
import { createPgRestoreRunStore } from './restore/run-store.js';
import { createLedgerFreezeReader } from './restore/platform-halt.js';
import { createWatermarkReader } from './restore/watermark-reader.js';
import { createPgVenueCostStore } from './venue-cost-store.js';
import { createListingDesk } from './protocol-listing/wiring.js';
import { createPgListingStore } from './protocol-listing/store.js';
import { createPgReasonCodeStore, createReasonCodes } from './protocol-listing/reason-codes.js';
import { reapplyCompletedErasures } from './outreach/restore-privacy.js';
import { buildEdgeContext } from './edge-context.js';
import { createOpsRouter } from './router.js';
import { createOpsApprovalClient } from './operator-desks.js';
import { OpsService } from './ops-service.js';
import { OPS_IDENTITY_UNWIRED, OPS_SUPPORT_UNWIRED } from './codes.js';
import { homeConfigFromEnv } from './home-config.js';
import { valuationPricesFromEnv } from './valuation-prices.js';
import { ReconciliationAlertStore } from './reconciliation-alerts/store.js';
import { createCorrectiveTxClient } from './reconciliation-alerts/transactions-client.js';

/**
 * The wire replay for svc-ops: every ops call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden.json` and `wire-replay.golden/` hold what svc-ops answered (main 2026-11-19, as it is, bugs
 * included) to a matrix of requests: every procedure of the router `index.ts` mounts, six inputs and five callers, sent
 * through the production Fastify adapter with `index.ts`'s context (edge principal, operator authority, the hashed
 * client address). A later move of these calls must answer each one byte for byte the same; a wrong scope, a changed
 * refusal code, a widened input or a reshaped envelope shows here as a difference.
 *
 * The router is composed as `index.ts` composes it, line for line, in two set-ups:
 * - `blank`: an empty environment (only the secrets the schema requires), as a stack nobody configured: no database, so
 *   every store is absent, and no identity, so every operator call refuses its authority as unavailable.
 * - `stored`: the same, over a freshly migrated database, with `IDENTITY_URL` set. Identity is the one outside service
 *   that answers: its operator entitlement read says `enabled` for whoever asks, and every other call to it (an approval
 *   to spend) gets a 503. Every other outside service stays blank. Requests build state up in the order they run.
 *
 * Ids and times the database or the clock makes are new on every run, so each is recorded by its place: a uuid the
 * replay did not choose becomes `<uuid-N>` in order of first appearance, an ISO time becomes `<time>`. The clock is
 * fixed for the run, and tRPC's stack becomes `<stack>`.
 *
 * Not recorded: `/health` and `/ready` (written inline in `index.ts`, which connects and listens when imported), and the
 * timers `index.ts` starts after it listens (notifications, alerts, capital, reconciliation, staff holds, retention).
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the recording. Only for a change that is meant to change the wire, named in its PR.
 */

/** The recording's index: who may call each procedure, and the shard files below it. */
const INDEX = new URL('./wire-replay.golden.json', import.meta.url);
const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/** One recorded shard in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
/** One review part holds 400 KB and a new file is one hunk, so each recorded file stays under this. */
const SHARD_BYTES = 350_000;
const SECRET = 'an-ops-wire-replay-edge-secret-long-enough-ok';
const INTERNAL = 'an-ops-wire-replay-internal-secret-long-enough';
const IDENTITY = 'http://identity.replay.invalid';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const ID = '22222222-2222-4222-8222-222222222222';
const FIXED_IDS = new Set([USER, SESSION, ID]);
const NOW = '2026-11-19T00:00:00.000Z';

/** Blank owner settings: nothing set but what the schema refuses to start without, as on a test stack nobody configured. */
const ENV_SOURCE: NodeJS.ProcessEnv = {
  APP_ENV: 'test',
  SERVICE_NAME: 'svc-ops',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: INTERNAL,
};

/** `env.ts` parses `process.env` when it is imported: it is imported once, over the blank source alone. */
async function loadBlankEnv(): Promise<OpsEnv> {
  const saved = process.env;
  process.env = { ...ENV_SOURCE };
  try {
    return (await import('./env.js')).env;
  } finally {
    process.env = saved;
  }
}
const blankEnv = await loadBlankEnv();

/** The answers identity gives in the `stored` set-up: the operator entitlement is enabled; anything else is unavailable. */
async function identityStub(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url === `${IDENTITY}/trpc/accountControls.operatorEntitlement`) {
    const { userId } = JSON.parse(String(init?.body)) as { userId: string };
    const data = { status: 'enabled', userId, version: 1, changedAt: NOW };
    return new Response(JSON.stringify({ result: { data } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'replay: identity unavailable' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The router and context exactly as `index.ts` builds them before it listens, from `env` and `crmSql`. The timers and the
 * event bus `index.ts` starts after listening are left out; the bus reads detached, as before its first attach.
 */
async function composeAsIndex(env: OpsEnv, sqlUrl: string | null) {
  const ops = new OpsService({
    warehouseEnv: process.env,
    custodyWrap: env.OPS_CUSTODY_WRAP,
    custodyFreezePolicy: env.OPS_CUSTODY_FREEZE_POLICY,
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
  if (sqlUrl) {
    crmSql = postgres(sqlUrl, { max: 2, onnotice: () => undefined, connection: { application_name: 'ops' } });
    await migrateOutreach(crmSql);
    await reapplyCompletedErasures(crmSql, archivePublisher);
  }
  const alertRuleStore = crmSql ? createPgAlertRuleStore(crmSql) : null;
  const alertState = crmSql ? createPgAlertState(crmSql) : null;
  const alertDesk = crmSql ? createPgAlertDesk(crmSql) : undefined;
  const outreachConfiguration: unknown = null;
  const s2s = s2sFromEnv(env, 'svc-ops');
  const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
  const notificationPort = createOutreachNotificationClient({
    notifyUrl: env.NOTIFY_URL,
    secret: env.OPS_NOTIFY_SERVICE_SECRET,
    ...(s2sKey ? { s2s: s2sKey } : {}),
  });
  const crm = new OutreachCrm(crmSql, outreachConfiguration, undefined, notificationPort, archivePublisher);
  const approvalConsumer =
    env.IDENTITY_URL && env.INTERNAL_SERVICE_SECRET
      ? createOpsApprovalClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey)
      : undefined;
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
  const staffHolds = new StaffHoldDesk({
    store: crmSql ? new SqlStaffHoldStore(crmSql) : undefined,
    ledger: createStaffHoldLedger({ ledgerUrl: env.LEDGER_URL, secret: env.INTERNAL_SERVICE_SECRET, ...(s2sKey ? { s2s: s2sKey } : {}) }),
    approvals: approvalConsumer,
    settings: {
      confirmAccount: env.OPS_STAFF_HOLD_CONFIRM_ACCOUNT ?? null,
      expiryMaxHours: env.OPS_STAFF_HOLD_EXPIRY_MAX_HOURS ?? null,
    },
    now: () => new Date(),
    onWorkerError: () => undefined,
  });
  const protocolReasonCodes = env.OPS_PROTOCOL_REASON_CODES
    ? env.OPS_PROTOCOL_REASON_CODES.split(',')
        .map((code) => code.trim())
        .filter(Boolean)
    : null;
  const capitalStore = crmSql ? new SqlCapitalStore(crmSql) : undefined;
  const capitalSources = createCapitalSources({
    ledgerUrl: env.LEDGER_URL,
    bankUrl: env.BANK_URL,
    secret: env.INTERNAL_SERVICE_SECRET,
    ...(s2sKey ? { s2s: s2sKey } : {}),
  });
  const capitalVenues = createVenueReader(
    testVenuesFor(env.OPS_TEST_VENUE, env.OPS_TEST_VENUE_BUILDER_ACCOUNT, { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV }),
  );
  const founderAuthority = createFounderAuthority({
    identityUrl: env.IDENTITY_URL,
    serviceSecret: process.env.INTERNAL_SERVICE_SECRET,
  });
  const operatorAuthority = operatorAuthorityFrom(founderAuthority);
  const appRouter = createOpsRouter(
    ops,
    {
      crm,
      ...(crmSql ? { publicSettings: new SqlPublicSettingsBook(crmSql) } : {}),
      authority: founderAuthority,
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
            halt: createLedgerFreezeReader({ ledgerUrl: env.LEDGER_URL }),
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
      capital: capitalStore,
      capitalSources,
      ...(capitalVenues ? { capitalVenues } : {}),
      announcements: crmSql ? new SqlAnnouncementStore(crmSql) : undefined,
      preferences: crmSql ? new SqlPreferenceStore(crmSql) : undefined,
      serviceRecords: crmSql ? new SqlServiceRecordStore(crmSql) : undefined,
      incidents: crmSql ? new SqlIncidentStore(crmSql) : undefined,
      incidentSeverities: parseIncidentSeverities(env.OPS_INCIDENT_SEVERITIES),
      staffHolds,
      homeConfig: homeConfigFromEnv(env),
      valuationPrices: valuationPricesFromEnv(env.OPS_VALUATION_TEST_PRICES, {
        APP_ENV: process.env.APP_ENV,
        NODE_ENV: process.env.NODE_ENV,
      }),
      reconciliationAlerts: reconciliationAlerts ?? undefined,
      reconciliationBus: () => 'detached',
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
  const app = Fastify({ maxParamLength: 5_000, trustProxy: false, genReqId: () => 'replay-request' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: async ({
        req,
      }: {
        req: Parameters<typeof edgeContext>[0] & { raw: { socket: { remoteAddress?: string } }; headers: Record<string, unknown> };
      }) => ({
        ...(await edgeContext(req)),
        operatorAuthority,
        outreachAbuseKey: createHash('sha256')
          .update(resolveClientIp(req.raw.socket.remoteAddress, req.headers['x-intafaced-client-ip'] as string | undefined))
          .digest('hex'),
      }),
    } as never,
  });
  await app.ready();
  return { app, router: appRouter, close: async () => (await app.close(), await crmSql?.end({ timeout: 5 })) };
}

interface Caller {
  readonly scopes: readonly Scope[] | null;
  readonly tier: 'none' | 'basic' | 'full';
  readonly mfa: boolean;
  readonly region: string;
}

/** Nobody; a signed-in person holding no scope; every scope with and without a second factor; every scope in an unserved region. */
const CALLERS: ReadonlyArray<[string, Caller]> = [
  ['anon', { scopes: null, tier: 'none', mfa: false, region: 'DE' }],
  ['no-scope', { scopes: [], tier: 'basic', mfa: false, region: 'DE' }],
  ['all', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'DE' }],
  ['all-no-mfa', { scopes: [...SCOPES], tier: 'full', mfa: false, region: 'DE' }],
  ['all-US', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'US' }],
];

function headers(caller: Caller): Record<string, string> {
  if (caller.scopes === null) return {};
  const principal = {
    sub: USER,
    userId: USER,
    sid: SESSION,
    scopes: caller.scopes,
    tier: caller.tier,
    mfa: caller.mfa,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, caller.region),
    'x-intafaced-region': caller.region,
  };
}

type Json = { [k: string]: unknown };

/** Strings tried against a schema's pattern, in order: the first that matches is the sample. */
const PATTERN_TRIES = [
  '1.50',
  '1',
  '1.5',
  'BTC',
  'USDC',
  'DE',
  'placeholder',
  ID,
  '2026-01-01',
  '2026-01-01T00:00:00Z',
  '2026-01',
  'a-b',
  'A',
  'ops.placeholder',
  '0x' + 'a'.repeat(40),
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
      // A sample says it is a placeholder, so the secret scan never reads a sample `key` as a committed credential.
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

type Answer = { status: number; body: string };

interface Golden {
  readonly callers: unknown;
  /** The requests made from each call's schema when the recording was written: replayed as they are. */
  readonly inputs: Record<string, Samples>;
  /** Per `<set-up> <call>`, per `<input> <caller>`: the answer. */
  readonly answers: Record<string, Record<string, Answer>>;
}

/** The shard a call is kept in: its set-up and namespace (`stored-alertRules`); `depth` adds one more part when a shard would pass SHARD_BYTES. */
function shardOf(call: string, depth: number): string {
  const [setup, path] = call.split(' ') as [string, string];
  return `${setup}-${path.split('.').slice(0, depth).join('.')}`;
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
  const paths = [...new Set(calls.map((c) => c.split(' ')[1]!))].filter((p) => g.inputs[p]);
  const inputs = paths.map((p) => `    ${JSON.stringify(p)}: ${JSON.stringify(g.inputs[p])}`);
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
      else throw new Error(`shard ${name} is ${Buffer.byteLength(text)} bytes, over ${SHARD_BYTES}`);
    }
  };
  await place(Object.keys(g.answers), 1);
  rmSync(GOLDEN, { recursive: true, force: true });
  mkdirSync(GOLDEN);
  for (const [name, text] of files) writeFileSync(goldenJson(name), text);
  const index = JSON.stringify({ callers: g.callers, shards: [...files.keys()].sort() });
  writeFileSync(INDEX, await prettier.format(index, { ...(await prettier.resolveConfig(INDEX.pathname)), filepath: INDEX.pathname }));
}

function readGolden(): Golden {
  const index = JSON.parse(readFileSync(INDEX, 'utf8')) as { callers: unknown; shards: string[] };
  const g: Golden = { callers: index.callers, inputs: {}, answers: {} };
  // A shard the index does not name is a leftover, and fails like a missing one.
  expect(readdirSync(GOLDEN).sort()).toEqual(index.shards.map((s) => `${s}.json`).sort());
  for (const shardName of index.shards) {
    const shard = JSON.parse(readFileSync(goldenJson(shardName), 'utf8')) as {
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;

/** Ids and times made during the run, recorded by their place; the same id keeps its number for the whole run. */
function normaliser() {
  const seen = new Map<string, string>();
  return (body: string) =>
    body
      .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
      .replace(UUID, (id) => {
        const key = id.toLowerCase();
        if (FIXED_IDS.has(key)) return id;
        if (!seen.has(key)) seen.set(key, `<uuid-${seen.size + 1}>`);
        return seen.get(key)!;
      })
      .replace(ISO_TIME, (t) => (t.startsWith('2026-01-01') || t.startsWith('2099-01-01') ? t : '<time>'));
}

async function replay(recorded: Golden['inputs'] | null, db: TestDatabase): Promise<Golden> {
  const answers: Golden['answers'] = {};
  const samples: Golden['inputs'] = {};
  let callers: unknown = null;
  const normalise = normaliser();
  const setups: Array<[string, OpsEnv, string | null]> = [
    ['blank', blankEnv, null],
    ['stored', { ...blankEnv, IDENTITY_URL: IDENTITY }, db.url],
  ];
  for (const [setup, env, sqlUrl] of setups) {
    const { app, router, close } = await composeAsIndex(env, sqlUrl);
    try {
      const anyRouter: AnyRouter = router;
      const procedures: Record<string, Proc> = anyRouter._def.procedures;
      callers ??= procedureCallers(router as never);
      for (const path of Object.keys(procedures).sort()) {
        const proc = procedures[path]!;
        if (proc._def.type === 'subscription') continue;
        // A call missing from the recording gets samples from its schema; its answers then match no recorded key and fail.
        samples[path] = recorded?.[path] ?? samples[path] ?? samplesOf(sampleInput(proc));
        const query = proc._def.type === 'query';
        for (const [inputName, input] of inputs(samples[path]))
          for (const [callerName, caller] of CALLERS) {
            const url = `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
            const payload = query ? undefined : input === undefined ? '' : JSON.stringify(input);
            const h = headers(caller);
            const res = await app.inject({
              method: query ? 'GET' : 'POST',
              url,
              headers: payload === undefined ? h : { ...h, 'content-type': 'application/json' },
              ...(payload === undefined ? {} : { payload }),
            });
            (answers[`${setup} ${path}`] ??= {})[`${inputName} ${callerName}`] = { status: res.statusCode, body: normalise(res.body) };
          }
      }
    } finally {
      await close();
    }
  }
  return { callers, inputs: samples, answers };
}

describe('the wire replay: svc-ops answers every ops call as recorded', () => {
  // Some answers carry the time: one fixed clock keeps them the same on every run. Shared packages read APP_ENV and a few
  // settings per request: they read the same blank source, whatever runs the test.
  let saved: NodeJS.ProcessEnv;
  let db: TestDatabase;
  beforeEach(async () => {
    saved = process.env;
    db = await createTestDatabase({ service: 'ops' });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
    vi.stubGlobal('fetch', identityStub);
    process.env = { ...ENV_SOURCE, ...(saved.WIRE_REPLAY_WRITE ? { WIRE_REPLAY_WRITE: saved.WIRE_REPLAY_WRITE } : {}) };
  }, 120_000);
  afterEach(async () => {
    process.env = saved;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await db?.drop();
  }, 30_000);

  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const write = process.env.WIRE_REPLAY_WRITE === '1';
    const now = await replay(write ? null : readGolden().inputs, db);
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
  }, 300_000);
});
