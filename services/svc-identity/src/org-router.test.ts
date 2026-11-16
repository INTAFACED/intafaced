import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createOrgRouter } from './org-router.js';
import { addOrgMember, assertOrgActor, assertOrgPlace, createOrg } from './orgs/org-service.js';

const authConfig = {
  secret: 'an-identity-org-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SESSION = '44444444-4444-4444-8444-444444444444';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken(
    {
      userId,
      sessionId: SESSION,
      scopes,
      tier: 'none',
      mfa: true,
    },
    authConfig,
  );
  return {
    principal: await verifyAccessToken(token, authConfig),
    service: null,
    region: 'DE',
    requestId: 'req-org-1',
  };
}

type OrgRow = { id: string; name: string; created_by: string };
type MemberRow = { org_id: string; user_id: string; role: string };

function store(users: string[], orgs: OrgRow[], members: MemberRow[]) {
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').toLowerCase();
    if (text.includes('insert into organizations')) {
      const id = String(values[0]);
      const name = String(values[1]);
      const createdBy = String(values[2]);
      const row = { id, name, created_by: createdBy };
      orgs.push(row);
      return [row];
    }
    if (text.includes('insert into organization_members')) {
      members.push({
        org_id: String(values[0]),
        user_id: String(values[1]),
        role: String(values[2]),
      });
      return [];
    }
    if (text.includes('update organization_members')) {
      const grant = String(values[0]);
      const orgId = String(values[1]);
      const userId = String(values[2]);
      const row = members.find((m) => m.org_id === orgId && m.user_id === userId);
      if (row) row.role = grant;
      return [];
    }
    if (text.includes('from organizations')) {
      const id = values[0];
      return orgs.filter((o) => o.id === id).map((o) => ({ id: o.id }));
    }
    if (text.includes('from organization_members') && text.includes('role')) {
      const orgId = values[0];
      const userId = values[1];
      return members.filter((m) => m.org_id === orgId && m.user_id === userId).map((m) => ({ role: m.role }));
    }
    if (text.includes('from organization_members')) {
      const orgId = values[0];
      const userId = values[1];
      return members.filter((m) => m.org_id === orgId && m.user_id === userId).map((m) => ({ user_id: m.user_id }));
    }
    if (text.includes('from users')) {
      const id = values[0];
      return users.filter((u) => u === id).map((u) => ({ id: u }));
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return fn as Parameters<typeof createOrg>[0];
}

const codeOf = (err: unknown) => (err as { code?: string }).code;

describe('org router', () => {
  it('create, add trader, member of A cannot act as B; missing ids/role refuse', async () => {
    const sql = store(
      [A, B, C],
      [
        { id: ORG_A, name: 'A', created_by: A },
        { id: ORG_B, name: 'B', created_by: B },
      ],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_B, user_id: B, role: 'admin' },
      ],
    );
    const r = createOrgRouter(sql);
    const ownerA = r.createCaller(await ctx(A, ['identity:write']));
    const memberC = r.createCaller(await ctx(C, ['identity:write']));
    const ownerB = r.createCaller(await ctx(B, ['identity:write']));

    const created = await ownerA.createOrg({ name: 'Desk C' });
    expect(created.createdBy).toBe(A);

    await expect(ownerA.addOrgMember({ orgId: ORG_A, memberId: C, role: 'trader' })).resolves.toEqual({
      orgId: ORG_A,
      userId: C,
      role: 'trader',
    });

    await expect(memberC.assertOrgActor({ orgId: ORG_A })).resolves.toMatchObject({
      orgId: ORG_A,
      userId: C,
      role: 'trader',
    });
    await expect(memberC.assertOrgPlace({ orgId: ORG_A })).resolves.toMatchObject({
      orgId: ORG_A,
      userId: C,
      role: 'trader',
    });
    const cross = await memberC.assertOrgActor({ orgId: ORG_B }).catch((e: unknown) => e);
    expect(codeOf(cross)).toBe('FORBIDDEN');

    const steal = await ownerB.addOrgMember({ orgId: ORG_A, memberId: C, role: 'trader' }).catch((e: unknown) => e);
    expect(codeOf(steal)).toBe('FORBIDDEN');

    const missingOrg = await ownerA.addOrgMember({ orgId: '', memberId: C, role: 'trader' } as never).catch((e: unknown) => e);
    expect(codeOf(missingOrg)).toBe('BAD_REQUEST');
    const missingMember = await ownerA.addOrgMember({ orgId: ORG_A, memberId: '', role: 'trader' } as never).catch((e: unknown) => e);
    expect(codeOf(missingMember)).toBe('BAD_REQUEST');
    const missingRole = await ownerA.addOrgMember({ orgId: ORG_A, memberId: C } as never).catch((e: unknown) => e);
    expect(codeOf(missingRole)).toBe('BAD_REQUEST');
  });

  it('trader cannot add members; auditor cannot place', async () => {
    const sql = store(
      [A, B, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'trader' },
        { org_id: ORG_A, user_id: C, role: 'auditor' },
      ],
    );
    const r = createOrgRouter(sql);
    const trader = r.createCaller(await ctx(B, ['identity:write']));
    const auditor = r.createCaller(await ctx(C, ['identity:write']));

    const add = await trader.addOrgMember({ orgId: ORG_A, memberId: C, role: 'trader' }).catch((e: unknown) => e);
    expect(codeOf(add)).toBe('FORBIDDEN');

    const place = await auditor.assertOrgPlace({ orgId: ORG_A }).catch((e: unknown) => e);
    expect(codeOf(place)).toBe('FORBIDDEN');
  });

  it('risk-manager can see risk, cannot place, cannot add members', async () => {
    const sql = store(
      [A, B, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'risk-manager' },
        { org_id: ORG_A, user_id: C, role: 'trader' },
      ],
    );
    const r = createOrgRouter(sql);
    const risk = r.createCaller(await ctx(B, ['identity:write']));
    const trader = r.createCaller(await ctx(C, ['identity:write']));

    await expect(risk.assertOrgRisk({ orgId: ORG_A })).resolves.toMatchObject({
      orgId: ORG_A,
      userId: B,
      role: 'risk-manager',
    });
    const place = await risk.assertOrgPlace({ orgId: ORG_A }).catch((e: unknown) => e);
    expect(codeOf(place)).toBe('FORBIDDEN');
    const add = await risk.addOrgMember({ orgId: ORG_A, memberId: C, role: 'trader' }).catch((e: unknown) => e);
    expect(codeOf(add)).toBe('FORBIDDEN');
    const traderRisk = await trader.assertOrgRisk({ orgId: ORG_A }).catch((e: unknown) => e);
    expect(codeOf(traderRisk)).toBe('FORBIDDEN');
  });

  it('adding a second admin without a distinct admin approver is FORBIDDEN', async () => {
    const sql = store(
      [A, B, C, D],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'trader' },
      ],
    );
    const r = createOrgRouter(sql);
    const owner = r.createCaller(await ctx(A, ['identity:write']));

    const missing = await owner.addOrgMember({ orgId: ORG_A, memberId: C, role: 'admin' }).catch((e: unknown) => e);
    expect(codeOf(missing)).toBe('FORBIDDEN');
    const self = await owner.addOrgMember({ orgId: ORG_A, memberId: C, role: 'admin', secondApproverId: A }).catch((e: unknown) => e);
    expect(codeOf(self)).toBe('FORBIDDEN');
    const traderEyes = await owner.addOrgMember({ orgId: ORG_A, memberId: C, role: 'admin', secondApproverId: B }).catch((e: unknown) => e);
    expect(codeOf(traderEyes)).toBe('FORBIDDEN');
    const grantMissing = await owner.grantOrgRole({ orgId: ORG_A, memberId: B, role: 'admin' }).catch((e: unknown) => e);
    expect(codeOf(grantMissing)).toBe('FORBIDDEN');
  });

  it('two distinct admins can add a third admin', async () => {
    const sql = store(
      [A, B, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'admin' },
      ],
    );
    const owner = createOrgRouter(sql).createCaller(await ctx(A, ['identity:write']));
    await expect(owner.addOrgMember({ orgId: ORG_A, memberId: C, role: 'admin', secondApproverId: B })).resolves.toEqual({
      orgId: ORG_A,
      userId: C,
      role: 'admin',
    });
  });

  it('refuses identity:read on write doors', async () => {
    const sql = store([A], [], []);
    const api = createOrgRouter(sql).createCaller(await ctx(A, ['identity:read']));
    const err = await api.createOrg({ name: 'Desk' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
  });

  it('createDmaHierarchyProduct refuses until owner law; org roles unchanged', async () => {
    const sql = store([A], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: 'admin' }]);
    const owner = createOrgRouter(sql).createCaller(await ctx(A, ['identity:write']));
    for (const kind of ['dma-broker', 'desk', 'shift'] as const) {
      const err = await owner.createDmaHierarchyProduct({ orgId: ORG_A, kind }).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('PRECONDITION_FAILED');
      expect(String((err as { message?: string }).message)).toMatch(/identity\.dma\.hierarchy_law_unset|owner-set DMA hierarchy law/);
    }
    await expect(owner.assertOrgActor({ orgId: ORG_A })).resolves.toEqual({ orgId: ORG_A, userId: A, role: 'admin' });
  });
});

describe('org service helpers stay wired to the router store', () => {
  it('createOrg on the same fake sql as the router', async () => {
    const sql = store([A], [], []);
    const org = await createOrg(sql, A, 'Desk');
    await expect(assertOrgActor(sql, A, org.id)).resolves.toMatchObject({ role: 'admin' });
    await expect(assertOrgPlace(sql, A, org.id)).resolves.toMatchObject({ role: 'admin' });
    await expect(addOrgMember(sql, A, org.id, B, 'trader')).rejects.toMatchObject({ code: 'org.member_not_found' });
  });
});

describe('org door is mounted', () => {
  it('index.ts mergeRouters includes createOrgRouter', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
    expect(src).toMatch(/createOrgRouter\(sql,\s*dmaHierarchyLaw\)/);
    expect(src).toMatch(/parseDmaHierarchyLawJson/);
  });
});
