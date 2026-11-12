import type { ProtocolComplianceReport, ProtocolComplianceReview } from '@intafaced/contracts/protocol-address-risk';

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
  'Token tiers': 'Not built yet: svc-protocol keeps no human tier record (D-launch-listing-02), so no tier can be set or removed here.',
  Blocklist: 'Not built yet: svc-protocol and svc-dex keep no token blocklist (D-launch-listing-02), so nothing can be blocked here.',
  'Name tags': 'Not built yet: svc-protocol keeps no public name tag request (D-launch-listing-01), so none can be approved here.',
  'Pool halts': 'Not built yet: no pool halt record reaches routing (D-launch-listing-07), so no pool can be halted here.',
  'Permissioned pools':
    'Not built yet: svc-protocol keeps no permissioned pool onboarding checklist (D-liquidity-07), so none can be approved here.',
};

export const reportWords = (r: Pick<ProtocolComplianceReport, 'duplicatesRefused'>): string | null =>
  r.duplicatesRefused === 0
    ? null
    : `Duplicate from the same reporter refused ${r.duplicatesRefused === 1 ? 'once' : `${r.duplicatesRefused} times`}`;

export const pendingReview = (r: ProtocolComplianceReport): ProtocolComplianceReview | null =>
  r.reviews.find((v) => v.status === 'pending') ?? null;

export const publishedWords = (r: ProtocolComplianceReport): string[] =>
  r.reviews.filter((v) => v.status === 'published').map((v) => `Public: ${v.kind}`);

const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'protocol.compliance.same_reviewer': 'You asked for this label, so a different person must approve it. Nothing was published.',
  'protocol.compliance.review_pending': 'A label of this kind is already waiting for a second reviewer on this report.',
  'protocol.compliance.report_unknown': 'That report is not in the queue on this network.',
  'protocol.compliance.review_unknown': 'That label review is not in the queue on this network.',
};
export const trustRefusalWords = (code: string | null): string | null =>
  code !== null && Object.hasOwn(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code]! : null;
