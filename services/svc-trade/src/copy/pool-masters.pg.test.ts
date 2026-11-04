/**
 * Pooled masters on Postgres (CB-copy-pro-share-11, -04 creation, -06; J-copy-bots-otc-10 #6): a master application
 * from the master center enters the founders' one review queue apart from lead applications, two founders approve it
 * without listing anyone, the approved master creates one pool with the owner's limits for its type, and founders add
 * investors to its whitelist within the owner's batch limit. Every refusal writes nothing. TEST people and names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { principalFor } from '../spot/testing.js';
import { ALICE, BOB, openTradeDatabase } from '../spot/__tests__/saga-trade-fixture.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { MemoryApprovalBook, payloadHash } from '../admin/common.js';
import { sqlLeaderDirectory } from './leader-directory.js';
import { COPY_LEAD_APPROVE_ACTION, LeadDesk, leadApprovalPayload } from './lead-applications.js';
import { PoolDesk, parsePoolLaw, parsePoolWhitelistBatchMax, type PoolLaw } from './pool-masters.js';

const FOUNDER_A = '33333333-3333-4333-8333-333333333333';
const FOUNDER_B = '44444444-4444-4444-8444-444444444444';
const founder = (id: string) => principalFor(id, ['admin:read', 'admin:write']);
const reader = () => principalFor(FOUNDER_A, ['admin:read']);
const customer = (id: string) => principalFor(id, ['trade:read', 'trade:write']);
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STABLE: PoolLaw = { stable: { maxLeverage: '3', maxDrawdownPct: '20', maxCapital: '100000' } };
const MASTER = { nickname: 'TEST master', contact: 'TEST contact: desk chat', style: 'TEST style: low-leverage majors' };

let db: TestDatabase | undefined;
let stop: () => Promise<void> = async () => undefined;
const sql = () => {
  if (!db) throw new Error('database not ready');
  return db.sql;
};

beforeAll(async () => {
  const opened = await openTradeDatabase();
  db = opened.db;
  stop = opened.stop;
}, 120_000);
afterAll(async () => {
  await db?.drop();
  await stop();
}, 30_000);
beforeEach(async () => {
  await truncateTradeExceptOrderEvents(sql());
});

let tick = Date.parse('2026-11-04T00:00:00.000Z');
const now = () => new Date((tick += 1_000));

function harness(opts: { law?: PoolLaw; batch?: number | null } = {}) {
  const approvals = new MemoryApprovalBook();
  const directory = sqlLeaderDirectory(sql(), { now, feeShareLaw: { published: false } });
  return {
    approvals,
    leads: new LeadDesk({ sql: sql(), approvals, directory, now }),
    pools: new PoolDesk({
      sql: sql(),
      now,
      law: opts.law ?? STABLE,
      whitelistBatchMax: opts.batch === undefined ? 20 : opts.batch,
    }),
  };
}

/** Two founders approve the application: A files and attaches identity's approval, B confirms it. */
async function approveByTwo(h: ReturnType<typeof harness>, applicationId: string, name: string) {
  await h.leads.setCriteria(founder(FOUNDER_A), { minTrackRecordDays: 30, clientRequestId: 'crit-1' });
  h.approvals.put({
    approvalId: `appr-${applicationId}`,
    actionType: COPY_LEAD_APPROVE_ACTION,
    targetService: 'svc-trade',
    targetId: applicationId,
    expectedVersion: 'pending',
    payloadHash: payloadHash(leadApprovalPayload({ applicationId, displayName: name, minTrackRecordDays: 30 })),
    requesterId: FOUNDER_A,
    approverId: FOUNDER_B,
    operationId: `op-${applicationId}`,
  });
  await h.leads.propose(founder(FOUNDER_A), { applicationId, approvalId: `appr-${applicationId}` });
  return h.leads.approve(founder(FOUNDER_B), { applicationId, approvalId: `appr-${applicationId}`, operationId: `op-${applicationId}` });
}

