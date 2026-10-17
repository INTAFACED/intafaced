import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerClient } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { memoryJobSource } from './job-source.js';
import { miningPayoutIdempotencyKey } from './ledger.js';
import { planPplns } from './pplns.js';
import { createMiningRouter } from './router.js';
import { MiningReadStore } from './reads.js';
import { handleSubmitSharePost } from './submit-share.js';

const SECRET = 'mining-reads-db-edge-secret-32chars';
const HMAC = 'mining-reads-db-hmac-secret-32chars!';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const migration = (name: string) => readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8');

function databaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL required for mining reads');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-mining-pool' });

function principal(userId: string, scopes: string[]): Principal {
  return {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(userId: string, scopes: string[]) {
  const raw = encodePrincipal(principal(userId, scopes));
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: userId,
  });
}

describe('mining pool reads', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'off');
    vi.stubEnv('APP_ENV', 'test');
    db = await createTestDatabase({
      service: 'mining_pool',
      url: databaseUrl(),
      migrations: [migration('0000_mining_pool_init.sql'), migration('0001_blank_reward_share.sql'), migration('0002_mining_reads.sql')],
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  beforeEach(async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'off');
    vi.stubEnv('APP_ENV', 'test');
    await db.truncateAll();
  });

  const post = (body: unknown, jobSource: ReturnType<typeof memoryJobSource> | null = null, headers?: Record<string, string>) => {
    const rawBody = Buffer.from(JSON.stringify(body));
    return handleSubmitSharePost({
      rawBody,
      sql: db.sql,
      secret: HMAC,
      headers: headers ?? serviceAuthHeadersForBody('svc-cron', HMAC, rawBody),
      jobSource,
    });
  };

  function routerFor(ledger: Pick<LedgerClient, 'getTxByKey'> | null = null) {
    return createMiningRouter(new MiningReadStore(db.sql, ledger));
  }

  it('lists the caller workers and the exact accepted-weight sum, and hides the other account', async () => {
    await db.sql`
      INSERT INTO mining_pool.workers (id, user_id, name, created_at) VALUES
        ('rig-a', ${ALICE}, 'alpha', '2026-01-01T00:00:00Z'),
        ('rig-a2', ${ALICE}, 'beta', '2026-01-02T00:00:00Z'),
        ('rig-b', ${BOB}, 'other', '2026-01-03T00:00:00Z')
    `;
    await db.sql`
      INSERT INTO mining_pool.windows (window_id, asset_id, reward, fee_bps) VALUES ('w', 'IFC', 10, 100)
    `;
    await db.sql`
      INSERT INTO mining_pool.shares (share_id, window_id, miner_id, weight, created_at) VALUES
        ('s1', 'w', 'rig-a', 2, now()),
        ('s2', 'w', 'rig-a', 3, now()),
        ('old', 'w', 'rig-a', 9, now() - interval '3 days'),
        ('sb', 'w', 'rig-b', 7, now())
    `;
    const alice = routerFor().createCaller(signed(ALICE, ['ledger:read']));
    const mine = await alice.workers.mine({ windowMinutes: 60 });
    expect(mine.workers.map((worker) => worker.id)).toEqual(['rig-a2', 'rig-a']);
    expect(mine.workers.find((worker) => worker.id === 'rig-a')).toMatchObject({ hashrate: '5', hashrateReason: null });
    expect(mine.workers.find((worker) => worker.id === 'rig-a2')).toMatchObject({
      hashrate: null,
      hashrateReason: 'no_shares_in_window',
    });
    expect(JSON.stringify(mine)).not.toContain('rig-b');
    expect(JSON.stringify(mine)).not.toContain('"0"');
    const bob = await routerFor()
      .createCaller(signed(BOB, ['ledger:read']))
      .workers.mine({ windowMinutes: 60 });
    expect(bob.workers.map((worker) => worker.id)).toEqual(['rig-b']);
    expect(bob.workers[0]).toMatchObject({ hashrate: '7' });
  });

  it('pages every worker for an operator and refuses a blank limit', async () => {
    await db.sql`
      INSERT INTO mining_pool.workers (id, user_id, name, created_at) VALUES
        ('c', ${ALICE}, 'c', '2026-01-03T00:00:00Z'),
        ('b', ${BOB}, 'b', '2026-01-02T00:00:00Z'),
        ('a', ${ALICE}, 'a', '2026-01-01T00:00:00Z')
    `;
    const ops = routerFor().createCaller(signed(ALICE, ['admin:read']));
    await expect(ops.ops.workers({})).rejects.toMatchObject({ cause: { code: 'mining.workers_list_limit_unset' } });
    const first = await ops.ops.workers({ limit: 2 });
    const second = await ops.ops.workers({ limit: 2, cursor: first.nextCursor ?? undefined });
    const ids = [...first.workers, ...second.workers].map((worker) => worker.id);
    expect(ids).toEqual(['c', 'b', 'a']);
    expect(new Set(ids).size).toBe(3);
    expect(second.nextCursor).toBeNull();
    expect(first.workers.map((worker) => worker.id).some((id) => second.workers.some((worker) => worker.id === id))).toBe(false);
  });

  it('counts two accepted shares and one refusal, ignores a bad HMAC, and hides the other account', async () => {
    const jobs = memoryJobSource(['known']);
    const body = {
      windowId: 'w',
      epoch: 1,
      assetId: 'IFC',
      reward: '10',
      feeBps: 100,
      shares: [
        { shareId: 'a1', minerId: ALICE, weight: '1' },
        { shareId: 'b1', minerId: BOB, weight: '3' },
        { shareId: 'nope', minerId: ALICE, weight: '9', jobId: 'missing', idempotencyKey: 'reject-alice-1' },
      ],
    };
    expect((await post(body, jobs)).status).toBe(200);
    const again = await post(body, jobs);
    expect(again.status).toBe(409);
    expect(await db.sql`SELECT count(*)::int AS n FROM mining_pool.share_rejections`).toEqual([{ n: 1 }]);
    const bad = Buffer.from(JSON.stringify(body));
    expect(
      (
        await handleSubmitSharePost({
          rawBody: bad,
          sql: db.sql,
          secret: HMAC,
          headers: { 'x-intafaced-service': 'svc-cron' },
          jobSource: jobs,
        })
      ).status,
    ).toBe(401);
    expect(await db.sql`SELECT count(*)::int AS n FROM mining_pool.share_rejections`).toEqual([{ n: 1 }]);

    const ops = await routerFor()
      .createCaller(signed(ALICE, ['admin:read']))
      .ops.shares({ windowId: 'w' });
    expect(ops.windows).toEqual([{ windowId: 'w', acceptedCount: 2, rejectedCount: 1, acceptedWeight: '4' }]);
    expect(ops.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const alice = await routerFor()
      .createCaller(signed(ALICE, ['ledger:read']))
      .shares.mine({});
    expect(alice.windows).toEqual([{ windowId: 'w', acceptedCount: 1, rejectedCount: 1, acceptedWeight: '1' }]);
    const bob = await routerFor()
      .createCaller(signed(BOB, ['ledger:read']))
      .shares.mine({});
    expect(bob.windows).toEqual([{ windowId: 'w', acceptedCount: 1, rejectedCount: 0, acceptedWeight: '3' }]);
    expect(JSON.stringify(bob)).not.toContain(ALICE);
  });

  it('does not record a share or a credit when the job source is missing or does not know the id', async () => {
    const unknown = {
      windowId: 'unknown',
      epoch: 1,
      assetId: 'IFC',
      reward: '10',
      feeBps: 100,
      shares: [{ shareId: 'u', minerId: ALICE, weight: '1', jobId: 'nope', idempotencyKey: 'reject-unknown-1' }],
    };
    expect((await post(unknown, null)).body).toMatchObject({ accepted: false, rejected: 1 });
    expect((await post(unknown, null)).body).toMatchObject({ accepted: false, rejected: 1 });
    expect(await db.sql`SELECT count(*)::int AS n FROM mining_pool.share_rejections`).toEqual([{ n: 1 }]);
    expect(await db.sql`SELECT reason_code FROM mining_pool.share_rejections`).toEqual([{ reason_code: 'mining.job_source_unconfigured' }]);
    expect(await db.sql`SELECT count(*)::int AS n FROM mining_pool.shares`).toEqual([{ n: 0 }]);

    await db.truncateAll();
    const missing = { ...unknown, windowId: 'missing', shares: [{ ...unknown.shares[0], shareId: 'm', jobId: 'nope' }] };
    expect((await post(missing, memoryJobSource(['known']))).body).toMatchObject({ accepted: false });
    expect(await db.sql`SELECT reason_code FROM mining_pool.share_rejections`).toEqual([{ reason_code: 'job_not_found' }]);
    expect(await db.sql`SELECT count(*)::int AS n FROM mining_pool.shares`).toEqual([{ n: 0 }]);

    await db.truncateAll();
    const known = {
      windowId: 'known',
      epoch: 1,
      assetId: 'IFC',
      reward: '10',
      feeBps: 100,
      shares: [{ shareId: 'k', minerId: ALICE, weight: '1', jobId: 'known' }],
    };
    expect(await post(known, memoryJobSource(['known']))).toEqual({
      status: 200,
      body: { accepted: true, settled: false, epoch: 1 },
    });
    expect(await db.sql`SELECT status FROM mining_pool.windows`).toEqual([{ status: 'open' }]);
    expect(await db.sql`SELECT count(*)::int AS n FROM mining_pool.shares`).toEqual([{ n: 1 }]);
    const payouts = await routerFor()
      .createCaller(signed(ALICE, ['ledger:read']))
      .payouts.mine({ limit: 10 });
    expect(payouts.payouts).toEqual([]);
  });

  it('pending weights and estimate match planPplns, a blank reward has no estimate, and the stored fee is kept', async () => {
    vi.stubEnv('MINING_POOL_FEE_BPS', '500');
    vi.stubEnv('MINING_POOL_WINDOW_SIZE', '40');
    await db.sql`
      INSERT INTO mining_pool.windows (window_id, epoch, asset_id, reward, fee_bps, status) VALUES
        ('open', 1, 'IFC', 10, 100, 'open'),
        ('blank', 2, 'IFC', null, null, 'open')
    `;
    await db.sql`
      INSERT INTO mining_pool.shares (share_id, window_id, miner_id, weight) VALUES
        ('a', 'open', ${ALICE}, 1),
        ('b', 'open', ${BOB}, 3)
    `;
    const plan = planPplns({
      windowId: 'open',
      assetId: 'IFC',
      reward: '10',
      feeBps: 100,
      shares: [
        { shareId: 'a', minerId: ALICE, weight: 1n },
        { shareId: 'b', minerId: BOB, weight: 3n },
      ],
    });
    const alice = await routerFor()
      .createCaller(signed(ALICE, ['ledger:read']))
      .windows.pending();
    const open = alice.windows.find((window) => window.windowId === 'open');
    const blank = alice.windows.find((window) => window.windowId === 'blank');
    expect(open).toMatchObject({
      callerWeight: '1',
      totalWeight: '4',
      feeBps: 100,
      estimate: { estimate: true, estimatedGross: plan.payouts.find((payout) => payout.minerId === ALICE)?.amount },
    });
    expect(blank?.estimate).toBeNull();
    expect(blank).not.toHaveProperty('estimatedGross');
    const bob = await routerFor()
      .createCaller(signed(BOB, ['ledger:read']))
      .windows.pending();
    expect(bob.windows.find((window) => window.windowId === 'open')).toMatchObject({
      callerWeight: '3',
      estimate: { estimatedGross: plan.payouts.find((payout) => payout.minerId === BOB)?.amount },
    });
    expect(JSON.stringify(bob.windows.find((window) => window.windowId === 'open'))).not.toContain(ALICE);
    const terms = await routerFor()
      .createCaller(signed(ALICE, ['identity:read']))
      .terms();
    expect(terms.feeBps).toBe(500);
    expect((await db.sql`SELECT fee_bps FROM mining_pool.windows WHERE window_id = 'open'`)[0]).toEqual({ fee_bps: 100 });
    const listed = await routerFor()
      .createCaller(signed(ALICE, ['admin:read']))
      .ops.windows();
    expect(listed.windows.find((window) => window.windowId === 'open')).toMatchObject({
      status: 'open',
      reward: '10',
      feeBps: 100,
      shareCount: 2,
      totalWeight: '4',
      paidAt: null,
    });
    expect(listed.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('pages the caller payouts with the ledger transaction id and does not return the other account', async () => {
    for (const [id, user, at, epoch] of [
      ['p1', ALICE, '2026-01-03T00:00:00Z', 11],
      ['p2', ALICE, '2026-01-02T00:00:00Z', 12],
      ['p3', ALICE, '2026-01-01T00:00:00Z', 13],
      ['pb', BOB, '2026-01-04T00:00:00Z', 14],
    ] as const) {
      await db.sql`
        INSERT INTO mining_pool.windows (window_id, epoch, asset_id, reward, fee_bps, status, paid_at)
        VALUES (${id}, ${epoch}, 'IFC', 10, 100, 'paid', ${at})
      `;
      await db.sql`
        INSERT INTO mining_pool.shares (share_id, window_id, miner_id, weight) VALUES (${id + '-s'}, ${id}, ${user}, 1)
      `;
    }
    const seen: string[] = [];
    const ledger: Pick<LedgerClient, 'getTxByKey'> = {
      async getTxByKey(key: string) {
        seen.push(key);
        if (key === miningPayoutIdempotencyKey('p1', ALICE)) return { id: 'tx-p1' } as Awaited<ReturnType<LedgerClient['getTxByKey']>>;
        if (key === miningPayoutIdempotencyKey('pb', BOB)) return { id: 'tx-bob' } as Awaited<ReturnType<LedgerClient['getTxByKey']>>;
        return null;
      },
    };
    const alice = routerFor(ledger).createCaller(signed(ALICE, ['ledger:read']));
    await expect(alice.payouts.mine({})).rejects.toMatchObject({ cause: { code: 'mining.payouts_list_limit_unset' } });
    const first = await alice.payouts.mine({ limit: 2 });
    const second = await alice.payouts.mine({ limit: 2, cursor: first.nextCursor ?? undefined });
    const ids = [...first.payouts, ...second.payouts].map((row) => row.windowId);
    expect(ids).toEqual(['p1', 'p2', 'p3']);
    expect(new Set(ids).size).toBe(3);
    expect(second.nextCursor).toBeNull();
    expect(first.payouts[0]).toMatchObject({ windowId: 'p1', amount: '9.9', ledgerTransactionId: 'tx-p1', ledgerReason: null });
    expect(first.payouts[1]).toMatchObject({ windowId: 'p2', ledgerTransactionId: null, ledgerReason: 'mining.ledger_tx_unrecorded' });
    expect(seen).toContain(miningPayoutIdempotencyKey('p1', ALICE));
    const bob = await routerFor(ledger)
      .createCaller(signed(BOB, ['ledger:read']))
      .payouts.mine({ limit: 10 });
    expect(bob.payouts.map((row) => row.windowId)).toEqual(['pb']);
    expect(bob.payouts[0]?.ledgerTransactionId).toBe('tx-bob');
    expect(JSON.stringify(bob)).not.toContain('tx-p1');
    expect(JSON.stringify(first)).not.toContain('tx-bob');
  });

  it('register refuses and leaves the worker table empty', async () => {
    await expect(
      routerFor()
        .createCaller(signed(ALICE, ['ledger:read']))
        .workers.register(),
    ).rejects.toMatchObject({
      cause: { code: 'mining.worker_registration_scope_unset' },
    });
    expect(await db.sql`SELECT count(*)::int AS n FROM mining_pool.workers`).toEqual([{ n: 0 }]);
  });
});
