import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  REGION_FAIL_CLOSED_ENV,
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_FAIL_CLOSED_ENV,
  UNSIGNED_SANCTIONS_ROWS_ENV,
} from '@intafaced/config';
import { createEdgeContext, encodePrincipal, procedureCallers, signPrincipalHeader, type Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { missingLake } from './backtest/lake.js';
import {
  missingFees,
  missingHistory,
  missingMarginRules,
  missingVenuePrices,
  tradeFeePort,
  tradeHistoryPort,
  tradeMarginRulesPort,
  tradeVenuePricePort,
} from './engine/ports.js';
import { openDisclosureRepository } from './disclosure/open.js';
import { openShareRepository } from './share/open.js';
import { openTemplateRepository } from './templates/open.js';
import { createQuantRouter } from './router.js';
import { idempotencyKeyHeaderOf, openKeyIdempotencyRepository, refuseKeyCall } from './key-api/key-api.js';
import { openRunRepository } from './runs/open.js';
import { openStrategyRepository } from './studio/open.js';
import { openQuota } from './quota/open.js';
import { openNotifyRepository } from './notify/open.js';
import { openRiskRepository } from './risk/open.js';
import { openTeamRepository } from './team/open.js';
import { openLibraryRepository } from './library/open.js';
import { parseLicences, parseRealismChecklist } from './library/service.js';
import { openLifecycleRepository } from './lifecycle/open.js';
import { openApprovalRepository } from './approval/repository.js';
import { createMemoryLakeStore, createPostgresLakeStore, type LakeSettings } from './lake/lake.js';
import { parseQuotaSeed } from './quota/quota.js';

/**
 * The wire replay for svc-quant: every call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden/` holds what svc-quant's tRPC router answered (main 2026-11-19, as it is, bugs included) to a
 * matrix of requests: every procedure of the router `index.ts` mounts, each call's own inputs and six generic ones, and
 * several callers, in two set-ups. `blank` is the router `index.ts` builds from an empty environment: no database, no
 * svc-trade, every owner value blank. `set` is the same wiring on a freshly migrated database with every owner value
 * set, svc-trade's candle and fee reads answered by a fixed stub, and a clock fixed for the run; the set-up saves one
 * strategy and runs one backtest on it first, so the calls that need them reach past "not found". Requests go through
 * the production Fastify adapter with the context `index.ts` builds (the edge context, the API-key refusal and the
 * `Idempotency-Key` header). A later move of these calls must answer each one byte for byte the same; a wrong door, a
 * changed refusal code, a widened input or a reshaped envelope shows here as a difference.
 *
 * Each call's own inputs go to every caller. The six generic inputs (absent, null, a wrong type, `{}`, the valid input
 * plus a key, the valid input with every field null) go to the two callers that reach input checking past every
 * door (a signed customer, a signed operator), which keeps the recording within the size the CI review reads (ten parts).
 *
 * Ids and times the database makes are new on every run, so each is recorded by its place: a uuid the replay did not
 * choose becomes `<uuid-N>` in order of first appearance across the run (the same id keeps its number everywhere), an
 * ISO time becomes `<time>`, a cursor built from them becomes `<cursor>`, a run's wall-clock duration becomes
 * `<duration>`, a share link's random token becomes `<token-N>` wherever it appears, and `ops.runCounts`'s
 * `byOutcome`, which main lists in no fixed order, is recorded sorted by outcome. tRPC's stack becomes `<stack>`. The
 * screening list is fixed here, so the recording does not change with the machine's environment.
 *
 * `/health` and `/ready` are plain Fastify routes written inline in `index.ts`, which connects to a database and
 * listens when imported; they are not in this recording. Nor are the fill-alert sweep and the lake's capture timer.
 *
 * The recording is one file for the callers and, per set-up, files cut at call boundaries, so each new file stays under
 * the size one review part reads whole. `WIRE_REPLAY_WRITE=1` rewrites the golden files. Only for a change that is
 * meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/** One recorded JSON file in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
const SECRET = 'a-quant-wire-replay-edge-secret-long-enough';

const USER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const MISSING = '77777777-7777-4777-8777-777777777777';
const SESSION = '55555555-5555-4555-8555-555555555555';
const FIXED_IDS = new Set([USER, MEMBER, OPERATOR, MISSING, SESSION]);

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-20T00:00:00.000Z');
/** The run's clock in the `set` set-up: two days after the stub's first candle. */
const NOW = T0 + 48 * HOUR;

/** The screening list and its fail-closed switches, fixed for the run: KP is screened out, every other region is not. */
const SCREENING_ENV: Record<string, string | undefined> = {
  APP_ENV: 'test',
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
  for (const [name, value] of Object.entries(SCREENING_ENV)) vi.stubEnv(name, value);
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is required (database name must end with _test)');
  db = await createTestDatabase({ service: 'quant', url, migrations });
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await db?.drop();
}, 30_000);

/** The settings `index.ts` reads, by their env names; absent is unset. */
type QuantEnv = Partial<Record<string, string>>;

/** Candle rows as svc-trade's ohlcv route answers them: [openTimeMs, open, high, low, close, volume]. */
const CLOSES = ['100', '100', '100', '110', '120', '130', '115', '100'];
function candleRows(): [number, string, string, string, string, string][] {
  return CLOSES.map((close, i) => {
    const open = i === 0 ? close : CLOSES[i - 1]!;
    const high = Number(open) > Number(close) ? open : close;
    const low = Number(open) < Number(close) ? open : close;
    return [T0 + i * HOUR, open, high, low, close, '1'];
  });
}

/** svc-trade's public reads the history, fee, venue price and venue margin-rules ports make, answered the same on every run. */
async function tradeStub(url: string) {
  const path = url.replace('http://trade.test', '').split('?')[0]!;
  if (path.startsWith('/api/v1/ohlcv/')) return { ok: true, status: 200, json: async () => candleRows() };
  if (path === '/api/v1/fees/published')
    return { ok: true, status: 200, json: async () => ({ version: 'replay:v1', fees: { 'BTC/USDT': { makerBps: 8, takerBps: 10 } } }) };
  if (path === '/api/v1/venue/spot-candles')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        symbol: 'BTC-USDC',
        test: true,
        value: candleRows().map(([at, open, high, low, close, volume]) => ({
          openAt: new Date(at).toISOString(),
          openPrice: open,
          highPrice: high,
          lowPrice: low,
          closePrice: close,
          baseVolume: volume,
        })),
      }),
    };
  if (path === '/api/v1/venue/margin-rules')
    return {
      ok: true,
      status: 200,
      json: async () => ({ symbol: 'BTC-PERP', maxLeverageBps: 50_000, maintenanceRate: '0.05', test: true }),
    };
  return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
}