const count = async (table: string) => (await sql().unsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM trade.${table}`))[0]!.n;

describe('pooled masters', () => {
  it('applies from the master center: applied once, apart from the lead queue, read by founders with contact and style', async () => {
    const h = harness();
    const lead = await h.leads.apply(customer(BOB), { displayName: 'TEST lead b' });
    const mine = await h.pools.apply(customer(ALICE), MASTER);
    expect(mine.application).toMatchObject({ state: 'submitted', nickname: 'TEST master', reason: null });
    expect(mine.pool).toBeNull();
    expect(mine.investors).toBe(0);
    // The same submit answers the open application; another while it waits refuses; a blank field refuses.
    expect((await h.pools.apply(customer(ALICE), MASTER)).application?.applicationId).toBe(mine.application?.applicationId);
    await expect(h.pools.apply(customer(ALICE), { ...MASTER, style: 'TEST other' })).rejects.toMatchObject({
      code: 'trade.pool_master_application_open',
    });
    await expect(h.pools.apply(customer(BOB), { ...MASTER, contact: '  ' })).rejects.toMatchObject({
      code: 'trade.pool_master_application_invalid',
    });
    // A person may wait in both queues: Alice's lead application is not blocked by her master application.
    await h.leads.apply(customer(ALICE), { displayName: 'TEST lead a' });
    expect(await count('copy_lead_applications')).toBe(3);
    // The lead queue holds only lead applications; the founders' pooled masters read holds only master applications.
    expect((await h.leads.queue(reader())).applications.map((a) => a.kind)).toEqual(['lead', 'lead']);
    expect((await h.leads.queue(reader())).applications[0]!.id).toBe(lead.applicationId);
    const read = await h.pools.read(reader());
    expect(read.applications).toEqual([
      expect.objectContaining({
        id: mine.application!.applicationId,
        kind: 'pool_master',
        displayName: 'TEST master',
        contact: MASTER.contact,
        style: MASTER.style,
        status: 'pending',
      }),
    ]);
    expect(read.batchLimit).toBe(20);
    await expect(h.pools.read(customer(ALICE))).rejects.toThrow();
  });

  it('two founders approve a master without listing anyone; only then may the master create one pool with the owner limits', async () => {
    const h = harness();
    const applied = await h.pools.apply(customer(ALICE), MASTER);
    const id = applied.application!.applicationId;
    await expect(
      h.pools.create(customer(ALICE), { name: 'TEST pool', strategyType: 'stable', clientRequestId: 'c1' }),
    ).rejects.toMatchObject({
      code: 'trade.pool_master_not_approved',
    });
    const approved = await approveByTwo(h, id, 'TEST master');
    expect(approved).toMatchObject({ status: 'approved', kind: 'pool_master', leaderRef: null, approverId: FOUNDER_B });
    expect(await h.leads.leads(reader())).toEqual([]);
    const audit = await h.leads.audit(reader());
    expect(audit.filter((r) => r.subject === id).map((r) => r.action)).toEqual(['copy_pool_master.approve', 'copy_pool_master.propose']);
    expect((await h.pools.mine(customer(ALICE))).application?.state).toBe('approved');
    await expect(h.pools.apply(customer(ALICE), MASTER)).rejects.toMatchObject({ code: 'trade.pool_master_already_approved' });

    // An unset type refuses by name; a valid one creates the pool in "strategy creation" with the owner's limits.
    await expect(
      h.pools.create(customer(ALICE), { name: 'TEST pool', strategyType: 'aggressive', clientRequestId: 'c1' }),
    ).rejects.toMatchObject({ code: 'trade.pool_limit_not_set' });
    await expect(
      h.pools.create(customer(ALICE), { name: 'TEST pool', strategyType: 'other', clientRequestId: 'c1' }),
    ).rejects.toMatchObject({
      code: 'trade.pool_type_invalid',
    });
    expect(await count('copy_pools')).toBe(0);
    const pool = await h.pools.create(customer(ALICE), { name: 'TEST pool', strategyType: 'stable', clientRequestId: 'c1' });
    expect(pool).toMatchObject({ name: 'TEST pool', strategyType: 'stable', state: 'strategy_creation', limits: STABLE.stable });
    // The same request answers the same pool; a second strategy refuses.
    expect(await h.pools.create(customer(ALICE), { name: 'TEST pool', strategyType: 'stable', clientRequestId: 'c1' })).toEqual(pool);
    await expect(
      h.pools.create(customer(ALICE), { name: 'TEST pool 2', strategyType: 'stable', clientRequestId: 'c2' }),
    ).rejects.toMatchObject({
      code: 'trade.pool_one_strategy_only',
    });
    expect(await count('copy_pools')).toBe(1);
    expect((await h.pools.mine(customer(ALICE))).pool).toEqual(pool);
    // Someone who never applied cannot create a pool.
    await expect(h.pools.create(customer(BOB), { name: 'TEST pool', strategyType: 'stable', clientRequestId: 'c1' })).rejects.toMatchObject(
      {
        code: 'trade.pool_master_not_approved',
      },
    );
  });

  it('a rejected master reads the reason; the founders read it decided', async () => {
    const h = harness();
    const applied = await h.pools.apply(customer(ALICE), MASTER);
    const id = applied.application!.applicationId;
    await h.leads.reject(founder(FOUNDER_A), { applicationId: id, reason: 'TEST: no track record' });
    expect((await h.pools.mine(customer(ALICE))).application).toMatchObject({ state: 'disapproved', reason: 'TEST: no track record' });
    expect((await h.pools.read(reader())).applications.map((a) => a.status)).toEqual(['rejected']);
    // The owner's wait is unset in this harness: applying again refuses by the shared unset code.
    await expect(h.pools.apply(customer(ALICE), MASTER)).rejects.toMatchObject({ code: 'trade.copy_lead_reapply_wait_unset' });
  });

  it("adds investors to a pool's whitelist within the batch limit, once per import key; refusals write nothing", async () => {
    const h = harness();
    const applied = await h.pools.apply(customer(ALICE), MASTER);
    await approveByTwo(h, applied.application!.applicationId, 'TEST master');
    const pool = await h.pools.create(customer(ALICE), { name: 'TEST pool', strategyType: 'stable', clientRequestId: 'c1' });

    const tooMany = Array.from({ length: 21 }, (_, i) => uid(i + 1));
    await expect(
      h.pools.importWhitelist(founder(FOUNDER_A), { poolId: pool.poolId, userIds: tooMany, clientRequestId: 'w0' }),
    ).rejects.toMatchObject({
      code: 'trade.pool_batch_too_large',
    });
    await expect(
      h.pools.importWhitelist(founder(FOUNDER_A), { poolId: pool.poolId, userIds: ['not-an-id'], clientRequestId: 'w0' }),
    ).rejects.toMatchObject({ code: 'trade.pool_whitelist_uid_invalid' });
    await expect(
      h.pools.importWhitelist(founder(FOUNDER_A), { poolId: pool.poolId, userIds: [], clientRequestId: 'w0' }),
    ).rejects.toMatchObject({
      code: 'trade.pool_whitelist_empty',
    });
    await expect(
      h.pools.importWhitelist(founder(FOUNDER_A), { poolId: uid(999), userIds: [uid(1)], clientRequestId: 'w0' }),
    ).rejects.toMatchObject({ code: 'trade.pool_not_found' });
    await expect(h.pools.importWhitelist(reader(), { poolId: pool.poolId, userIds: [uid(1)], clientRequestId: 'w0' })).rejects.toThrow();
    expect([await count('copy_pool_whitelist'), await count('copy_pool_whitelist_imports')]).toEqual([0, 0]);

    // Twenty is the limit: allowed, and duplicates in one import count once.
    const twenty = Array.from({ length: 20 }, (_, i) => uid(i + 1));
    const first = await h.pools.importWhitelist(founder(FOUNDER_A), {
      poolId: pool.poolId,
      userIds: [...twenty, uid(1).toUpperCase()],
      clientRequestId: 'w1',
    });
    expect(first).toMatchObject({ requested: 20, added: 20, members: 20 });
    // The same import again writes nothing new; the key used for other accounts refuses.
    expect(await h.pools.importWhitelist(founder(FOUNDER_A), { poolId: pool.poolId, userIds: twenty, clientRequestId: 'w1' })).toEqual(
      first,
    );
    await expect(
      h.pools.importWhitelist(founder(FOUNDER_A), { poolId: pool.poolId, userIds: [uid(30)], clientRequestId: 'w1' }),
    ).rejects.toMatchObject({ code: 'trade.pool_whitelist_key_reused' });
    // A second import adds only the accounts not already on the list.
    expect(
      await h.pools.importWhitelist(founder(FOUNDER_B), { poolId: pool.poolId, userIds: [uid(1), uid(21)], clientRequestId: 'w2' }),
    ).toMatchObject({ requested: 2, added: 1, members: 21 });
    const read = await h.pools.read(reader());
    expect(read.whitelists).toHaveLength(1);
    expect(read.whitelists[0]).toMatchObject({ poolId: pool.poolId, poolName: 'TEST pool', masterUserId: ALICE });
    expect(read.whitelists[0]!.members.map((m) => m.userId)).toEqual([...twenty, uid(21)].sort());
    expect((await h.leads.audit(reader())).filter((r) => r.action === 'copy_pool.whitelist_import')).toHaveLength(2);
  });

  it('refuses every import while the batch limit is unset', async () => {
    const h = harness({ batch: null });
    const applied = await h.pools.apply(customer(ALICE), MASTER);
    await approveByTwo(h, applied.application!.applicationId, 'TEST master');
    const pool = await h.pools.create(customer(ALICE), { name: 'TEST pool', strategyType: 'stable', clientRequestId: 'c1' });
    await expect(
      h.pools.importWhitelist(founder(FOUNDER_A), { poolId: pool.poolId, userIds: [uid(1)], clientRequestId: 'w1' }),
    ).rejects.toMatchObject({
      code: 'trade.pool_batch_limit_unset',
    });
    expect((await h.pools.read(reader())).batchLimit).toBeNull();
    expect(await count('copy_pool_whitelist_imports')).toBe(0);
  });

  it('reads the owner values: blank is unset, malformed stops the boot', () => {
    expect(parsePoolLaw('')).toEqual({});
    expect(parsePoolLaw(JSON.stringify({ published: true, ...STABLE }))).toEqual(STABLE);
    for (const bad of ['{', '{"published":false}', JSON.stringify({ published: true, stable: { maxLeverage: '3' } })]) {
      expect(() => parsePoolLaw(bad)).toThrow();
    }
    expect(() => parsePoolLaw(JSON.stringify({ published: true, stable: { ...STABLE.stable, maxCapital: '0' } }))).toThrow();
    expect(parsePoolWhitelistBatchMax(' ')).toBeNull();
    expect(parsePoolWhitelistBatchMax('20')).toBe(20);
    for (const bad of ['0', '-1', '2.5', '10001']) expect(() => parsePoolWhitelistBatchMax(bad)).toThrow();
  });
});
