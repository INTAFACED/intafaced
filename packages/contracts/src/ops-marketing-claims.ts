import { z } from 'zod';

/**
 * Wire types for the marketing claims evidence register (RC-more-catalogue-24, more-catalogue-claims-register-001).
 *
 * A claim is a sentence the platform would say about itself or a launch ("reserves are held 1:1", "best execution"), with
 * the evidence it rests on. A founder records it; a DIFFERENT founder publishes it, and only when it carries evidence.
 * Until then the register shows the claim with its block: no evidence, or waiting for a second founder. An unpublished
 * claim is never shown to customers. No money moves.
 *
 * Browser-safe: zod only.
 */

/** Publishing a claim that names no evidence. */
export const CLAIM_EVIDENCE_MISSING = 'ops.claim_evidence_missing' as const;
/** The founder who recorded a claim may not publish it: a second founder does. */
export const CLAIM_SELF_APPROVAL = 'ops.claim_self_approval' as const;
export const CLAIM_NOT_FOUND = 'ops.claim_not_found' as const;
/** svc-ops has no durable storage, so no claim can be recorded and none is published. */
export const CLAIMS_STORAGE_UNCONFIGURED = 'ops.claims_storage_unconfigured' as const;

export const CLAIM_TEXT_MAX = 300;
export const CLAIM_TOPIC_MAX = 120;
export const CLAIM_EVIDENCE_MAX = 500;
export const CLAIMS_LIST_LIMIT = 100;

const iso = z.string().datetime({ offset: true });

/** Why a claim cannot be used yet, or null once a second founder published it. */
export const CLAIM_BLOCKS = ['evidence_missing', 'awaiting_approval'] as const;
export type ClaimBlock = (typeof CLAIM_BLOCKS)[number];

export const marketingClaimSchema = z.object({
  id: z.string().uuid(),
  /** What the claim is about: a launch event, a product, or "platform". */
  topic: z.string().trim().min(1).max(CLAIM_TOPIC_MAX),
  text: z.string().trim().min(1).max(CLAIM_TEXT_MAX),
  /** The evidence the claim rests on (a document reference or an https address), or null when none is recorded. */
  evidence: z.string().trim().min(1).max(CLAIM_EVIDENCE_MAX).nullable(),
  status: z.enum(['draft', 'published']),
  block: z.enum(CLAIM_BLOCKS).nullable(),
  authorId: z.string(),
  createdAt: iso,
  approverId: z.string().nullable(),
  publishedAt: iso.nullable(),
});
export type MarketingClaim = z.infer<typeof marketingClaimSchema>;

/** The block a claim shows: none once published; otherwise no evidence first, then waiting for a second founder. */
export function claimBlock(c: Pick<MarketingClaim, 'status' | 'evidence'>): ClaimBlock | null {
  if (c.status === 'published') return null;
  return c.evidence === null ? 'evidence_missing' : 'awaiting_approval';
}

export const claimsListOutputSchema = z.object({
  /** Newest first, drafts included, at most `CLAIMS_LIST_LIMIT`. */
  items: z.array(marketingClaimSchema),
  asOf: iso,
});
export type ClaimsList = z.infer<typeof claimsListOutputSchema>;

/**
 * Record a claim. `key` is the business key the console derives from the founder and the content (`claim:<hash>`): a
 * lost reply sent again finds the same claim.
 */
export const claimRecordInputSchema = z.object({
  key: z.string().regex(/^claim:[0-9a-f]{16,64}$/),
  topic: z.string().trim().min(1).max(CLAIM_TOPIC_MAX),
  text: z.string().trim().min(1).max(CLAIM_TEXT_MAX),
  evidence: z.string().trim().min(1).max(CLAIM_EVIDENCE_MAX).nullable(),
});
export type ClaimRecordInput = z.infer<typeof claimRecordInputSchema>;

export const claimPublishInputSchema = z.object({ id: z.string().uuid() });
export type ClaimPublishInput = z.infer<typeof claimPublishInputSchema>;

export const claimWriteOutputSchema = z.object({
  claim: marketingClaimSchema,
  /** `created` and `published` stored something; `replayed` found the same record already stored; `noop` found it published. */
  outcome: z.enum(['created', 'replayed', 'published', 'noop']),
});
export type ClaimWriteOutput = z.infer<typeof claimWriteOutputSchema>;