type Closer = () => Promise<unknown>;

/**
 * The router as `index.ts` builds it from `env`, with the same `open*` calls and the same settings read. Two things
 * differ, so the run is the same every time: svc-trade's reads go to `tradeStub`, and the `set` set-up's clock is `NOW`.
 */
function build(env: QuantEnv, clock: (() => number) | undefined): { router: ReturnType<typeof createQuantRouter>; closers: Closer[] } {
  const dbEnv = { DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX };
  const now = clock ?? (() => Date.now());
  const lake = missingLake();
  const history = env.TRADE_URL ? tradeHistoryPort({ tradeUrl: env.TRADE_URL, now, fetch: tradeStub as never }) : missingHistory();
  const fees = env.TRADE_URL ? tradeFeePort({ tradeUrl: env.TRADE_URL, fetch: tradeStub as never }) : missingFees();
  const marginRules = env.TRADE_URL ? tradeMarginRulesPort({ tradeUrl: env.TRADE_URL, fetch: tradeStub as never }) : missingMarginRules();
  const venuePrices = env.TRADE_URL
    ? tradeVenuePricePort({ tradeUrl: env.TRADE_URL, now, fetch: tradeStub as never })
    : missingVenuePrices();
  const quota = openQuota(dbEnv, {
    defaultProfile: env.QUANT_DEFAULT_QUOTA_PROFILE ?? null,
    seed: parseQuotaSeed(env.QUANT_TEST_QUOTA_SEED),
  });
  const strategies = openStrategyRepository(dbEnv, quota.gate);
  const keyIdempotency = openKeyIdempotencyRepository(dbEnv, (url, max) => postgres(url, { max, onnotice: () => undefined }));
  const runs = openRunRepository(dbEnv, quota.gate);
  const disclosure = openDisclosureRepository(dbEnv);
  const templates = openTemplateRepository(dbEnv);
  const lifecycle = openLifecycleRepository(dbEnv);
  const shares = openShareRepository(dbEnv);
  const notify = openNotifyRepository(dbEnv);
  const risk = openRiskRepository(dbEnv);
  const team = openTeamRepository(dbEnv, quota.gate);
  const library = openLibraryRepository(dbEnv);
  const approvals = openApprovalRepository(dbEnv);
  const lakeSettings: LakeSettings = {
    symbols: (env.QUANT_LAKE_SYMBOLS ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
    captureSeconds: env.QUANT_LAKE_CAPTURE_SECONDS === undefined ? null : Number(env.QUANT_LAKE_CAPTURE_SECONDS),
    retentionDays: env.QUANT_LAKE_RETENTION_DAYS === undefined ? null : Number(env.QUANT_LAKE_RETENTION_DAYS),
  };
  const lakeSql = env.DATABASE_URL && env.DATABASE_POOL_MAX ? postgres(env.DATABASE_URL, { max: 2, onnotice: () => undefined }) : null;
  const lakeStore = lakeSql ? createPostgresLakeStore(lakeSql) : createMemoryLakeStore();
  const origins = (env.QUANT_EMBED_ORIGINS ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const num = (name: string) => (env[name] === undefined ? null : Number(env[name]));
  const router = createQuantRouter({
    wired: true,
    venueVaultSet: env.QUANT_VENUE_VAULT !== undefined,
    paperFeeBps: env.QUANT_PAPER_FEE_BPS ?? null,
    limits: {
      maxOps: env.SANDBOX_MAX_OPS === undefined ? undefined : Number(env.SANDBOX_MAX_OPS),
      maxSource: env.SANDBOX_MAX_SOURCE === undefined ? undefined : Number(env.SANDBOX_MAX_SOURCE),
    },
    lake,
    history,
    fees,
    venuePrices,
    ...(clock ? { now: clock } : {}),
    judgement: {
      criteria: {
        minTrades: env.QUANT_OOS_MIN_TRADES ?? null,
        minReturnPercent: env.QUANT_OOS_MIN_RETURN_PERCENT ?? null,
        maxDrawdownPercent: env.QUANT_OOS_MAX_DRAWDOWN_PERCENT ?? null,
        maxShortfallPercent: env.QUANT_OOS_MAX_SHORTFALL_PERCENT ?? null,
      },
      holdoutStart: env.QUANT_HOLDOUT_START ?? null,
      checks: {
        maxSampleGapPercent: env.QUANT_CHECK_MAX_SAMPLE_GAP_PERCENT ?? null,
        maxVariants: env.QUANT_CHECK_MAX_VARIANTS ?? null,
        maxOffsetShiftPercent: env.QUANT_CHECK_MAX_OFFSET_SHIFT_PERCENT ?? null,
      },
      account: { marginCallPercent: env.QUANT_ACCOUNT_MARGIN_CALL_PERCENT ?? null, venue: marginRules },
    },
    strategies: strategies.repository,
    runs: runs.repository,
    keyIdempotency: keyIdempotency.repository,
    disclosure: disclosure.repository,
    templates: templates.repository,
    quota: quota.repository,
    notify: notify.repository,
    risk: risk.repository,
    team: team.repository,
    library: {
      repository: library.repository,
      licences: parseLicences(env.QUANT_LIBRARY_LICENCES),
      checklist: parseRealismChecklist(env.QUANT_REALISM_CHECKLIST),
    },
    editLockSeconds: num('QUANT_EDIT_LOCK_SECONDS'),
    lifecycle: lifecycle.repository,
    approvals: approvals.repository,
    monteCarlo: { runs: num('QUANT_MONTECARLO_RUNS'), minTrades: num('QUANT_MONTECARLO_MIN_TRADES') },
    dataLake: { store: lakeStore, settings: lakeSettings },
    releaseNoteMax: num('QUANT_RELEASE_NOTE_MAX'),
    share: {
      repository: shares.repository,
      rate: num('QUANT_SHARE_RATE'),
      windowSec: num('QUANT_SHARE_WINDOW_SEC'),
      embedOrigins: origins.length === 0 ? null : origins,
    },
  });
  const closers: Closer[] = [
    notify.close,
    risk.close,
    team.close,
    library.close,
    strategies.close,
    runs.close,
    keyIdempotency.close,
    disclosure.close,
    templates.close,
    quota.close,
    lifecycle.close,
    approvals.close,
    shares.close,
    async () => lakeSql?.end({ timeout: 5 }),
  ];
  return { router, closers };
}

/** Every owner value set, each to a value a test stack may hold. */
function setEnv(url: string): QuantEnv {
  return {
    DATABASE_URL: url,
    DATABASE_POOL_MAX: '2',
    TRADE_URL: 'http://trade.test',
    SANDBOX_MAX_OPS: '50000',
    SANDBOX_MAX_SOURCE: '8000',
    QUANT_PAPER_FEE_BPS: '10',
    QUANT_VENUE_VAULT: 'replay-vault',
    QUANT_DEFAULT_QUOTA_PROFILE: 'TEST plan',
    QUANT_TEST_QUOTA_SEED: JSON.stringify({
      profile: 'TEST plan',
      limits: {
        strategies: '50',
        versions: '50',
        concurrent_runs: '5',
        paper_runs: '5',
        runs: '200',
        log_lines: '1000',
        storage: '10000000',
        collaborators: '5',
        notifications: '20',
      },
      sandbox: { wall_clock_ms: '5000', memory_bytes: '1000000', output_bytes: '1000000' },
    }),
    QUANT_OOS_MIN_TRADES: '1',
    QUANT_OOS_MIN_RETURN_PERCENT: '0',
    QUANT_OOS_MAX_DRAWDOWN_PERCENT: '50',
    QUANT_OOS_MAX_SHORTFALL_PERCENT: '50',
    QUANT_HOLDOUT_START: '2026-10-20T04:00:00.000Z',
    QUANT_CHECK_MAX_SAMPLE_GAP_PERCENT: '10',
    QUANT_CHECK_MAX_VARIANTS: '10',
    QUANT_CHECK_MAX_OFFSET_SHIFT_PERCENT: '10',
    QUANT_ACCOUNT_MARGIN_CALL_PERCENT: '100',
    QUANT_LIBRARY_LICENCES: 'MIT|All rights reserved',
    QUANT_REALISM_CHECKLIST: JSON.stringify({ version: 'TEST v1', items: ['costs included', 'no look-ahead'] }),
    QUANT_EDIT_LOCK_SECONDS: '300',
    QUANT_MONTECARLO_RUNS: '20',
    QUANT_MONTECARLO_MIN_TRADES: '1',
    QUANT_LAKE_SYMBOLS: 'BTC/USDT',
    QUANT_LAKE_CAPTURE_SECONDS: '60',
    QUANT_LAKE_RETENTION_DAYS: '30',
    QUANT_RELEASE_NOTE_MAX: '200',
    QUANT_SHARE_RATE: '100',
    QUANT_SHARE_WINDOW_SEC: '60',
    QUANT_EMBED_ORIGINS: 'https://embed.test',
  };
}

/** What the set-up saved, for the calls' own inputs. */
interface Seed {
  strategyId: string;
  runId: string;
  listingId: string;
}

type Built = { router: ReturnType<typeof createQuantRouter>; seed: Seed; closers: Closer[] };

const RULES = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
} as const;

/** A strategy save the user makes, under its own client id and key. */
const saveInput = (client: string) => ({
  name: 'Replay cross',
  blocks: [],
  modules: RULES,
  risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
  cash: '1000',
  environment: 'paper',
  clientStrategyId: client,
  idempotencyKey: `studio.save:${client}`,
});

/** A bar backtest over the stub's eight candles. */
const backtestInput = (strategyId: string) => ({
  strategyId,
  strategyVersion: 1,
  cash: '1000',
  from: new Date(T0).toISOString(),
  to: new Date(T0 + CLOSES.length * HOUR).toISOString(),
  fillTiming: 'next_open',
  costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
});

/** A template's rules: the shape set, every number blank for the person to fill. */
const TEMPLATE_RULES = { ...RULES, signal: { ...RULES.signal, fast: '', slow: '' }, sizing: { kind: 'quantity', value: '' } } as const;

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });

