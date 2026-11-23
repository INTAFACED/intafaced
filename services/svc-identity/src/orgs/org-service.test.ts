import { describe, expect, it } from 'vitest';
import {
  addOrgMember,
  assertOrgActor,
  assertOrgPlace,
  assertOrgRisk,
  createOrg,
  grantOrgRole,
  requireMemberId,
  requireOrgId,
  requireOrgRole,
} from './org-service.js';

type OrgRow = { id: string; name: string; created_by: string };
type MemberRow = { org_id: string; user_id: string; role: string };

function store(users: string[], orgs: OrgRow[], members: MemberRow[]) {
  let writes = 0;
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').toLowerCase();
    if (text.includes('insert into organizations')) {
      writes += 1;
      const id = String(values[0]);
      const name = String(values[1]);
      const createdBy = String(values[2]);
      const row = { id, name, created_by: createdBy };
      orgs.push(row);
      return [row];
    }
    if (text.includes('insert into organization_members')) {
      writes += 1;
      members.push({
        org_id: String(values[0]),
        user_id: String(values[1]),
        role: String(values[2]),
      });
      return [];
    }
    if (text.includes('update organization_members')) {
      writes += 1;
      const grant = String(values[0]);
      const orgId = String(values[1]);
      const userId = String(values[2]);
      const row = members.find((m) => m.org_id === orgId && m.user_id === userId);
      if (row) row.role = grant;
      return [];
    }
    if (text.includes('from organizations')) {
      const id = values[0];
      return orgs.filter((o) => o.id === id).map((o) => ({ id: o.id, name: o.name, created_by: o.created_by }));
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
  return Object.assign(fn, {
    get writes() {
      return writes;
    },
    orgs,
    members,
  }) as Parameters<typeof createOrg>[0] & { writes: number; orgs: OrgRow[]; members: MemberRow[] };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

describe('createOrg', () => {
  it('creates an org and seats the actor as admin', async () => {
    const sql = store([A], [], []);
    const out = await createOrg(sql, A, ' Desk Alpha ');
    expect(out.name).toBe('Desk Alpha');
    expect(out.createdBy).toBe(A);
    expect(sql.members).toEqual([{ org_id: out.id, user_id: A, role: 'admin' }]);
  });

  it('refuses a missing actor and does not write', async () => {
    const sql = store([A], [], []);
    await expect(createOrg(sql, undefined, 'Desk')).rejects.toMatchObject({ code: 'org.actor_id_required' });
    await expect(createOrg(sql, '   ', 'Desk')).rejects.toMatchObject({ code: 'org.actor_id_required' });
    expect(sql.writes).toBe(0);
  });
});

describe('addOrgMember', () => {
  it('lets an admin add a trader', async () => {
    const sql = store([A, C], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: 'admin' }]);
    await expect(addOrgMember(sql, A, ORG_A, C, 'trader')).resolves.toEqual({
      orgId: ORG_A,
      userId: C,
      role: 'trader',
    });
    expect(sql.members.some((m) => m.user_id === C && m.org_id === ORG_A && m.role === 'trader')).toBe(true);
  });

  it('lets an admin add an auditor', async () => {
    const sql = store([A, C], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: 'admin' }]);
    await expect(addOrgMember(sql, A, ORG_A, C, 'auditor')).resolves.toEqual({
      orgId: ORG_A,
      userId: C,
      role: 'auditor',
    });
  });

  it('lets an admin add a risk-manager', async () => {
    const sql = store([A, C], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: 'admin' }]);
    await expect(addOrgMember(sql, A, ORG_A, C, 'risk-manager')).resolves.toEqual({
      orgId: ORG_A,
      userId: C,
      role: 'risk-manager',
    });
  });

  it('refuses a trader adding a member and does not write', async () => {
    const sql = store(
      [A, B, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'trader' },
      ],
    );
    const before = sql.writes;
    await expect(addOrgMember(sql, B, ORG_A, C, 'trader')).rejects.toMatchObject({ code: 'org.not_admin' });
    expect(sql.writes).toBe(before);
    expect(sql.members.filter((m) => m.user_id === C)).toHaveLength(0);
  });

  it('refuses a risk-manager adding a member and does not write', async () => {
    const sql = store(
      [A, B, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'risk-manager' },
      ],
    );
    const before = sql.writes;
    await expect(addOrgMember(sql, B, ORG_A, C, 'trader')).rejects.toMatchObject({ code: 'org.not_admin' });
    expect(sql.writes).toBe(before);
    expect(sql.members.filter((m) => m.user_id === C)).toHaveLength(0);
  });

  it('refuses a single admin adding a second admin (four-eyes) and does not write', async () => {
    const sql = store([A, C], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: 'admin' }]);
    await expect(addOrgMember(sql, A, ORG_A, C, 'admin')).rejects.toMatchObject({
      code: 'org.second_approver_required',
    });
    await expect(addOrgMember(sql, A, ORG_A, C, 'admin', '  ')).rejects.toMatchObject({
      code: 'org.second_approver_required',
    });
    await expect(addOrgMember(sql, A, ORG_A, C, 'admin', A)).rejects.toMatchObject({ code: 'org.self_approval' });
    expect(sql.members.filter((m) => m.user_id === C)).toHaveLength(0);
    expect(sql.writes).toBe(0);
  });

  it('refuses a trader as the second admin approver and does not write', async () => {
    const sql = store(
      [A, B, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'trader' },
      ],
    );
    await expect(addOrgMember(sql, A, ORG_A, C, 'admin', B)).rejects.toMatchObject({
      code: 'org.second_approver_not_admin',
    });
    expect(sql.members.filter((m) => m.user_id === C)).toHaveLength(0);
  });

  it('lets two distinct admins add a third admin', async () => {
    const sql = store(
      [A, B, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'admin' },
      ],
    );
    await expect(addOrgMember(sql, A, ORG_A, C, 'admin', B)).resolves.toEqual({
      orgId: ORG_A,
      userId: C,
      role: 'admin',
    });
    expect(sql.members.some((m) => m.user_id === C && m.role === 'admin')).toBe(true);
  });

  it('refuses an auditor adding a member and does not write', async () => {
    const sql = store(
      [A, B, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'auditor' },
      ],
    );
    await expect(addOrgMember(sql, B, ORG_A, C, 'trader')).rejects.toMatchObject({ code: 'org.not_admin' });
    expect(sql.members.filter((m) => m.user_id === C)).toHaveLength(0);
  });

  it('refuses a missing role and does not write', async () => {
    const sql = store([A, C], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: 'admin' }]);
    await expect(addOrgMember(sql, A, ORG_A, C, undefined)).rejects.toMatchObject({ code: 'org.role_required' });
    await expect(addOrgMember(sql, A, ORG_A, C, '  ')).rejects.toMatchObject({ code: 'org.role_required' });
    expect(() => requireOrgRole(null)).toThrow(/org role is required/);
    expect(sql.writes).toBe(0);
  });

  it('refuses an unknown role and does not write', async () => {
    const sql = store([A, C], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: 'admin' }]);
    await expect(addOrgMember(sql, A, ORG_A, C, 'owner')).rejects.toMatchObject({ code: 'org.role_invalid' });
    await expect(addOrgMember(sql, A, ORG_A, C, 'member')).rejects.toMatchObject({ code: 'org.role_invalid' });
    expect(sql.writes).toBe(0);
  });

  it('refuses missing orgId or memberId and does not write', async () => {
    const sql = store([A, C], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: 'admin' }]);
    await expect(addOrgMember(sql, A, undefined, C, 'trader')).rejects.toMatchObject({ code: 'org.id_required' });
    await expect(addOrgMember(sql, A, '', C, 'trader')).rejects.toMatchObject({ code: 'org.id_required' });
    await expect(addOrgMember(sql, A, ORG_A, undefined, 'trader')).rejects.toMatchObject({ code: 'org.member_id_required' });
    await expect(addOrgMember(sql, A, ORG_A, '  ', 'trader')).rejects.toMatchObject({ code: 'org.member_id_required' });
    expect(() => requireOrgId(null)).toThrow(/orgId is required/);
    expect(() => requireMemberId(null)).toThrow(/memberId is required/);
    expect(sql.writes).toBe(0);
  });

  it('refuses a member of another org adding here', async () => {
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
    await expect(addOrgMember(sql, B, ORG_A, C, 'trader')).rejects.toMatchObject({ code: 'org.membership_denied' });
    expect(sql.writes).toBe(0);
    expect(sql.members.filter((m) => m.user_id === C)).toHaveLength(0);
  });
});

