import { MerchantOpsError } from './errors.js';
import {
  capabilityFlagsForSession,
  MERCHANT_PERMISSIONS,
  roleHasPermission,
  rolesWithPermission,
  TEAM_ROLES,
  type MerchantPermission,
  type MerchantRole,
} from './roles.js';

/**
 * M-plat-org-03 (spec group merchant-plat-org): the predefined roles and a
 * permission catalogue people can read.
 *
 * ONE SOURCE OF TRUTH. Every grant below is read from `roles.ts`
 * (`roleHasPermission`, `rolesWithPermission`); this file only adds the words
 * people read (the area a permission belongs to, a plain description of each
 * role) and never a second grant table. The `satisfies` maps make the build
 * fail when a permission or role is added to `roles.ts` without its catalogue
 * words, so the catalogue and the code table cannot drift.
 *
 * Built-in roles are read only: no procedure edits them, and a forced write is
 * refused with `pay.team_builtin_role_immutable`.
 */

export const PERMISSION_AREAS = ['payments', 'money_out', 'team', 'developer', 'reports', 'risk', 'account'] as const;
export type PermissionArea = (typeof PERMISSION_AREAS)[number];

/** Which area of the Roles page a permission is listed under. */
const AREA_OF = {
  'team.read': 'team',
  'team.manage': 'team',
  'disputes.read': 'risk',
  'disputes.respond': 'risk',
  'invoices.read': 'payments',
  'invoices.write': 'payments',
  'customers.read': 'payments',
  'kyb.read': 'account',
  'profile.read': 'account',
  'profile.manage': 'account',
  'exports.create': 'reports',
  'exports.read': 'reports',
  'notifications.read': 'account',
  'notifications.manage': 'account',
  'payments.read': 'payments',
  'settlements.read': 'money_out',
  'halts.read': 'money_out',
  'payout.request': 'money_out',
  'payout.approve': 'money_out',
  'activity.read': 'reports',
  'payouts.read': 'money_out',
  'webhooks.read': 'developer',
  'webhooks.manage': 'developer',
  'products.read': 'payments',
  'products.manage': 'payments',
  'payments.unmask': 'payments',
} as const satisfies Record<MerchantPermission, PermissionArea>;

/**
 * An action that only makes sense together with another permission (the page
 * shows the pair). Each entry is checked against the role table in the unit
 * test: every role holding the key also holds what it requires.
 */
const REQUIRES: Partial<Record<MerchantPermission, readonly MerchantPermission[]>> = {
  'team.manage': ['team.read'],
  'disputes.respond': ['disputes.read'],
  'invoices.write': ['invoices.read'],
  'profile.manage': ['profile.read'],
  'exports.create': ['exports.read'],
  'notifications.manage': ['notifications.read'],
  'payout.request': ['payouts.read'],
  'payout.approve': ['payouts.read'],
  'webhooks.manage': ['webhooks.read'],
  'products.manage': ['products.read'],
  'payments.unmask': ['payments.read'],
};

export const BUILT_IN_ROLES = ['owner', ...TEAM_ROLES] as const satisfies readonly MerchantRole[];

/** One plain sentence per built-in role: what it can and cannot do. */
const ROLE_DESCRIPTION = {
  owner: 'The person who opened the merchant account. Can do everything, and cannot be removed or demoted by a role change.',
  admin: 'Can do everything the owner can, including managing the team, the business profile, webhooks and products.',
  finance:
    'Can read everything except webhooks, answer disputes, write invoices, create exports, change notification settings, and request and approve payouts. Cannot manage the team, the business profile, webhooks or products.',
  developer:
    'Can read everything, create exports, and manage webhooks and products. Cannot request or approve payouts, answer disputes, write invoices or manage the team.',
  viewer: 'Can read everything except webhooks. Cannot change anything.',
} as const satisfies Record<MerchantRole, string>;

export interface CataloguePermission {
  readonly key: MerchantPermission;
  readonly area: PermissionArea;
  /** A write is dropped for an API key or a session without MFA, whatever the role. */
  readonly kind: 'read' | 'write';
  readonly requires: readonly MerchantPermission[];
  readonly heldBy: readonly MerchantRole[];
  /** True when no built-in role holds it: the page flags it. */
  readonly unheld: boolean;
}

export interface CatalogueRole {
  readonly role: MerchantRole;
  readonly builtIn: true;
  readonly editable: false;
  readonly description: string;
  readonly grants: readonly MerchantPermission[];
}

export interface PermissionCatalogue {
  readonly roles: readonly CatalogueRole[];
  readonly areas: ReadonlyArray<{ readonly area: PermissionArea; readonly permissions: readonly CataloguePermission[] }>;
}

/** Writes are what an API key loses: read from the session rule in roles.ts, not restated here. */
const OWNER_WITHOUT_MFA = capabilityFlagsForSession('owner', false);

function permissionEntry(key: MerchantPermission): CataloguePermission {
  const heldBy = rolesWithPermission(key);
  return {
    key,
    area: AREA_OF[key],
    kind: OWNER_WITHOUT_MFA[key] ? 'read' : 'write',
    requires: REQUIRES[key] ?? [],
    heldBy,
    unheld: heldBy.length === 0,
  };
}

/** The whole catalogue, derived from the role table at call time. */
export function permissionCatalogue(): PermissionCatalogue {
  const roles = BUILT_IN_ROLES.map((role): CatalogueRole => ({
    role,
    builtIn: true,
    editable: false,
    description: ROLE_DESCRIPTION[role],
    grants: MERCHANT_PERMISSIONS.filter((p) => roleHasPermission(role, p)),
  }));
  const areas = PERMISSION_AREAS.map((area) => ({
    area,
    permissions: MERCHANT_PERMISSIONS.filter((p) => AREA_OF[p] === area).map(permissionEntry),
  })).filter((group) => group.permissions.length > 0);
  return { roles, areas };
}

/** Built-in roles have no write. Any attempt to change one is refused with a named reason. */
export function refuseBuiltInRoleEdit(): never {
  throw new MerchantOpsError('pay.team_builtin_role_immutable', 'forbidden');
}
