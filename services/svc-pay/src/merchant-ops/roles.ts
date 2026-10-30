import type { Principal } from '@intafaced/auth';
import type { Sql } from 'postgres';
import { MerchantOpsError } from './errors.js';

/**
 * TEAM ROLES AND THEIR PERMISSIONS (W15, reusable by later streams).
 *
 * `owner` is not stored: it is whoever `pay.merchants.user_id` names, so a
 * merchant always has exactly one and it cannot be demoted by a role edit.
 * The four stored roles are `admin`, `finance`, `developer`, `viewer`.
 *
 * `finance` is the approver role: the one a maker-checker payout flow (W1)
 * asks for with `payout.approve`. Owner and admin hold it too, because a small
 * merchant has one person. A caller who is both maker and checker is W1's rule
 * to refuse, not this table's.
 *
 * WHAT A PERMISSION IS NOT. It is a second check on top of the session scope
 * (`pay:read` / `pay:write` ...) and the merchant scoping, never instead of
 * them: a role can only narrow what the scope already allows.
 */
export const TEAM_ROLES = ['admin', 'finance', 'developer', 'viewer'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export type MerchantRole = 'owner' | TeamRole;

export const MERCHANT_PERMISSIONS = [
  'team.read',
  'team.manage',
  'disputes.read',
  'disputes.respond',
  'invoices.read',
  'invoices.write',
  'customers.read',
  'kyb.read',
  'profile.read',
  'profile.manage',
  'exports.create',
  'exports.read',
  'notifications.read',
  'notifications.manage',
  'payments.read',
  'settlements.read',
  'halts.read',
  'payout.request',
  'payout.approve',
  'activity.read',
  'payouts.read',
  'webhooks.read',
  'webhooks.manage',
  'products.read',
  'products.manage',
  'payments.unmask',
] as const;
export type MerchantPermission = (typeof MERCHANT_PERMISSIONS)[number];

const READS: readonly MerchantPermission[] = [
  'team.read',
  'disputes.read',
  'invoices.read',
  'customers.read',
  'kyb.read',
  'profile.read',
  'exports.read',
  'notifications.read',
  'payments.read',
  'settlements.read',
  'halts.read',
  'activity.read',
  'payouts.read',
  'products.read',
];

const ROLE_PERMISSIONS: Record<MerchantRole, ReadonlySet<MerchantPermission>> = {
  owner: new Set(MERCHANT_PERMISSIONS),
  admin: new Set(MERCHANT_PERMISSIONS),
  finance: new Set<MerchantPermission>([
    ...READS,
    'disputes.respond',
    'invoices.write',
    'exports.create',
    'notifications.manage',
    'payout.request',
    'payout.approve',
    'payments.unmask',
  ]),
  developer: new Set<MerchantPermission>([...READS, 'exports.create', 'webhooks.read', 'webhooks.manage', 'products.manage']),
  viewer: new Set<MerchantPermission>(READS),
};

export function roleHasPermission(role: MerchantRole, permission: MerchantPermission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * D-145 step-up door. `refunds.create` and `payout.send` are held by the same
 * money roles as the existing table's owner, admin, and finance seats.
 * Developer and viewer do not hold them. This does not change `payout.approve`
 * or the maker-checker on a payout.
 */
const PAY_STEP_UP_ROLES = new Set<MerchantRole>(['owner', 'admin', 'finance']);

export function payStepUpPermissions(role: MerchantRole | null): { 'refunds.create': boolean; 'payout.send': boolean } {
  const allowed = role !== null && PAY_STEP_UP_ROLES.has(role);
  return { 'refunds.create': allowed, 'payout.send': allowed };
}

/** Owner, admin, and finance see a stored pricing row. Viewer and developer see the fee amount only. */
const FULL_PRICING = new Set<MerchantRole>(['owner', 'admin', 'finance']);

export function seesFullPricing(role: MerchantRole): boolean {
  return FULL_PRICING.has(role);
}

export function pricingVisibilityFor(role: MerchantRole): 'full' | 'fee_only' {
  return seesFullPricing(role) ? 'full' : 'fee_only';
}

/** Every permission flag for a role, taken from the role table and not from the request. */
export function capabilityFlags(role: MerchantRole): { [K in MerchantPermission]: boolean } {
  return Object.fromEntries(MERCHANT_PERMISSIONS.map((permission) => [permission, roleHasPermission(role, permission)])) as {
    [K in MerchantPermission]: boolean;
  };
}

const WRITE_PERMISSIONS = new Set<MerchantPermission>(MERCHANT_PERMISSIONS.filter((permission) => !READS.includes(permission)));

/**
 * Role flags, then the session. An API key or a session without MFA keeps the
 * reads and loses every write, including profile.manage and payout.approve.
 */
export function capabilityFlagsForSession(role: MerchantRole, sessionInteractive: boolean): { [K in MerchantPermission]: boolean } {
  const flags = capabilityFlags(role);
  if (sessionInteractive) return flags;
  return Object.fromEntries(
    MERCHANT_PERMISSIONS.map((permission) => [permission, flags[permission] && !WRITE_PERMISSIONS.has(permission)]),
  ) as {
    [K in MerchantPermission]: boolean;
  };
}

/** Roles that hold a permission, for docs and tests. */
export function rolesWithPermission(permission: MerchantPermission): MerchantRole[] {
  return (Object.keys(ROLE_PERMISSIONS) as MerchantRole[]).filter((r) => ROLE_PERMISSIONS[r].has(permission));
}

/** Who is calling, for which merchant, in which role. Always derived from the principal, never from the body. */
export interface MerchantCaller {
  readonly merchantId: string;
  readonly userId: string;
  readonly role: MerchantRole;
  /** True for a long-lived `ifc_` key. */
  readonly viaApiKey: boolean;
  /** No API key, MFA passed, not a sub-account. Team changes require it. */
  readonly interactive: boolean;
}

type CallerPrincipal = Pick<Principal, 'userId' | 'kid'> & Partial<Pick<Principal, 'mfa' | 'sub_account'>>;

/** An interactive, MFA-verified, first-party session: the only kind that may change who holds which role. */
export function isInteractivePrincipal(principal: CallerPrincipal): boolean {
  return principal.kid === undefined && principal.mfa === true && principal.sub_account === undefined;
}

export function assertPermission(caller: MerchantCaller, permission: MerchantPermission): void {
  if (!roleHasPermission(caller.role, permission)) throw new MerchantOpsError('pay.team_role_forbidden', 'forbidden');
}

/**
 * Resolve the calling principal to its merchant and role: the merchant it owns,
 * else the one team it is an ACTIVE member of. A principal that is neither is
 * refused as `pay.merchant_ops_not_merchant`; it learns nothing about any merchant.
 */
export async function resolveMerchantCaller(sql: Sql, principal: CallerPrincipal): Promise<MerchantCaller> {
  const viaApiKey = principal.kid !== undefined;
  const interactive = isInteractivePrincipal(principal);
  const owned = await sql<Array<{ id: string }>>`SELECT id FROM pay.merchants WHERE user_id = ${principal.userId} LIMIT 1`;
  if (owned[0]) return { merchantId: owned[0].id, userId: principal.userId, role: 'owner', viaApiKey, interactive };
  const member = await sql<Array<{ merchant_id: string; role: TeamRole }>>`
    SELECT m.merchant_id, m.role
      FROM pay.merchant_team_members m
     WHERE m.user_id = ${principal.userId} AND m.status = 'active'
     LIMIT 1`;
  if (!member[0]) throw new MerchantOpsError('pay.merchant_ops_not_merchant', 'forbidden');
  return { merchantId: member[0].merchant_id, userId: principal.userId, role: member[0].role, viaApiKey, interactive };
}

/**
 * The reusable gate for later streams: resolve the caller, then require a
 * permission. W1's `merchantControl.approvals.decide` calls
 * `requireMerchantPermission(sql, ctx.principal, 'payout.approve')`.
 */
export async function requireMerchantPermission(
  sql: Sql,
  principal: CallerPrincipal,
  permission: MerchantPermission,
): Promise<MerchantCaller> {
  const caller = await resolveMerchantCaller(sql, principal);
  assertPermission(caller, permission);
  return caller;
}
