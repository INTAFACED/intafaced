import { describe, expect, it } from 'vitest';
import {
  BUILTIN_STAFF_ROLE_MAPPINGS,
  BUILTIN_STAFF_ROLE_NAMES,
  STAFF_AREAS,
  STAFF_ENVS,
  STAFF_PERMISSIONS,
  STAFF_VERBS,
  StaffPermissionError,
  assertGrantWithinHolder,
  assertStaffRoleHolderEligible,
  builtinStaffRoleForAssignment,
  explainStaffPermissions,
  hasStaffPermission,
  isStaffPermission,
  resolveStaffPermissions,
  staffPermission,
  type StaffPermission,
  type StaffRole,
} from './staff-permissions.js';

const role = (id: string, allow: StaffPermission[], deny: StaffPermission[] = []): StaffRole => ({
  id,
  name: id,
  kind: 'custom',
  allow,
  deny,
});

function refusal(fn: () => unknown): StaffPermissionError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StaffPermissionError);
    return err as StaffPermissionError;
  }
  throw new Error('expected a refusal');
}

describe('staff permission catalogue', () => {
  it('holds the closed lists the spec names', () => {
    expect(STAFF_AREAS).toEqual([
      'accounts',
      'ledger',
      'payments',
      'cards',
      'trading',
      'documents',
      'flags',
      'tokens',
      'settings',
      'authentication',
    ]);
    expect(STAFF_VERBS).toEqual(['read', 'write', 'create', 'update', 'delete', 'approve', 'apply', 'skip']);
    expect(STAFF_ENVS).toEqual(['local', 'staging', 'production']);
    expect(STAFF_PERMISSIONS).toHaveLength(STAFF_AREAS.length * STAFF_VERBS.length * STAFF_ENVS.length);
    expect(new Set(STAFF_PERMISSIONS).size).toBe(STAFF_PERMISSIONS.length);
    expect(STAFF_PERMISSIONS.every((p) => isStaffPermission(p))).toBe(true);
  });

  it('accepts exactly staff:<area>:<verb>:<env>', () => {
    expect(isStaffPermission('staff:ledger:write:production')).toBe(true);
    expect(staffPermission('payments', 'approve', 'staging')).toBe('staff:payments:approve:staging');
  });

  it('refuses malformed strings', () => {
    for (const bad of [
      '',
      'staff',
      'staff:ledger:write',
      'staff:ledger:write:production:extra',
      'staff:ledger:write:prod',
      'staff:ledger:admin:production',
      'staff:treasury:read:local',
      'Staff:ledger:read:local',
      'staff:Ledger:read:local',
      ' staff:ledger:read:local',
      'staff:ledger:read:local ',
      'staff::read:local',
      'admin:ledger:read:local',
      'staff:ledger:*:production',
      'staff:*:read:local',
      'admin:write',
    ]) {
      expect(isStaffPermission(bad), bad).toBe(false);
    }
    expect(isStaffPermission(undefined)).toBe(false);
    expect(isStaffPermission(42)).toBe(false);
    expect(isStaffPermission(['staff:ledger:read:local'])).toBe(false);
  });

  it('refuses a role row that holds a malformed string instead of skipping it', () => {
    const tampered = role('r1', ['staff:ledger:read:local', 'staff:ledger:*:production' as StaffPermission]);
    expect(refusal(() => resolveStaffPermissions([tampered])).code).toBe('identity.staff_permission_invalid');
    expect(refusal(() => explainStaffPermissions([tampered])).code).toBe('identity.staff_permission_invalid');
    expect(refusal(() => assertGrantWithinHolder(resolveStaffPermissions([]), tampered)).code).toBe('identity.staff_permission_invalid');
  });
});

