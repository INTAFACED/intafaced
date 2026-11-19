import Fastify from 'fastify';
import type { AnyRouter } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SCOPES, type Principal, type Scope } from '@intafaced/auth';
import {
  REGION_FAIL_CLOSED_ENV,
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_FAIL_CLOSED_ENV,
  UNSIGNED_SANCTIONS_ROWS_ENV,
} from '@intafaced/config';
import { encodePrincipal, procedureCallers, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import type { Env } from './env.js';
import { parseContractEscrowTokens } from './contract-escrow.js';
import { buildEdgeContext } from './edge-context.js';
import { installP2pS2sRawBody } from './s2s-auth.js';
import { registerClosureCheck } from './closure/closure-check.js';
import {
  P2pService,
  publishedDisputeEscalationRecheckSeconds,
  publishedDisputeSlaSeconds,
  publishedEscrowDeadlineSeconds,
  publishedInstrumentRetentionDays,
  publishedPaymentDeadlineSeconds,
  publishedReleaseDeadlineSeconds,
} from './p2p-service.js';
import { InstrumentService } from './instrument-service.js';
import { offerLimitsFromEnv } from './merchant-limits.js';
import { createLedgerClient } from './ledger-client.js';
import { unconfiguredCounterpartyState } from './counterparty-state.js';
import { MerchantService } from './merchant-service.js';
import { unwiredApprovalConsumer } from './action-approval-consume.js';
import { createTakeStepUp } from './take-step-up.js';
import { createReleaseStepUp } from './release-step-up.js';
import { createInstrumentStepUp } from './instrument-step-up.js';
import { OpsReads } from './ops/ops-reads.js';
import { createP2pRouter } from './router.js';
import { BlockRfqService } from './block-rfq.js';
import { SqlBlockQuoteStore } from './block-rfq-store.js';
import { parseModeratorUserIds } from './moderation-auth.js';
import { P2pErasure } from './erasure.js';
import { instrumentKeyHealth } from './instrument-key-provider.js';
import { parseVerificationLimits } from './verification-limits.js';
import { parseActiveOrderCap, parseBuyerCancelLimit, parsePairLimits } from './take-limits.js';
import { parseReminderPolicy } from './seller-reminders.js';
import { parseToleranceBps } from './amount-mismatch.js';
import { parseAdContentRules } from './ad-content-rules.js';
import { parsePostingThresholds } from './posting-eligibility.js';
import { AdvertiserTermsAcceptances, advertiserTermsVersion, createAdvertiserTerms } from './advertiser-terms.js';
import { createLocalTestKeyProvider } from './local-test-kms.js';
import { createLocalTestReferencePrices } from './local-test-reference.js';
import { createTakeGate, unwiredContactReader } from './take-eligibility.js';

/**
 * The wire replay for svc-p2p: every call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden.json` and `wire-replay.golden/` hold what svc-p2p answered (main 2026-11-19, as it is, bugs
 * included) to a matrix of requests: every procedure of the router `index.ts` mounts and the one REST route it mounts
 * through an exported register function (`/internal/closure-check`), six inputs, seven callers and each service that
 * calls svc-p2p, sent through the production Fastify adapter with `index.ts`'s context and raw-body hook.
 *
 * The composition is `index.ts`'s, line for line, from a blank environment (only the secrets the schema requires are
 * set) on a freshly migrated test database: every owner value blank, every outside service (ledger, identity,
 * protocol) unreachable or unwired as `index.ts` leaves it, the bus in memory. A later move of these calls must answer
 * each one byte for byte the same; a wrong door, a changed refusal code, a widened input or a reshaped envelope shows
 * here as a difference.
 *
 * Each call's inputs are made from its own input schema once and kept in the recording, so a changed schema cannot
 * change its own requests: nothing, null, a wrong type, `{}`, a sample of what the schema asks for, and that sample
 * with every field null. Calls run in name order on one database, so a call that writes leaves its row for the next.
 *
 * Ids and times the database or the clock makes are new on every run, so each is recorded by its place: a uuid the
 * replay did not choose becomes `<uuid-N>` in order of first appearance, an ISO time becomes `<time>`, a cursor
 * becomes `<cursor>`, tRPC's stack becomes `<stack>`. The screening list is fixed for the run.
 *
 * Not recorded: `/health`, `/ready`, `/internal/escrow-integrity`, `/internal/moderation-backlog` and
 * `/internal/reputation/:userId`, written inline in `index.ts`, which connects to a database and a bus and listens
 * when imported; and the sweeps (a timer in `index.ts`).
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
const SECRET = 'a-p2p-wire-replay-edge-secret-long-enough';
const INTERNAL = 'a-p2p-wire-replay-internal-secret-long-enough';
/** A port nothing listens on: an outside service that is not there. */
const NOWHERE = 'http://127.0.0.1:1';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const FIXED_IDS = new Set([USER, ID, SESSION]);

/** What every set-up holds: the secrets the schema refuses to start without, and an unreachable ledger. */
const BASE_ENV: NodeJS.ProcessEnv = {
  APP_ENV: 'test',
  SERVICE_NAME: 'svc-p2p',
  DATABASE_URL: 'postgres://replay:replay@localhost:5432/replay_test',
  DATABASE_POOL_MAX: '1',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: INTERNAL,
  LEDGER_URL: NOWHERE,
};

/**
 * `boot`: the least svc-p2p starts on. The clocks and the retention have no default and `index.ts` refuses to start
 * without them, so they hold the local test stack's TEST figures (`tooling/scripts/local-stack-services/p2p.mjs`);
 * every other owner value is blank and identity and protocol are unwired.
 */
const BOOT_ENV: NodeJS.ProcessEnv = {
  ...BASE_ENV,
  P2P_ESCROW_DEADLINE_SECONDS: '120',
  P2P_PAYMENT_DEADLINE_SECONDS: '180',
  P2P_RELEASE_DEADLINE_SECONDS: '1800',
  P2P_DISPUTE_SLA_SECONDS: '604800',
  P2P_DISPUTE_ESCALATION_RECHECK_SECONDS: '3600',
  P2P_SWEEP_INTERVAL_SECONDS: '30',
  P2P_INSTRUMENT_RETENTION_DAYS: '90',
};

/**
 * `stack`: `boot` plus the owner values the local test stack sets, fixed here as they were on 2026-11-19 (the free
 * TEST cut and `tooling/profiles/test-owner-values/p2p.json`), so a later profile edit does not move the recording.
 */
const STACK_ENV: NodeJS.ProcessEnv = {
  ...BOOT_ENV,
  P2P_FEE_BPS: '0',
  P2P_ACTIVE_ORDER_CAP: '20',
  P2P_BUYER_CANCEL_LIMIT: '3',
  P2P_BUYER_CANCEL_WINDOW_HOURS: '24',
  P2P_REMIND_WAIT_SECONDS: '5',
  P2P_REMIND_MAX: '3',
  P2P_ADVERTISER_TERMS_VERSION: 'TEST-2026-10-24',
  P2P_AD_CONTENT_RULES: JSON.stringify({
    messenger: ['telegram', 'whatsapp', 'wechat', 'signal app'],
    link: ['http://', 'https://', 'www.'],
    contact: ['call me', 'text me', 'my number'],
  }),
  P2P_POSTING_THRESHOLDS: JSON.stringify({ EUR: { minKycTier: 'basic', minCompletedOrders: '0' }, USD: 'none' }),
  P2P_MISMATCH_TOLERANCE_BPS: '50',
  P2P_EXPORT_MAX_RANGE_DAYS: '90',
  P2P_EXPORT_MAX_ROWS: '1000',
  P2P_EXPORT_DAILY_QUOTA: '5',
  P2P_PAIR_LIMITS: JSON.stringify({ 'USDT/EUR': { min: '0.5', max: '500' }, 'USDT/USD': { min: '0.5', max: '500' } }),
  P2P_RECEIPT_DAILY_QUOTA: '20',
  P2P_RECEIPT_PER_TRADE_QUOTA: '5',
  P2P_REVIEW_EDIT_WINDOW_SECONDS: '600',
  P2P_VERIFICATION_LIMITS: JSON.stringify({
    currency: 'EUR',
    tiers: Object.fromEntries(
      ['none', 'basic', 'full', 'institutional'].map((t) => [
        t,
        { orderMin: '0.5', orderMax: '500', dailyMax: '600', lifetimeMax: '100000' },
      ]),
    ),
  }),
  P2P_OFFER_EDITS_PER_DAY: '20',
  P2P_SHARE_LINK_MAX_SECONDS: '86400',
  P2P_APPEAL_REVIEW_HOURS: '48',
  P2P_FOLLOWER_NOTICES_PER_DAY: '20',
};

/** `env.ts` parses `process.env` when it is imported: a fresh import over the set-up's source alone. */
async function loadEnv(source: NodeJS.ProcessEnv): Promise<Env> {
  const saved = process.env;
  process.env = { ...source };
  vi.resetModules();
  try {
    return (await import('./env.js')).env;
  } finally {
    process.env = saved;
  }
}

const SETUPS: ReadonlyArray<[string, Env]> = [
  ['boot', await loadEnv(BOOT_ENV)],
  ['stack', await loadEnv(STACK_ENV)],
];

/** The screening list and its fail-closed switches, fixed for the run: KP is screened out, every other region is not. */
const SCREENING_ENV: Record<string, string | undefined> = {
  [SANCTIONS_REGIONS_ENV]: 'KP',
  [SANCTIONS_SOURCE_ENV]: 'wire-replay-fixture',
  [UNSIGNED_SANCTIONS_ROWS_ENV]: undefined,
  [SCREENING_FAIL_CLOSED_ENV]: undefined,
  [REGION_FAIL_CLOSED_ENV]: undefined,
};

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

let db: TestDatabase | undefined;

beforeAll(async () => {
  // Shared packages read APP_ENV and the screening settings per request: the same fixed values, whatever runs the test.
  for (const [name, value] of Object.entries({ ...BASE_ENV, ...SCREENING_ENV })) vi.stubEnv(name, value);
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is required (database name must end with _test)');
  db = await createTestDatabase({ service: 'p2p', url, migrations });
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await db?.drop();
}, 30_000);

/** `index.ts`'s composition, in its order, over the blank environment; only the bus and the database are the test's. */
function createReplayP2pRouter(sql: TestDatabase['sql'], env: Env) {
  const bus = new MemoryEventBus('svc-p2p');
  const ledger = createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, { s2s: undefined });
  const instrumentKeyProvider = createLocalTestKeyProvider(process.env);
  const instrumentKey = instrumentKeyHealth(instrumentKeyProvider?.kind);
  const instruments = new InstrumentService(sql, {
    retentionDays: publishedInstrumentRetentionDays(env.P2P_INSTRUMENT_RETENTION_DAYS),
    keyProvider: instrumentKeyProvider,
  });
  const offerLimits = offerLimitsFromEnv(env);
  const p2p: P2pService = new P2pService(sql, ledger, bus, {
    instruments,
    feeBps: env.P2P_FEE_BPS,
    tradingEnabled: env.P2P_TRADING_ENABLED,
    offerLimits,
    appealReviewHours: env.P2P_APPEAL_REVIEW_HOURS,
    followerNoticesPerDay: env.P2P_FOLLOWER_NOTICES_PER_DAY,
    reviewEditWindowSeconds: env.P2P_REVIEW_EDIT_WINDOW_SECONDS,
    exportPolicy: {
      maxRangeDays: env.P2P_EXPORT_MAX_RANGE_DAYS,
      maxRows: env.P2P_EXPORT_MAX_ROWS,
      exportDailyQuota: env.P2P_EXPORT_DAILY_QUOTA,
      receiptDailyQuota: env.P2P_RECEIPT_DAILY_QUOTA,
      receiptPerTradeQuota: env.P2P_RECEIPT_PER_TRADE_QUOTA,
    },
    merchantStatusOf: async (userId: string) => (await merchants.get(userId))?.status ?? null,
    affiliateAccrue: undefined,
    affiliatePayout: undefined,
    counterpartyState: unconfiguredCounterpartyState(),
    verificationLimits: parseVerificationLimits(env.P2P_VERIFICATION_LIMITS),
    securityChangeLockSeconds: env.P2P_SECURITY_CHANGE_LOCK_SECONDS,
    takeLimits: {
      activeOrderCap: parseActiveOrderCap(env.P2P_ACTIVE_ORDER_CAP),
      pairLimits: parsePairLimits(env.P2P_PAIR_LIMITS),
      buyerCancels: parseBuyerCancelLimit(env.P2P_BUYER_CANCEL_LIMIT, env.P2P_BUYER_CANCEL_WINDOW_HOURS),
    },
    reminders: parseReminderPolicy(env.P2P_REMIND_WAIT_SECONDS, env.P2P_REMIND_MAX),
    offerEditsPerDay: parseActiveOrderCap(env.P2P_OFFER_EDITS_PER_DAY),
    shareLinkMaxSeconds: parseActiveOrderCap(env.P2P_SHARE_LINK_MAX_SECONDS),
    mismatchToleranceBps: parseToleranceBps(env.P2P_MISMATCH_TOLERANCE_BPS),
    advertiserTerms: createAdvertiserTerms({
      acceptances: new AdvertiserTermsAcceptances(sql),
      version: advertiserTermsVersion(env.P2P_ADVERTISER_TERMS_VERSION),
    }),
    sellBalanceAtPost: true,
    adContentRules: parseAdContentRules(env.P2P_AD_CONTENT_RULES),
    postingThresholds: parsePostingThresholds(env.P2P_POSTING_THRESHOLDS),
    deadlines: {
      escrowSeconds: publishedEscrowDeadlineSeconds(env.P2P_ESCROW_DEADLINE_SECONDS),
      paymentSeconds: publishedPaymentDeadlineSeconds(env.P2P_PAYMENT_DEADLINE_SECONDS),
      releaseSeconds: publishedReleaseDeadlineSeconds(env.P2P_RELEASE_DEADLINE_SECONDS),
      disputeSeconds: publishedDisputeSlaSeconds(env.P2P_DISPUTE_SLA_SECONDS),
      escalationRecheckSeconds: publishedDisputeEscalationRecheckSeconds(env.P2P_DISPUTE_ESCALATION_RECHECK_SECONDS),
    },
    referencePrices: createLocalTestReferencePrices(process.env),
  });
  const erasure = new P2pErasure(sql);
  const moderatorUserIds = parseModeratorUserIds(env.P2P_MODERATOR_USER_IDS);
  const merchants: MerchantService = new MerchantService(sql, p2p);
  const blockRfq = new BlockRfqService(new SqlBlockQuoteStore(sql), { isTradingEnabled: () => p2p.isTradingEnabled() });
  const takeGate = createTakeGate({ contact: unwiredContactReader() });
  const actionApprovals = unwiredApprovalConsumer();
  const contractEscrow = {
    tokens: parseContractEscrowTokens(env.P2P_CONTRACT_ESCROW_TOKENS),
    disputeWindowSeconds: env.P2P_CONTRACT_ESCROW_DISPUTE_WINDOW_SECONDS ?? null,
    reader: null,
  };
  return createP2pRouter(
    p2p,
    instruments,
    erasure,
    {
      moderatorUserIds,
      offerLimits,
      blockRfq,
      approvals: actionApprovals,
      instrumentKeyProvider: instrumentKey.instrumentKeyProvider,
      opsReads: new OpsReads(sql),
      disputeResolveRequiresApproval: env.P2P_DISPUTE_RESOLVE_REQUIRES_APPROVAL,
      takeGate,
      takeStepUp: createTakeStepUp({ sql, approvals: actionApprovals }),
      releaseStepUp: createReleaseStepUp({ sql, approvals: actionApprovals }),
      instrumentStepUp: createInstrumentStepUp({ sql, approvals: actionApprovals }),
      contractEscrow,
    },
    merchants,
  );
}

