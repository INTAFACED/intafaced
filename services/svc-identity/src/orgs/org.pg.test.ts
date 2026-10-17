import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { addOrgMember, assertOrgActor, assertOrgPlace, assertOrgRisk, createOrg, grantOrgRole } from './org-service.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-org-pg-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('orgs (Postgres unavailable)', () => {
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

  describe('orgs against Postgres', () => {
    it('admin vs trader vs auditor: trader cannot add; auditor cannot place; missing role refuses', async () => {
      const ownerA = await register();
      const ownerB = await register();
      const trader = await register();
      const auditor = await register();
      const extra = await register();

      const orgA = await createOrg(db.sql, ownerA.userId, 'Desk A');
      const orgB = await createOrg(db.sql, ownerB.userId, 'Desk B');
      await addOrgMember(db.sql, ownerA.userId, orgA.id, trader.userId, 'trader');
      await addOrgMember(db.sql, ownerA.userId, orgA.id, auditor.userId, 'auditor');

      await expect(assertOrgActor(db.sql, trader.userId, orgA.id)).resolves.toMatchObject({
        orgId: orgA.id,
        userId: trader.userId,
        role: 'trader',
      });
      await expect(assertOrgPlace(db.sql, trader.userId, orgA.id)).resolves.toMatchObject({ role: 'trader' });
      await expect(assertOrgPlace(db.sql, ownerA.userId, orgA.id)).resolves.toMatchObject({ role: 'admin' });
      await expect(assertOrgPlace(db.sql, auditor.userId, orgA.id)).rejects.toMatchObject({
        code: 'org.place_denied',
      });
      await expect(addOrgMember(db.sql, trader.userId, orgA.id, extra.userId, 'trader')).rejects.toMatchObject({
        code: 'org.not_admin',
      });
      await expect(addOrgMember(db.sql, auditor.userId, orgA.id, extra.userId, 'trader')).rejects.toMatchObject({
        code: 'org.not_admin',
      });
      await expect(addOrgMember(db.sql, ownerA.userId, orgA.id, extra.userId, undefined)).rejects.toMatchObject({
        code: 'org.role_required',
      });
      await expect(assertOrgActor(db.sql, trader.userId, orgB.id)).rejects.toMatchObject({
        code: 'org.membership_denied',
      });
      await expect(addOrgMember(db.sql, ownerB.userId, orgA.id, extra.userId, 'trader')).rejects.toMatchObject({
        code: 'org.membership_denied',
      });
    });

    it('risk-manager can see risk, cannot place or add; second admin needs four-eyes', async () => {
      const ownerA = await register();
      const risk = await register();
      const extra = await register();
      const second = await register();
      const third = await register();

      const orgA = await createOrg(db.sql, ownerA.userId, 'Desk A');
      await addOrgMember(db.sql, ownerA.userId, orgA.id, risk.userId, 'risk-manager');

      await expect(assertOrgRisk(db.sql, risk.userId, orgA.id)).resolves.toMatchObject({ role: 'risk-manager' });
      await expect(assertOrgPlace(db.sql, risk.userId, orgA.id)).rejects.toMatchObject({ code: 'org.place_denied' });
      await expect(addOrgMember(db.sql, risk.userId, orgA.id, extra.userId, 'trader')).rejects.toMatchObject({
        code: 'org.not_admin',
      });
      await expect(addOrgMember(db.sql, ownerA.userId, orgA.id, extra.userId, 'admin')).rejects.toMatchObject({
        code: 'org.second_approver_required',
      });
      await expect(addOrgMember(db.sql, ownerA.userId, orgA.id, extra.userId, 'admin', ownerA.userId)).rejects.toMatchObject({
        code: 'org.self_approval',
      });
      await expect(grantOrgRole(db.sql, ownerA.userId, orgA.id, risk.userId, 'admin')).rejects.toMatchObject({
        code: 'org.second_approver_required',
      });

      await db.sql`
        INSERT INTO organization_members (org_id, user_id, role)
        VALUES (${orgA.id}, ${second.userId}, ${'admin'})
      `;
      await expect(addOrgMember(db.sql, ownerA.userId, orgA.id, third.userId, 'admin', second.userId)).resolves.toMatchObject({
        userId: third.userId,
        role: 'admin',
      });
    });
  });
}
