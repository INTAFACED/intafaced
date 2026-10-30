import type { MemberRole } from '../schemas';

/** One key per permission the service checks. `owner` is not a permission: it is the person the merchant record names. */
export const CAPABILITIES = [
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
export type Capability = (typeof CAPABILITIES)[number];
export type Need = Capability | 'owner';

/**
 * A copy of `ROLE_PERMISSIONS` in services/svc-pay/src/merchant-ops/roles.ts on main. It is used only when the
 * service cannot say what a team member may do (`merchant.myAccess` is not live). `roles.pin.test.ts` fails if the
 * two ever differ.
 */
const READS: readonly Capability[] = [
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
export const ROLE_CAPABILITIES: Record<MemberRole, ReadonlySet<Capability>> = {
  owner: new Set(CAPABILITIES),
  admin: new Set(CAPABILITIES),
  finance: new Set<Capability>([
    ...READS,
    'disputes.respond',
    'invoices.write',
    'exports.create',
    'notifications.manage',
    'payout.request',
    'payout.approve',
    'payments.unmask',
  ]),
  developer: new Set<Capability>([...READS, 'exports.create', 'webhooks.read', 'webhooks.manage', 'products.manage']),
  viewer: new Set<Capability>(READS),
};