/** One app as `index.ts` builds it: the raw-body hook, the closure check, then the tRPC mount. */
async function serve(
  sql: TestDatabase['sql'],
  env: Env,
  router: ReturnType<typeof createP2pRouter>,
  routes: Array<{ method: string; url: string }>,
) {
  // Fastify gives each request a counted id; one fixed id keeps an added call from shifting every later answer.
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD' || route.url.startsWith('/trpc')) continue;
      routes.push({ method, url: route.url });
    }
  });
  installP2pS2sRawBody(app);
  registerClosureCheck(app, { sql, secret: env.INTERNAL_SERVICE_SECRET, s2s: undefined });
  const edgeContext = buildEdgeContext(env);
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router, createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
  await app.ready();
  return app;
}

type How = 'signed' | 'forged' | 'none';
interface Caller {
  readonly scopes: readonly Scope[];
  readonly tier: Principal['tier'];
  readonly mfa: boolean;
  readonly region: string;
  readonly how: How;
}

const CUSTOMER: Scope[] = ['p2p:read', 'p2p:write'];
/**
 * Nobody; a signed person with no scope; a verified customer in a served region, an unserved one and a screened one;
 * an operator holding every scope with MFA; and a customer's principal with no signature.
 */
const CALLERS: ReadonlyArray<[string, Caller]> = [
  ['anon', { scopes: [], tier: 'none', mfa: false, region: 'DE', how: 'none' }],
  ['no-scope', { scopes: [], tier: 'basic', mfa: false, region: 'DE', how: 'signed' }],
  ['customer', { scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'DE', how: 'signed' }],
  ['customer-US', { scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'US', how: 'signed' }],
  ['customer-KP', { scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'KP', how: 'signed' }],
  ['all', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'DE', how: 'signed' }],
  ['forged', { scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'DE', how: 'forged' }],
];

