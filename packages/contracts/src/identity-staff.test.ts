import { describe, expect, it } from 'vitest';
import {
  IDENTITY_STAFF_ACTION_TYPES,
  IDENTITY_STAFF_REFUSAL_CODES,
  readStaffInvite,
  staffAccessSchema,
  staffChangeApprovalSubject,
  staffChangeResultSchema,
  staffDisableInputSchema,
  staffEntrySchema,
  staffInviteInputSchema,
  staffListInputSchema,
  staffListSchema,
  staffPermissionSchema,
  staffRemoveInputSchema,
  staffRoleAssignInputSchema,
  staffRoleDefineInputSchema,
  staffRoleSchema,
  staffRoleUnassignInputSchema,
  staffRolesListSchema,
} from './identity-staff.js';

const NOW = '2026-10-31T12:00:00.000Z';
const HASH = `sha256:${'a'.repeat(64)}`;
const approval = { approvalId: 'appr-1', payloadHash: HASH };

const entry = {
  staffId: 'staff-1',
  userId: 'user-1',
  displayName: 'Ada Example',
  email: 'ada@example.test',
  status: 'active',
  roleIds: ['role-1'],
  lastSignInAt: NOW,
  invitedAt: NOW,
  invitedBy: 'staff-0',
  activatedAt: NOW,
  disabledAt: null,
  version: '3',
} as const;

const invite = { requestId: 'invite:ada@example.test', email: 'ada@example.test', displayName: 'Ada Example', roleIds: [], approval };

describe('refusal codes', () => {
  it('lists exactly the slice codes and leaves identity.idp_unset for a later slice', () => {
    expect([...IDENTITY_STAFF_REFUSAL_CODES]).toEqual([
      'identity.staff_invite_open_link_refused',
      'identity.role_grant_exceeds_holder',
      'identity.permission_denied_explicit',
      'identity.staff_last_founder',
      'identity.staff_not_invited',
      'identity.role_mapping_unset',
      'identity.business_user_not_staff',
      'action_approval.policy_unset',
    ]);
    expect(IDENTITY_STAFF_REFUSAL_CODES).not.toContain('identity.idp_unset');
  });
});

