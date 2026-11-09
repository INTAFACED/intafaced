import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  developerTeam,
  DeveloperTeamError,
  manageRefusalOf,
  parseDeveloperRoles,
  revokeOrgKey,
  setDeveloperRole,
} from './developer-team.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const KEY = '44444444-4444-4444-8444-444444444444';
const BOTH = ['keys_admin', 'keys_read'] as const;

function fakeSql(queue: unknown[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return queue[calls.length - 1] ?? [];
  };
  const sql = Object.assign(fn, {
    unsafe: (text: string) => text,
    begin: async (run: (tx: unknown) => unknown) => run(sql),
  });
  return { sql: sql as unknown as Sql, calls };
}

const seat = (orgRole: string, developerRole: string | null) => [
  { org_role: orgRole, developer_role: developerRole, org_name: 'Acme TEST' },
];
const keyRow = (revoked = false) => ({
  id: KEY,
  name: 'org-key',
  key_prefix: 'ifc_abc',
  mode: 'live',
  scopes: ['trade:read'],
  ip_allowlist: null,
  require_signature: false,
  created_at: new Date('2026-11-09T14:00:00.000Z'),
  expires_at: null,
  last_used_at: null,
  revoked,
  revoked_at: revoked ? new Date('2026-11-09T14:05:00.000Z') : null,
  revoked_cause: revoked ? 'owner' : null,
  revoke_reason: null,
  account_id: null,
  kind: 'personal',
});

describe('parseDeveloperRoles (the owner value IDENTITY_DEVELOPER_ROLES)', () => {
  it('blank is roles not set, never a default', () => {
    expect(parseDeveloperRoles(undefined)).toBeNull();
    expect(parseDeveloperRoles('  ')).toBeNull();
  });
  it('reads the published roles', () => {
    expect(parseDeveloperRoles('keys_admin, keys_read')).toEqual(['keys_admin', 'keys_read']);
    expect(parseDeveloperRoles('keys_read')).toEqual(['keys_read']);
  });
  it('an unknown or repeated role stops the service', () => {
    expect(() => parseDeveloperRoles('keys_admin,owner')).toThrow(/IDENTITY_DEVELOPER_ROLES/);
    expect(() => parseDeveloperRoles('keys_read,keys_read')).toThrow(/IDENTITY_DEVELOPER_ROLES/);
  });
});

describe('manageRefusalOf (who may create and revoke an organisation key)', () => {
  const s = (orgRole: string, developerRole: 'keys_admin' | 'keys_read' | null) => ({ orgRole, developerRole, orgName: 'x' });
  it('the owner always may, roles set or not', () => {
    expect(manageRefusalOf(s('admin', null), null)).toBeNull();
    expect(manageRefusalOf(s('admin', null), BOTH)).toBeNull();
  });
  it('with roles not set, no member may', () => {
    expect(manageRefusalOf(s('trader', 'keys_admin'), null)).toBe('identity.developer_roles_unset');
  });
  it('a read role sees but may not change; no role may not either', () => {
    expect(manageRefusalOf(s('trader', 'keys_read'), BOTH)).toBe('identity.developer_role_read_only');
    expect(manageRefusalOf(s('trader', null), BOTH)).toBe('identity.developer_role_none');
    expect(manageRefusalOf(s('trader', 'keys_admin'), BOTH)).toBeNull();
  });
  it('a role the owner no longer publishes gives no authority', () => {
    expect(manageRefusalOf(s('trader', 'keys_admin'), ['keys_read'])).toBe('identity.developer_role_none');
  });
});