/** The services that call svc-p2p, each with a body-bound signature over the shared secret. */
const SERVICES = ['svc-identity', 'svc-notify', 'svc-edge', 'svc-ops'] as const;

function headers(caller: Caller): Record<string, string> {
  if (caller.how === 'none') return { 'x-intafaced-region': caller.region };
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
    ...(caller.how === 'signed' ? { 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, caller.region) } : {}),
    'x-intafaced-region': caller.region,
  };
}

type Json = { [k: string]: unknown };

/** Strings tried against a schema's pattern, in order: the first that matches is the sample. */
const PATTERN_TRIES = [
  '1.50',
  '1',
  '1.5',
  'USDT',
  'EUR',
  'DE',
  'placeholder',
  ID,
  '2026-01-01',
  '2026-01-01T00:00:00Z',
  'a-b',
  'A',
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
      // A sample says it is a placeholder, so the secret scan never reads a sample field as a committed credential.
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

/** The two inputs made from a call's own schema, kept in the recording as the JSON text that is sent. */
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
  /** Per call, per `<input> <caller>`: the answer. */
  readonly answers: Record<string, Record<string, Answer>>;
}

/** The shard a call is kept in: its set-up and namespace (`stack-offers`), or for REST `<set-up>-rest`. */
function shardOf(call: string): string {
  const [setup, ...rest] = call.split(' ');
  const name = rest.join(' ');
  return `${setup}-${/^[A-Z]+ \//.test(name) ? 'rest' : name.split('.')[0]}`;
}

