import type { ApiResult } from '../../../../shared/api';
import type { Resource } from '../../../../shared/resource';
import { isNotLive } from '../refusal';
import type { MemberRole, MerchantRecord } from '../schemas';
import type { Capability, Need } from './capabilities';
import { memberFromTeam, ownerFromRecord } from './fallback';
import type { Membership, MyAccess } from './schemas';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type TeamMe = { merchantId: string; userId: string; role: MemberRole };

/** What the portal knows about the signed-in person's place in a business. Only a `ready` value grants anything. */
export type Access =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'failed'; failure: Failed }
  | {
      status: 'ready';
      source: 'my-access' | 'owner-record' | 'team-member';
      merchantId: string;
      role: MemberRole;
      /** The business account's own state, from the service when it says so. */
      accountStatus: Membership['status'];
      kybStatus: Membership['kybStatus'] | null;
      mode: Membership['mode'] | null;
      /** Null means unknown: the service decides and its refusal is shown plainly. */
      sessionInteractive: boolean | null;
      displayName: string | null;
      legalName: string | null;
      pricingVisibility: 'full' | 'fee_only' | null;
      capabilities: ReadonlySet<Capability>;
    };
export type Ready = Extract<Access, { status: 'ready' }>;

export type AccessInputs = {
  sessionUserId: string | null;
  myAccess: Resource<MyAccess>;
  merchant: Resource<MerchantRecord | null>;
  team: Resource<TeamMe>;
};

const toReady = (m: Membership): Ready => ({
  status: 'ready',
  source: 'my-access',
  merchantId: m.merchantId,
  role: m.role,
  accountStatus: m.status,
  kybStatus: m.kybStatus,
  mode: m.mode,
  sessionInteractive: m.sessionInteractive,
  displayName: m.displayName,
  legalName: m.legalName,
  pricingVisibility: m.pricingVisibility,
  capabilities: new Set((Object.entries(m.capabilities) as [Capability, boolean][]).filter(([, on]) => on).map(([key]) => key)),
});

/**
 * Who this person is in a business, in order of trust:
 *  1. `merchant.myAccess`, when the service answers it. Empty means no business.
 *  2. If that procedure is not live (and only then), the owner proved by `merchant.me` naming the signed-in user,
 *     or a team member by `merchantOps.team.me` with the role table copied in `capabilities.ts`.
 *  3. Any other failure of `myAccess` (forbidden, unreachable) grants nothing. It never falls back.
 */
export function resolveAccess({ sessionUserId, myAccess, merchant, team }: AccessInputs): Access {
  if (myAccess.status === 'ready') {
    const first = myAccess.data.memberships[0];
    return first ? toReady(first) : { status: 'none' };
  }
  if (myAccess.status === 'failed' && !isNotLive(myAccess.failure)) return { status: 'failed', failure: myAccess.failure };
  if (myAccess.status === 'loading' || merchant.status === 'loading') return { status: 'loading' };
  // From here `merchant.myAccess` is not live: work it out from the two reads that are.
  const owner = merchant.status === 'ready' ? ownerFromRecord(merchant.data, sessionUserId) : null;
  if (owner) return fromDerived(owner);
  if (merchant.status === 'failed' && team.status !== 'ready') return { status: 'failed', failure: merchant.failure };
  if (team.status === 'loading') return { status: 'loading' };
  const member = team.status === 'ready' ? memberFromTeam(team.data, sessionUserId) : null;
  return member ? fromDerived(member) : { status: 'none' };
}

function fromDerived(d: NonNullable<ReturnType<typeof ownerFromRecord>>): Ready {
  return {
    status: 'ready',
    source: d.source,
    merchantId: d.merchantId,
    role: d.role,
    accountStatus: d.status,
    kybStatus: d.kybStatus,
    mode: d.mode,
    sessionInteractive: null,
    displayName: null,
    legalName: null,
    pricingVisibility: null,
    capabilities: d.capabilities,
  };
}

/** Does this person hold the permission, or is this the account owner? Anything not ready holds nothing. */
export function allows(access: Access, need: Need): boolean {
  if (access.status !== 'ready') return false;
  return need === 'owner' ? access.role === 'owner' : access.capabilities.has(need);
}

/** The owner of an active account in a session that can change things. Links, refunds and payouts are owner-only on the service. */
export function canOwnerWrite(access: Access): boolean {
  return access.status === 'ready' && access.role === 'owner' && access.accountStatus === 'active' && access.sessionInteractive !== false;
}
