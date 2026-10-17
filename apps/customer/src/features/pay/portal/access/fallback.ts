import type { MemberRole, MerchantRecord } from '../schemas';
import { ROLE_CAPABILITIES, type Capability } from './capabilities';

/**
 * SECURITY REVIEW SURFACE. This is the whole of what the browser may work out for itself about who a person is in a
 * business. It runs only when `merchant.myAccess` is not live. It decides what the page shows and disables; the
 * service still checks every call. It never reads identity.me.modes, a strategy sub-account, a company id or a UI role.
 */
export type Derived = {
  source: 'owner-record' | 'team-member';
  merchantId: string;
  role: MemberRole;
  /** Only an owner record carries these; a team member reads them from the service later. */
  status: MerchantRecord['status'] | 'active';
  kybStatus: MerchantRecord['kybStatus'] | null;
  mode: MerchantRecord['mode'] | null;
  capabilities: ReadonlySet<Capability>;
};

/**
 * The owner: only when `merchant.me` returned a record whose `userId` is the signed-in person. This is the same test
 * the service's `assertAccess` applies. A record for anyone else gives nothing.
 */
export function ownerFromRecord(record: MerchantRecord | null, sessionUserId: string | null): Derived | null {
  if (!record || !sessionUserId || record.userId !== sessionUserId) return null;
  return {
    source: 'owner-record',
    merchantId: record.id,
    role: 'owner',
    status: record.status,
    kybStatus: record.kybStatus,
    mode: record.mode,
    capabilities: ROLE_CAPABILITIES.owner,
  };
}

/** A team member: the role `merchantOps.team.me` reports, with the capabilities a copy of the service's role table gives it. */
export function memberFromTeam(
  team: { merchantId: string; userId: string; role: MemberRole },
  sessionUserId: string | null,
): Derived | null {
  // `owner` is never taken from here: the owner is proved by the merchant record alone (ownerFromRecord).
  if (!sessionUserId || team.userId !== sessionUserId || team.role === 'owner') return null;
  return {
    source: 'team-member',
    merchantId: team.merchantId,
    role: team.role,
    status: 'active',
    kybStatus: null,
    mode: null,
    capabilities: ROLE_CAPABILITIES[team.role],
  };
}