/** The request name of a recorded call: the call without its set-up. */
const requestOf = (call: string) => call.slice(call.indexOf(' ') + 1);

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
  const inputs = calls
    .filter((c) => c.startsWith(`${SETUPS[0]![0]} `) && g.inputs[requestOf(c)])
    .map((c) => `    ${JSON.stringify(requestOf(c))}: ${JSON.stringify(g.inputs[requestOf(c)])}`);
  return [
    '{',
    `  "inputs": {\n${inputs.join(',\n')}\n  },`,
    `  "bodies": [\n${bodies.map((b) => `    ${JSON.stringify(b)}`).join(',\n')}\n  ],`,
    `  "answers": {\n${rows.join(',\n')}\n  }`,
    '}',
    '',
  ].join('\n');
}

/**
 * Writes the recording in the repo's own format, each shard under SHARD_BYTES. Calls are grouped by namespace; a group
 * too big for one file is cut, in name order, into numbered parts.
 */
async function writeGolden(g: Golden) {
  const prettier = await import('prettier');
  const format = async (name: string, text: string) => {
    const file = goldenJson(name).pathname;
    return prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file });
  };
  const files = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const c of Object.keys(g.answers)) groups.set(shardOf(c), [...(groups.get(shardOf(c)) ?? []), c]);
  for (const [name, group] of groups) {
    const whole = await format(name, shardText(group, g));
    if (Buffer.byteLength(whole) <= SHARD_BYTES) {
      files.set(name, whole);
      continue;
    }
    let part: string[] = [];
    let n = 1;
    for (const call of group) {
      const next = await format(`${name}-${n}`, shardText([...part, call], g));
      if (part.length > 0 && Buffer.byteLength(next) > SHARD_BYTES) {
        files.set(`${name}-${n}`, await format(`${name}-${n}`, shardText(part, g)));
        n += 1;
        part = [call];
      } else part.push(call);
    }
    const last = await format(`${name}-${n}`, shardText(part, g));
    if (Buffer.byteLength(last) > SHARD_BYTES)
      throw new Error(`shard ${name}-${n} is ${Buffer.byteLength(last)} bytes, over ${SHARD_BYTES}`);
    files.set(`${name}-${n}`, last);
  }
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
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** Ids and times the database or the clock made, recorded by their place; the numbering carries over the whole run. */
function stable(body: string, ids: Map<string, string>): string {
  return body
    .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
    .replace(/"(nextCursor|cursor)":"(?:[^"\\]|\\.)*"/g, '"$1":"<cursor>"')
    .replace(UUID, (id) => {
      if (FIXED_IDS.has(id.toLowerCase())) return id;
      if (!ids.has(id)) ids.set(id, `<uuid-${ids.size + 1}>`);
      return ids.get(id)!;
    })
    .replace(ISO_TIME, '<time>');
}

