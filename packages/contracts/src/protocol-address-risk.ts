import { z } from 'zod';

/**
 * Wire types for the address risk card and the scam report queue (D-developer-compliance-01), version 1: svc-protocol's
 * `addressRisk.read` (public) and `addressReports.submit` (signed in). The card shows the published labels with their
 * reasons, the highest reputation among them and the open-report count. A count only: who reported and what they wrote
 * are for compliance and never cross this wire to the public. The sanctioned set comes only from an AML list source;
 * while none is connected the card says the list is not loaded (`vendor.aml`), never that the address is clear.
 */
export const PROTOCOL_ADDRESS_RISK_CONTRACT_VERSION = 1 as const;

export const ADDRESS_LABEL_KINDS = ['name', 'exchange', 'risk', 'sanctioned', 'phishing', 'contract_type'] as const;
export const ADDRESS_LABEL_SOURCES = ['curator', 'user_report', 'vendor', 'owner_proof'] as const;
/** Lowest to highest: the card shows the highest among the published labels. */
export const ADDRESS_REPUTATIONS = ['UNKNOWN', 'OK', 'CAUTION', 'UNSAFE'] as const;
export const ADDRESS_REPORT_KINDS = ['scam', 'phishing', 'impersonation', 'other'] as const;
export type AddressReputation = (typeof ADDRESS_REPUTATIONS)[number];
export type AddressReportKind = (typeof ADDRESS_REPORT_KINDS)[number];

export const PROTOCOL_ADDRESS_REPORT_REFUSALS = [
  /** The same person already has an open report for this address on this chain. */
  'protocol.reports.duplicate',
  /** The address is not an EVM address. */
  'protocol.reports.address_invalid',
  /** The evidence link is not an http(s) link, or the note is too long. */
  'protocol.reports.evidence_invalid',
] as const;
export type ProtocolAddressReportRefusal = (typeof PROTOCOL_ADDRESS_REPORT_REFUSALS)[number];

