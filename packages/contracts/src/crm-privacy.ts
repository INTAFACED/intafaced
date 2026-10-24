import { z } from 'zod';
import type { Context } from './trpc.js';

const id = z
  .string()
  .guid()
  .transform((value) => value.toLowerCase());
const revision = z.number().int().positive();
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().safe().nonnegative();
export const crmErasureCodeSchema = z.enum([
  'ops.crm.notification_unconfigured',
  'ops.crm.notification_erasure_unknown',
  'ops.crm.notification_in_flight',
]);
export const crmErasurePreviewInputSchema = z.object({ canonicalContactId: id }).strict();
export const crmErasurePreviewSchema = z
  .object({
    canonicalContactId: id,
    canonicalRevision: revision,
    contacts: z
      .array(z.object({ contactId: id, revision }).strict())
      .min(1)
      .max(200),
    submissionIds: z.array(id).max(200),
    counts: z.object({ contacts: count, submissions: count, opportunities: count, tasks: count, messages: count }).strict(),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const crmErasureBeginInputSchema = z
  .object({
    requestId: id,
    canonicalContactId: id,
    expectedCanonicalRevision: revision,
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    confirmedEntireCluster: z.literal(true),
    reason: z.enum(['confirmed_privacy_request', 'approved_retention_policy']),
  })
  .strict();
export const crmErasureAdvanceInputSchema = z.object({ requestId: id, intentId: id, expectedRevision: revision }).strict();
export const crmErasureStatusInputSchema = z.union([z.object({ intentId: id }).strict(), z.object({ canonicalContactId: id }).strict()]);
export const crmErasureStatusSchema = z
  .object({
    intentId: id,
    canonicalContactId: id,
    revision,
    status: z.enum(['pending_notify', 'complete']),
    /** Legacy manual intents remain founder-attributed; automation never impersonates a founder. */
    actorKind: z.enum(['founder', 'system']).default('founder'),
    requestedBy: id.nullable(),
    requestedAt: timestamp,
    completedAt: timestamp.nullable(),
    pendingSubmissionCount: count,
    code: crmErasureCodeSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.actorKind === 'founder') !== (value.requestedBy !== null))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requestedBy'], message: 'Erasure attribution must match its actual actor' });
    if (value.status === 'complete' && (value.completedAt === null || value.pendingSubmissionCount !== 0 || value.code !== null))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Completion requires all original notification erasure receipts' });
    if (value.status === 'pending_notify' && value.completedAt !== null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pending erasure cannot claim completion' });
  });
export const crmRetentionStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('disabled'), reason: z.literal('published_policy_unconfigured') }).strict(),
  z
    .object({
      status: z.literal('configured'),
      inactivityCalendarMonths: z.literal(6),
      clockTimeZone: z.literal('UTC'),
      activeReviewMaxDays: z.literal(30),
      automationEnabled: z.boolean(),
      lastSweepAt: timestamp.nullable(),
    })
    .strict(),
]);
export const crmRetentionReviewStatusInputSchema = z.object({ canonicalContactId: id }).strict();
export const crmRetentionReviewInputSchema = z
  .object({
    requestId: id,
    canonicalContactId: id,
    expectedCanonicalRevision: revision,
    expectedReviewRevision: z.number().int().safe().nonnegative(),
    state: z.enum(['active', 'inactive']),
    evidenceRef: z.string().trim().min(1).max(256),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export const crmRetentionReviewSchema = z
  .object({
    reviewId: id,
    canonicalContactId: id,
    revision,
    state: z.enum(['active', 'inactive']),
    reviewedBy: id,
    reviewedAt: timestamp,
    expiresAt: timestamp.nullable(),
    evidenceRef: z.string().trim().min(1).max(256),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'inactive') {
      if (value.expiresAt !== null)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'Inactive reviews do not exempt a contact' });
      return;
    }
    const reviewedAt = Date.parse(value.reviewedAt);
    const expiresAt = value.expiresAt === null ? NaN : Date.parse(value.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= reviewedAt || expiresAt - reviewedAt > 30 * 24 * 60 * 60 * 1000)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'Active review must expire within 30 days' });
  });

/** Private founder/MFA operations; no email lookup or public deletion authority. */
export interface CrmPrivacyContract {
  privacyPreview(context: Context, input: z.infer<typeof crmErasurePreviewInputSchema>): Promise<z.infer<typeof crmErasurePreviewSchema>>;
  privacyBegin(context: Context, input: z.infer<typeof crmErasureBeginInputSchema>): Promise<z.infer<typeof crmErasureStatusSchema>>;
  /** One bounded remote erasure per call. Identical retries drive the same durable intent and return its current status. */
  privacyAdvance(context: Context, input: z.infer<typeof crmErasureAdvanceInputSchema>): Promise<z.infer<typeof crmErasureStatusSchema>>;
  privacyStatus(context: Context, input: z.infer<typeof crmErasureStatusInputSchema>): Promise<z.infer<typeof crmErasureStatusSchema>>;
  privacyRetentionStatus(context: Context): Promise<z.infer<typeof crmRetentionStatusSchema>>;
  privacyRetentionReviewStatus(
    context: Context,
    input: z.infer<typeof crmRetentionReviewStatusInputSchema>,
  ): Promise<z.infer<typeof crmRetentionReviewSchema> | null>;
  privacyRetentionReview(
    context: Context,
    input: z.infer<typeof crmRetentionReviewInputSchema>,
  ): Promise<z.infer<typeof crmRetentionReviewSchema>>;
}
