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
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Need = Capability | 'owner';

/**
 * A copy of `ROLE_PERMISSIONS` in services/svc-pay/src/merchant-ops/roles.ts on main. It is used only when the
 * service cannot say what a team member may do (`merchant.myAccess` is not live). `roles.pin.test.ts` fails if the
 * two ever differ. The profile permissions are not on main, so they read as false here.
 */
const READS: readonly Capability[] = [
  'team.read',
  'disputes.read',
  'invoices.read',
  'customers.read',
  'kyb.read',
  'exports.read',
  'notifications.read',
  'payments.read',
  'settlements.read',
  'halts.read',
  'activity.read',
  'payouts.read',
];
const ALL_ON_MAIN = CAPABILITIES.filter((c) => c !== 'profile.read' && c !== 'profile.manage');
export const ROLE_CAPABILITIES: Record<MemberRole, ReadonlySet<Capability>> = {
  owner: new Set(ALL_ON_MAIN),
  admin: new Set(ALL_ON_MAIN),
  finance: new Set<Capability>([
    ...READS,
    'disputes.respond',
    'invoices.write',
    'exports.create',
    'notifications.manage',
    'payout.request',
    'payout.approve',
  ]),
  developer: new Set<Capability>([...READS, 'exports.create', 'webhooks.read', 'webhooks.manage']),
  viewer: new Set<Capability>(READS),
};
