import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { addOrgMember, createOrg, grantOrgRole } from './org-service.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-org-last-admin-pg-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('org last admin (Postgres unavailable)', () => {
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

  describe('grantOrgRole never leaves an organization without an admin', () => {
    it('refuses demoting the last admin with org.last_admin and keeps the seat', async () => {
      const owner = await register();
      const org = await createOrg(db.sql, owner.userId, 'Last admin desk');
      await expect(grantOrgRole(db.sql, owner.userId, org.id, owner.userId, 'trader')).rejects.toMatchObject({ code: 'org.last_admin' });
      const [seat] = await db.sql<Array<{ role: string }>>`
        SELECT role FROM organization_members WHERE org_id = ${org.id} AND user_id = ${owner.userId}`;
      expect(seat?.role).toBe('admin');
    });

    it('lets an admin demote another admin while one admin remains, then refuses the last', async () => {
      const owner = await register();
      const second = await register();
      const org = await createOrg(db.sql, owner.userId, 'Two admin desk');
      await addOrgMember(db.sql, owner.userId, org.id, second.userId, 'trader');
      // A second admin seat set up directly: granting admin itself needs a second admin approver.
      await db.sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${second.userId}`;

      await expect(grantOrgRole(db.sql, owner.userId, org.id, second.userId, 'auditor')).resolves.toEqual({
        orgId: org.id,
        userId: second.userId,
        role: 'auditor',
      });
      await expect(grantOrgRole(db.sql, owner.userId, org.id, owner.userId, 'trader')).rejects.toMatchObject({ code: 'org.last_admin' });
      const admins = await db.sql<Array<{ user_id: string }>>`
        SELECT user_id FROM organization_members WHERE org_id = ${org.id} AND role = 'admin'`;
      expect(admins.map((a) => a.user_id)).toEqual([owner.userId]);
    });

    it('keeps an admin when two admins demote each other at the same time', async () => {
      const owner = await register();
      const second = await register();
      const org = await createOrg(db.sql, owner.userId, 'Race desk');
      await addOrgMember(db.sql, owner.userId, org.id, second.userId, 'trader');
      await db.sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${second.userId}`;

      const results = await Promise.allSettled([
        grantOrgRole(db.sql, owner.userId, org.id, second.userId, 'trader'),
        grantOrgRole(db.sql, second.userId, org.id, owner.userId, 'trader'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const admins = await db.sql<Array<{ user_id: string }>>`
        SELECT user_id FROM organization_members WHERE org_id = ${org.id} AND role = 'admin'`;
      expect(admins).toHaveLength(1);
    });

    it('never ends with no admin when the target of a plain role change is promoted concurrently', async () => {
      // Review #5825 blocker 1: A reads B as a trader, B is promoted and demotes A,
      // then A's plain role change on B must not demote the last admin.
      for (let round = 0; round < 8; round += 1) {
        const a = await register();
        const b = await register();
        const org = await createOrg(db.sql, a.userId, `Promote race ${round}`);
        await addOrgMember(db.sql, a.userId, org.id, b.userId, 'trader');
        await Promise.allSettled([
          (async () => {
            await db.sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${b.userId}`;
            await grantOrgRole(db.sql, b.userId, org.id, a.userId, 'trader');
          })(),
          grantOrgRole(db.sql, a.userId, org.id, b.userId, 'auditor'),
        ]);
        const admins = await db.sql<Array<{ user_id: string }>>`
          SELECT user_id FROM organization_members WHERE org_id = ${org.id} AND role = 'admin'`;
        expect(admins.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('refuses a plain role change from an actor who is no longer an admin', async () => {
      const owner = await register();
      const second = await register();
      const member = await register();
      const org = await createOrg(db.sql, owner.userId, 'Stale actor desk');
      await addOrgMember(db.sql, owner.userId, org.id, second.userId, 'trader');
      await addOrgMember(db.sql, owner.userId, org.id, member.userId, 'trader');
      await db.sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${second.userId}`;
      await grantOrgRole(db.sql, owner.userId, org.id, second.userId, 'auditor');
      await expect(grantOrgRole(db.sql, second.userId, org.id, member.userId, 'risk-manager')).rejects.toMatchObject({
        code: 'org.not_admin',
      });
    });

    it('still promotes and changes non-admin roles without the admin lock', async () => {
      const owner = await register();
      const member = await register();
      const org = await createOrg(db.sql, owner.userId, 'Plain desk');
      await addOrgMember(db.sql, owner.userId, org.id, member.userId, 'trader');
      await expect(grantOrgRole(db.sql, owner.userId, org.id, member.userId, 'risk-manager')).resolves.toMatchObject({
        role: 'risk-manager',
      });
      await expect(grantOrgRole(db.sql, owner.userId, org.id, owner.userId, 'admin')).rejects.toMatchObject({
        code: 'org.second_approver_required',
      });
    });

    it('three admins: A demotes B while B demotes C, in a gated order; each outcome and the final admin set are exact', async () => {
      const a = await register();
      const b = await register();
      const c = await register();
      const org = await createOrg(db.sql, a.userId, 'Three admin desk');
      for (const m of [b, c]) {
        await addOrgMember(db.sql, a.userId, org.id, m.userId, 'trader');
        await db.sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${m.userId}`;
      }
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // Hold the admin lock so both calls queue on it: A's demotion of B first, then B's demotion of C.
      const holder = db.sql.begin(async (tx) => {
        await tx`SELECT user_id FROM organization_members WHERE org_id = ${org.id} AND role = 'admin' FOR UPDATE`;
        await gate;
      });
      await new Promise((r) => setTimeout(r, 100));
      const aDemotesB = grantOrgRole(db.sql, a.userId, org.id, b.userId, 'trader');
      await new Promise((r) => setTimeout(r, 150));
      const bDemotesC = grantOrgRole(db.sql, b.userId, org.id, c.userId, 'trader');
      await new Promise((r) => setTimeout(r, 150));
      release();
      await holder;
      await expect(aDemotesB).resolves.toEqual({ orgId: org.id, userId: b.userId, role: 'trader' });
      await expect(bDemotesC).rejects.toMatchObject({ code: 'org.not_admin' });
      const admins = await db.sql<Array<{ user_id: string }>>`
        SELECT user_id FROM organization_members WHERE org_id = ${org.id} AND role = 'admin' ORDER BY user_id`;
      expect(admins.map((x) => x.user_id)).toEqual([a.userId, c.userId].sort());
    });

    it('takes the plain role change when the target was demoted concurrently (no member_not_found)', async () => {
      const a = await register();
      const b = await register();
      const org = await createOrg(db.sql, a.userId, 'Concurrent demotion desk');
      await addOrgMember(db.sql, a.userId, org.id, b.userId, 'trader');
      await db.sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${b.userId}`;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const other = db.sql.begin(async (tx) => {
        await tx`SELECT user_id FROM organization_members WHERE org_id = ${org.id} AND role = 'admin' FOR UPDATE`;
        await tx`UPDATE organization_members SET role = 'trader' WHERE org_id = ${org.id} AND user_id = ${b.userId}`;
        await gate;
      });
      await new Promise((r) => setTimeout(r, 100));
      const change = grantOrgRole(db.sql, a.userId, org.id, b.userId, 'auditor');
      await new Promise((r) => setTimeout(r, 200));
      release();
      await other;
      await expect(change).resolves.toEqual({ orgId: org.id, userId: b.userId, role: 'auditor' });
      const admins = await db.sql<Array<{ user_id: string }>>`
        SELECT user_id FROM organization_members WHERE org_id = ${org.id} AND role = 'admin'`;
      expect(admins.map((x) => x.user_id)).toEqual([a.userId]);
    });

    it('refuses a stale actor whose admin seat was taken away after the first check (org.not_admin)', async () => {
      const a = await register();
      const b = await register();
      const c = await register();
      const org = await createOrg(db.sql, a.userId, 'Stale actor desk');
      for (const m of [b, c]) {
        await addOrgMember(db.sql, a.userId, org.id, m.userId, 'trader');
        await db.sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${m.userId}`;
      }
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // Another session locks the admin seats and demotes B, but has not committed yet.
      const other = db.sql.begin(async (tx) => {
        await tx`SELECT user_id FROM organization_members WHERE org_id = ${org.id} AND role = 'admin' FOR UPDATE`;
        await tx`UPDATE organization_members SET role = 'trader' WHERE org_id = ${org.id} AND user_id = ${b.userId}`;
        await gate;
      });
      await new Promise((r) => setTimeout(r, 100));
      // B still reads as admin outside the lock, then waits on it.
      const stale = grantOrgRole(db.sql, b.userId, org.id, c.userId, 'trader');
      await new Promise((r) => setTimeout(r, 200));
      release();
      await other;
      await expect(stale).rejects.toMatchObject({ code: 'org.not_admin' });
      const [seat] = await db.sql<Array<{ role: string }>>`
        SELECT role FROM organization_members WHERE org_id = ${org.id} AND user_id = ${c.userId}`;
      expect(seat?.role).toBe('admin');
    });

    it('refuses with org.member_not_found when the target left after the first check', async () => {
      const a = await register();
      const b = await register();
      const org = await createOrg(db.sql, a.userId, 'Gone member desk');
      await addOrgMember(db.sql, a.userId, org.id, b.userId, 'trader');
      await db.sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${b.userId}`;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const other = db.sql.begin(async (tx) => {
        await tx`SELECT user_id FROM organization_members WHERE org_id = ${org.id} AND role = 'admin' FOR UPDATE`;
        await tx`DELETE FROM organization_members WHERE org_id = ${org.id} AND user_id = ${b.userId}`;
        await gate;
      });
      await new Promise((r) => setTimeout(r, 100));
      const late = grantOrgRole(db.sql, a.userId, org.id, b.userId, 'trader');
      await new Promise((r) => setTimeout(r, 200));
      release();
      await other;
      await expect(late).rejects.toMatchObject({ code: 'org.member_not_found' });
    });
  });
}
