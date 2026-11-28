/**
 * svc-trade's entry, booted: what the running service mounts, starts and hands its parts, asked of the service itself
 * (`__tests__/entry.ts` boots `index.ts` over a pool that answers no rows and an in-memory bus).
 *
 * Two boots, one with the switches each test names on and one with them off, so every wiring below is seen to follow
 * its env and not a literal. The doors are asked over HTTP; the parts the entry builds are read from the calls it made.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productionPostureIssues } from '@intafaced/config';
import { serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';

import { COPY_LEADER_FIXTURES_PATH } from './agents/copy-leader-fixtures-routes.js';
import { bootTrade, tradeEnvOf, type BootRecord, type BootedTrade } from './__tests__/entry.js';
import { DELTA_HEDGE_PATH } from './greeks/delta-hedge.js';
import { GREEKS_WHAT_IF_PATH } from './greeks/what-if.js';
import { parseFeeScheduleJson } from './spot/fee-schedule.js';
import { LOCAL_TEST_TAPE_RETIME_PATH } from './spot/local-test-tape-routes.js';
import { CREATE_PROMO_PATH } from './spot/promo.js';
import { TEST_AGE_PATH } from './test-age-door.js';

const BOOT_MS = 180_000;
const SECRET = process.env.INTERNAL_SERVICE_SECRET!;
const FEE_SCHEDULE = JSON.stringify({ published: true, version: 'boot-test', makerBps: '10', takerBps: '20' });

/** The exports whose calls the boot records, by the module that defines them. */
const SPY = {
  './spot/trade-service.js': ['TradeService'],
  './futures/position-service.js': ['PositionService'],
  './otc/otc-service.js': ['OtcDeskService'],
  './spot/email-proof.js': ['createEmailProofClient'],
  './spot/affiliate-accrue.js': ['createAffiliateAccrueClient'],
  './spot/affiliate-payout.js': ['createAffiliatePayoutClient'],
  './spot/drop-copy-ingest.js': ['createDropCopyIngestClient'],
  './spot/order-preview-rest.js': ['registerSpotOrderPreviewRest'],
  './algo/algo-jobs.js': ['startAlgoJobs'],
  './mm/seed-jobs.js': ['startMmSeedJobs'],
  './spot/options-exercise-jobs.js': ['startOptionsExerciseJobs'],
} as const;

const ON = {
  INTERNAL_SERVICE_BODY_BIND: 'accept-both',
  TRADE_ALGO_ENABLED: 'true',
  TRADE_ALGO_JOBS_ENABLED: 'true',
  TRADE_MM_SEED_ENABLED: 'true',
  TRADE_OPTIONS_JOBS_ENABLED: 'true',
  TRADE_OPTIONS_SETTLEMENT_FIXING: 'TEST owner fixing source',
  TRADE_CONVERT_QUOTE_TTL_MS: '15000',
  TRADE_FEE_SCHEDULE: FEE_SCHEDULE,
  TRADE_FIX_DROPCOPY_INGEST_URL: 'http://drop-copy.test',
  TEST_AGE_DOOR: 'on',
  TRADE_LOCAL_TEST_TAPE_RETIME: 'on',
  APP_ENV: 'test',
};
const OFF = {
  INTERNAL_SERVICE_BODY_BIND: 'require',
  TRADE_ALGO_ENABLED: 'false',
  TRADE_ALGO_JOBS_ENABLED: 'false',
  TRADE_MM_SEED_ENABLED: 'false',
  TRADE_OPTIONS_JOBS_ENABLED: 'false',
  TRADE_OPTIONS_SETTLEMENT_FIXING: undefined,
  TRADE_CONVERT_QUOTE_TTL_MS: undefined,
  TRADE_FEE_SCHEDULE: undefined,
  TRADE_FIX_DROPCOPY_INGEST_URL: undefined,
  TEST_AGE_DOOR: undefined,
  TRADE_LOCAL_TEST_TAPE_RETIME: undefined,
  APP_ENV: 'test',
};

/**
 * Every variable this process inherited (a CI runner's local chain URL, its dev database) that the dev-material guard
 * refuses on its own in production posture, removed for the production boot.
 */
const INHERITED_DEV_MATERIAL = Object.fromEntries(
  Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && productionPostureIssues({ APP_ENV: 'prod', [key]: value }).length > 0)
    .map(([key]) => [key, undefined]),
);

