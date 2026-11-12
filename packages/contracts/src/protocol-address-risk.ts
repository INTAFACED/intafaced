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
