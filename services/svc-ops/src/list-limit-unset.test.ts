/**
 * Unit card — directory lists refuse unpublished page size (never invent 50)
 *
 * 1. Promise: omit / NaN / 0 throws ops.*_list_limit_unset. Owner-explicit 50
 *    still pages. Zod still caps 1..200.
 * 2. Break: contacts/team/projects/fundraising/structured/custody.list with no
 *    page size dumps every in-memory row.
 * 3. Done bar: unset throws OpsError ops.*_list_limit_unset; 50 is allowed
 * 4. Class N
 * 5. Paths: services/svc-ops/src/list-limit.ts, router.ts
 *
 * OpsService maps remain the in-process book — not recut here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  OPS_CONTACTS_LIST_LIMIT_UNSET,
  OPS_CUSTODY_LIST_LIMIT_UNSET,
  OPS_FUNDRAISING_CHAIN_UNWIRED,
  OPS_FUNDRAISING_LIST_LIMIT_UNSET,
  OPS_FUNDRAISING_MILESTONES_LIST_LIMIT_UNSET,
  OPS_IDENTITY_UNWIRED,
  OPS_PAYROLL_INVENT_FORBIDDEN,
  OPS_PROJECTS_LIST_LIMIT_UNSET,
  OPS_STRUCTURED_LIST_LIMIT_UNSET,
  OPS_SUPPORT_UNWIRED,
  OPS_TEAM_LIST_LIMIT_UNSET,
  OpsError,
} from './codes.js';
import { assertOpsListLimit, OPS_LIST_LIMIT_CAP } from './list-limit.js';
import { OpsService } from './ops-service.js';
import { createOpsRouter } from './router.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'a-ops-list-limit-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    // An operator's session: the desks below are `operatorProcedure`s.
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

async function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  const ctx = await edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
  // The live entitlement read reads this person as an operator.
  return { ...ctx, operatorAuthority: async () => 'operator' as const };
}

async function caller(ops = new OpsService()) {
  return createOpsRouter(ops).createCaller(await signed());
}

describe('assertOpsListLimit', () => {
  it('refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertOpsListLimit(undefined, OPS_CONTACTS_LIST_LIMIT_UNSET)).toThrow(OpsError);
    expect(() => assertOpsListLimit(null, OPS_CONTACTS_LIST_LIMIT_UNSET)).toThrow(OpsError);
    expect(() => assertOpsListLimit(Number.NaN, OPS_CONTACTS_LIST_LIMIT_UNSET)).toThrow(OpsError);
    expect(() => assertOpsListLimit(0, OPS_CONTACTS_LIST_LIMIT_UNSET)).toThrow(OpsError);
    try {
      assertOpsListLimit(undefined, OPS_CONTACTS_LIST_LIMIT_UNSET);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(OpsError);
      expect((e as OpsError).code).toBe(OPS_CONTACTS_LIST_LIMIT_UNSET);
      expect((e as OpsError).message).toMatch(/never invent 50/);
      expect((e as OpsError).message).not.toMatch(/default 50|50-row/i);
    }
  });

  it('owner-explicit 50 is allowed and caps at 200', () => {
    expect(assertOpsListLimit(50, OPS_CONTACTS_LIST_LIMIT_UNSET)).toBe(50);
    expect(assertOpsListLimit(1, OPS_CONTACTS_LIST_LIMIT_UNSET)).toBe(1);
    expect(assertOpsListLimit(OPS_LIST_LIMIT_CAP, OPS_CONTACTS_LIST_LIMIT_UNSET)).toBe(OPS_LIST_LIMIT_CAP);
    expect(assertOpsListLimit(OPS_LIST_LIMIT_CAP + 1, OPS_CONTACTS_LIST_LIMIT_UNSET)).toBe(OPS_LIST_LIMIT_CAP);
  });
});

describe('ops directory list limit unset refuse', () => {
  it('router does not dump maps when list doors omit limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-ops/src/router.ts'), 'utf8');
    expect(src).toContain('assertOpsListLimit(input?.limit, OPS_CONTACTS_LIST_LIMIT_UNSET)');
    expect(src).toContain('assertOpsListLimit(input?.limit, OPS_TEAM_LIST_LIMIT_UNSET)');
    expect(src).toContain('assertOpsListLimit(input?.limit, OPS_PROJECTS_LIST_LIMIT_UNSET)');
    expect(src).toContain('assertOpsListLimit(input?.limit, OPS_FUNDRAISING_LIST_LIMIT_UNSET)');
    expect(src).toContain('assertOpsListLimit(input?.limit, OPS_FUNDRAISING_MILESTONES_LIST_LIMIT_UNSET)');
    expect(src).toContain('assertOpsListLimit(input?.limit, OPS_STRUCTURED_LIST_LIMIT_UNSET)');
    expect(src).toContain('assertOpsListLimit(input?.limit, OPS_CUSTODY_LIST_LIMIT_UNSET)');
    expect(src).toContain('.slice(0, limit)');
    expect(src).toContain('limit: listLimitField');
    expect(src).not.toMatch(/\?\? 50/);
    expect(src).not.toMatch(/limit = 50/);
    expect(src).not.toContain('contacts: [...out.contacts]');
    expect(src).not.toContain('members: [...out.members]');
    expect(src).not.toContain('projects: [...out.projects]');
    expect(src).not.toContain('raises: [...out.raises]');
    expect(src).not.toContain('milestones: [...out.milestones]');
    expect(src).not.toContain('records: [...out.records]');
    expect(src).not.toContain('approvals: [...out.approvals]');
  });

  it('omit / empty input refuses PRECONDITION_FAILED on every directory dump', async () => {
    const api = await caller();
    await expect(api.contacts()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_CONTACTS_LIST_LIMIT_UNSET),
    });
    await expect(api.contacts({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('never invent 50'),
    });
    await expect(api.team()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_TEAM_LIST_LIMIT_UNSET),
    });
    await expect(api.projects.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_PROJECTS_LIST_LIMIT_UNSET),
    });
    await expect(api.fundraising.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_FUNDRAISING_LIST_LIMIT_UNSET),
    });
    await expect(api.fundraising.milestones()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_FUNDRAISING_MILESTONES_LIST_LIMIT_UNSET),
    });
    await expect(api.structured.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_STRUCTURED_LIST_LIMIT_UNSET),
    });
    await expect(api.custody.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_CUSTODY_LIST_LIMIT_UNSET),
    });
  });

  it('empty with an explicit limit is [] — empty is not failed', async () => {
    const api = await caller();
    expect((await api.contacts({ limit: 50 })).contacts).toEqual([]);
    expect((await api.team({ limit: 50 })).members).toEqual([]);
    expect((await api.projects.list({ limit: 50 })).projects).toEqual([]);
    expect((await api.fundraising.list({ limit: 50 })).raises).toEqual([]);
    expect((await api.fundraising.milestones({ limit: 50 })).milestones).toEqual([]);
    expect((await api.structured.list({ limit: 50 })).records).toEqual([]);
    expect((await api.custody.list({ limit: 50 })).approvals).toEqual([]);
  });

  it('sourced identity stays absent; payroll is not invented as contacts', async () => {
    const api = await caller();
    const listed = await api.contacts({ limit: 50 });
    expect(listed.identity).toEqual({ status: 'absent', code: OPS_IDENTITY_UNWIRED });
    expect(listed.support).toEqual({ status: 'absent', code: OPS_SUPPORT_UNWIRED });
    expect(listed.contacts).toEqual([]);

    const team = await api.team({ limit: 50 });
    expect(team.identity).toEqual({ status: 'absent', code: OPS_IDENTITY_UNWIRED });
    expect(team.payroll).toEqual({ forbidden: true, code: OPS_PAYROLL_INVENT_FORBIDDEN });
    expect(team.members).toEqual([]);
  });

  it('owner-explicit 50 pages; limit 1 slices; custody pages approvals only', async () => {
    let n = 0;
    const api = await caller(
      new OpsService({
        id: () => `id-${++n}`,
        warehouseEnv: { STRUCTURED_OWNER_PRICE: 'owner-published' },
        custodyFreezePolicy: 'open',
      }),
    );

    await api.createContact({ displayName: 'Ada' });
    await api.createContact({ displayName: 'Bob' });
    expect((await api.contacts({ limit: 1 })).contacts).toHaveLength(1);
    expect((await api.contacts({ limit: 50 })).contacts).toHaveLength(2);

    await api.createTeamMember({ handle: 'ada' });
    await api.createTeamMember({ handle: 'bob' });
    expect((await api.team({ limit: 1 })).members).toHaveLength(1);
    expect((await api.team({ limit: 50 })).members).toHaveLength(2);

    await api.projects.create({ title: 'One' });
    await api.projects.create({ title: 'Two' });
    expect((await api.projects.list({ limit: 1 })).projects).toHaveLength(1);
    expect((await api.projects.list({ limit: 50 })).projects).toHaveLength(2);

    await api.fundraising.create({ name: 'Seed', milestoneLabels: ['legal', 'product'] });
    await api.fundraising.create({ name: 'Friends' });
    expect((await api.fundraising.list({ limit: 1 })).raises).toHaveLength(1);
    expect((await api.fundraising.list({ limit: 50 })).raises).toHaveLength(2);
    expect((await api.fundraising.milestones({ limit: 1 })).milestones).toHaveLength(1);
    expect((await api.fundraising.milestones({ limit: 50 })).milestones).toHaveLength(2);

    await expect(api.fundraising.fund({ raiseId: 'id-1', amount: '100' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_FUNDRAISING_CHAIN_UNWIRED),
    });

    await api.structured.create({ name: 'Note A', legLabels: ['principal'] });
    await api.structured.create({ name: 'Note B', legLabels: ['coupon'] });
    expect((await api.structured.list({ limit: 1 })).records).toHaveLength(1);
    expect((await api.structured.list({ limit: 50 })).records).toHaveLength(2);

    await api.custody.createApproval({ fromTier: 'cold', toTier: 'warm', amount: '10.25' });
    await api.custody.createApproval({ fromTier: 'warm', toTier: 'hot', amount: '1.00' });
    const page = await api.custody.list({ limit: 1 });
    expect(page.approvals).toHaveLength(1);
    expect(page.tiers.map((t) => t.id)).toEqual(['cold', 'warm', 'hot']);
    expect(page.tiers.every((t) => t.keys.length === 0)).toBe(true);
    expect((await api.custody.list({ limit: 50 })).approvals).toHaveLength(2);
  });
});