describe('staff permission schema', () => {
  it('accepts a catalogue permission and refuses anything malformed', () => {
    expect(staffPermissionSchema.safeParse('staff:ledger:approve:production').success).toBe(true);
    for (const bad of ['staff:ledger:approve', 'staff:ledger:approve:prod', 'admin:write', 'staff:*:read:local', 1, null]) {
      expect(staffPermissionSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe('staff roster', () => {
  it('carries last sign-in and status, and nothing secret', () => {
    expect(staffEntrySchema.safeParse(entry).success).toBe(true);
    expect(staffEntrySchema.safeParse({ ...entry, status: 'invited', lastSignInAt: null, activatedAt: null }).success).toBe(true);
    expect(staffEntrySchema.safeParse({ ...entry, status: 'removed' }).success).toBe(false);
    for (const secret of ['password', 'passwordHash', 'totpSecret', 'token', 'recoveryCodes']) {
      expect(staffEntrySchema.safeParse({ ...entry, [secret]: 'x' }).success, secret).toBe(false);
    }
  });

  it('lists an empty roster honestly and bounds the page', () => {
    expect(staffListSchema.safeParse({ staff: [], nextCursor: null, asOf: NOW }).success).toBe(true);
    expect(staffListInputSchema.safeParse({ limit: 50, status: 'disabled' }).success).toBe(true);
    expect(staffListInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(staffListInputSchema.safeParse({ limit: 500 }).success).toBe(false);
  });
});

describe('invite', () => {
  it('invites one named person with an approval reference', () => {
    expect(staffInviteInputSchema.safeParse(invite).success).toBe(true);
    const read = readStaffInvite(invite);
    expect(read.ok).toBe(true);
  });

  it('refuses an open link', () => {
    for (const raw of [
      { ...invite, openLink: true },
      { ...invite, link: 'https://example.test/join' },
      { requestId: invite.requestId, roleIds: ['role-1'], approval },
      { ...invite, email: '' },
      { ...invite, displayName: '   ' },
    ]) {
      expect(readStaffInvite(raw)).toEqual({ ok: false, code: 'identity.staff_invite_open_link_refused' });
    }
  });

  it('refuses an invite without an approval bound to a payload hash', () => {
    const { approval: _a, ...noApproval } = invite;
    expect(staffInviteInputSchema.safeParse(noApproval).success).toBe(false);
    expect(staffInviteInputSchema.safeParse({ ...invite, approval: { approvalId: 'appr-1' } }).success).toBe(false);
    expect(staffInviteInputSchema.safeParse({ ...invite, approval: { ...approval, payloadHash: 'abc' } }).success).toBe(false);
    expect(staffInviteInputSchema.safeParse({ ...invite, password: 'hunter2' }).success).toBe(false);
  });
});

describe('every privileged change carries an approval reference', () => {
  const disable = { requestId: 'disable:staff-1:3', staffId: 'staff-1', reason: 'Left the team', expectedVersion: '3', approval };
  const assign = { requestId: 'assign:staff-1:role-1:3', staffId: 'staff-1', roleId: 'role-1', expectedVersion: '3', approval };
  const define = { requestId: 'define:ops-read', name: 'Ops read', allow: ['staff:accounts:read:production'], deny: [], approval };
  const cases = [
    [staffInviteInputSchema, invite],
    [staffDisableInputSchema, disable],
    [staffRemoveInputSchema, disable],
    [staffRoleDefineInputSchema, define],
    [staffRoleAssignInputSchema, assign],
    [staffRoleUnassignInputSchema, assign],
  ] as const;

  it('accepts each with one and refuses each without', () => {
    for (const [schema, body] of cases) {
      expect(schema.safeParse(body).success).toBe(true);
      const { approval: _a, ...rest } = body;
      expect(schema.safeParse(rest).success).toBe(false);
    }
  });

  it('names one action type per verb, all on svc-identity', () => {
    expect([...IDENTITY_STAFF_ACTION_TYPES]).toEqual([
      'identity.staff.invite',
      'identity.staff.disable',
      'identity.staff.remove',
      'identity.roles.define',
      'identity.roles.assign',
      'identity.roles.unassign',
    ]);
    const { approval: _a, ...rest } = assign;
    const subject = staffChangeApprovalSubject({ action: 'identity.roles.assign', input: rest });
    expect(subject).toEqual({
      actionType: 'identity.roles.assign',
      targetService: 'svc-identity',
      targetId: 'staff:staff-1',
      fields: { staffId: 'staff-1', roleId: 'role-1', expectedVersion: '3' },
    });
  });

  it('binds the same role grant to the same fields whatever the list order', () => {
    const { approval: _a, ...a } = { ...define, allow: ['staff:cards:read:local', 'staff:accounts:read:local'] };
    const b = { ...a, allow: ['staff:accounts:read:local', 'staff:cards:read:local'] };
    const parsedA = staffRoleDefineInputSchema.parse({ ...a, approval });
    const parsedB = staffRoleDefineInputSchema.parse({ ...b, approval });
    const { approval: _x, ...inA } = parsedA;
    const { approval: _y, ...inB } = parsedB;
    expect(staffChangeApprovalSubject({ action: 'identity.roles.define', input: inA })).toEqual(
      staffChangeApprovalSubject({ action: 'identity.roles.define', input: inB }),
    );
  });
});

describe('define (custom roles only)', () => {
  const define = { requestId: 'define:ops-read', name: 'Ops read', allow: ['staff:accounts:read:production'], deny: [], approval };

  it('refuses a built-in name, a kind field, a malformed or repeated permission, and an empty role', () => {
    expect(staffRoleDefineInputSchema.safeParse({ ...define, name: 'Founder' }).success).toBe(false);
    expect(staffRoleDefineInputSchema.safeParse({ ...define, kind: 'builtin' }).success).toBe(false);
    expect(staffRoleDefineInputSchema.safeParse({ ...define, allow: ['staff:accounts:all:production'] }).success).toBe(false);
    expect(
      staffRoleDefineInputSchema.safeParse({ ...define, allow: ['staff:accounts:read:production', 'staff:accounts:read:production'] })
        .success,
    ).toBe(false);
    expect(staffRoleDefineInputSchema.safeParse({ ...define, allow: [], deny: [] }).success).toBe(false);
  });

  it('redefines only with roleId and expectedVersion together', () => {
    expect(staffRoleDefineInputSchema.safeParse({ ...define, roleId: 'role-9', expectedVersion: '2' }).success).toBe(true);
    expect(staffRoleDefineInputSchema.safeParse({ ...define, roleId: 'role-9' }).success).toBe(false);
    expect(staffRoleDefineInputSchema.safeParse({ ...define, expectedVersion: '2' }).success).toBe(false);
  });
});

describe('roles list', () => {
  it('shows a built-in role with no mapping as unset, never with invented permissions', () => {
    const unset = {
      roleId: 'builtin:founder',
      name: 'founder',
      version: '0',
      kind: 'builtin',
      state: 'mapping_unset',
      code: 'identity.role_mapping_unset',
    };
    expect(staffRoleSchema.safeParse(unset).success).toBe(true);
    expect(staffRoleSchema.safeParse({ ...unset, allow: ['staff:accounts:read:production'] }).success).toBe(false);
    expect(staffRoleSchema.safeParse({ ...unset, name: 'superuser' }).success).toBe(false);
    const custom = {
      roleId: 'role-1',
      name: 'Ops read',
      version: '1',
      kind: 'custom',
      state: 'defined',
      allow: ['staff:accounts:read:production'],
      deny: [],
    };
    expect(staffRolesListSchema.safeParse({ roles: [unset, custom], asOf: NOW }).success).toBe(true);
  });
});

describe('change result', () => {
  const audit = {
    auditId: 'audit-1',
    requestId: 'assign:staff-1:role-1:3',
    action: 'identity.roles.assign',
    actorId: 'staff-0',
    occurredAt: NOW,
  };

  it('refuses with one listed code and no state', () => {
    for (const code of IDENTITY_STAFF_REFUSAL_CODES) {
      expect(staffChangeResultSchema.safeParse({ ...audit, outcome: 'refused', code, detail: [] }).success, code).toBe(true);
    }
    expect(staffChangeResultSchema.safeParse({ ...audit, outcome: 'refused', code: 'identity.idp_unset', detail: [] }).success).toBe(false);
    expect(
      staffChangeResultSchema.safeParse({ ...audit, outcome: 'refused', code: 'identity.staff_last_founder', detail: [], staff: entry })
        .success,
    ).toBe(false);
  });

  it('a change names the approver whose approval was spent', () => {
    expect(
      staffChangeResultSchema.safeParse({ ...audit, outcome: 'changed', approverId: 'staff-2', staff: entry, role: null }).success,
    ).toBe(true);
    expect(staffChangeResultSchema.safeParse({ ...audit, outcome: 'changed', staff: entry, role: null }).success).toBe(false);
  });
});

describe('access overview', () => {
  it('lists every permission with its source role, or the deny that removed it', () => {
    const view = {
      staffId: 'staff-1',
      status: 'active',
      roles: [],
      permissions: [
        { permission: 'staff:accounts:read:production', state: 'allowed', sourceRoleIds: ['role-1'] },
        { permission: 'staff:ledger:apply:production', state: 'denied_explicit', sourceRoleIds: ['role-1'], deniedByRoleIds: ['role-2'] },
      ],
      asOf: NOW,
    };
    expect(staffAccessSchema.safeParse(view).success).toBe(true);
    const noSource = { ...view, permissions: [{ permission: 'staff:accounts:read:production', state: 'allowed', sourceRoleIds: [] }] };
    expect(staffAccessSchema.safeParse(noSource).success).toBe(false);
    const noDenier = {
      ...view,
      permissions: [{ permission: 'staff:ledger:apply:production', state: 'denied_explicit', sourceRoleIds: [], deniedByRoleIds: [] }],
    };
    expect(staffAccessSchema.safeParse(noDenier).success).toBe(false);
  });
});
