import {
  AUTOMATED_TOKEN_TIER,
  type OnboardingItem,
  type ProtocolComplianceReport,
  type ProtocolComplianceReview,
  type ProtocolNameTagRequest,
  type ProtocolTokenTier,
} from '@intafaced/contracts/protocol-address-risk';

/**
 * The Protocol trust desk's words (J-dex-protocol-30): what the console says about a report and its label reviews, and the
 * tabs it shows. A tab whose records svc-protocol does not keep yet says so with the slice it waits for; nothing in it
 * pretends to act.
 */
export const TRUST_TABS = [
  'Scam reports',
  'Token tiers',
  'Trust criteria',
  'Blocklist',
  'Name tags',
  'Pool halts',
  'Permissioned pools',
  'Audit and disclosures',
] as const;
export type TrustTab = (typeof TRUST_TABS)[number];

/** The tabs this console cannot act on yet, each with what it waits for. */
export const TRUST_TAB_WAITS: Readonly<Partial<Record<TrustTab, string>>> = {
  Blocklist: 'Not built yet: svc-protocol and svc-dex keep no token blocklist (D-launch-listing-02), so nothing can be blocked here.',
  'Pool halts': 'Not built yet: no pool halt record reaches routing (D-launch-listing-07), so no pool can be halted here.',
};

export const reportWords = (r: Pick<ProtocolComplianceReport, 'duplicatesRefused'>): string | null =>
  r.duplicatesRefused === 0
    ? null
    : `Duplicate from the same reporter refused ${r.duplicatesRefused === 1 ? 'once' : `${r.duplicatesRefused} times`}`;

export const pendingReview = (r: ProtocolComplianceReport): ProtocolComplianceReview | null =>
  r.reviews.find((v) => v.status === 'pending') ?? null;

export const publishedWords = (r: ProtocolComplianceReport): string[] =>
  r.reviews.filter((v) => v.status === 'published').map((v) => `Public: ${v.kind}. Why: ${v.reason}`);

const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'protocol.compliance.same_reviewer': 'You asked for this label, so a different person must approve it. Nothing was published.',
  'protocol.compliance.review_pending': 'A label of this kind is already waiting for a second reviewer on this report.',
  'protocol.compliance.report_unknown': 'That report is not in the queue on this network.',
  'protocol.compliance.review_unknown': 'That label review is not in the queue on this network.',
  'protocol.tiers.same_approver': 'You asked for this tier, so a different person must approve it. Nothing was changed.',
  'protocol.tiers.request_pending': 'A tier change for this token is already waiting for a second approver.',
  'protocol.tiers.request_unknown': 'That tier change is not waiting for approval on this network.',
  'protocol.tiers.none_set': 'This token has no human tier to remove.',
  'protocol.onboarding.incomplete': 'This checklist has a blank item, so it cannot be approved. Nothing was approved.',
  'protocol.onboarding.same_approver': 'You opened this checklist, so a different person must approve it. Nothing was approved.',
  'protocol.onboarding.unknown': 'That checklist is not open on this network.',
  'protocol.onboarding.duplicate': 'A checklist for this pool is already on this network.',
  'protocol.nametags.no_proof':
    'No proof of ownership is stored for this address, so its name tag cannot be approved. Nothing was approved.',
  'protocol.nametags.same_approver':
    'You already approved this name tag, so a different person must give the second approval. Nothing was changed.',
  'protocol.nametags.request_unknown': 'That name tag is not waiting for approval on this network.',
  'protocol.nametags.request_pending': 'A name tag for this address is already waiting for approval.',
};
export const trustRefusalWords = (code: string | null): string | null =>
  code !== null && Object.hasOwn(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code]! : null;

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** "13 Nov 2026", the day a tier came into force (UTC). */
export const tierDay = (iso: string): string => DAY.format(new Date(iso));

/**
 * A token's tier cell: the human tier with its day, or the automated tier, and a pending change after it. Never a tier
 * that is not approved.
 */
export function tierWords(t: Pick<ProtocolTokenTier, 'tier' | 'since' | 'pending'> | null): string {
  const now = t?.tier && t.since ? `${t.tier} · since ${tierDay(t.since)}` : AUTOMATED_TOKEN_TIER;
  return t?.pending ? `${now} · ${t.pending.tier} pending` : now;
}

const ITEM_WORDS: Readonly<Record<OnboardingItem, string>> = {
  legalEntity: 'Legal entity',
  tokenContract: 'Token contract',
  checkerAddress: 'Checker address',
  wrapperAddress: 'Wrapper address',
  routingRegistration: 'Routing registration',
};
export const onboardingItemWords = (item: OnboardingItem): string => ITEM_WORDS[item];
export const missingItemWords = (missing: readonly OnboardingItem[]): string[] => missing.map((m) => `${ITEM_WORDS[m]} missing`);

/** A name tag's state: public, or how many of its two approvals it has, and whether a proof of ownership is on file. */
export function nameTagWords(r: Pick<ProtocolNameTagRequest, 'status' | 'approvals' | 'proof'>): string {
  const proof = r.proof ? `Ownership proven by ${r.proof.signer} at block ${r.proof.blockNumber}` : 'No proof of ownership';
  if (r.status === 'public') return `Public · ${proof}`;
  return `${r.approvals.length} of 2 approvals · ${proof}`;
}