describe('developerTeam (the key page in an organisation)', () => {
  it('a read-role member sees the keys, no members, and why they may not change them', async () => {
    const { sql } = fakeSql([seat('trader', 'keys_read'), [keyRow()]]);
    const team = await developerTeam(sql, ORG, MEMBER, BOTH);
    expect(team.myRole).toBe('keys_read');
    expect(team.manageRefusal).toBe('identity.developer_role_read_only');
    expect(team.keys.map((k) => k.id)).toEqual([KEY]);
    expect(team.members).toEqual([]);
  });
  it('with roles not set the member sees roles not set and no keys', async () => {
    const { sql, calls } = fakeSql([seat('trader', 'keys_read')]);
    const team = await developerTeam(sql, ORG, MEMBER, null);
    expect(team.rolesPublished).toBeNull();
    expect(team.myRole).toBeNull();
    expect(team.manageRefusal).toBe('identity.developer_roles_unset');
    expect(team.keys).toEqual([]);
    expect(calls).toHaveLength(1);
  });
  it('a non-member is refused as if the organisation did not exist', async () => {
    const { sql } = fakeSql([[]]);
    await expect(developerTeam(sql, ORG, MEMBER, BOTH)).rejects.toMatchObject({ code: 'identity.developer_org_denied' });
  });
});

describe('setDeveloperRole (the owner changes a role)', () => {
  const input = { orgId: ORG, userId: MEMBER, role: 'keys_admin' as const, requestId: 'role-change-0001' };
  it('a member cannot raise a role, theirs or anyone’s', async () => {
    const { sql, calls } = fakeSql([seat('trader', 'keys_read')]);
    await expect(setDeveloperRole(sql, MEMBER, input, BOTH)).rejects.toMatchObject({ code: 'identity.developer_role_denied' });
    expect(calls).toHaveLength(1);
  });
  it('with roles not set the owner’s change refuses', async () => {
    const { sql } = fakeSql([seat('admin', null)]);
    await expect(setDeveloperRole(sql, OWNER, input, null)).rejects.toMatchObject({ code: 'identity.developer_roles_unset' });
  });
  it('a role the owner did not publish refuses', async () => {
    const { sql } = fakeSql([seat('admin', null)]);
    await expect(setDeveloperRole(sql, OWNER, input, ['keys_read'])).rejects.toMatchObject({ code: 'identity.developer_role_unknown' });
  });
  it('the owner sets the role once; a repeat of the request id changes nothing', async () => {
    const first = fakeSql([seat('admin', null), [], [{ ok: 1 }], [{ ok: 1 }], []]);
    await expect(setDeveloperRole(first.sql, OWNER, input, BOTH)).resolves.toEqual({ userId: MEMBER, role: 'keys_admin', changed: true });
    expect(first.calls.some((c) => c.text.includes('INSERT INTO org_developer_roles'))).toBe(true);
    const again = fakeSql([seat('admin', null), [{ user_id: MEMBER, role: 'keys_admin' }]]);
    await expect(setDeveloperRole(again.sql, OWNER, input, BOTH)).resolves.toEqual({ userId: MEMBER, role: 'keys_admin', changed: false });
    expect(again.calls).toHaveLength(2);
  });
  it('the same request id for a different change refuses', async () => {
    const { sql } = fakeSql([seat('admin', null), [{ user_id: MEMBER, role: 'keys_read' }]]);
    await expect(setDeveloperRole(sql, OWNER, input, BOTH)).rejects.toMatchObject({ code: 'identity.developer_request_conflict' });
  });
  it('someone outside the organisation cannot be given a role', async () => {
    const { sql } = fakeSql([seat('admin', null), [], []]);
    await expect(setDeveloperRole(sql, OWNER, input, BOTH)).rejects.toMatchObject({ code: 'identity.developer_member_unknown' });
  });
});

describe('revokeOrgKey', () => {
  it('a read-role member is refused before any key is read', async () => {
    const { sql, calls } = fakeSql([seat('trader', 'keys_read')]);
    await expect(revokeOrgKey(sql, ORG, MEMBER, KEY, null, BOTH)).rejects.toBeInstanceOf(DeveloperTeamError);
    expect(calls).toHaveLength(1);
  });
  it('a key admin revokes the organisation key', async () => {
    const { sql } = fakeSql([seat('trader', 'keys_admin'), [keyRow()], [keyRow(true)]]);
    const out = await revokeOrgKey(sql, ORG, MEMBER, KEY, null, BOTH);
    expect(out?.changed).toBe(true);
    expect(out?.row.revoked).toBe(true);
  });
  it('a key outside the organisation is not found', async () => {
    const { sql } = fakeSql([seat('admin', null), []]);
    await expect(revokeOrgKey(sql, ORG, OWNER, KEY, null, BOTH)).resolves.toBeNull();
  });
});
