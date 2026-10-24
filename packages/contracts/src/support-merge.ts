/**
 * Support merge contract (SP-tickets-07): fold a duplicate request (the source) into the one that stays (the survivor).
 *
 * Browser safe: nothing here imports Node.
 *
 * Rules carried by the shapes below:
 * - Both requests must be below resolved (open, pending or on hold) and belong to the same requester account. A request is
 *   never merged into someone else's: its messages would land in a thread the requester does not own.
 * - A merge cannot be undone. The source's messages and files move under the survivor, and the source ends `closed` with
 *   `mergedInto` set. A rating or an escalation case file stays on the source.
 * - A merge writes a `merged` trail row on both requests in the same transaction as the move.
 * - The key is (source, survivor): a replay returns the stored result and moves nothing twice.
 */
import { z } from 'zod';

export const SUPPORT_MERGE_ERROR_CODES = ['support.merge_not_allowed', 'support.merge_same_ticket'] as const;
export type SupportMergeErrorCode = (typeof SUPPORT_MERGE_ERROR_CODES)[number];

/** Short enough that the trail note (500) holds the reason with the other request's id. */
export const SUPPORT_MERGE_REASON_MAX = 400;

const reasonSchema = z.string().trim().min(1).max(SUPPORT_MERGE_REASON_MAX);

export const supportMergeInputSchema = z
  .object({
    sourceId: z.string().guid(),
    survivorId: z.string().guid(),
    reason: reasonSchema,
  })
  .strict();
export type SupportMergeInput = z.infer<typeof supportMergeInputSchema>;

export const supportMergeResultSchema = z
  .object({
    sourceId: z.string().guid(),
    survivorId: z.string().guid(),
    commentsMoved: z.number().int().nonnegative(),
    attachmentsMoved: z.number().int().nonnegative(),
    mergedAt: z.string().datetime(),
  })
  .strict();
export type SupportMergeResult = z.infer<typeof supportMergeResultSchema>;

/** What a merge would do, read before the confirmation. Moves nothing. */
export const supportMergePreviewInputSchema = z.object({ sourceId: z.string().guid(), survivorId: z.string().guid() }).strict();
export type SupportMergePreviewInput = z.infer<typeof supportMergePreviewInputSchema>;

export const supportMergePreviewSchema = z
  .object({
    sourceId: z.string().guid(),
    survivorId: z.string().guid(),
    /** Null when the merge is allowed; otherwise the typed code a merge would give. */
    refusal: z.enum(SUPPORT_MERGE_ERROR_CODES).nullable(),
    commentsToMove: z.number().int().nonnegative(),
    attachmentsToMove: z.number().int().nonnegative(),
    /** The source keeps these: a rating and an escalation case file are not moved. */
    staysOnSource: z.object({ rating: z.boolean(), caseFile: z.boolean() }).strict(),
    /** True when this merge was already made; the stored result is returned on a replay. */
    alreadyMerged: z.boolean(),
  })
  .strict();
export type SupportMergePreview = z.infer<typeof supportMergePreviewSchema>;