/** A production posture the dev-material guard accepts, so the only refusal left is the TEST flag's own. */
const PRODUCTION = {
  ...INHERITED_DEV_MATERIAL,
  APP_ENV: 'prod',
  INTAFACED_SCREENING_FAIL_CLOSED: undefined,
  DATABASE_URL: 'postgres://127.0.0.1:5432/intafaced_trade',
  EDGE_PRINCIPAL_SECRET: 'boot-refusal-edge-value-not-a-real-key-0123456789',
  INTERNAL_SERVICE_SECRET: 'boot-refusal-service-value-not-a-real-key-0123456789',
};

let on: BootedTrade;
let off: BootedTrade;

/** A started job handle the entry made, stopped so its timers do not outlive the boot. */
function stopJobs(boot: BootedTrade): void {
  for (const name of ['startAlgoJobs', 'startMmSeedJobs', 'startOptionsExerciseJobs']) {
    for (const handle of (boot.results[name] ?? []) as Array<{ stop(): void }>) handle.stop();
  }
}

beforeAll(async () => {
  on = await bootTrade(ON, { spy: SPY });
  stopJobs(on);
  off = await bootTrade(OFF, { spy: SPY });
  stopJobs(off);
}, BOOT_MS);

afterAll(async () => {
  await on?.close();
  await off?.close();
});

/** The one call of `name` the boot made, as its arguments. */
function only(boot: BootedTrade, name: string): unknown[] {
  const calls = boot.calls[name] ?? [];
  expect(calls, name).toHaveLength(1);
  return calls[0]!;
}

/** The one value `name` returned in the boot. */
function made(boot: BootedTrade, name: string): unknown {
  only(boot, name);
  return boot.results[name]![0];
}

/** TradeService's options as the entry built them. */
const tradeOptions = (boot: BootedTrade) => only(boot, 'TradeService')[5] as Record<string, unknown>;

/** POST `body` to `path` as a service: signed over the body, signed the legacy way (no body digest), or not at all. */
function servicePost(boot: BootedTrade, path: string, body: unknown, sign: 'bound' | 'legacy' | 'none') {
  const payload = JSON.stringify(body);
  const auth =
    sign === 'bound'
      ? serviceAuthHeadersForBody('svc-ops', SECRET, payload)
      : sign === 'legacy'
        ? serviceAuthHeaders('svc-ops', SECRET)
        : {};
  return boot.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: payload });
}

function serviceGet(boot: BootedTrade, path: string, sign: 'bound' | 'legacy' | 'none') {
  const auth =
    sign === 'bound'
      ? serviceAuthHeadersForBody('svc-agents', SECRET, '')
      : sign === 'legacy'
        ? serviceAuthHeaders('svc-agents', SECRET)
        : {};
  return boot.request(path, { headers: auth });
}

describe('the booted entry mounts its service doors', () => {
  it('registers the copy leader fixtures S2S route at boot, behind the internal secret', async () => {
    for (const boot of [on, off]) {
      expect((await serviceGet(boot, COPY_LEADER_FIXTURES_PATH, 'none')).status).toBe(401);
      // Signed with the env's secret: past the door (no leaders in an empty store), so the door holds that secret.
      const signed = await serviceGet(boot, COPY_LEADER_FIXTURES_PATH, 'bound');
      expect(signed.status).toBe(503);
      expect(await signed.json()).toEqual({ ok: false, reason: 'no_live_leaders' });
    }
  });

  it('mounts the signed closure-check route with the internal secret', async () => {
    const body = { userId: '11111111-1111-4111-8111-111111111111', subAccountIds: [] };
    for (const boot of [on, off]) {
      expect((await servicePost(boot, '/internal/closure-check', body, 'none')).status).toBe(401);
      expect((await servicePost(boot, '/internal/closure-check', body, 'bound')).status).not.toBe(401);
    }
  });

  it('mounts the greeks what-if, delta-hedge and promo doors behind the person door', async () => {
    for (const boot of [on, off]) {
      for (const path of [GREEKS_WHAT_IF_PATH, DELTA_HEDGE_PATH, CREATE_PROMO_PATH]) {
        const res = await boot.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        expect(res.status, path).toBe(401);
      }
      expect((await boot.request('/api/v1/greeks/not-a-door', { method: 'POST', body: '{}' })).status).toBe(404);
    }
  });
});

