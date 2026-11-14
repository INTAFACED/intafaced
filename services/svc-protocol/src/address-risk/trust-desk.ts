import {
  ONBOARDING_ITEMS,
  type HumanTokenTier,
  type OnboardingItem,
  type ProtocolOnboardingChecklist,
  type ProtocolOnboardingOpenInput,
  type ProtocolOnboardingRefusal,
  type ProtocolTierAudit,
  type ProtocolTierRefusal,
  type ProtocolTokenTier,
} from '@intafaced/contracts/protocol-address-risk';

/**
 * The trust desk's records beside the compliance queue (J-dex-protocol-30 #4 #9).
 *
 * Token tiers (D-launch-listing-02): a human tier is a recorded review. One person asks, a different person approves, and
 * only then is it in force, with its date and reason. Removing it returns the token to the tier it had before (an earlier
 * human tier, or the automated one). Every ask, approval and removal is an audit row.
 *
 * Permissioned pool onboarding (D-liquidity-07): a checklist names the legal entity, the token contract, the allowlist
 * checker, the wrapper and the routing registration. One with any item blank cannot be approved, and its opener cannot
 * approve it. Nothing here holds or moves value.
 */
export class TrustDeskRefusedError extends Error {
  constructor(
    readonly code: ProtocolTierRefusal | ProtocolOnboardingRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'TrustDeskRefusedError';
  }
}

export type TierAskOutcome = { kind: 'asked'; tier: ProtocolTokenTier } | { kind: 'pending' };
export type TierApproveOutcome = { kind: 'approved'; tier: ProtocolTokenTier } | { kind: 'unknown' } | { kind: 'same_approver' };
export type TierRemoveOutcome = { kind: 'removed'; tier: ProtocolTokenTier } | { kind: 'none_set' };
export type OnboardingApproveOutcome =
  | { kind: 'approved'; checklist: ProtocolOnboardingChecklist }
  | { kind: 'unknown' }
  | { kind: 'same_approver' }
  | { kind: 'incomplete'; missing: OnboardingItem[] };

export interface TrustDeskStore {
  /** Every token with a human tier or a pending change, and the newest audit rows. */
  tiers(chainId: number, auditLimit: number): Promise<{ tiers: ProtocolTokenTier[]; audit: ProtocolTierAudit[] }>;
  /** A pending request and its audit row, unless one is already pending for the token (the business key). */
  askTier(input: { chainId: number; token: string; tier: HumanTokenTier; reason: string; requesterId: string }): Promise<TierAskOutcome>;
  /** In one transaction: the request, the tier in force (keeping the one before it) and the audit row. */
  approveTier(input: { chainId: number; requestId: string; approverId: string }): Promise<TierApproveOutcome>;
  /** In one transaction: back to the prior tier, and the audit row. */
  removeTier(input: { chainId: number; token: string; reason: string; actorId: string }): Promise<TierRemoveOutcome>;
  checklists(chainId: number): Promise<ProtocolOnboardingChecklist[]>;
  /** A new checklist, unless one with this pool name is open or approved on the chain (the business key). */
  openChecklist(
    input: ProtocolOnboardingOpenInput & { chainId: number; openedBy: string },
  ): Promise<{ kind: 'opened'; checklist: ProtocolOnboardingChecklist } | { kind: 'duplicate' }>;
  approveChecklist(input: { chainId: number; checklistId: string; approverId: string; reason: string }): Promise<OnboardingApproveOutcome>;
}

export const AUDIT_LIMIT = 200;

/** The items of a checklist still blank, in checklist order. */
export function missingItems(c: Pick<ProtocolOnboardingChecklist, OnboardingItem>): OnboardingItem[] {
  return ONBOARDING_ITEMS.filter((item) => c[item] === null || c[item] === '');
}

