/**
 * TEST rows in the contract's shapes, for the staff screens' tests only. Every name and id is a TEST value; none is a real
 * person, and nothing here is shown by the console.
 */
export const T_FOUNDER = '11111111-1111-4111-8111-111111111111';
export const T_STAFF_ID = 'stf_test_0001';
export const T_STAFF_USER = '33333333-3333-4333-8333-333333333333';
export const T_ROLE_ID = 'role_test_ops';
export const T_AS_OF = '2026-10-31T05:00:00.000Z';

export function tStaff(over: Record<string, unknown> = {}) {
  return {
    staffId: T_STAFF_ID,
    userId: T_STAFF_USER,
    displayName: 'TEST Staff One',
    email: 'test.staff@example.test',
    status: 'active',
    roleIds: [T_ROLE_ID],
    lastSignInAt: null,
    invitedAt: '2026-10-30T10:00:00.000Z',
    invitedBy: T_FOUNDER,
    activatedAt: '2026-10-30T11:00:00.000Z',
    disabledAt: null,
    version: '4',
    ...over,
  };
}

export const tBuiltin = (name = 'compliance') => ({
  roleId: `builtin:${name}`,
  name,
  version: '1',
  kind: 'builtin',
  state: 'mapping_unset',
  code: 'identity.role_mapping_unset',
});

export const tCustom = (over: Record<string, unknown> = {}) => ({
  roleId: T_ROLE_ID,
  name: 'TEST ops reader',
  version: '2',
  kind: 'custom',
  state: 'defined',
  allow: ['staff:ledger:read:production'],
  deny: ['staff:ledger:write:production'],
  ...over,
});

export const tRoles = () => ({ roles: [tBuiltin('founder'), tBuiltin('compliance'), tCustom()], asOf: T_AS_OF });
export const tList = (staff: unknown[] = [tStaff()]) => ({ staff, nextCursor: null, asOf: T_AS_OF });
export const tGet = () => ({ staff: tStaff(), roles: [tCustom()], asOf: T_AS_OF });
export const tAccess = () => ({
  staffId: T_STAFF_ID,
  status: 'active',
  roles: [tCustom()],
  permissions: [
    { permission: 'staff:ledger:read:production', state: 'allowed', sourceRoleIds: [T_ROLE_ID] },
    { permission: 'staff:ledger:write:production', state: 'denied_explicit', sourceRoleIds: [], deniedByRoleIds: [T_ROLE_ID] },
  ],
  asOf: T_AS_OF,
});

/** What tRPC answers for a procedure the router does not have, as svc-identity's adapter sends it through the edge. */
export const noProcedure = (path: string) =>
  Response.json(
    { error: { message: `No procedure found on path "${path}"`, code: -32004, data: { code: 'NOT_FOUND', httpStatus: 404, path } } },
    { status: 404 },
  );
export const trpcOk = (data: unknown) => Response.json({ result: { data } });
export const trpcForbidden = (code: string) =>
  Response.json({ error: { message: code, code: -32003, data: { code: 'FORBIDDEN', httpStatus: 403, cause: { code } } } }, { status: 403 });