describe('the S2S doors that move money bind the signature to the body, whatever INTERNAL_SERVICE_BODY_BIND says', () => {
  it('funding-rate and outcomes settle hardcode require; copy-leader GET stays env', async () => {
    for (const boot of [on, off]) {
      // A legacy signature (no body digest) is refused even where the env accepts both.
      expect((await servicePost(boot, '/internal/futures/funding-rate', {}, 'legacy')).status).toBe(401);
      expect((await servicePost(boot, '/api/v1/outcomes/settle', {}, 'legacy')).status).toBe(401);
      // Bound to the body, the same calls pass the door and reach the request's own checks.
      expect((await servicePost(boot, '/internal/futures/funding-rate', {}, 'bound')).status).toBe(400);
      const settle = await servicePost(boot, '/api/v1/outcomes/settle', { marketId: 'none' }, 'bound');
      expect(settle.status).toBe(404);
    }
    // The copy-leader fixtures read follows the env: accept-both takes a legacy signature, require refuses it.
    expect((await serviceGet(on, COPY_LEADER_FIXTURES_PATH, 'legacy')).status).toBe(503);
    expect((await serviceGet(off, COPY_LEADER_FIXTURES_PATH, 'legacy')).status).toBe(401);
  });
});

describe('the booted entry starts its jobs from their env switches', () => {
  it('live host passes TRADE_ALGO_ENABLED and TRADE_ALGO_JOBS_ENABLED into capabilities', async () => {
    const algoOf = async (boot: BootedTrade) =>
      ((await (await boot.request('/api/v1/capabilities')).json()) as { notes: { algo: unknown } }).notes.algo;
    expect(await algoOf(on)).toMatchObject({ createEnabled: true, jobsEnabled: true });
    expect(await algoOf(off)).toMatchObject({ createEnabled: false, jobsEnabled: false });
  });

  it('live host wires startAlgoJobs from the env flag, not a literal true', () => {
    expect((only(on, 'startAlgoJobs')[0] as { config: { enabled: boolean } }).config.enabled).toBe(true);
    expect((only(off, 'startAlgoJobs')[0] as { config: { enabled: boolean } }).config.enabled).toBe(false);
    expect((made(off, 'startAlgoJobs') as { host: { list(): string[] } }).host.list()).toEqual([]);
  });

  it('mounts MM seed jobs behind TRADE_MM_SEED_ENABLED', () => {
    expect((only(on, 'startMmSeedJobs')[0] as { config: { enabled: boolean } }).config.enabled).toBe(true);
    expect((only(off, 'startMmSeedJobs')[0] as { config: { enabled: boolean } }).config.enabled).toBe(false);
    expect((made(off, 'startMmSeedJobs') as { host: { list(): string[] } }).host.list()).toEqual([]);
  });

  it('starts the options exercise jobs from TRADE_OPTIONS_JOBS_ENABLED with the owner fixing, never a price of its own', () => {
    const onDeps = only(on, 'startOptionsExerciseJobs')[0] as { config: Record<string, unknown> } & Record<string, unknown>;
    expect(onDeps.config.enabled).toBe(true);
    expect(onDeps.config.settlementFixing).toBe('TEST owner fixing source');
    expect(onDeps).not.toHaveProperty('ownerSettlementPriceFor');
    expect(onDeps).not.toHaveProperty('lastTradePrice');
    const offDeps = only(off, 'startOptionsExerciseJobs')[0] as { config: Record<string, unknown> };
    expect(offDeps.config.enabled).toBe(false);
    expect(offDeps.config.settlementFixing).toBe('');
    expect((made(off, 'startOptionsExerciseJobs') as { host: { list(): string[] } }).host.list()).toEqual([]);
  });
});

