import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { addOrgMember, createOrg, grantOrgRole, OrgError } from './org-service.js';
import { removeOrgMember } from './org-admin.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-org-role-followup-pg-test-secret-long-ok',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('org role follow-up (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig);
  await rank.seedTiers();

  let counter = 0;
  const unique = () => `o${process.pid}${++counter}`;
  const register = () => {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  };

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  /**
   * Barrier (no sleeps): resolve once `n` backends wait, directly or through another waiter, on the
   * holder's backend `holderPid`. Scoped by pg_blocking_pids, so parallel test files cannot satisfy it.
   */
  async function lockWaiters(holderPid: number, n: number): Promise<void> {
    for (let i = 0; i < 2000; i += 1) {
      const rows = await db.sql<Array<{ pid: number; blockers: number[] }>>`
        SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
      const chain = new Set<number>([holderPid]);
      for (let grew = true; grew;) {
        grew = false;
        for (const r of rows) {
          if (!chain.has(r.pid) && r.blockers.some((b) => chain.has(b))) {
            chain.add(r.pid);
            grew = true;
          }
        }
      }
      if (chain.size - 1 >= n) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error(`barrier: ${n} lock waiter(s) on ${holderPid} never appeared`);
  }

  async function holdAdminLock(orgId: string, work?: (tx: typeof db.sql) => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: (pid: number) => void;
    const isLocked = new Promise<number>((r) => (locked = r));
    const done = db.sql.begin(async (tx) => {
      const [me] = await tx<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT user_id FROM organization_members WHERE org_id = ${orgId} AND role = 'admin' ORDER BY user_id FOR UPDATE`;
      if (work) await work(tx as unknown as typeof db.sql);
      locked(me!.pid);
      await gate;
    });
    const pid = await isLocked;
    return { release, done, pid };
  }

  describe('grantOrgRole follow-up to review #5825', () => {
    it('refuses an admin grant co-signed by an approver demoted concurrently (org.second_approver_not_admin)', async () => {
      const a = await register();
      const approver = await register();
      const target = await register();
      const org = await createOrg(db.sql, a.userId, 'Approver race desk');
      for (const m of [approver, target]) await addOrgMember(db.sql, a.userId, org.id, m.userId, 'trader');
      await db.sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${approver.userId}`;
      const other = await holdAdminLock(
        org.id,
        (tx) => tx`UPDATE organization_members SET role = 'trader' WHERE org_id = ${org.id} AND user_id = ${approver.userId}`,
      );
      const grant = grantOrgRole(db.sql, a.userId, org.id, target.userId, 'admin', approver.userId);
      grant.catch(() => undefined);
      await lockWaiters(other.pid, 1);
      other.release();
      await other.done;
      await expect(grant).rejects.toMatchObject({ code: 'org.second_approver_not_admin' });
      const [seat] = await db.sql<Array<{ role: string }>>`
        SELECT role FROM organization_members WHERE org_id = ${org.id} AND user_id = ${target.userId}`;
      expect(seat?.role).toBe('trader');
    });

    it('writes one role_changed history row with the change, and none for a refused or no-op change', async () => {
      const a = await register();
      const b = await register();
      const org = await createOrg(db.sql, a.userId, 'History desk');
      await addOrgMember(db.sql, a.userId, org.id, b.userId, 'trader');
      await grantOrgRole(db.sql, a.userId, org.id, b.userId, 'auditor');
      await grantOrgRole(db.sql, a.userId, org.id, b.userId, 'auditor');
      await expect(grantOrgRole(db.sql, a.userId, org.id, a.userId, 'trader')).rejects.toMatchObject({ code: 'org.last_admin' });
      const rows = await db.sql<Array<{ actor_id: string; kind: string; subject_id: string; before: string; after: string }>>`
        SELECT actor_id, kind, subject_id, before, after FROM organization_history WHERE org_id = ${org.id}`;
      expect(rows).toEqual([{ actor_id: a.userId, kind: 'role_changed', subject_id: b.userId, before: 'trader', after: 'auditor' }]);
    });

    it('two admins demote each other: a lock barrier fixes the order, so the first wins and the second is refused', async () => {
      const a = await register();
      const b = await register();
      const org = await createOrg(db.sql, a.userId, 'Deterministic race desk');
      await addOrgMember(db.sql, a.userId, org.id, b.userId, 'trader');
      await db.sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${b.userId}`;
      const holder = await holdAdminLock(org.id);
      const aDemotesB = grantOrgRole(db.sql, a.userId, org.id, b.userId, 'trader');
      aDemotesB.catch(() => undefined);
      await lockWaiters(holder.pid, 1);
      const bDemotesA = grantOrgRole(db.sql, b.userId, org.id, a.userId, 'trader');
      bDemotesA.catch(() => undefined);
      await lockWaiters(holder.pid, 2);
      holder.release();
      await holder.done;
      await expect(aDemotesB).resolves.toEqual({ orgId: org.id, userId: b.userId, role: 'trader' });
      await expect(bDemotesA).rejects.toMatchObject({ code: 'org.not_admin' });
      const admins = await db.sql<Array<{ user_id: string }>>`
        SELECT user_id FROM organization_members WHERE org_id = ${org.id} AND role = 'admin'`;
      expect(admins.map((x) => x.user_id)).toEqual([a.userId]);
    });

    it('stale actor, deterministic: the actor demoted under the lock is refused with org.not_admin', async () => {
      const a = await register();
      const b = await register();
      const c = await register();
      const org = await createOrg(db.sql, a.userId, 'Barrier stale desk');
      for (const m of [b, c]) {
        await addOrgMember(db.sql, a.userId, org.id, m.userId, 'trader');
        await db.sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${m.userId}`;
      }
      const other = await holdAdminLock(
        org.id,
        (tx) => tx`UPDATE organization_members SET role = 'trader' WHERE org_id = ${org.id} AND user_id = ${b.userId}`,
      );
      const stale = grantOrgRole(db.sql, b.userId, org.id, c.userId, 'trader');
      stale.catch(() => undefined);
      await lockWaiters(other.pid, 1);
      other.release();
      await other.done;
      await expect(stale).rejects.toMatchObject({ code: 'org.not_admin' });
    });

    it('removeOrgMember and demotion share one org.last_admin error class (OrgError)', async () => {
      const a = await register();
      const org = await createOrg(db.sql, a.userId, 'One class desk');
      const removal = await removeOrgMember(db.sql, a.userId, org.id, a.userId).catch((e: unknown) => e);
      const demotion = await grantOrgRole(db.sql, a.userId, org.id, a.userId, 'trader').catch((e: unknown) => e);
      expect(removal).toBeInstanceOf(OrgError);
      expect(demotion).toBeInstanceOf(OrgError);
      expect(removal).toMatchObject({ code: 'org.last_admin' });
      expect(demotion).toMatchObject({ code: 'org.last_admin' });
    });
  });
}
