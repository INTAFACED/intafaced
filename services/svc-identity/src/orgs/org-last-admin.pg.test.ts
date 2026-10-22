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
  });
}