describe('resolveStaffPermissions and hasStaffPermission', () => {
  it('denies everything when no role is held', () => {
    const effective = resolveStaffPermissions([]);
    for (const p of STAFF_PERMISSIONS) {
      const [, area, verb, env] = p.split(':') as [
        string,
        (typeof STAFF_AREAS)[number],
        (typeof STAFF_VERBS)[number],
        (typeof STAFF_ENVS)[number],
      ];
      expect(hasStaffPermission(effective, area, verb, env)).toBe(false);
    }
  });

  it('denies a permission left unset: ledger write in production', () => {
    const effective = resolveStaffPermissions([role('r1', ['staff:ledger:write:staging', 'staff:ledger:read:production'])]);
    expect(hasStaffPermission(effective, 'ledger', 'write', 'production')).toBe(false);
    expect(hasStaffPermission(effective, 'ledger', 'write', 'staging')).toBe(true);
  });

  it('merges allows across roles', () => {
    const effective = resolveStaffPermissions([role('a', ['staff:accounts:read:production']), role('b', ['staff:cards:read:production'])]);
    expect(hasStaffPermission(effective, 'accounts', 'read', 'production')).toBe(true);
    expect(hasStaffPermission(effective, 'cards', 'read', 'production')).toBe(true);
  });

  it('lets an explicit deny win over every allow, in any role order', () => {
    const allowA = role('a', ['staff:payments:apply:production']);
    const allowB = role('b', ['staff:payments:apply:production', 'staff:payments:read:production']);
    const denier = role('c', [], ['staff:payments:apply:production']);
    for (const order of [
      [allowA, allowB, denier],
      [denier, allowA, allowB],
      [allowA, denier, allowB],
    ]) {
      const effective = resolveStaffPermissions(order);
      expect(hasStaffPermission(effective, 'payments', 'apply', 'production')).toBe(false);
      expect(hasStaffPermission(effective, 'payments', 'read', 'production')).toBe(true);
      expect(effective.allow.has('staff:payments:apply:production')).toBe(false);
      expect(effective.deny.has('staff:payments:apply:production')).toBe(true);
    }
  });

  it('a role that allows and denies the same permission denies it', () => {
    const effective = resolveStaffPermissions([role('a', ['staff:flags:update:local'], ['staff:flags:update:local'])]);
    expect(hasStaffPermission(effective, 'flags', 'update', 'local')).toBe(false);
  });

  it('approve does not give apply or skip, and nothing implies anything', () => {
    const effective = resolveStaffPermissions([role('approver', ['staff:ledger:approve:production'])]);
    expect(hasStaffPermission(effective, 'ledger', 'approve', 'production')).toBe(true);
    expect(hasStaffPermission(effective, 'ledger', 'apply', 'production')).toBe(false);
    expect(hasStaffPermission(effective, 'ledger', 'skip', 'production')).toBe(false);
    expect(hasStaffPermission(effective, 'ledger', 'read', 'production')).toBe(false);
    expect(hasStaffPermission(effective, 'ledger', 'approve', 'staging')).toBe(false);

    const writer = resolveStaffPermissions([role('writer', ['staff:settings:write:production'])]);
    for (const verb of STAFF_VERBS.filter((v) => v !== 'write')) {
      expect(hasStaffPermission(writer, 'settings', verb, 'production'), verb).toBe(false);
    }
    for (const env of STAFF_ENVS.filter((e) => e !== 'production')) {
      expect(hasStaffPermission(writer, 'settings', 'write', env), env).toBe(false);
    }
    expect(writer.allow.size).toBe(1);
  });

  it('refuses a deny smuggled past a hand-built effective set', () => {
    const effective = {
      allow: new Set<StaffPermission>(['staff:tokens:read:local']),
      deny: new Set<StaffPermission>(['staff:tokens:read:local']),
    };
    expect(hasStaffPermission(effective, 'tokens', 'read', 'local')).toBe(false);
  });
});

describe('explainStaffPermissions (access overview)', () => {
  it('lists every named permission with its source roles, or the deny that removed it', () => {
    const rows = explainStaffPermissions([
      role('support', ['staff:accounts:read:production', 'staff:documents:read:production']),
      role('lead', ['staff:accounts:read:production']),
      role('no-docs', [], ['staff:documents:read:production']),
    ]);
    expect(rows).toEqual([
      { permission: 'staff:accounts:read:production', state: 'allowed', sourceRoleIds: ['support', 'lead'] },
      {
        permission: 'staff:documents:read:production',
        state: 'denied_explicit',
        sourceRoleIds: ['support'],
        deniedByRoleIds: ['no-docs'],
      },
    ]);
  });

  it('lists nothing for no roles', () => {
    expect(explainStaffPermissions([])).toEqual([]);
  });
});

