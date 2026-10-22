import { describe, expect, it } from 'vitest';
import {
  ACADEMY_ROLE_ACTION_TYPES,
  ACADEMY_ROLE_REFUSAL_CODES,
  academyCustomRoleSchema,
  academyRoleActionPayloadSchema,
  academyRoleHolderSchema,
  academyRoleIdSchema,
  academyRolesCatalogueSchema,
} from './academy-roles.js';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('academy roles contracts (AC-roles-01)', () => {
  it('declares the four approval action types and the refusal codes', () => {
    expect(ACADEMY_ROLE_ACTION_TYPES).toEqual([
      'academy.role.create',
      'academy.role.activate',
      'academy.role.assign',
      'academy.role.revoke',
    ]);
    expect(ACADEMY_ROLE_REFUSAL_CODES).toContain('academy.role_limit_unset');
  });
  it('role ids are built-in or custom:<slug>', () => {
    for (const ok of ['admin', 'custom:tutor', 'custom:lead-tutor']) expect(academyRoleIdSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['owner', 'custom:', 'custom:Tutor', 'custom:a--b']) expect(academyRoleIdSchema.safeParse(bad).success).toBe(false);
  });
  it('custom roles and holders are strict', () => {
    const role = { id: 'custom:tutor', label: 'Tutor', permissions: ['grade'], active: true };
    expect(academyCustomRoleSchema.safeParse(role).success).toBe(true);
    expect(academyCustomRoleSchema.safeParse({ ...role, permissions: ['withdraw'] }).success).toBe(false);
    expect(academyCustomRoleSchema.safeParse({ ...role, label: '' }).success).toBe(false);
    const holder = { courseScope: '*', accountId: uuid, role: 'staff', activation: 1, active: true };
    expect(academyRoleHolderSchema.safeParse(holder).success).toBe(true);
    expect(academyRoleHolderSchema.safeParse({ ...holder, accountId: 'x' }).success).toBe(false);
    expect(academyRoleHolderSchema.safeParse({ ...holder, activation: 1.5 }).success).toBe(false);
    expect(academyRolesCatalogueSchema.safeParse({ permissions: [], builtin: [], custom: [], extra: 1 }).success).toBe(false);
  });
  it('approval payloads match their action type', () => {
    expect(
      academyRoleActionPayloadSchema.safeParse({
        actionType: 'academy.role.create',
        slug: 'tutor',
        label: 'Tutor',
        permissions: 'comments,grade',
      }).success,
    ).toBe(true);
    expect(
      academyRoleActionPayloadSchema.safeParse({
        actionType: 'academy.role.create',
        slug: 'tutor',
        label: 'Tutor',
        permissions: 'grade,comments',
      }).success,
    ).toBe(false);
    expect(
      academyRoleActionPayloadSchema.safeParse({
        actionType: 'academy.role.create',
        slug: 'tutor',
        label: 'Tutor',
        permissions: 'grade,grade',
      }).success,
    ).toBe(false);
    expect(
      academyRoleActionPayloadSchema.safeParse({ actionType: 'academy.role.activate', roleId: 'custom:tutor', active: 'yes' }).success,
    ).toBe(false);
    expect(
      academyRoleActionPayloadSchema.safeParse({ actionType: 'academy.role.assign', courseScope: '*', accountId: uuid, role: 'staff' })
        .success,
    ).toBe(true);
    expect(academyRoleActionPayloadSchema.safeParse({ actionType: 'academy.role.revoke', courseScope: '*', accountId: uuid }).success).toBe(
      false,
    );
    expect(academyRoleActionPayloadSchema.safeParse({ actionType: 'academy.role.delete', roleId: 'custom:tutor' }).success).toBe(false);
  });
});
