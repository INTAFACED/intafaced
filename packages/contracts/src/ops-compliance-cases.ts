/**
 * COMPLIANCE CASES — the shape of case inboxes and the case list (OPS-cases-01).
 *
 * Cases live in svc-ops behind `compliance.*` procedures. This file holds only
 * the wire shapes and typed refusal codes; nothing here picks a number. The
 * list page size is a blank owner value: `limit` is optional on the input so a
 * blank reaches svc-ops' typed refusal (`compliance.cases_list_limit_unset`)
 * instead of a bare "Required", and blank is never a default of 50.
 *
 * Browser-safe: zod and string helpers only.
 */

import { z } from 'zod';

export const COMPLIANCE_INBOX_FORBIDDEN = 'compliance.inbox_forbidden' as const;
export const COMPLIANCE_CASE_NOT_FOUND = 'compliance.case_not_found' as const;
export const COMPLIANCE_QUEUE_ENTITY_UNKNOWN = 'compliance.queue_entity_unknown' as const;
export const COMPLIANCE_CASES_LIST_LIMIT_UNSET = 'compliance.cases_list_limit_unset' as const;
export const COMPLIANCE_QUEUE_NAME_TAKEN = 'compliance.queue_name_taken' as const;

export const COMPLIANCE_CASE_REFUSAL_CODES = [
  COMPLIANCE_INBOX_FORBIDDEN,
  COMPLIANCE_CASE_NOT_FOUND,
  COMPLIANCE_QUEUE_ENTITY_UNKNOWN,
  COMPLIANCE_CASES_LIST_LIMIT_UNSET,
  COMPLIANCE_QUEUE_NAME_TAKEN,
] as const;
export type ComplianceCaseRefusalCode = (typeof COMPLIANCE_CASE_REFUSAL_CODES)[number];

/** What fed the case: mechanism kinds only, never list content. Mirrors `ComplianceQueueKind` in packages/config. */
export const COMPLIANCE_CASE_KINDS = ['screening_hit', 'kyc_review', 'network_flag', 'manual'] as const;
export type ComplianceCaseKind = (typeof COMPLIANCE_CASE_KINDS)[number];

/** The subject types a queue can hold. An unknown one is refused with `compliance.queue_entity_unknown`. */
export const COMPLIANCE_ENTITY_TYPES = ['user', 'business', 'account', 'transfer'] as const;
export type ComplianceEntityType = (typeof COMPLIANCE_ENTITY_TYPES)[number];

/** Status set of OPS-cases-01. OPS-cases-02 adds the rest of the machine. */
export const COMPLIANCE_CASE_STATUSES = ['pending', 'cleared', 'rejected', 'partner_cleared'] as const;
export type ComplianceCaseStatus = (typeof COMPLIANCE_CASE_STATUSES)[number];

export const COMPLIANCE_REVIEW_LEVELS = ['green', 'yellow', 'red'] as const;
export type ComplianceReviewLevel = (typeof COMPLIANCE_REVIEW_LEVELS)[number];

/** alert = raised by a rule or a hit; monitoring = ongoing watch. */
export const COMPLIANCE_CASE_TYPES = ['alert', 'monitoring'] as const;
export type ComplianceCaseType = (typeof COMPLIANCE_CASE_TYPES)[number];

const isoTime = z.string().datetime({ offset: true });
const tag = z.string().trim().min(1).max(40);

export const complianceCaseSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  kind: z.enum(COMPLIANCE_CASE_KINDS),
  type: z.enum(COMPLIANCE_CASE_TYPES),
  /** Opaque subject (identity id, account id). Never a PII payload. */
  subjectId: z.string().min(1).max(128),
  entityType: z.enum(COMPLIANCE_ENTITY_TYPES),
  inboxId: z.string().min(1).max(128),
  status: z.enum(COMPLIANCE_CASE_STATUSES),
  /** Null until a reviewer sets one. */
  reviewLevel: z.enum(COMPLIANCE_REVIEW_LEVELS).nullable(),
  assignee: z.string().min(1).max(128).nullable(),
  tags: z.array(tag).max(20),
  snoozedUntil: isoTime.nullable(),
  /** Null means "not set": the SLA durations are blank owner values. */
  dueAt: isoTime.nullable(),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type ComplianceCase = z.infer<typeof complianceCaseSchema>;

