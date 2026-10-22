import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createOrgRouter } from '../org-router.js';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { addOrgMember, createOrg } from './org-service.js';
import { getOrg, listOrgs, removeOrgMember, renameOrg } from './org-admin.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-org-admin-pg-test-signing-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('org admin (Postgres unavailable)', () => {
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
  const unique = () => `oa${process.pid}${++counter}`;
  const register = () => {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  };
  const history = (orgId: string) =>
    db.sql<
      Array<{ kind: string; actor_id: string; subject_id: string | null; before: string | null; after: string | null }>
    >`SELECT kind, actor_id, subject_id, before, after FROM organization_history WHERE org_id = ${orgId} ORDER BY at`;

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  async function orgWithTrader() {
    const admin = await register();
    const trader = await register();
    const org = await createOrg(db.sql, admin.userId, 'TEST Desk');
    await addOrgMember(db.sql, admin.userId, org.id, trader.userId, 'trader');
    return { admin, trader, org };
  }

  describe('organisation reads and upkeep (I-account-lifecycle-05)', () => {
    it('lists only the caller organisations with the caller role', async () => {
      const { admin, trader, org } = await orgWithTrader();
      const outsider = await register();
      expect((await listOrgs(db.sql, admin.userId)).orgs).toMatchObject([{ id: org.id, name: 'TEST Desk', role: 'admin' }]);
      expect((await listOrgs(db.sql, trader.userId)).orgs).toMatchObject([{ id: org.id, role: 'trader' }]);
      expect(await listOrgs(db.sql, outsider.userId)).toEqual({ orgs: [] });
      await expect(listOrgs(db.sql, ' ')).rejects.toMatchObject({ code: 'org.actor_id_required' });
    });

    it('shows members to a member; a non-member and a missing org get the same not found', async () => {
      const { admin, trader, org } = await orgWithTrader();
      const outsider = await register();
      const seen = await getOrg(db.sql, trader.userId, org.id);
      expect(seen).toMatchObject({ id: org.id, name: 'TEST Desk', createdBy: admin.userId });
      expect(seen.members.map((m) => [m.userId, m.role])).toEqual([
        [admin.userId, 'admin'],
        [trader.userId, 'trader'],
      ]);
      await expect(getOrg(db.sql, outsider.userId, org.id)).rejects.toMatchObject({ code: 'org.not_found' });
      await expect(getOrg(db.sql, admin.userId, randomUUID())).rejects.toMatchObject({ code: 'org.not_found' });
      await expect(getOrg(db.sql, admin.userId, '')).rejects.toMatchObject({ code: 'org.id_required' });
    });

    it('an admin removes a member in one step with a history row', async () => {
      const { admin, trader, org } = await orgWithTrader();
      expect(await removeOrgMember(db.sql, admin.userId, org.id, trader.userId)).toEqual({
        orgId: org.id,
        userId: trader.userId,
        removed: true,
      });
      expect((await getOrg(db.sql, admin.userId, org.id)).members.map((m) => m.userId)).toEqual([admin.userId]);
      expect(await history(org.id)).toEqual([
        { kind: 'member_removed', actor_id: admin.userId, subject_id: trader.userId, before: 'trader', after: null },
      ]);
      await expect(removeOrgMember(db.sql, admin.userId, org.id, trader.userId)).rejects.toMatchObject({ code: 'org.member_not_found' });
    });

    it('a member may leave; a non-admin cannot remove someone else; a non-member is refused', async () => {
      const { admin, trader, org } = await orgWithTrader();
      const other = await register();
      await addOrgMember(db.sql, admin.userId, org.id, other.userId, 'auditor');
      await expect(removeOrgMember(db.sql, trader.userId, org.id, other.userId)).rejects.toMatchObject({ code: 'org.not_admin' });
      const outsider = await register();
      await expect(removeOrgMember(db.sql, outsider.userId, org.id, trader.userId)).rejects.toMatchObject({
        code: 'org.membership_denied',
      });
      await expect(removeOrgMember(db.sql, admin.userId, randomUUID(), trader.userId)).rejects.toMatchObject({ code: 'org.not_found' });
      expect(await removeOrgMember(db.sql, trader.userId, org.id, trader.userId)).toMatchObject({ removed: true });
      expect((await history(org.id)).map((h) => h.kind)).toEqual(['member_removed']);
    });

    it('refuses removing the last admin, by others or by themselves, and changes nothing', async () => {
      const { admin, trader, org } = await orgWithTrader();
      await expect(removeOrgMember(db.sql, admin.userId, org.id, admin.userId)).rejects.toMatchObject({ code: 'org.last_admin' });
      expect((await getOrg(db.sql, admin.userId, org.id)).members).toHaveLength(2);
      expect(await history(org.id)).toEqual([]);
      // With a second admin, one admin may leave.
      const second = await register();
      await db.sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${org.id}, ${second.userId}, 'admin') ON CONFLICT DO NOTHING`;
      expect(await removeOrgMember(db.sql, admin.userId, org.id, admin.userId)).toMatchObject({ removed: true });
      await expect(removeOrgMember(db.sql, second.userId, org.id, second.userId)).rejects.toMatchObject({ code: 'org.last_admin' });
      expect((await getOrg(db.sql, second.userId, org.id)).members.map((m) => m.userId)).toEqual([trader.userId, second.userId]);
    });

    it('two admins removing each other at once leave one admin', async () => {
      const { admin, org } = await orgWithTrader();
      const second = await register();
      await db.sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${org.id}, ${second.userId}, 'admin')`;
      const results = await Promise.allSettled([
        removeOrgMember(db.sql, admin.userId, org.id, second.userId),
        removeOrgMember(db.sql, second.userId, org.id, admin.userId),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [admins] = await db.sql<
        Array<{ n: string }>
      >`SELECT count(*)::text AS n FROM organization_members WHERE org_id = ${org.id} AND role = 'admin'`;
      expect(admins!.n).toBe('1');
    });

    it('renames by an admin with history; a repeat is a no-op; blank and non-admin are refused', async () => {
      const { admin, trader, org } = await orgWithTrader();
      expect(await renameOrg(db.sql, admin.userId, org.id, '  TEST Desk Two ')).toEqual({
        id: org.id,
        name: 'TEST Desk Two',
        changed: true,
      });
      expect(await renameOrg(db.sql, admin.userId, org.id, 'TEST Desk Two')).toEqual({ id: org.id, name: 'TEST Desk Two', changed: false });
      expect(await history(org.id)).toEqual([
        { kind: 'renamed', actor_id: admin.userId, subject_id: null, before: 'TEST Desk', after: 'TEST Desk Two' },
      ]);
      await expect(renameOrg(db.sql, admin.userId, org.id, '   ')).rejects.toMatchObject({ code: 'org.invalid' });
      await expect(renameOrg(db.sql, admin.userId, org.id, 'x'.repeat(129))).rejects.toMatchObject({ code: 'org.invalid' });
      await expect(renameOrg(db.sql, trader.userId, org.id, 'Mine')).rejects.toMatchObject({ code: 'org.not_admin' });
      const outsider = await register();
      await expect(renameOrg(db.sql, outsider.userId, org.id, 'Mine')).rejects.toMatchObject({ code: 'org.membership_denied' });
      expect((await getOrg(db.sql, admin.userId, org.id)).name).toBe('TEST Desk Two');
    });

    it('maps refusals to tRPC codes through the router', async () => {
      const { admin, trader, org } = await orgWithTrader();
      const outsider = await register();
      const caller = async (userId: string, sessionId: string) => {
        const { token } = await issueAccessToken(
          { userId, sessionId, scopes: ['identity:read', 'identity:write'], tier: 'none', mfa: false },
          tokenConfig,
        );
        const context: Context = {
          principal: await verifyAccessToken(token, tokenConfig),
          service: null,
          region: 'DE',
          requestId: 'org-admin',
        };
        return createOrgRouter(db.sql).createCaller(context);
      };
      const asAdmin = await caller(admin.userId, admin.sessionId);
      expect((await asAdmin.listOrgs()).orgs).toHaveLength(1);
      expect((await asAdmin.getOrg({ orgId: org.id })).members).toHaveLength(2);
      await expect(asAdmin.removeOrgMember({ orgId: org.id, memberId: admin.userId })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringContaining('org.last_admin'),
      });
      const asOutsider = await caller(outsider.userId, outsider.sessionId);
      await expect(asOutsider.getOrg({ orgId: org.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const asTrader = await caller(trader.userId, trader.sessionId);
      await expect(asTrader.renameOrg({ orgId: org.id, name: 'Mine' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(asAdmin.renameOrg({ orgId: org.id, name: ' ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await asAdmin.renameOrg({ orgId: org.id, name: 'TEST Renamed' })).toMatchObject({ changed: true });
    });
  });
}