describe('assertOrgActor', () => {
  it('a trader of A cannot act as B', async () => {
    const sql = store(
      [A, B, C],
      [
        { id: ORG_A, name: 'A', created_by: A },
        { id: ORG_B, name: 'B', created_by: B },
      ],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: C, role: 'trader' },
        { org_id: ORG_B, user_id: B, role: 'admin' },
      ],
    );
    await expect(assertOrgActor(sql, C, ORG_A)).resolves.toEqual({ orgId: ORG_A, userId: C, role: 'trader' });
    await expect(assertOrgActor(sql, C, ORG_B)).rejects.toMatchObject({ code: 'org.membership_denied' });
    await expect(assertOrgActor(sql, C, undefined)).rejects.toMatchObject({ code: 'org.id_required' });
  });

  it('refuses a missing seat role', async () => {
    const sql = store([A], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: '' }]);
    await expect(assertOrgActor(sql, A, ORG_A)).rejects.toMatchObject({ code: 'org.role_required' });
  });
});

describe('assertOrgPlace', () => {
  it('lets admin and trader place; auditor cannot; missing role refuses', async () => {
    const sql = store(
      [A, B, C, D],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'trader' },
        { org_id: ORG_A, user_id: C, role: 'auditor' },
        { org_id: ORG_A, user_id: D, role: '' },
      ],
    );
    await expect(assertOrgPlace(sql, A, ORG_A)).resolves.toEqual({ orgId: ORG_A, userId: A, role: 'admin' });
    await expect(assertOrgPlace(sql, B, ORG_A)).resolves.toEqual({ orgId: ORG_A, userId: B, role: 'trader' });
    await expect(assertOrgPlace(sql, C, ORG_A)).rejects.toMatchObject({ code: 'org.place_denied' });
    await expect(assertOrgPlace(sql, D, ORG_A)).rejects.toMatchObject({ code: 'org.role_required' });
  });

  it('a trader of A cannot place as B', async () => {
    const sql = store(
      [A, B, C],
      [
        { id: ORG_A, name: 'A', created_by: A },
        { id: ORG_B, name: 'B', created_by: B },
      ],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: C, role: 'trader' },
        { org_id: ORG_B, user_id: B, role: 'admin' },
      ],
    );
    await expect(assertOrgPlace(sql, C, ORG_B)).rejects.toMatchObject({ code: 'org.membership_denied' });
  });

  it('refuses a risk-manager placing', async () => {
    const sql = store(
      [A, B],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'risk-manager' },
      ],
    );
    await expect(assertOrgPlace(sql, B, ORG_A)).rejects.toMatchObject({ code: 'org.place_denied' });
  });
});

