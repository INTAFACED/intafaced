import { z } from 'zod';

/** Wire shapes for `screening.*` (the compliance desk). Strict inputs; ids and amounts only, never a name or address. */
const kind = z.enum(['payout', 'withdrawal']);
const status = z.enum(['clear', 'review', 'refuse', 'unavailable']);
const key = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.string().trim().min(3).max(500);
const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);

export const caseListInputSchema = z
  .object({
    /** Required, like every list in this service: a blank page size is not 50. */
    limit: z.number().int().min(1).max(200),
    status: status.optional(),
    subjectKind: kind.optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const caseKeyInputSchema = z.object({ subjectKind: kind, caseId: key }).strict();

export const caseDecideInputSchema = z
  .object({
    subjectKind: kind,
    caseId: key,
    decision: z.enum(['release', 'uphold']),
    reason,
    /** Identity-issued second-person approval, bound to this case and reason. Needed to release; not to uphold. */
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  })
  .strict();

export const caseRescreenInputSchema = z.object({ subjectKind: kind, caseId: key, reason }).strict();

export const caseViewSchema = z
  .object({
    subjectKind: kind,
    caseId: key,
    status,
    /** Reason codes only. */
    factors: z.array(z.string()),
    /** Who answered. `none` means no supplier is connected, so the case is a refusal, not a verdict. */
    provider: z.string().nullable(),
    partyRef: z.string().nullable(),
    amount: decimal.nullable(),
    assetId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    decision: z.enum(['released', 'upheld']).nullable(),
    decidedBy: z.string().nullable(),
    approverId: z.string().nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: z.string().nullable(),
    releaseExpiresAt: z.string().nullable(),
    releaseSpentAt: z.string().nullable(),
  })
  .strict();
export type CaseView = z.infer<typeof caseViewSchema>;

export const caseEventViewSchema = z
  .object({
    id: z.string(),
    seq: z.string(),
    action: z.enum(['release', 'uphold', 'rescreen', 'release_spent']),
    actorId: z.string(),
    approverId: z.string().nullable(),
    fromStatus: status,
    toStatus: status,
    reason: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const caseDetailSchema = z.object({ case: caseViewSchema, events: z.array(caseEventViewSchema) }).strict();
export const caseListSchema = z.object({ rows: z.array(caseViewSchema), nextCursor: z.string().nullable() }).strict();

export const listStatusSchema = z
  .object({
    /** `blank`: no counsel-grade list is configured, so no send can be cleared. */
    posture: z.enum(['blank', 'named']),
    grade: z.enum(['unconfigured', 'fixture', 'counsel']),
    regionCount: z.number().int().min(0),
    /** Whether a screening supplier is connected. */
    supplier: z.enum(['none', 'connected']),
    /** Whether a release can be issued: needs a named list and an owner-set time-to-live. */
    releaseTtlSeconds: z.number().int().positive().nullable(),
  })
  .strict();
export type ListStatus = z.infer<typeof listStatusSchema>;