/** `index.ts`'s context: the edge context, then the API-key refusal, then the `Idempotency-Key` header. */
function quantContext({ req, info }: { req: unknown; info: { calls: ReadonlyArray<{ path: string }> } }) {
  const ctx = edgeContext(req as never);
  refuseKeyCall(
    ctx.principal,
    info.calls.map((call) => call.path),
  );
  return { ...ctx, idempotencyKeyHeader: idempotencyKeyHeaderOf((req as { headers: Record<string, string> }).headers) };
}

async function blank(): Promise<Built> {
  const { router, closers } = build({}, undefined);
  return { router, seed: { strategyId: MISSING, runId: MISSING, listingId: MISSING }, closers };
}

async function set(): Promise<Built> {
  const { router, closers } = build(setEnv(db!.url), () => NOW);
  const caller = router.createCaller(
    quantContext({
      req: { headers: { 'x-intafaced-region': 'DE', ...headers(CALLERS.find((c) => c.name === 'signed')!) }, id: 'replay-seed' },
      info: { calls: [] },
    }) as never,
  );
  const strategy = await caller.studio.save(saveInput('replay-seed'));
  const run = await caller.backtest.start(backtestInput(strategy.id));
  const listing = await caller.library.publish({
    strategyId: strategy.id,
    strategyVersion: 1,
    title: 'Replay seed',
    description: 'The seeded listing',
    tags: ['trend'],
    visibility: 'open',
    licence: 'MIT',
    checklistVersion: 'TEST v1',
    checklistAccepted: true,
  });
  return { router, seed: { strategyId: strategy.id, runId: run.runId, listingId: listing.listingId }, closers };
}

const SETUPS: ReadonlyArray<[string, () => Promise<Built>]> = [
  ['blank', blank],
  ['set', set],
];

async function serve(router: Built['router']) {
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router, createContext: quantContext as never },
  });
  return app;
}

type Call = { path: string; kind: 'query' | 'mutation'; own: Array<[string, unknown]> };