/** What an inbox shows. Every field is optional; an empty filter shows every case of the entity type. */
export const complianceInboxFilterSchema = z.object({
  assignee: z.string().min(1).max(128).optional(),
  closedOnly: z.boolean().optional(),
  unassignedOnly: z.boolean().optional(),
  includeSnoozed: z.boolean().optional(),
  reviewLevels: z.array(z.enum(COMPLIANCE_REVIEW_LEVELS)).max(3).optional(),
  tags: z.array(tag).max(20).optional(),
  createdFrom: isoTime.optional(),
  createdTo: isoTime.optional(),
});
export type ComplianceInboxFilter = z.infer<typeof complianceInboxFilterSchema>;

export const complianceInboxSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
  version: z.number().int().min(1),
  entityType: z.enum(COMPLIANCE_ENTITY_TYPES),
  /** Workflow the inbox's cases follow. Unknown workflows are refused at definition. */
  workflow: z.string().min(1).max(80),
  filter: complianceInboxFilterSchema,
  owner: z.string().min(1).max(128),
  /** Member operator ids. A non-member sees the access panel naming the owner, never the rows. */
  members: z.array(z.string().min(1).max(128)).max(200),
  createdAt: isoTime,
});
export type ComplianceInbox = z.infer<typeof complianceInboxSchema>;

/** One inbox as the caller sees it. A non-member gets no counts and no rows. */
export const complianceInboxEntrySchema = z.object({
  inbox: complianceInboxSchema.omit({ members: true }),
  member: z.boolean(),
  favourite: z.boolean(),
  /** Counted by the service. Null when the caller is not a member. */
  openCount: z.number().int().min(0).nullable(),
});
export type ComplianceInboxEntry = z.infer<typeof complianceInboxEntrySchema>;

/** Business key of a queue definition: a repeat returns the stored definition, never a duplicate. */
export function complianceQueueBusinessKey(name: string, version: number): string {
  return `compliance:queue:${name}:${version}`;
}

export const complianceQueueDefineInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  version: z.number().int().min(1),
  /** A string on the wire so an unknown value reaches the typed refusal instead of a bare enum error. */
  entityType: z.string().trim().min(1).max(40),
  workflow: z.string().trim().min(1).max(80),
  filter: complianceInboxFilterSchema.default({}),
  members: z.array(z.string().min(1).max(128)).max(200).default([]),
});
export type ComplianceQueueDefineInput = z.infer<typeof complianceQueueDefineInputSchema>;

export const complianceCasesListInputSchema = z.object({
  inboxId: z.string().min(1).max(128),
  filter: complianceInboxFilterSchema.default({}),
  /** Group rows by review level (green, yellow, red, unset). */
  groupByReviewLevel: z.boolean().default(false),
  /** Optional so a blank reaches `compliance.cases_list_limit_unset`. */
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).max(600).optional(),
});
export type ComplianceCasesListInput = z.infer<typeof complianceCasesListInputSchema>;

export const complianceCasesListOutputSchema = z.object({
  rows: z.array(complianceCaseSchema),
  /** The total for the inbox and filter, counted by the service, never by the browser. */
  total: z.number().int().min(0),
  nextCursor: z.string().nullable(),
  /** Per review level counts when grouped, else null. `unset` has no level yet. */
  groups: z
    .object({
      green: z.number().int().min(0),
      yellow: z.number().int().min(0),
      red: z.number().int().min(0),
      unset: z.number().int().min(0),
    })
    .nullable(),
});
export type ComplianceCasesListOutput = z.infer<typeof complianceCasesListOutputSchema>;