describe('the booted entry hands TradeService its parts', () => {
  it('passes TRADE_CONVERT_QUOTE_TTL_MS (does not drop the env)', () => {
    expect(tradeOptions(on).convertQuoteTtlMs).toBe(15_000);
    expect(tradeOptions(off).convertQuoteTtlMs).toBeNull();
  });

  it('parses TRADE_FEE_SCHEDULE and passes the one schedule into place and the preview door', () => {
    expect(tradeOptions(on).feeSchedule).toEqual(parseFeeScheduleJson(FEE_SCHEDULE));
    expect(tradeOptions(off).feeSchedule).toEqual(parseFeeScheduleJson(''));
    for (const boot of [on, off]) {
      const preview = only(boot, 'registerSpotOrderPreviewRest')[1] as { feeSchedule: unknown };
      expect(preview.feeSchedule).toBe(tradeOptions(boot).feeSchedule);
    }
  });

  it('builds the identity client and hands it to TradeService, the position service and the OTC desk', () => {
    for (const boot of [on, off]) {
      const client = tradeOptions(boot).emailProof;
      const at = (boot.results.createEmailProofClient ?? []).indexOf(client);
      expect(at, 'TradeService holds a client the entry built').toBeGreaterThanOrEqual(0);
      expect(boot.calls.createEmailProofClient![at]!.slice(0, 2)).toEqual([tradeEnvOf().IDENTITY_URL, SECRET]);
      expect((only(boot, 'PositionService')[2] as { emailProof: unknown }).emailProof).toBe(client);
      expect((only(boot, 'OtcDeskService')[2] as { emailProof: unknown }).emailProof).toBe(client);
    }
  });

  it('hands TradeService the affiliate accrue and payout clients it builds', () => {
    for (const boot of [on, off]) {
      expect(only(boot, 'createAffiliateAccrueClient')[1]).toBe(SECRET);
      expect(only(boot, 'createAffiliatePayoutClient')[1]).toBe(SECRET);
      expect(tradeOptions(boot).affiliateAccrue).toBe(made(boot, 'createAffiliateAccrueClient'));
      expect(tradeOptions(boot).affiliatePayout).toBe(made(boot, 'createAffiliatePayoutClient'));
    }
  });

  it('builds the drop-copy ingest client from TRADE_FIX_DROPCOPY_INGEST_URL and hands it to TradeService', () => {
    expect(only(on, 'createDropCopyIngestClient').slice(0, 2)).toEqual(['http://drop-copy.test', SECRET]);
    expect(only(off, 'createDropCopyIngestClient').slice(0, 2)).toEqual(['', SECRET]);
    for (const boot of [on, off]) expect(tradeOptions(boot).dropCopyIngest).toBe(made(boot, 'createDropCopyIngestClient'));
  });
});

describe('the TEST doors open only from the boot flag, read before the database', () => {
  it(
    'reads TEST_AGE_DOOR before opening the database, mounts the door once, and opens it only from that read',
    async () => {
      const age = { subject: 'otc-quote', id: 'none', ms: 60_000 };
      const closed = await servicePost(off, TEST_AGE_PATH, age, 'bound');
      expect(closed.status).toBe(403);
      expect(await closed.json()).toMatchObject({ error: 'test_age.door_closed' });
      // Open: the door reads its subject (none in an empty store) instead of refusing as closed.
      const open = await servicePost(on, TEST_AGE_PATH, age, 'bound');
      expect(open.status).toBe(404);
      expect(await open.json()).toMatchObject({ error: 'test_age.not_found' });

      const record: BootRecord = { poolsOpened: 0, queries: [], calls: {}, results: {} };
      await expect(bootTrade({ ...OFF, ...PRODUCTION, TEST_AGE_DOOR: 'on' }, { record })).rejects.toThrow(/TEST_AGE_DOOR=on/);
      expect(record.poolsOpened).toBe(0);
    },
    BOOT_MS,
  );

  it(
    'checks the tape retime flag before opening the database, and registers the route only when it is on',
    async () => {
      expect((await servicePost(off, LOCAL_TEST_TAPE_RETIME_PATH, {}, 'bound')).status).toBe(404);
      expect((await servicePost(on, LOCAL_TEST_TAPE_RETIME_PATH, {}, 'none')).status).toBe(401);

      const record: BootRecord = { poolsOpened: 0, queries: [], calls: {}, results: {} };
      await expect(bootTrade({ ...OFF, ...PRODUCTION, TRADE_LOCAL_TEST_TAPE_RETIME: 'on' }, { record })).rejects.toThrow(
        /refused unless APP_ENV is dev or test/,
      );
      expect(record.poolsOpened).toBe(0);
    },
    BOOT_MS,
  );
});