/** Each call with its own inputs: the valid one first, then the ones that reach its own refusals. In the order they run. */
function calls(seed: Seed): Call[] {
  const s = seed.strategyId;
  const r = seed.runId;
  const l = seed.listingId;
  const q = (path: string, ...own: Array<[string, unknown]>): Call => ({ path, kind: 'query', own });
  const m = (path: string, ...own: Array<[string, unknown]>): Call => ({ path, kind: 'mutation', own });
  return [
    q('health', ['valid', undefined]),
    q('sandbox.capabilities', ['valid', undefined]),
    q('quickStart', ['valid', {}], ['other-account', { accountId: MISSING }]),
    q('quota.get', ['valid', {}]),
    q('limits.get', ['valid', {}]),
    q('tier.list', ['valid', {}]),
    q('backtest.accountRules', ['valid', { symbol: 'BTC/USDT' }]),
    q('backtest.fee', ['valid', { symbol: 'BTC/USDT' }], ['unknown-symbol', { symbol: 'NOPE/USDT' }]),
    q('ops.criteria.get', ['valid', undefined]),
    m(
      'ops.criteria.set',
      ['valid', { name: 'oos.minTrades', value: '2', reason: 'replay', idempotencyKey: 'crit-1' }],
      ['bad-value', { name: 'gate.paperMinutes', value: 'soon', reason: 'replay', idempotencyKey: 'crit-2' }],
      ['paper-minutes', { name: 'gate.paperMinutes', value: '1', reason: 'replay', idempotencyKey: 'crit-4' }],
      ['gate-drawdown', { name: 'gate.maxDrawdownPercent', value: '50', reason: 'replay', idempotencyKey: 'crit-5' }],
      ['queue-page', { name: 'library.queuePageSize', value: '10', reason: 'replay', idempotencyKey: 'crit-6' }],
      ['blank-reason', { name: 'live.enabled', value: null, reason: '', idempotencyKey: 'crit-3' }],
    ),
    m('ops.disclosure.publish', ['valid', { text: 'TEST disclosure text', reason: 'replay', idempotencyKey: 'disc-1' }]),
    q('ops.disclosure.counts', ['valid', undefined]),
    m(
      'ops.lake.capture',
      ['valid', { symbol: 'BTC/USDT', capturing: false, reason: 'replay', idempotencyKey: 'lake-1' }],
      ['unknown', { symbol: 'NOPE', capturing: true, reason: 'replay', idempotencyKey: 'lake-2' }],
    ),
    m(
      'ops.template.publish',
      [
        'valid',
        {
          id: 'replay-template',
          name: 'Replay template',
          description: 'A cross',
          rules: TEMPLATE_RULES,
          releaseNote: 'first',
          reason: 'replay',
          idempotencyKey: 'tpl-1',
        },
      ],
      [
        'numbers-set',
        { id: 'replay-numbers', name: 'x', description: 'x', rules: RULES, releaseNote: 'x', reason: 'x', idempotencyKey: 'tpl-3' },
      ],
      [
        'bad-id',
        { id: 'NOPE', name: 'x', description: 'x', rules: TEMPLATE_RULES, releaseNote: 'x', reason: 'x', idempotencyKey: 'tpl-2' },
      ],
    ),
    m(
      'ops.template.listing',
      ['valid', { id: 'replay-template', listed: true, reason: 'replay', idempotencyKey: 'tpl-list-1' }],
      ['unknown', { id: 'no-such', listed: true, reason: 'replay', idempotencyKey: 'tpl-list-2' }],
    ),
    m(
      'sandbox.run',
      [
        'valid',
        { language: 'javascript', source: 'oms.buy("BTC-USD", "0.01");', cash: '10000', environment: 'paper', idempotencyKey: 'sbx-1' },
      ],
      ['no-environment', { language: 'javascript', source: 'console.log(1);', cash: '10000', idempotencyKey: 'sbx-2' }],
      ['no-cash', { language: 'javascript', source: 'console.log(1);', environment: 'paper', idempotencyKey: 'sbx-3' }],
      ['escape', { language: 'javascript', source: 'process.exit(1)', cash: '10000', environment: 'paper', idempotencyKey: 'sbx-4' }],
      [
        'as-live',
        {
          language: 'javascript',
          source: 'console.log(1);',
          cash: '10000',
          environment: 'paper',
          presentedAs: 'live',
          idempotencyKey: 'sbx-5',
        },
      ],
      ['python', { language: 'python', source: 'print(1)', cash: '10000', environment: 'paper', idempotencyKey: 'sbx-6' }],
    ),
    m(
      'studio.save',
      ['valid', saveInput('replay-call')],
      ['no-client-id', { ...saveInput('replay-x'), clientStrategyId: undefined }],
      ['no-key', { ...saveInput('replay-y'), idempotencyKey: undefined }],
      ['no-risk', { ...saveInput('replay-z'), risk: {} }],
      ['bad-qty', { ...saveInput('replay-q'), modules: null, blocks: [{ side: 'buy', symbol: 'BTC/USDT', qty: 'one' }] }],
    ),
    q('studio.compile', ['valid', { modules: RULES }], ['blank-fast', { modules: { ...RULES, signal: { ...RULES.signal, fast: '' } } }]),
    q('studio.list', ['valid', { limit: 10 }], ['no-limit', {}], ['bad-cursor', { limit: 10, cursor: 'nope' }]),
    q('studio.get', ['valid', { id: s }], ['unknown', { id: MISSING }]),
    q('studio.diff', ['valid', { id: s, from: 1, to: 1 }], ['unknown-version', { id: s, from: 1, to: 9 }]),
    m(
      'studio.update',
      ['valid', { ...saveInput('replay-seed'), id: s, idempotencyKey: 'studio.update:1', releaseNote: 'tighter risk' }],
      ['long-note', { ...saveInput('replay-seed'), id: s, idempotencyKey: 'studio.update:2', releaseNote: 'x'.repeat(201) }],
      ['unknown', { ...saveInput('replay-seed'), id: MISSING, idempotencyKey: 'studio.update:3' }],
    ),
    m(
      'studio.organise',
      ['valid', { id: s, name: 'Renamed', folder: 'Replay', idempotencyKey: 'org-1' }],
      ['bad-name', { id: s, name: 7, idempotencyKey: 'org-2' }],
    ),
    m(
      'studio.run',
      ['valid', { id: s, environment: 'paper', idempotencyKey: 'run-1' }],
      ['no-environment', { id: s, idempotencyKey: 'run-2' }],
    ),
    m(
      'studio.clone',
      ['valid', { id: s, name: 'Copy', clientStrategyId: 'replay-clone', idempotencyKey: 'clone-1' }],
      ['unknown', { id: MISSING, name: 'Copy', clientStrategyId: 'replay-clone-2', idempotencyKey: 'clone-2' }],
    ),
    q('studio.operatorList', ['valid', { limit: 10 }], ['no-limit', {}]),
    m(
      'backtest.start',
      ['valid', backtestInput(s)],
      ['blank-cash', { ...backtestInput(s), cash: '' }],
      ['open-window', { ...backtestInput(s), to: new Date(NOW + HOUR).toISOString() }],
      ['bad-day', { ...backtestInput(s), from: '2026-09-31T00:00Z' }],
      ['split', { ...backtestInput(s), split: { preset: '70/30' }, enforceHoldout: true }],
      ['margin', { ...backtestInput(s), simulatedAccount: { leverage: '2' } }],
    ),
    m(
      'backtest.run',
      [
        'valid',
        {
          strategyId: s,
          symbol: 'BTC/USDT',
          walkForward: {
            inSampleFrom: new Date(T0).toISOString(),
            inSampleTo: new Date(T0 + 4 * HOUR).toISOString(),
            outOfSampleFrom: new Date(T0 + 4 * HOUR).toISOString(),
            outOfSampleTo: new Date(T0 + 8 * HOUR).toISOString(),
          },
          environment: 'backtest',
          idempotencyKey: 'bt-1',
        },
      ],
      ['no-window', { strategyId: s, symbol: 'BTC/USDT', environment: 'backtest', idempotencyKey: 'bt-3' }],
      ['no-walk-forward', { strategyId: s, symbol: 'BTC/USDT', walkForward: null, environment: 'backtest', idempotencyKey: 'bt-2' }],
    ),
    q(
      'backtest.history',
      ['valid', { limit: 10 }],
      ['by-strategy', { limit: 10, strategyId: s }],
      ['bad-cursor', { limit: 10, cursor: 'nope' }],
    ),
    q('backtest.get', ['valid', { runId: r }], ['unknown', { runId: MISSING }]),
    q('backtest.result', ['valid', { runId: r }], ['unknown', { runId: MISSING }]),
    q('backtest.report', ['valid', { runId: r }], ['unknown', { runId: MISSING }]),
    q('backtest.monteCarlo', ['valid', { runId: r, seed: 7 }], ['unknown', { runId: MISSING, seed: 7 }]),
    m(
      'backtest.rename',
      ['valid', { runId: r, label: 'Replay label' }],
      ['unknown', { runId: MISSING, label: 'x' }],
      ['long', { runId: r, label: 'x'.repeat(200) }],
    ),
    m(
      'marketplace.claim',
      ['valid', { runId: r, environment: 'backtest', idempotencyKey: 'claim-1' }],
      ['as-live', { runId: r, presentedAs: 'live', idempotencyKey: 'claim-2' }],
    ),
    q('result.share.get', ['valid', { runId: r }], ['unknown', { runId: MISSING }]),
    m(
      'result.share.create',
      ['valid', { runId: r, seq: 0 }],
      ['stale-seq', { runId: r, seq: 5 }],
      ['no-seq', { runId: r }],
      ['unknown', { runId: MISSING, seq: 0 }],
    ),
    m('result.share.embed', ['valid', { runId: r, token: 'nope' }], ['no-token', { runId: r }]),
    q('result.share.public', ['valid', { token: 'nope' }], ['blank', { token: '' }]),
    m('result.share.revoke', ['valid', { runId: r }], ['unknown', { runId: MISSING }]),
    m(
      'paper.start',
      [
        'valid',
        {
          strategyId: s,
          strategyVersion: 1,
          cash: '1000',
          holdings: [],
          feed: 'own_venue',
          costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
          ordinal: 1,
        },
      ],
      [
        'blank-cash',
        {
          strategyId: s,
          strategyVersion: 1,
          cash: '',
          holdings: [],
          feed: 'own_venue',
          costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
          ordinal: 2,
        },
      ],
      [
        'unknown',
        {
          strategyId: MISSING,
          strategyVersion: 1,
          cash: '1000',
          holdings: [],
          feed: 'own_venue',
          costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
          ordinal: 3,
        },
      ],
    ),
    q('paper.list', ['valid', { strategyId: s, limit: 10 }], ['no-limit', { strategyId: s }]),
    q('paper.get', ['valid', { runId: MISSING }]),
    m('paper.stop', ['valid', { runId: MISSING }]),
    q('notify.get', ['valid', { strategyId: s }], ['unknown', { strategyId: MISSING }]),
    m('notify.set', ['valid', { strategyId: s, channels: ['inapp'] }], ['bad-channel', { strategyId: s, channels: ['pigeon'] }]),
    q('alert.list', ['valid', { strategyId: s }]),
    m(
      'alert.create',
      ['valid', { strategyId: s, strategyVersion: 1, template: 'Filled {side} {qty}', ordinal: 1 }],
      ['blank-template', { strategyId: s, strategyVersion: 1, template: '', ordinal: 2 }],
    ),
    q('risk.get', ['valid', { strategyId: s }], ['unknown', { strategyId: MISSING }]),
    m(
      'risk.set',
      [
        'valid',
        {
          strategyId: s,
          caps: { depositPercent: '50', maxPositionNotional: '1000', maxDailyLoss: '100', equityFloor: '500' },
          floorPolicy: 'reduce_only',
        },
      ],
      [
        'blank-cap',
        {
          strategyId: s,
          caps: { depositPercent: '', maxPositionNotional: '1000', maxDailyLoss: '100', equityFloor: '500' },
          floorPolicy: 'reduce_only',
        },
      ],
      [
        'bad-policy',
        {
          strategyId: s,
          caps: { depositPercent: '50', maxPositionNotional: '1000', maxDailyLoss: '100', equityFloor: '500' },
          floorPolicy: 'shrug',
        },
      ],
    ),
    m('risk.trading', ['valid', { strategyId: s, on: false }], ['unknown', { strategyId: MISSING, on: true }]),
    q('team.get', ['valid', { strategyId: s }]),
    q('team.shared', ['valid', {}]),
    m(
      'team.set',
      ['valid', { strategyId: s, memberId: MEMBER, role: 'edit', liveControl: false }],
      ['self', { strategyId: s, memberId: USER, role: 'view', liveControl: false }],
    ),
    m('team.grant', ['valid', { strategyId: s, seconds: 600, seq: 1 }], ['negative', { strategyId: s, seconds: -1, seq: 2 }]),
    m('team.lock', ['valid', { strategyId: s }], ['unknown', { strategyId: MISSING }]),
    q('team.open', ['valid', { strategyId: s }]),
    m(
      'team.save',
      ['valid', { strategyId: s, baseVersion: 1, name: 'Team edit', releaseNote: 'by the team' }],
      ['stale', { strategyId: s, baseVersion: 9, name: 'Team edit' }],
    ),
    m('team.unlock', ['valid', { strategyId: s }]),
    q('team.paperRuns', ['valid', { strategyId: s }]),
    m(
      'team.order',
      ['valid', { strategyId: s, runId: MISSING, side: 'buy', size: '1' }],
      ['bad-size', { strategyId: s, runId: MISSING, side: 'buy', size: '-1' }],
    ),
    m('team.stop', ['valid', { strategyId: s, runId: MISSING }]),
    m('team.remove', ['valid', { strategyId: s, memberId: MEMBER }], ['unknown', { strategyId: s, memberId: MISSING }]),
    q('lifecycle.get', ['valid', { strategyId: s, strategyVersion: 1 }], ['unknown', { strategyId: MISSING, strategyVersion: 1 }]),
    m(
      'lifecycle.promote',
      ['valid', { strategyId: s, strategyVersion: 1, seq: 1 }],
      ['unknown', { strategyId: MISSING, strategyVersion: 1, seq: 2 }],
    ),
    q('approval.policy.get', ['valid', {}]),
    m(
      'approval.policy.set',
      ['valid', { required: true, idempotencyKey: 'policy-1' }],
      ['blank-key', { required: false, idempotencyKey: '' }],
    ),
    m('approval.request', ['valid', { strategyId: s, strategyVersion: 1 }], ['unknown', { strategyId: MISSING, strategyVersion: 1 }]),
    q('approval.get', ['valid', { strategyId: s }]),
    m(
      'approval.decide',
      ['valid', { strategyId: s, approvalId: 'appr-1', decision: 'approved', reason: 'fine' }],
      ['bad-decision', { strategyId: s, approvalId: 'appr-1', decision: 'maybe', reason: 'x' }],
    ),
    q('live.check', ['valid', { strategyId: s, strategyVersion: 1 }], ['unknown', { strategyId: MISSING, strategyVersion: 1 }]),
    m(
      'live.deploy',
      ['valid', { strategyId: s, strategyVersion: 1, amount: '100' }],
      ['blank-amount', { strategyId: s, strategyVersion: 1, amount: '' }],
    ),
    q('library.options', ['valid', {}]),
    q(
      'library.check',
      [
        'valid',
        {
          strategyId: s,
          strategyVersion: 2,
          title: 'Replay cross',
          description: 'A cross',
          tags: ['trend'],
          visibility: 'open',
          licence: 'MIT',
        },
      ],
      [
        'bad-licence',
        {
          strategyId: s,
          strategyVersion: 2,
          title: 'Replay cross',
          description: 'A cross',
          tags: ['trend'],
          visibility: 'open',
          licence: 'GPL',
        },
      ],
    ),
    m(
      'library.publish',
      [
        'valid',
        {
          strategyId: s,
          strategyVersion: 2,
          title: 'Replay cross',
          description: 'A cross',
          tags: ['trend'],
          visibility: 'open',
          licence: 'MIT',
          checklistVersion: 'TEST v1',
          checklistAccepted: true,
        },
      ],
      [
        'unaccepted',
        {
          strategyId: s,
          strategyVersion: 2,
          title: 'Replay cross',
          description: 'A cross',
          tags: ['trend'],
          visibility: 'open',
          licence: 'MIT',
          checklistVersion: 'TEST v1',
          checklistAccepted: false,
        },
      ],
    ),
    q('library.mine', ['valid', {}]),
    q('library.browse', ['valid', { limit: 10 }], ['by-tag', { limit: 10, tag: 'trend' }], ['bad-cursor', { limit: 10, cursor: 'nope' }]),
    q('library.get', ['valid', { listingId: l }], ['unknown', { listingId: MISSING }]),
    q('library.preview', ['valid', { listingId: l }], ['unknown', { listingId: MISSING }]),
    m('library.clone', ['valid', { listingId: l }], ['unknown', { listingId: MISSING }]),
    m('library.request', ['valid', { listingId: l, seq: 0 }], ['unknown', { listingId: MISSING, seq: 0 }]),
    m('library.grant', ['valid', { listingId: l, userId: MEMBER, seq: 0 }], ['unknown', { listingId: MISSING, userId: MEMBER, seq: 0 }]),
    m('library.revoke', ['valid', { listingId: l, userId: MEMBER, seq: 0 }], ['unknown', { listingId: MISSING, userId: MEMBER, seq: 0 }]),
    m('library.review', ['valid', { listingId: l, text: 'Good' }], ['unknown', { listingId: MISSING, text: 'Good' }]),
    q('library.lineage', ['valid', { strategyId: s }]),
    q('template.list', ['valid', { limit: 10 }], ['no-limit', {}]),
    q('template.get', ['valid', { id: 'replay-template' }], ['bad-id', { id: 'NOPE' }]),
    q('disclosure.current', ['valid', undefined]),
    q('disclosure.status', ['valid', { strategyId: s, strategyVersion: 1 }]),
    m('disclosure.accept', ['valid', { strategyId: s, strategyVersion: 1, disclosureVersion: 1 }]),
    q('lake.catalogue', ['valid', {}], ['by-symbol', { symbol: 'BTC/USDT', kind: 'tick' }]),
    m('preview.act', ['valid', { room: 'editor', action: 'compile' }], ['bad-room', { room: 'kitchen', action: 'start' }]),
    q('ops.quota.profile', ['valid', { profile: 'TEST plan' }], ['unknown', { profile: 'No plan' }]),
    m(
      'ops.quota.set',
      ['valid', { profile: 'TEST plan', resource: 'runs', limit: '300', reason: 'replay', idempotencyKey: 'q-set-1' }],
      ['blank-reason', { profile: 'TEST plan', resource: 'runs', limit: '300', reason: '', idempotencyKey: 'q-set-2' }],
    ),
    m(
      'ops.quota.sandbox',
      ['valid', { profile: 'TEST plan', limit: 'wall_clock_ms', value: '5000', reason: 'replay', idempotencyKey: 'q-sbx-1' }],
      ['bad-value', { profile: 'TEST plan', limit: 'memory_bytes', value: 'lots', reason: 'replay', idempotencyKey: 'q-sbx-2' }],
    ),
    m(
      'ops.quota.tier',
      [
        'valid',
        {
          profile: 'TEST plan',
          dataFreshnessSeconds: '60',
          priorityClass: '1',
          published: true,
          reason: 'replay',
          idempotencyKey: 'q-tier-1',
        },
      ],
      [
        'unset',
        {
          profile: 'TEST plan',
          dataFreshnessSeconds: null,
          priorityClass: null,
          published: true,
          reason: 'replay',
          idempotencyKey: 'q-tier-2',
        },
      ],
    ),
    m(
      'ops.quota.assign',
      ['valid', { accountId: MEMBER, profile: 'TEST plan', reason: 'replay', idempotencyKey: 'q-assign-1' }],
      ['unknown', { accountId: MEMBER, profile: 'No plan', reason: 'replay', idempotencyKey: 'q-assign-2' }],
    ),
    m('ops.sandbox.corpus', ['valid', { profile: 'TEST plan' }]),
    q('ops.runCounts', ['valid', { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' }], ['unset', {}]),
    q(
      'ops.runs',
      ['valid', { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z', limit: 10 }],
      ['no-limit', { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' }],
      ['big-limit', { from: null, to: null, limit: 100_000 }],
    ),
    q('ops.strategy.source', ['valid', { strategyId: s, ownerId: USER }], ['unknown', { strategyId: MISSING, ownerId: USER }]),
    q('ops.lifecycle.audit', ['valid', undefined]),
    q('ops.library.queue', ['valid', {}], ['bad-cursor', { cursor: 'nope' }]),
    m(
      'ops.library.hide',
      ['valid', { listingId: l, reason: 'replay', seq: 0 }],
      ['unknown', { listingId: MISSING, reason: 'replay', seq: 0 }],
    ),
    m(
      'ops.library.unhide',
      ['valid', { listingId: l, reason: 'replay', seq: 1 }],
      ['unknown', { listingId: MISSING, reason: 'replay', seq: 0 }],
    ),
    m(
      'ops.library.remove',
      ['valid', { listingId: l, reason: 'replay', seq: 2 }],
      ['unknown', { listingId: MISSING, reason: 'replay', seq: 0 }],
    ),
    m(
      'ops.library.dispute.open',
      ['valid', { listingId: l, reason: 'replay', ticketRef: 'T-1', seq: 0 }],
      ['unknown', { listingId: MISSING, reason: 'replay', ticketRef: 'T-2', seq: 0 }],
    ),
    m('ops.library.dispute.resolve', ['valid', { disputeId: MISSING, reason: 'replay' }]),
    m('studio.delete', ['valid', { id: s, idempotencyKey: 'del-1' }], ['unknown', { id: MISSING, idempotencyKey: 'del-2' }]),
    q('studio.listDeleted', ['valid', { limit: 10 }], ['no-limit', {}]),
    m('studio.restore', ['valid', { id: s, idempotencyKey: 'restore-1' }], ['unknown', { id: MISSING, idempotencyKey: 'restore-2' }]),
  ];
}

/** The generic inputs: nothing; null; a wrong type; an empty object; the valid input plus a key; the valid input with every field null. */
function generic(call: Call): Array<[string, unknown]> {
  const valid = call.own[0]![1];
  const isObject = valid !== null && typeof valid === 'object' && !Array.isArray(valid);
  return [
    ['absent', undefined],
    ['null', null],
    ['wrong-type', 7],
    ['empty', {}],
    ['extra-key', isObject ? { ...(valid as object), extra: 1 } : { extra: 1 }],
    ['all-null', isObject ? Object.fromEntries(Object.keys(valid as object).map((k) => [k, null])) : null],
  ];
}

type Principal = NonNullable<Context['principal']>;
type Scope = Principal['scopes'][number];
type How = 'signed' | 'forged' | 'none';
interface Caller {
  readonly name: string;
  readonly user: string;
  readonly scopes: Scope[];
  readonly tier: Principal['tier'];
  readonly mfa: boolean;
  readonly region: string;
  readonly how: How;
  readonly kid?: string;
}

const CUSTOMER: Scope[] = ['trade:read', 'trade:write'];
const OPS: Scope[] = ['admin:read', 'admin:write'];
/**
 * Nobody; a verified customer in a served region, in an unserved one and in a screened one; an unverified customer; a
 * second customer (the collaborator); an API key with `quant:read`; an operator with MFA; and an operator's principal
 * with no signature.
 */
const CALLERS: readonly Caller[] = [
  { name: 'anon', user: USER, scopes: [], tier: 'none', mfa: false, region: 'DE', how: 'none' },
  { name: 'signed', user: USER, scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'DE', how: 'signed' },
  { name: 'signed-US', user: USER, scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'US', how: 'signed' },
  { name: 'signed-KP', user: USER, scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'KP', how: 'signed' },
  { name: 'tier-none', user: USER, scopes: CUSTOMER, tier: 'none', mfa: false, region: 'DE', how: 'signed' },
  { name: 'member', user: MEMBER, scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'DE', how: 'signed' },
  { name: 'key', user: USER, scopes: ['quant:read' as Scope], tier: 'basic', mfa: false, region: 'DE', how: 'signed', kid: 'replay-key' },
  { name: 'ops', user: OPERATOR, scopes: OPS, tier: 'none', mfa: true, region: 'DE', how: 'signed' },
  { name: 'forged', user: OPERATOR, scopes: OPS, tier: 'none', mfa: true, region: 'DE', how: 'forged' },
];
/** The callers the generic inputs go to. */
const GENERIC_CALLERS = new Set(['signed', 'ops']);

function headers(caller: Caller): Record<string, string> {
  if (caller.how === 'none') return { 'x-intafaced-region': caller.region };
  const principal = {
    sub: caller.user,
    userId: caller.user,
    sid: SESSION,
    scopes: caller.scopes,
    tier: caller.tier,
    mfa: caller.mfa,
    ...(caller.kid ? { kid: caller.kid } : {}),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    ...(caller.how === 'signed' ? { 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, caller.region) } : {}),
    'x-intafaced-region': caller.region,
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** Ids and times the database made, recorded by their place; the numbering carries over the whole run. */
function stable(body: string, ids: Map<string, string>): string {
  // A share link's token is random: each is recorded by its place, wherever it appears (the token, the link's path).
  for (const [, token] of body.matchAll(/"token":"([A-Za-z0-9_-]{20,})"/g))
    if (!ids.has(token!)) ids.set(token!, `<token-${ids.size + 1}>`);
  for (const [token, place] of ids) if (place.startsWith('<token-')) body = body.split(token).join(place);
  // `ops.runCounts` lists `byOutcome` in the order Postgres groups the rows, which no ORDER BY fixes
  // (runs/postgres-repository.ts `counts`): the order is not part of main's answer, so it is recorded sorted.
  if (body.includes('"byOutcome":')) {
    const parsed = JSON.parse(body) as { result?: { data?: { byOutcome?: Array<{ outcome: string }> } } };
    parsed.result?.data?.byOutcome?.sort((a, b) => (a.outcome < b.outcome ? -1 : a.outcome > b.outcome ? 1 : 0));
    body = JSON.stringify(parsed);
  }
  return body
    .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
    .replace(/"(nextCursor|cursor)":"(?:[^"\\]|\\.)*"/g, '"$1":"<cursor>"')
    .replace(/"duration":\d+/g, '"duration":"<duration>"')
    .replace(UUID, (id) => {
      if (FIXED_IDS.has(id)) return id;
      if (!ids.has(id)) ids.set(id, `<uuid-${ids.size + 1}>`);
      return ids.get(id)!;
    })
    .replace(ISO_TIME, '<time>');
}

async function hit(app: Awaited<ReturnType<typeof serve>>, call: Call, input: unknown, h: Record<string, string>) {
  const url = `/trpc/${call.path}${call.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  return call.kind === 'query'
    ? app.inject({ method: 'GET', url, headers: h })
    : app.inject({
        method: 'POST',
        url,
        headers: { ...h, 'content-type': 'application/json' },
        payload: input === undefined ? '' : JSON.stringify(input),
      });
}

interface Golden {
  readonly callers: unknown;
  readonly answers: Record<string, { status: number; body: string }>;
}

/** Most bytes one recording file holds, so each new file stays under the size one review part reads whole. */
const PART_BYTES = 370_000;

/** One set-up's answers in run order, cut into files at call boundaries, each at most `PART_BYTES` where a call fits. */
function parts(setup: string, answers: Golden['answers']): Array<Golden['answers']> {
  const out: Array<Golden['answers']> = [];
  let part: Golden['answers'] = {};
  let size = 0;
  let lastPath = '';
  for (const [key, answer] of Object.entries(answers)) {
    if (!key.startsWith(`${setup} `)) continue;
    const path = key.split(' ')[1]!;
    const bytes = JSON.stringify({ [key]: answer }, null, 2).length;
    if (path !== lastPath && size > 0 && size + bytes > PART_BYTES) {
      out.push(part);
      part = {};
      size = 0;
    }
    part[key] = answer;
    size += bytes;
    lastPath = path;
  }
  if (size > 0) out.push(part);
  return out;
}

async function replay(): Promise<Golden> {
  const answers: Golden['answers'] = {};
  let callers: unknown;
  const ids = new Map<string, string>();
  for (const [setup, make] of SETUPS) {
    const { router, seed, closers } = await make();
    callers ??= procedureCallers(router as never);
    const app = await serve(router);
    try {
      for (const call of calls(seed)) {
        const matrix: Array<[string, unknown, readonly Caller[]]> = [
          ...call.own.map(([name, input]): [string, unknown, readonly Caller[]] => [name, input, CALLERS]),
          ...generic(call).map(([name, input]): [string, unknown, readonly Caller[]] => [
            name,
            input,
            CALLERS.filter((c) => GENERIC_CALLERS.has(c.name)),
          ]),
        ];
        for (const [inputName, input, who] of matrix)
          for (const caller of who) {
            const res = await hit(app, call, input, headers(caller));
            answers[`${setup} ${call.path} ${inputName} ${caller.name}`] = { status: res.statusCode, body: stable(res.body, ids) };
          }
      }
    } finally {
      await app.close();
      for (const close of closers) await close();
    }
  }
  return { callers, answers };
}

describe('the wire replay: svc-quant answers as main did on 2026-11-19', () => {
  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const now = await replay();
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    if (process.env.WIRE_REPLAY_WRITE === '1') {
      rmSync(GOLDEN, { recursive: true, force: true });
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(goldenJson('callers'), json(now.callers));
      for (const [setup] of SETUPS)
        parts(setup, now.answers).forEach((part, i) => writeFileSync(goldenJson(`${setup}-${i + 1}`), json(part)));
    }
    const read = (name: string): unknown => JSON.parse(readFileSync(goldenJson(name), 'utf8'));
    const answerFiles = readdirSync(GOLDEN).filter((f) => f !== 'callers.json');
    const golden: Golden = {
      callers: read('callers'),
      answers: Object.assign({}, ...answerFiles.map((f) => read(f.replace(/\.json$/, '')))) as Golden['answers'],
    };
    expect(Object.keys(golden.answers)).toHaveLength(Object.keys(now.answers).length);
    expect(now.callers).toEqual(golden.callers);
    const diffs = Object.entries(golden.answers)
      .filter(([key, was]) => now.answers[key]?.status !== was.status || now.answers[key]?.body !== was.body)
      .map(
        ([key, was]) =>
          `${key}: ${was.status} ${was.body.slice(0, 160)} != ${now.answers[key]?.status} ${now.answers[key]?.body.slice(0, 160)}`,
      );
    expect(diffs).toEqual([]);
  }, 600_000);
});