/** Engineering bounds on the wire, not owner values. */
export const ADDRESS_REPORT_NOTE_MAX = 1000;
export const ADDRESS_REPORT_EVIDENCE_MAX = 500;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const protocolAddressRiskInputSchema = z.object({ address });
export const protocolAddressLabelSchema = z.object({
  kind: z.enum(ADDRESS_LABEL_KINDS),
  value: z.string(),
  source: z.enum(ADDRESS_LABEL_SOURCES),
  reputation: z.enum(ADDRESS_REPUTATIONS),
  reason: z.string(),
  /** Only ever an http(s) link (the table refuses anything else), so the card can show it as a link. */
  evidenceUrl: z
    .string()
    .regex(/^https?:\/\//)
    .nullable(),
  setAt: z.string(),
  version: z.number().int().positive(),
});
export const protocolAddressRiskSchema = z.object({
  chainId: z.number().int(),
  address: z.string(),
  /** The highest reputation among the published labels; UNKNOWN with none. Never "clear". */
  reputation: z.enum(ADDRESS_REPUTATIONS),
  labels: z.array(protocolAddressLabelSchema),
  /** Open reports about this address: a count, never who reported or what they wrote. */
  openReports: z.number().int().nonnegative(),
  /** Whether a sanctions screening list is connected. `not_loaded` means nothing was checked, not that it is clean. */
  screening: z.object({ status: z.enum(['not_loaded', 'loaded']), code: z.literal('vendor.aml').nullable() }),
});
export type ProtocolAddressLabel = z.infer<typeof protocolAddressLabelSchema>;
export type ProtocolAddressRisk = z.infer<typeof protocolAddressRiskSchema>;

export const protocolAddressReportInputSchema = z.object({
  address,
  kind: z.enum(ADDRESS_REPORT_KINDS),
  evidenceUrl: z.string().max(ADDRESS_REPORT_EVIDENCE_MAX).optional(),
  note: z.string().max(ADDRESS_REPORT_NOTE_MAX).optional(),
});
export const protocolAddressReportReceiptSchema = z.object({
  id: z.string(),
  chainId: z.number().int(),
  address: z.string(),
  kind: z.enum(ADDRESS_REPORT_KINDS),
  createdAt: z.string(),
});
export type ProtocolAddressReportInput = z.infer<typeof protocolAddressReportInputSchema>;
export type ProtocolAddressReportReceipt = z.infer<typeof protocolAddressReportReceiptSchema>;

/**
 * The compliance queue (D-developer-compliance-01, J-dex-protocol-30 #1 #2), version 1: svc-protocol's operator reads and
 * writes under `compliance.*`. An operator sees each report with who filed it and how many duplicates by the same person
 * were refused. A label is published only by two different people: the first asks, the second approves, and the label,
 * its history row and the report's status change in one transaction.
 */
export const PROTOCOL_COMPLIANCE_REFUSALS = [
  /** The report is not in the queue. */
  'protocol.compliance.report_unknown',
  /** The review is not pending, or does not exist. */
  'protocol.compliance.review_unknown',
  /** The person who asked cannot be the second reviewer. */
  'protocol.compliance.same_reviewer',
  /** A review for this report and label kind is already pending. */
  'protocol.compliance.review_pending',
] as const;
export type ProtocolComplianceRefusal = (typeof PROTOCOL_COMPLIANCE_REFUSALS)[number];

export const ADDRESS_LABEL_REASON_MAX = 500;

export const protocolComplianceReviewSchema = z.object({
  id: z.string(),
  kind: z.enum(ADDRESS_LABEL_KINDS),
  reason: z.string(),
  status: z.enum(['pending', 'published']),
  requesterId: z.string(),
  approverId: z.string().nullable(),
  askedAt: z.string(),
  decidedAt: z.string().nullable(),
});
export const protocolComplianceReportSchema = z.object({
  id: z.string(),
  chainId: z.number().int(),
  address: z.string(),
  kind: z.enum(ADDRESS_REPORT_KINDS),
  /** Compliance only: the signed-in person who filed it. Never on the public read. */
  reporterId: z.string(),
  note: z.string().nullable(),
  evidenceUrl: z.string().nullable(),
  status: z.enum(['open', 'published', 'dismissed']),
  /** How many further reports by the same person about the same address were refused as duplicates. */
  duplicatesRefused: z.number().int().nonnegative(),
  createdAt: z.string(),
  reviews: z.array(protocolComplianceReviewSchema),
});
export const protocolComplianceReportsOutputSchema = z.object({
  asOf: z.string(),
  chainId: z.number().int(),
  reports: z.array(protocolComplianceReportSchema),
});
export const protocolComplianceLabelAskInputSchema = z.object({
  reportId: z.string().uuid(),
  kind: z.enum(ADDRESS_LABEL_KINDS),
  reason: z.string().trim().min(1).max(ADDRESS_LABEL_REASON_MAX),
});
export const protocolComplianceLabelApproveInputSchema = z.object({ reviewId: z.string().uuid() });
export type ProtocolComplianceReview = z.infer<typeof protocolComplianceReviewSchema>;
export type ProtocolComplianceReport = z.infer<typeof protocolComplianceReportSchema>;
export type ProtocolComplianceReportsOutput = z.infer<typeof protocolComplianceReportsOutputSchema>;

/**
 * Human token tiers (D-launch-listing-02, J-dex-protocol-30 #4), version 1: svc-protocol's `compliance.tiers.*`. A human
 * tier is a recorded review, not an audit or an endorsement. One person asks, a different person approves, and only then is
 * it shown, with its date and reason. Removing it returns the token to the tier it had before, and every ask, approval and
 * removal is an audit row. The automated tier stays "unknown" while the owner's trust criteria are blank.
 */
export const HUMAN_TOKEN_TIERS = ['verified', 'unverified', 'banned'] as const;
export type HumanTokenTier = (typeof HUMAN_TOKEN_TIERS)[number];
/** The tier a token has with no human tier set: the owner's criteria are blank, so nothing is judged. */
export const AUTOMATED_TOKEN_TIER = 'unknown' as const;

export const PROTOCOL_TIER_REFUSALS = [
  /** The person who asked cannot be the second approver. */
  'protocol.tiers.same_approver',
  /** A tier change for this token is already waiting for a second approver. */
  'protocol.tiers.request_pending',
  /** The request is not pending, or does not exist. */
  'protocol.tiers.request_unknown',
  /** The token has no human tier to remove. */
  'protocol.tiers.none_set',
] as const;
export type ProtocolTierRefusal = (typeof PROTOCOL_TIER_REFUSALS)[number];

export const protocolTokenTierSchema = z.object({
  token: z.string(),
  /** The human tier in force, or null when only the automated tier applies. */
  tier: z.enum(HUMAN_TOKEN_TIERS).nullable(),
  /** What removal returns to: the earlier human tier, or null for the automated tier. */
  priorTier: z.enum(HUMAN_TOKEN_TIERS).nullable(),
  reason: z.string().nullable(),
  since: z.string().nullable(),
  requesterId: z.string().nullable(),
  approverId: z.string().nullable(),
  pending: z
    .object({ id: z.string(), tier: z.enum(HUMAN_TOKEN_TIERS), reason: z.string(), requesterId: z.string(), askedAt: z.string() })
    .nullable(),
});
export const protocolTierAuditSchema = z.object({
  id: z.string(),
  token: z.string(),
  action: z.enum(['asked', 'approved', 'removed']),
  tier: z.enum(HUMAN_TOKEN_TIERS),
  /** For a removal, the tier it returned to (null: the automated tier). */
  returnedTo: z.enum(HUMAN_TOKEN_TIERS).nullable(),
  reason: z.string(),
  actorId: z.string(),
  at: z.string(),
});
export const protocolTokenTiersOutputSchema = z.object({
  asOf: z.string(),
  chainId: z.number().int(),
  tiers: z.array(protocolTokenTierSchema),
  audit: z.array(protocolTierAuditSchema),
});
export const protocolTierAskInputSchema = z.object({
  token: address,
  tier: z.enum(HUMAN_TOKEN_TIERS),
  reason: z.string().trim().min(1).max(ADDRESS_LABEL_REASON_MAX),
});
export const protocolTierApproveInputSchema = z.object({ requestId: z.string().uuid() });
export const protocolTierRemoveInputSchema = z.object({ token: address, reason: z.string().trim().min(1).max(ADDRESS_LABEL_REASON_MAX) });
export type ProtocolTokenTier = z.infer<typeof protocolTokenTierSchema>;
export type ProtocolTierAudit = z.infer<typeof protocolTierAuditSchema>;
export type ProtocolTokenTiersOutput = z.infer<typeof protocolTokenTiersOutputSchema>;

/**
 * Permissioned pool onboarding (D-liquidity-07, J-dex-protocol-30 #9), version 1: svc-protocol's `compliance.onboarding.*`.
 * A checklist names the legal entity, the token contract, the allowlist checker, the wrapper and the routing registration.
 * A checklist with any of them missing cannot be approved, and the person who opened it cannot approve it.
 */
export const ONBOARDING_ITEMS = ['legalEntity', 'tokenContract', 'checkerAddress', 'wrapperAddress', 'routingRegistration'] as const;
export type OnboardingItem = (typeof ONBOARDING_ITEMS)[number];

export const PROTOCOL_ONBOARDING_REFUSALS = [
  /** A required item is blank: the refusal names which. */
  'protocol.onboarding.incomplete',
  /** The person who opened the checklist cannot approve it. */
  'protocol.onboarding.same_approver',
  /** The checklist is not open, or does not exist. */
  'protocol.onboarding.unknown',
  /** A checklist for this pool name is already open. */
  'protocol.onboarding.duplicate',
] as const;
export type ProtocolOnboardingRefusal = (typeof PROTOCOL_ONBOARDING_REFUSALS)[number];

const optionalAddress = address.nullable();
export const protocolOnboardingChecklistSchema = z.object({
  id: z.string(),
  pool: z.string(),
  legalEntity: z.string().nullable(),
  tokenContract: optionalAddress,
  checkerAddress: optionalAddress,
  wrapperAddress: optionalAddress,
  routingRegistration: z.string().nullable(),
  /** The items still blank, in checklist order; approval needs none. */
  missing: z.array(z.enum(ONBOARDING_ITEMS)),
  status: z.enum(['open', 'approved']),
  openedBy: z.string(),
  approvedBy: z.string().nullable(),
  approvalReason: z.string().nullable(),
  openedAt: z.string(),
  approvedAt: z.string().nullable(),
});
export const protocolOnboardingOutputSchema = z.object({
  asOf: z.string(),
  chainId: z.number().int(),
  checklists: z.array(protocolOnboardingChecklistSchema),
});
export const POOL_NAME_MAX = 120;
export const protocolOnboardingOpenInputSchema = z.object({
  pool: z.string().trim().min(1).max(POOL_NAME_MAX),
  legalEntity: z.string().trim().max(200).nullable(),
  tokenContract: optionalAddress,
  checkerAddress: optionalAddress,
  wrapperAddress: optionalAddress,
  routingRegistration: z.string().trim().max(200).nullable(),
});
export const protocolOnboardingApproveInputSchema = z.object({
  checklistId: z.string().uuid(),
  reason: z.string().trim().min(1).max(ADDRESS_LABEL_REASON_MAX),
});
export type ProtocolOnboardingChecklist = z.infer<typeof protocolOnboardingChecklistSchema>;
export type ProtocolOnboardingOpenInput = z.infer<typeof protocolOnboardingOpenInputSchema>;
