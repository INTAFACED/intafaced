import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buybackJobSet } from './buyback-job.js';
import { BUYBACK_PLACE_PUBLISHED } from './buyback-trade-client.js';
import { createTokenRouter } from './router.js';
import { TokenService } from './token-service.js';
import { reportBuybackRuns, type BuybackRunRow } from './treasury-view.js';

/**
 * Stored buyback runs (the burn page). Each settled run is shown as stored and
 * must add up — bought = burned + toRewards — or the read refuses. Pending
 * claims are not runs. The rate comes back or says it is not set; the job
 * state is "unset" unless every setting the job refuses on is present.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'a-token-buyback-runs-test-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-token' });

function signed() {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['token:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-buyback-runs',
  });
}

const row = (overrides: Partial<BuybackRunRow> = {}): BuybackRunRow => ({
  id: 'run-1',
  bought: '1000',
  burned: '600',
  toRewards: '400',
  executedAt: new Date('2026-10-01T00:00:00.000Z'),
  windowFrom: new Date('2026-09-24T00:00:00.000Z'),
  windowTo: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

describe('reportBuybackRuns', () => {
  it('returns each run as canonical decimals and instants', () => {
    expect(reportBuybackRuns([row({ bought: '1000.50', burned: '600.30', toRewards: '400.20' })])).toEqual({
      ok: true,
      runs: [
        {
          id: 'run-1',
          bought: '1000.5',
          burned: '600.3',
          toRewards: '400.2',
          executedAt: '2026-10-01T00:00:00.000Z',
          windowFrom: '2026-09-24T00:00:00.000Z',
          windowTo: '2026-10-01T00:00:00.000Z',
        },
      ],
    });
    expect(reportBuybackRuns([])).toEqual({ ok: true, runs: [] });
  });

  it('refuses a run that does not add up, never showing it', () => {
    expect(reportBuybackRuns([row(), row({ id: 'run-2', toRewards: '399' })])).toEqual({
      ok: false,
      code: 'token.treasury_figure_unreadable',
    });
  });

  it.each([
    ['a blank bought', { bought: null }],
    ['a negative burned', { burned: '-1', bought: '399' }],
    ['a non-decimal toRewards', { toRewards: 'abc' }],
    ['a missing execution time', { executedAt: null }],
    ['an unreadable window start', { windowFrom: 'not-a-date' }],
    ['a blank id', { id: ' ' }],
  ] as const)('refuses %s instead of reading it as zero', (_label, overrides) => {
    expect(reportBuybackRuns([row(overrides as Partial<BuybackRunRow>)])).toEqual({
      ok: false,
      code: 'token.treasury_figure_unreadable',
    });
  });
});

describe('buybackJobSet', () => {
  const all = { enabled: true, quoteAssetId: 'USDT', symbol: 'IFC-USDT', internalSecret: 's', placePublished: true };
  it('is set only when enabled with a quote asset, a listing, the place secret and a published place', () => {
    expect(buybackJobSet(all)).toBe(true);
    expect(buybackJobSet({ ...all, placePublished: false })).toBe(false);
    expect(buybackJobSet({ ...all, enabled: false })).toBe(false);
    expect(buybackJobSet({ ...all, quoteAssetId: ' ' })).toBe(false);
    expect(buybackJobSet({ ...all, symbol: '' })).toBe(false);
    expect(buybackJobSet({ ...all, internalSecret: undefined })).toBe(false);
  });

  it('reads not set today: the trade place is unpublished, so the service never says set', () => {
    expect(BUYBACK_PLACE_PUBLISHED).toBe(false);
    expect(buybackJobSet({ ...all, placePublished: BUYBACK_PLACE_PUBLISHED })).toBe(false);
  });
});

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_buyback_runs_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const RUN_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const RUN_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const RUN_C = 'aaaaaaaa-0000-4000-8000-000000000003';
const RUN_BAD = 'aaaaaaaa-0000-4000-8000-0000000000ff';

describe('buyback runs read', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let fromDb: TokenService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'token', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE token.buyback_runs RESTART IDENTITY CASCADE`;
    await sql`UPDATE token.token_params SET buyback_bps = NULL, burn_split_bps = NULL WHERE id = true`;
    fromDb = new TokenService(sql, new MemoryLedger(), new MemoryEventBus('svc-token'), {
      assetId: 'IFC',
      loadParamsFromDb: true,
      feeScheduleTtlMs: 0,
      emissionEpochMs: 0,
    });
  });

  async function seed(input: { id: string; day: number; bought: string; burned: string; toRewards: string; status?: string }) {
    const from = new Date(Date.UTC(2026, 9, input.day));
    const to = new Date(Date.UTC(2026, 9, input.day + 1));
    await sql`
      INSERT INTO token.buyback_runs (
        id, revenue_window_from, revenue_window_to, revenue_total,
        tokens_bought, tokens_burned, tokens_to_rewards, status, executed_at, created_at, last_post_at
      ) VALUES (
        ${input.id}, ${from}, ${to}, ${sql.json({ TST: '1' } as never)},
        ${input.bought}::numeric, ${input.burned}::numeric, ${input.toRewards}::numeric,
        ${input.status ?? 'settled'}, ${to}, ${to}, ${to}
      )
    `;
  }

  it('lists settled runs newest first, leaves out pending claims, and says the rate is not set', async () => {
    await seed({ id: RUN_A, day: 1, bought: '1000', burned: '600', toRewards: '400' });
    await seed({ id: RUN_B, day: 3, bought: '50.5', burned: '30.3', toRewards: '20.2' });
    await seed({ id: RUN_C, day: 5, bought: '9', burned: '5', toRewards: '4', status: 'pending' });

    const read = await fromDb.buybackRuns(10);
    expect(read.runs.map((run) => [run.id, run.bought, run.burned, run.toRewards])).toEqual([
      [RUN_B, '50.5', '30.3', '20.2'],
      [RUN_A, '1000', '600', '400'],
    ]);
    expect(read.rate).toBeNull();
    expect(read.reason).toBe('token.params_unset');
    expect(read.missing).toBe('token_params.buyback_bps');
    expect((await fromDb.buybackRuns(1)).runs.map((run) => run.id)).toEqual([RUN_B]);
  });

  it('returns the stored rate when it is set', async () => {
    await sql`UPDATE token.token_params SET buyback_bps = 2500, burn_split_bps = 6000 WHERE id = true`;
    expect(await fromDb.buybackRuns(10)).toEqual({
      runs: [],
      rate: { buybackBps: 2500, burnSplitBps: 6000 },
      missing: null,
      reason: null,
    });
  });

  it('refuses the whole read when a stored run does not add up', async () => {
    await seed({ id: RUN_A, day: 1, bought: '1000', burned: '600', toRewards: '400' });
    await seed({ id: RUN_BAD, day: 3, bought: '1000', burned: '600', toRewards: '300' });
    await expect(fromDb.buybackRuns(10)).rejects.toMatchObject({ code: 'token.treasury_figure_unreadable' });
  });

  it('serves the read through the router with the job state and a capped limit', async () => {
    await seed({ id: RUN_A, day: 1, bought: '1000', burned: '600', toRewards: '400' });
    const unset = await createTokenRouter(fromDb).createCaller(signed()).buybackRuns({ limit: 5 });
    expect(unset.job).toBe('unset');
    expect(unset.runs).toHaveLength(1);
    const rateBlank = await createTokenRouter(fromDb, { buybackJobSet: true }).createCaller(signed()).buybackRuns({ limit: 5 });
    expect(rateBlank.job).toBe('unset');
    await sql`UPDATE token.token_params SET buyback_bps = 2500, burn_split_bps = 6000 WHERE id = true`;
    const set = await createTokenRouter(fromDb, { buybackJobSet: true }).createCaller(signed()).buybackRuns({ limit: 5 });
    expect(set.job).toBe('set');
    await expect(createTokenRouter(fromDb).createCaller(signed()).buybackRuns({ limit: 201 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('maps an unbalanced stored run to a typed precondition refusal, not a 500', async () => {
    await seed({ id: RUN_BAD, day: 3, bought: '1000', burned: '600', toRewards: '300' });
    await expect(createTokenRouter(fromDb).createCaller(signed()).buybackRuns({ limit: 5 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'A treasury figure recorded by this service could not be read.',
    });
  });
});