async function send(
  app: Awaited<ReturnType<typeof serve>>,
  method: string,
  url: string,
  payload: string | undefined,
  h: Record<string, string>,
  ids: Map<string, string>,
): Promise<Answer> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: payload === undefined ? h : { ...h, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: stable(res.body, ids) };
}

async function replay(recorded: Golden['inputs'] | null): Promise<Golden> {
  const sql = db!.sql;
  const answers: Golden['answers'] = {};
  const samples: Golden['inputs'] = {};
  let callers: unknown;
  for (const [setup, env] of SETUPS) {
    await db!.truncateAll();
    const r = createReplayP2pRouter(sql, env);
    callers ??= procedureCallers(r as never);
    const anyRouter: AnyRouter = r;
    const procedures: Record<string, Proc> = anyRouter._def.procedures;
    const ids = new Map<string, string>();
    const routes: Array<{ method: string; url: string }> = [];
    const app = await serve(sql, env, r, routes);
    try {
      for (const path of Object.keys(procedures).sort()) {
        const proc = procedures[path]!;
        if (proc._def.type === 'subscription') continue;
        // A call missing from the recording gets samples from its schema; its answers then match no recorded key and fail.
        samples[path] ??= recorded?.[path] ?? samplesOf(sampleInput(proc));
        const query = proc._def.type === 'query';
        const request = (input: unknown) => ({
          method: query ? 'GET' : 'POST',
          url: `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`,
          payload: query ? undefined : input === undefined ? '' : JSON.stringify(input),
        });
        const call = `${setup} ${path}`;
        for (const [inputName, input] of inputs(samples[path]))
          for (const [callerName, caller] of CALLERS) {
            const { method, url, payload } = request(input);
            (answers[call] ??= {})[`${inputName} ${callerName}`] = await send(app, method, url, payload, headers(caller), ids);
          }
      }
      // REST: every route `index.ts` mounts through a register function, path parameters filled with one id, the six bodies.
      for (const route of [...routes].sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`))) {
        const name = `${route.method} ${route.url}`;
        const call = `${setup} ${name}`;
        const url = route.url.replace(/:[A-Za-z]+/g, ID);
        const takesBody = route.method !== 'GET' && route.method !== 'DELETE';
        if (takesBody) samples[name] ??= recorded?.[name] ?? samplesOf({ userId: USER, subAccountIds: [] });
        const bodies: Array<[string, unknown]> = takesBody ? inputs(samples[name]!) : [['absent', undefined]];
        for (const [inputName, input] of bodies) {
          const payload = takesBody ? (input === undefined ? '' : JSON.stringify(input)) : undefined;
          for (const [callerName, caller] of CALLERS)
            (answers[call] ??= {})[`${inputName} ${callerName}`] = await send(app, route.method, url, payload, headers(caller), ids);
          for (const service of SERVICES)
            (answers[call] ??= {})[`${inputName} ${service}`] = await send(
              app,
              route.method,
              url,
              payload,
              serviceAuthHeadersForBody(service, INTERNAL, payload ?? ''),
              ids,
            );
        }
      }
    } finally {
      await app.close();
    }
  }
  return { callers, inputs: samples, answers };
}

describe('the wire replay: svc-p2p answers every call as main did on 2026-11-19', () => {
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
