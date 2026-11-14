import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import { PostgresTrustDeskStore } from './trust-desk.pg.js';
import { approveChecklist, approveTier, askTier, openChecklist, readChecklists, readTiers, removeTier } from './trust-desk.js';

/** Token tiers and pool onboarding (20261113040000) on a real test database. Deletes only this file's rows. */
// CI provides the database; this test runs unconditionally and fails where none answers.
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced:intafaced@127.0.0.1:5432/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, '..', '..', 'drizzle', '20261113040000_protocol_trust_desk.sql');
if (!(await postgresAvailable(URL))) throw new Error('postgres unavailable');
const db = createDb({ url: URL, schema: 'protocol', max: 4 }, {});
const sql: Sql = db.sql;
const CHAIN_ID = 991_130;
const TOKEN = '0x000000000000000000000000000000000000ab04';
const CHECKER = '0x000000000000000000000000000000000000c4ec';
const A = 'founder-a';
const B = 'founder-b';

describe('trust desk (Postgres)', () => {
  const store = new PostgresTrustDeskStore(sql);
  const cleanup = async () => {
    await sql`DELETE FROM protocol.token_tiers WHERE chain_id = ${CHAIN_ID}`;
    await sql`DELETE FROM protocol.token_tier_audit WHERE chain_id = ${CHAIN_ID}`;
    await sql`DELETE FROM protocol.token_tier_requests WHERE chain_id = ${CHAIN_ID}`;
    await sql`DELETE FROM protocol.pool_onboarding WHERE chain_id = ${CHAIN_ID}`;
  };
  beforeAll(async () => {
    await assertTestDatabase(sql, 'svc-protocol trust-desk.pg.test');
    await sql`CREATE SCHEMA IF NOT EXISTS protocol`;
    await sql.unsafe(readFileSync(migration, 'utf8'));
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db.close();
  });

  it('a tier is pending until a different person approves; then in force with its date and reason', async () => {
    const asked = await askTier(store, {
      chainId: CHAIN_ID,
      token: TOKEN.toUpperCase().replace('0X', '0x'),
      tier: 'verified',
      reason: 'TEST checked',
      requesterId: A,
    });
    expect(asked).toMatchObject({ token: TOKEN, tier: null, pending: { tier: 'verified', reason: 'TEST checked', requesterId: A } });
    await expect(askTier(store, { chainId: CHAIN_ID, token: TOKEN, tier: 'banned', reason: 'TEST', requesterId: B })).rejects.toMatchObject(
      {
        code: 'protocol.tiers.request_pending',
      },
    );
    await expect(approveTier(store, { chainId: CHAIN_ID, requestId: asked.pending!.id, approverId: A })).rejects.toMatchObject({
      code: 'protocol.tiers.same_approver',
    });
    // The table refuses the same person even if the service did not.
    await expect(
      sql`UPDATE protocol.token_tier_requests SET status = 'approved', approver_id = ${A}, decided_at = now() WHERE id = ${asked.pending!.id}`,
    ).rejects.toThrow(/four_eyes/);
    expect((await readTiers(store, CHAIN_ID, new Date())).tiers[0]).toMatchObject({ tier: null });
    // Two approvals at once change the tier once.
    const results = await Promise.allSettled([
      approveTier(store, { chainId: CHAIN_ID, requestId: asked.pending!.id, approverId: B }),
      approveTier(store, { chainId: CHAIN_ID, requestId: asked.pending!.id, approverId: 'founder-c' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const read = await readTiers(store, CHAIN_ID, new Date());
    expect(read.tiers).toHaveLength(1);
    expect(read.tiers[0]).toMatchObject({ tier: 'verified', priorTier: null, reason: 'TEST checked', requesterId: A, pending: null });
    expect(read.tiers[0]!.since).not.toBeNull();
    expect(read.audit.map((a) => a.action)).toEqual(['approved', 'asked']);
  });

  it('removal returns to the prior tier with an audit row', async () => {
    // A second human tier over the first: removing it returns to verified, and removing that returns to the automated tier.
    const asked = await askTier(store, { chainId: CHAIN_ID, token: TOKEN, tier: 'banned', reason: 'TEST banned', requesterId: B });
    await approveTier(store, { chainId: CHAIN_ID, requestId: asked.pending!.id, approverId: A });
    expect((await readTiers(store, CHAIN_ID, new Date())).tiers[0]).toMatchObject({ tier: 'banned', priorTier: 'verified' });
    const back = await removeTier(store, { chainId: CHAIN_ID, token: TOKEN, reason: 'TEST remove', actorId: A });
    expect(back).toMatchObject({ tier: 'verified', priorTier: null, reason: 'TEST checked' });
    const gone = await removeTier(store, { chainId: CHAIN_ID, token: TOKEN, reason: 'TEST remove', actorId: A });
    expect(gone).toMatchObject({ tier: null, priorTier: null });
    await expect(removeTier(store, { chainId: CHAIN_ID, token: TOKEN, reason: 'TEST', actorId: A })).rejects.toMatchObject({
      code: 'protocol.tiers.none_set',
    });
    const audit = (await readTiers(store, CHAIN_ID, new Date())).audit.filter((a) => a.action === 'removed');
    expect(audit.map((a) => [a.tier, a.returnedTo, a.actorId])).toEqual([
      ['verified', null, A],
      ['banned', 'verified', A],
    ]);
  });

  it('a checklist missing the checker address cannot be approved; a complete one needs a second person', async () => {
    const base = {
      chainId: CHAIN_ID,
      legalEntity: 'TEST Issuer Ltd',
      tokenContract: TOKEN,
      wrapperAddress: '0x000000000000000000000000000000000000a7a9',
      routingRegistration: 'TEST registry entry',
      openedBy: A,
    };
    const missing = await openChecklist(store, { ...base, pool: 'TEST pool no checker', checkerAddress: null });
    expect(missing.missing).toEqual(['checkerAddress']);
    await expect(
      approveChecklist(store, { chainId: CHAIN_ID, checklistId: missing.id, approverId: B, reason: 'TEST' }),
    ).rejects.toMatchObject({
      code: 'protocol.onboarding.incomplete',
      message: expect.stringContaining('checker address'),
    });
    // The table refuses an approved checklist with a blank item even if the service did not.
    await expect(
      sql`UPDATE protocol.pool_onboarding SET status = 'approved', approved_by = ${B}, approval_reason = 'x', approved_at = now() WHERE id = ${missing.id}`,
    ).rejects.toThrow(/complete/);
    await expect(openChecklist(store, { ...base, pool: 'test POOL no checker', checkerAddress: null })).rejects.toMatchObject({
      code: 'protocol.onboarding.duplicate',
    });
    const full = await openChecklist(store, { ...base, pool: 'TEST pool complete', checkerAddress: CHECKER });
    expect(full.missing).toEqual([]);
    await expect(approveChecklist(store, { chainId: CHAIN_ID, checklistId: full.id, approverId: A, reason: 'TEST' })).rejects.toMatchObject(
      {
        code: 'protocol.onboarding.same_approver',
      },
    );
    const done = await approveChecklist(store, {
      chainId: CHAIN_ID,
      checklistId: full.id,
      approverId: B,
      reason: 'TEST all items checked',
    });
    expect(done).toMatchObject({ status: 'approved', approvedBy: B, approvalReason: 'TEST all items checked' });
    const list = await readChecklists(store, CHAIN_ID, new Date());
    expect(list.checklists.map((c) => [c.pool, c.status])).toEqual(
      expect.arrayContaining([
        ['TEST pool no checker', 'open'],
        ['TEST pool complete', 'approved'],
      ]),
    );
  });
});
