/**
 * AC-roles-01 — role store, permission query and two-founder doors against PostgreSQL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type ActionApproval } from '@intafaced/contracts';
import type { AcademyService } from '../academy-service.js';
import type { ActionApprovalConsumer } from '../action-approval-consume.js';
import { createAcademyRouter } from '../router.js';
import { AcademyRoleStore } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
const sql = db.sql;
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const COURSE = 'course-a';
const meta = { actor: FOUNDER, approver: 'founder-2', reason: 'TEST' };
const store = (...limit: [number | undefined] | []) => new AcademyRoleStore(sql, limit.length === 0 ? 5 : limit[0]);

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

describe('AcademyRoleStore (AC-roles-01)', () => {
  it('limited staff cannot edit content but can read progress', async () => {
    await store().assign({ courseScope: COURSE, accountId: MEMBER, role: 'limited_staff', ...meta });
    await expect(store().requirePermission(MEMBER, COURSE, 'edit_content')).rejects.toMatchObject({ code: 'academy.permission_denied' });
    await expect(store().requirePermission(MEMBER, COURSE, 'view_progress')).resolves.toBeUndefined();
  });

  it('a course role does not reach another course; an academy-wide role does', async () => {
    await store().assign({ courseScope: COURSE, accountId: MEMBER, role: 'author', ...meta });
    await expect(store().requirePermission(MEMBER, 'course-b', 'edit_content')).rejects.toMatchObject({
      code: 'academy.permission_denied',
    });
    await store().assign({ courseScope: '*', accountId: MEMBER, role: 'author', ...meta });
    await expect(store().requirePermission(MEMBER, 'course-b', 'edit_content')).resolves.toBeUndefined();
  });

  it('custom role with refund grants the permission name only', async () => {
    await store().createCustomRole({ slug: 'support', label: 'TEST support', permissions: ['refund', 'comments'], ...meta });
    await store().assign({ courseScope: COURSE, accountId: MEMBER, role: 'custom:support', ...meta });
    expect((await store().permissionsOf(MEMBER, COURSE)).has('refund')).toBe(true);
  });

  it('deactivated custom role keeps holders but grants nothing; reactivation restores', async () => {
    await store().createCustomRole({ slug: 'mods', label: 'TEST', permissions: ['moderate'], ...meta });
    await store().assign({ courseScope: COURSE, accountId: MEMBER, role: 'custom:mods', ...meta });
    await store().setCustomRoleActive({ roleId: 'custom:mods', active: false, ...meta });
    expect(await store().holders(COURSE, 10)).toHaveLength(1);
    expect((await store().permissionsOf(MEMBER, COURSE)).has('moderate')).toBe(false);
    const again = await store().setCustomRoleActive({ roleId: 'custom:mods', active: false, ...meta });
    expect(again.active).toBe(false);
    await store().setCustomRoleActive({ roleId: 'custom:mods', active: true, ...meta });
    expect((await store().permissionsOf(MEMBER, COURSE)).has('moderate')).toBe(true);
  });

  it('blank role limit refuses academy.role_limit_unset; a full limit refuses academy.role_limit_reached', async () => {
    await expect(store(undefined).createCustomRole({ slug: 'x', label: 'x', permissions: ['comments'], ...meta })).rejects.toMatchObject({
      code: 'academy.role_limit_unset',
    });
    await store(1).createCustomRole({ slug: 'x', label: 'x', permissions: ['comments'], ...meta });
    await expect(store(1).createCustomRole({ slug: 'y', label: 'y', permissions: ['comments'], ...meta })).rejects.toMatchObject({
      code: 'academy.role_limit_reached',
    });
  });

  it('create is idempotent by slug; bad input refuses academy.role_invalid', async () => {
    const a = await store().createCustomRole({ slug: 'x', label: 'x', permissions: ['comments'], ...meta });
    const b = await store().createCustomRole({ slug: 'x', label: 'other', permissions: ['grade'], ...meta });
    expect(b).toEqual(a);
    await expect(store().createCustomRole({ slug: 'Bad', label: 'x', permissions: ['comments'], ...meta })).rejects.toMatchObject({
      code: 'academy.role_invalid',
    });
    await expect(store().createCustomRole({ slug: 'z', label: 'x', permissions: ['fly'], ...meta })).rejects.toMatchObject({
      code: 'academy.role_invalid',
    });
    await expect(store().createCustomRole({ slug: 'z', label: 'x', permissions: [], ...meta })).rejects.toMatchObject({
      code: 'academy.role_invalid',
    });
    await expect(
      store().createCustomRole({ slug: 'z', label: 'x', permissions: ['comments'], ...meta, reason: ' ' }),
    ).rejects.toMatchObject({
      code: 'academy.role_invalid',
    });
  });

  it('unknown role refuses academy.role_not_found', async () => {
    await expect(store().assign({ courseScope: COURSE, accountId: MEMBER, role: 'custom:nope', ...meta })).rejects.toMatchObject({
      code: 'academy.role_not_found',
    });
    await expect(store().setCustomRoleActive({ roleId: 'custom:nope', active: false, ...meta })).rejects.toMatchObject({
      code: 'academy.role_not_found',
    });
    await expect(store().revoke({ courseScope: COURSE, accountId: MEMBER, role: 'staff', ...meta })).rejects.toMatchObject({
      code: 'academy.role_not_found',
    });
  });

  it('a staff assigner cannot grant more than they hold (academy.role_escalation)', async () => {
    await store().assign({ courseScope: COURSE, accountId: MEMBER, role: 'limited_staff', ...meta });
    await expect(
      store().assign({ courseScope: COURSE, accountId: FOUNDER, role: 'admin', actor: MEMBER, approver: 'f2', reason: 'TEST' }),
    ).rejects.toMatchObject({ code: 'academy.role_escalation' });
    const ok = await store().assign({
      courseScope: COURSE,
      accountId: FOUNDER,
      role: 'limited_staff',
      actor: MEMBER,
      approver: 'f2',
      reason: 'TEST',
    });
    expect(ok.active).toBe(true);
  });

  it('assign and revoke are idempotent and re-assign bumps the activation; events appended once each', async () => {
    const a = { courseScope: COURSE, accountId: MEMBER, role: 'staff', ...meta };
    await store().assign(a);
    await store().assign(a);
    await store().revoke(a);
    const r2 = await store().revoke(a);
    expect(r2.active).toBe(false);
    const again = await store().assign(a);
    expect(again).toMatchObject({ active: true, activation: 1 });
    const keys = (await sql<Array<{ idempotency_key: string }>>`SELECT idempotency_key FROM academy.role_events ORDER BY at`).map(
      (r) => r.idempotency_key,
    );
    expect(keys).toEqual([`role:${COURSE}:${MEMBER}:staff`, `unrole:${COURSE}:${MEMBER}:staff:0`, `role:${COURSE}:${MEMBER}:staff:1`]);
  });
});

const SECRET = 'academy-roles-edge-secret-32-chars-x';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });
const approved: ActionApprovalConsumer = {
  consume: async () => ({ approverId: 'founder-2', requesterId: FOUNDER }) as unknown as ActionApproval,
};

function caller(scopes: string[], approvals?: ActionApprovalConsumer) {
  const p = {
    sub: FOUNDER,
    userId: FOUNDER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as unknown as Principal;
  const raw = encodePrincipal(p);
  const ctx = edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-roles',
  });
  return createAcademyRouter({} as AcademyService, {}, undefined, approvals, null, store()).createCaller(ctx);
}

describe('admin role doors', () => {
  const change = { courseScope: COURSE, accountId: MEMBER, role: 'staff', reason: 'TEST', approvalId: 'a', operationId: 'o' };

  it('one founder alone is refused until identity confirms a second founder', async () => {
    await expect(caller(['admin:write']).admin.assignRole(change)).rejects.toBeTruthy();
    expect(await store().holders(COURSE, 10)).toHaveLength(0);
  });

  it('with an identity approval the role is assigned and the permission query sees it', async () => {
    const h = await caller(['admin:write'], approved).admin.assignRole(change);
    expect(h.active).toBe(true);
    expect(
      (await caller(['admin:read']).admin.coursePermission({ accountId: MEMBER, courseScope: COURSE, permission: 'grade' })).allowed,
    ).toBe(true);
    const revoked = await caller(['admin:write'], approved).admin.revokeRole(change);
    expect(revoked.active).toBe(false);
  });

  it('roleHolders refuses a blank limit', async () => {
    await expect(caller(['admin:read']).admin.roleHolders({ courseScope: COURSE })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('academyRoles lists permissions, built-ins and custom roles', async () => {
    const out = await caller(['admin:read']).admin.academyRoles();
    expect(out.builtin.map((b) => b.id)).toContain('limited_staff');
    expect(out.permissions).toContain('refund');
    expect(out.custom).toEqual([]);
  });

  it('a learner session is refused', async () => {
    await expect(caller(['academy:read', 'academy:write'], approved).admin.assignRole(change)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
