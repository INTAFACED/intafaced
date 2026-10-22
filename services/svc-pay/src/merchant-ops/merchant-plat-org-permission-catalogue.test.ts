import { describe, expect, it } from 'vitest';
import { MerchantOpsError } from './errors.js';
import { BUILT_IN_ROLES, PERMISSION_AREAS, permissionCatalogue, refuseBuiltInRoleEdit } from './merchant-plat-org-permission-catalogue.js';
import { capabilityFlagsForSession, MERCHANT_PERMISSIONS, roleHasPermission, rolesWithPermission, TEAM_ROLES } from './roles.js';

describe('M-plat-org-03 permission catalogue', () => {
  const catalogue = permissionCatalogue();
  const all = catalogue.areas.flatMap((a) => a.permissions);

  it('lists all five built-in roles, each with a plain description, none editable', () => {
    expect(catalogue.roles.map((r) => r.role)).toEqual(['owner', ...TEAM_ROLES]);
    expect(BUILT_IN_ROLES).toHaveLength(5);
    for (const role of catalogue.roles) {
      expect(role.description.trim().length).toBeGreaterThan(10);
      expect(role.builtIn).toBe(true);
      expect(role.editable).toBe(false);
    }
  });

  it('walks the whole role table: every grant matches roleHasPermission exactly, no drift', () => {
    for (const role of catalogue.roles) {
      for (const permission of MERCHANT_PERMISSIONS) {
        expect(role.grants.includes(permission)).toBe(roleHasPermission(role.role, permission));
      }
    }
    for (const entry of all) expect([...entry.heldBy].sort()).toEqual([...rolesWithPermission(entry.key)].sort());
  });

  it('lists every permission key exactly once, grouped by a known area', () => {
    expect(all.map((p) => p.key).sort()).toEqual([...MERCHANT_PERMISSIONS].sort());
    expect(new Set(all.map((p) => p.key)).size).toBe(MERCHANT_PERMISSIONS.length);
    for (const group of catalogue.areas) {
      expect(PERMISSION_AREAS).toContain(group.area);
      expect(group.permissions.length).toBeGreaterThan(0);
      for (const p of group.permissions) expect(p.area).toBe(group.area);
    }
  });

  it('read or write comes from the session rule: a write is exactly what a non-MFA owner loses', () => {
    const quiet = capabilityFlagsForSession('owner', false);
    for (const p of all) expect(p.kind).toBe(quiet[p.key] ? 'read' : 'write');
  });

  it('every dependency holds in the table: a role with the action also holds what it requires', () => {
    const withDeps = all.filter((p) => p.requires.length > 0);
    expect(withDeps.length).toBeGreaterThan(0);
    for (const p of withDeps) {
      for (const role of BUILT_IN_ROLES) {
        if (!roleHasPermission(role, p.key)) continue;
        for (const needed of p.requires) expect(roleHasPermission(role, needed)).toBe(true);
      }
    }
  });

  it('flags a permission no role holds, and none is flagged today (owner holds all)', () => {
    for (const p of all) expect(p.unheld).toBe(p.heldBy.length === 0);
    expect(all.filter((p) => p.unheld)).toEqual([]);
  });

  it('a write to a built-in role is refused with a named reason', () => {
    let caught: unknown;
    try {
      refuseBuiltInRoleEdit();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MerchantOpsError);
    expect((caught as MerchantOpsError).code).toBe('pay.team_builtin_role_immutable');
    expect((caught as MerchantOpsError).kind).toBe('forbidden');
  });
});