describe('assertGrantWithinHolder', () => {
  const holder = resolveStaffPermissions([
    role(
      'h',
      ['staff:accounts:read:production', 'staff:accounts:update:production', 'staff:ledger:read:production'],
      ['staff:ledger:read:production'],
    ),
  ]);

  it('allows a grant within what the holder holds', () => {
    expect(() => assertGrantWithinHolder(holder, role('g', ['staff:accounts:read:production']))).not.toThrow();
  });

  it('allows a grant whose denies the holder does not hold (denies narrow)', () => {
    expect(() => assertGrantWithinHolder(holder, role('g', [], ['staff:cards:delete:production']))).not.toThrow();
  });

  it('refuses a grant beyond the holder, naming what is missing', () => {
    const err = refusal(() =>
      assertGrantWithinHolder(
        holder,
        role('g', ['staff:accounts:read:production', 'staff:accounts:delete:production', 'staff:accounts:read:staging']),
      ),
    );
    expect(err.code).toBe('identity.role_grant_exceeds_holder');
    expect(err.detail).toEqual(['staff:accounts:delete:production', 'staff:accounts:read:staging']);
  });

  it('refuses granting something the holder is explicitly denied', () => {
    const err = refusal(() => assertGrantWithinHolder(holder, role('g', ['staff:ledger:read:production'])));
    expect(err.code).toBe('identity.role_grant_exceeds_holder');
  });

  it('refuses apply from a holder who has only approve', () => {
    const approver = resolveStaffPermissions([role('a', ['staff:payments:approve:production'])]);
    expect(refusal(() => assertGrantWithinHolder(approver, role('g', ['staff:payments:apply:production']))).code).toBe(
      'identity.role_grant_exceeds_holder',
    );
  });

  it('refuses everything from a holder with no roles', () => {
    expect(refusal(() => assertGrantWithinHolder(resolveStaffPermissions([]), role('g', ['staff:flags:read:local']))).code).toBe(
      'identity.role_grant_exceeds_holder',
    );
  });
});

describe('built-in roles', () => {
  it('names the five roles and publishes no mapping for any', () => {
    expect(BUILTIN_STAFF_ROLE_NAMES).toEqual(['founder', 'compliance', 'support', 'finance', 'developer']);
    expect(Object.keys(BUILTIN_STAFF_ROLE_MAPPINGS).sort()).toEqual([...BUILTIN_STAFF_ROLE_NAMES].sort());
    for (const name of BUILTIN_STAFF_ROLE_NAMES) expect(BUILTIN_STAFF_ROLE_MAPPINGS[name]).toBeNull();
  });

  it('refuses assigning a built-in role whose mapping is null', () => {
    for (const name of BUILTIN_STAFF_ROLE_NAMES) {
      const err = refusal(() => builtinStaffRoleForAssignment(name));
      expect(err.code).toBe('identity.role_mapping_unset');
      expect(err.detail).toEqual([name]);
    }
  });

  it('builds the role from a mapping once one is given, and still refuses a malformed one', () => {
    const mappings = { ...BUILTIN_STAFF_ROLE_MAPPINGS, support: { allow: ['staff:accounts:read:local' as const], deny: [] } };
    expect(builtinStaffRoleForAssignment('support', mappings)).toEqual({
      id: 'builtin:support',
      name: 'support',
      kind: 'builtin',
      allow: ['staff:accounts:read:local'],
      deny: [],
    });
    expect(refusal(() => builtinStaffRoleForAssignment('founder', mappings)).code).toBe('identity.role_mapping_unset');
    const bad = { ...BUILTIN_STAFF_ROLE_MAPPINGS, support: { allow: ['staff:all' as StaffPermission], deny: [] } };
    expect(refusal(() => builtinStaffRoleForAssignment('support', bad)).code).toBe('identity.staff_permission_invalid');
  });
});

describe('assertStaffRoleHolderEligible', () => {
  it('allows an individual account', () => {
    expect(() => assertStaffRoleHolderEligible({ accountType: 'individual' })).not.toThrow();
  });

  it('refuses a business user', () => {
    expect(refusal(() => assertStaffRoleHolderEligible({ accountType: 'business' })).code).toBe('identity.business_user_not_staff');
  });

  it('refuses an account type it does not know', () => {
    expect(refusal(() => assertStaffRoleHolderEligible({ accountType: 'merchant' as 'business' })).code).toBe(
      'identity.business_user_not_staff',
    );
  });
});