describe('assertOrgRisk', () => {
  it('lets admin and risk-manager see risk; trader and auditor cannot', async () => {
    const sql = store(
      [A, B, C, D],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'risk-manager' },
        { org_id: ORG_A, user_id: C, role: 'trader' },
        { org_id: ORG_A, user_id: D, role: 'auditor' },
      ],
    );
    await expect(assertOrgRisk(sql, A, ORG_A)).resolves.toEqual({ orgId: ORG_A, userId: A, role: 'admin' });
    await expect(assertOrgRisk(sql, B, ORG_A)).resolves.toEqual({ orgId: ORG_A, userId: B, role: 'risk-manager' });
    await expect(assertOrgRisk(sql, C, ORG_A)).rejects.toMatchObject({ code: 'org.risk_denied' });
    await expect(assertOrgRisk(sql, D, ORG_A)).rejects.toMatchObject({ code: 'org.risk_denied' });
  });
});

describe('grantOrgRole', () => {
  it('refuses granting admin without a second distinct admin and does not write', async () => {
    const sql = store(
      [A, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: C, role: 'trader' },
      ],
    );
    const before = sql.writes;
    await expect(grantOrgRole(sql, A, ORG_A, C, 'admin')).rejects.toMatchObject({
      code: 'org.second_approver_required',
    });
    await expect(grantOrgRole(sql, A, ORG_A, C, 'admin', A)).rejects.toMatchObject({ code: 'org.self_approval' });
    expect(sql.writes).toBe(before);
    expect(sql.members.find((m) => m.user_id === C)?.role).toBe('trader');
  });

  it('lets two distinct admins grant admin to an existing trader', async () => {
    const sql = store(
      [A, B, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'admin' },
        { org_id: ORG_A, user_id: C, role: 'trader' },
      ],
    );
    await expect(grantOrgRole(sql, A, ORG_A, C, 'admin', B)).resolves.toEqual({
      orgId: ORG_A,
      userId: C,
      role: 'admin',
    });
    expect(sql.members.find((m) => m.user_id === C)?.role).toBe('admin');
  });

  it('lets an admin grant risk-manager without four-eyes', async () => {
    const sql = store(
      [A, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: C, role: 'trader' },
      ],
    );
    await expect(grantOrgRole(sql, A, ORG_A, C, 'risk-manager')).resolves.toEqual({
      orgId: ORG_A,
      userId: C,
      role: 'risk-manager',
    });
  });

  it('refuses a risk-manager granting a role', async () => {
    const sql = store(
      [A, B, C],
      [{ id: ORG_A, name: 'A', created_by: A }],
      [
        { org_id: ORG_A, user_id: A, role: 'admin' },
        { org_id: ORG_A, user_id: B, role: 'risk-manager' },
        { org_id: ORG_A, user_id: C, role: 'trader' },
      ],
    );
    await expect(grantOrgRole(sql, B, ORG_A, C, 'auditor')).rejects.toMatchObject({ code: 'org.not_admin' });
  });
});