const ITEM_WORDS: Readonly<Record<OnboardingItem, string>> = {
  legalEntity: 'legal entity',
  tokenContract: 'token contract',
  checkerAddress: 'checker address',
  wrapperAddress: 'wrapper address',
  routingRegistration: 'routing registration',
};
export const missingWords = (missing: readonly OnboardingItem[]): string => missing.map((m) => ITEM_WORDS[m]).join(', ');

export async function readTiers(store: TrustDeskStore, chainId: number, now: Date) {
  return { asOf: now.toISOString(), chainId, ...(await store.tiers(chainId, AUDIT_LIMIT)) };
}

export async function askTier(
  store: TrustDeskStore,
  input: { chainId: number; token: string; tier: HumanTokenTier; reason: string; requesterId: string },
): Promise<ProtocolTokenTier> {
  const outcome = await store.askTier({ ...input, token: input.token.toLowerCase(), reason: input.reason.trim() });
  if (outcome.kind === 'pending')
    throw new TrustDeskRefusedError(
      'protocol.tiers.request_pending',
      'A tier change for this token is already waiting for a second approver.',
    );
  return outcome.tier;
}

export async function approveTier(store: TrustDeskStore, input: { chainId: number; requestId: string; approverId: string }) {
  const outcome = await store.approveTier(input);
  if (outcome.kind === 'unknown')
    throw new TrustDeskRefusedError('protocol.tiers.request_unknown', 'That tier change is not waiting for approval on this network.');
  if (outcome.kind === 'same_approver')
    throw new TrustDeskRefusedError(
      'protocol.tiers.same_approver',
      'You asked for this tier, so a different person must approve it. Nothing was changed.',
    );
  return outcome.tier;
}

export async function removeTier(store: TrustDeskStore, input: { chainId: number; token: string; reason: string; actorId: string }) {
  const outcome = await store.removeTier({ ...input, token: input.token.toLowerCase(), reason: input.reason.trim() });
  if (outcome.kind === 'none_set') throw new TrustDeskRefusedError('protocol.tiers.none_set', 'This token has no human tier to remove.');
  return outcome.tier;
}

export async function readChecklists(store: TrustDeskStore, chainId: number, now: Date) {
  return { asOf: now.toISOString(), chainId, checklists: await store.checklists(chainId) };
}

const blankToNull = (v: string | null): string | null => (v === null || v.trim() === '' ? null : v.trim());

export async function openChecklist(store: TrustDeskStore, input: ProtocolOnboardingOpenInput & { chainId: number; openedBy: string }) {
  const outcome = await store.openChecklist({
    ...input,
    pool: input.pool.trim(),
    legalEntity: blankToNull(input.legalEntity),
    routingRegistration: blankToNull(input.routingRegistration),
    tokenContract: input.tokenContract?.toLowerCase() ?? null,
    checkerAddress: input.checkerAddress?.toLowerCase() ?? null,
    wrapperAddress: input.wrapperAddress?.toLowerCase() ?? null,
  });
  if (outcome.kind === 'duplicate')
    throw new TrustDeskRefusedError('protocol.onboarding.duplicate', 'A checklist for this pool is already on this network.');
  return outcome.checklist;
}

export async function approveChecklist(
  store: TrustDeskStore,
  input: { chainId: number; checklistId: string; approverId: string; reason: string },
) {
  const outcome = await store.approveChecklist({ ...input, reason: input.reason.trim() });
  if (outcome.kind === 'unknown')
    throw new TrustDeskRefusedError('protocol.onboarding.unknown', 'That checklist is not open on this network.');
  if (outcome.kind === 'same_approver')
    throw new TrustDeskRefusedError(
      'protocol.onboarding.same_approver',
      'You opened this checklist, so a different person must approve it. Nothing was approved.',
    );
  if (outcome.kind === 'incomplete')
    throw new TrustDeskRefusedError(
      'protocol.onboarding.incomplete',
      `This checklist cannot be approved while it is missing: ${missingWords(outcome.missing)}. Nothing was approved.`,
    );
  return outcome.checklist;
}
