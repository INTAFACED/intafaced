import { z } from 'zod';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';
import {
  escalateTicketInputSchema,
  setKbAudienceInputSchema,
  supportAccountGroundingSchema,
  supportCaseFileSchema,
  supportCommentSchema,
  supportInternalNoteInputSchema,
  supportKbArticleSchema,
  supportTicketLifecycleSchema,
  supportTicketPropertiesSchema,
  supportTicketPropertyChangeSchema,
  supportTicketSchema,
  supportTicketStatusSchema,
  supportViewCountsSchema,
} from './support.js';
import { supportBulkInputSchema, supportBulkPolicySchema, supportBulkResultSchema } from './support-bulk.js';
import {
  supportMacroAppliedSchema,
  supportMacroApplyInputSchema,
  supportMacroListSchema,
  supportSignatureSchema,
  supportSignatureSetInputSchema,
} from './support-macros.js';
import {
  supportMergeInputSchema,
  supportMergePreviewInputSchema,
  supportMergePreviewSchema,
  supportMergeResultSchema,
} from './support-merge.js';
import { supportExpectedSequenceSchema } from './support-workspace.js';

/**
 * svc-support's operator desk: the queue, one request's staff reads and writes, saved views, groups, staff, routing,
 * macros and the help articles a lead publishes, one record per call. Every call is `support:ops` (the desk's) except
 * `comment`, which a customer also sends on their own request (`support:write`), and `listKb`, which anyone may read. svc-support
 * takes the operator from the verified caller, never from the input. svc-support mounts each from here (`router.ts`,
 * `desk-routing-router.ts`, `desk-macros-router.ts`, `ticket-links-router.ts`) and the admin desk calls each by its record.
 */

/** How a lead routes a group's requests (SP-routing-01). */
export const SUPPORT_ROUTING_MODES = ['off', 'round_robin', 'load_balanced'] as const;
/** The most skills one agent holds. */
export const SUPPORT_SKILLS_MAX = 20;
/** The customer's own records a request may link to (J-support-public-20 #1). */
export const SUPPORT_TICKET_LINK_KINDS = ['order', 'withdrawal', 'deposit'] as const;
/** What a request waits with when no agent can take it. */
export const SUPPORT_NO_AGENT_AVAILABLE = 'support.no_agent_available' as const;

/** Each refusal by its code, with the status svc-support sends it with (`record-refusal.ts` `supportTrpcError`, `desk-macros-router.ts`). */
const STATUS = {
  'support.not_found': 'NOT_FOUND',
  'support.not_lead': 'FORBIDDEN',
  'support.not_staff': 'FORBIDDEN',
  'support.idempotency_conflict': 'CONFLICT',
  'support.stale_ticket': 'CONFLICT',
  'support.client_request_id_required': 'BAD_REQUEST',
  'support.comment_secret_refused': 'BAD_REQUEST',
  // Labels and saved views (`desk-views.ts`).
  'support.label_invalid': 'BAD_REQUEST',
  // Claiming, returning and assigning a request (`operator-queue.ts` `ClaimRefuse`).
  'support.claim.not_found': 'NOT_FOUND',
  'support.claim.not_queueable': 'PRECONDITION_FAILED',
  'support.claim.already_claimed': 'CONFLICT',
  'support.claim.invalid_operator': 'PRECONDITION_FAILED',
  'support.claim.not_assignee': 'BAD_REQUEST',
  'support.claim.queue_empty': 'PRECONDITION_FAILED',
  'support.release.not_found': 'NOT_FOUND',
  'support.release.not_queueable': 'PRECONDITION_FAILED',
  'support.release.already_claimed': 'BAD_REQUEST',
  'support.release.invalid_operator': 'BAD_REQUEST',
  'support.release.not_assignee': 'FORBIDDEN',
  'support.assign.not_found': 'NOT_FOUND',
  'support.assign.not_queueable': 'PRECONDITION_FAILED',
  'support.assign.already_claimed': 'BAD_REQUEST',
  'support.assign.invalid_operator': 'BAD_REQUEST',
  'support.assign.not_assignee': 'BAD_REQUEST',
  // One request's reads and writes.
  'support.identity_grounding_unwired': 'PRECONDITION_FAILED',
  'support.rating_window_invalid': 'PRECONDITION_FAILED',
  'support.comment.terminal': 'PRECONDITION_FAILED',
  'support.comment_cap_reached': 'PRECONDITION_FAILED',
  'support.comment_cap_unset': 'PRECONDITION_FAILED',
  'support.note_empty': 'BAD_REQUEST',
  'support.hold_reason_required': 'PRECONDITION_FAILED',
  'support.settle.refused': 'PRECONDITION_FAILED',
  'support.transition_illegal': 'PRECONDITION_FAILED',
  'support.transition_same_status': 'PRECONDITION_FAILED',
  'support.escalation.terminal': 'PRECONDITION_FAILED',
  'support.case_file.ungrounded': 'PRECONDITION_FAILED',
  'support.case_file.empty_summary': 'PRECONDITION_FAILED',
  'support.property_invalid': 'BAD_REQUEST',
  'support.ticket_closed': 'PRECONDITION_FAILED',
  'support.merge_not_allowed': 'PRECONDITION_FAILED',
  'support.merge_same_ticket': 'PRECONDITION_FAILED',
  'support.bulk_cap_unset': 'PRECONDITION_FAILED',
  'support.bulk_too_large': 'BAD_REQUEST',
  // Groups, staff and routing (`desk-groups.ts`, `desk-staff.ts`, `desk-routing.ts`).
  'support.group_name_taken': 'CONFLICT',
  'support.group_unknown': 'NOT_FOUND',
  'support.group_member_duplicate': 'CONFLICT',
  'support.availability_invalid': 'BAD_REQUEST',
  'support.routing_mode_invalid': 'BAD_REQUEST',
  'support.capacity_invalid': 'BAD_REQUEST',
  'support.skill_invalid': 'BAD_REQUEST',
  // Macros and signatures (`desk-macros-router.ts`).
  'support.macro_not_found': 'NOT_FOUND',
  'support.macro_revision_stale': 'CONFLICT',
  'support.macro_placeholder_blank': 'BAD_REQUEST',
  // Help articles (`kb-catalog.ts`).
  'support.list_kb_limit_unset': 'PRECONDITION_FAILED',
  'support.kb_invalid': 'BAD_REQUEST',
  'support.kb_revision_stale': 'CONFLICT',
  'support.kb_section_unknown': 'PRECONDITION_FAILED',
  'support.kb_vendor_name': 'BAD_REQUEST',
  'support.kb_version_unknown': 'PRECONDITION_FAILED',
  'support.kb_audience_invalid': 'BAD_REQUEST',
} as const satisfies Record<string, RefusalStatus>;
type Code = keyof typeof STATUS;
const refuse = (...codes: Code[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

const CLAIM = [
  'support.claim.not_found',
  'support.claim.not_queueable',
  'support.claim.already_claimed',
  'support.claim.invalid_operator',
  'support.claim.not_assignee',
] as const;
const RELEASE = [
  'support.release.not_found',
  'support.release.not_queueable',
  'support.release.already_claimed',
  'support.release.invalid_operator',
  'support.release.not_assignee',
] as const;
const ASSIGN = [
  'support.assign.not_found',
  'support.assign.not_queueable',
  'support.assign.already_claimed',
  'support.assign.invalid_operator',
  'support.assign.not_assignee',
] as const;
const TRANSITION = [
  'support.transition_illegal',
  'support.transition_same_status',
  'support.settle.refused',
  'support.hold_reason_required',
] as const;

const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;
const OPS = { caller: 'scope', scope: 'support:ops' } as const;
const TICKET = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const guid = z.string().guid();
const ticketInput = z.object({ ticketId: guid });
const pageSize = z.number().int().positive().max(500).optional();

// The answers no other contract describes yet, as svc-support has always sent them.

/** A customer's rating of one request. */
export const supportTicketRatingSchema = z.object({
  ticketId: z.string().guid(),
  userId: z.string().guid(),
  score: z.number().int(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const supportRatingSummarySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  solved: z.number().int(),
  responses: z.number().int(),
  perScore: z.object({ '1': z.number().int(), '2': z.number().int(), '3': z.number().int(), '4': z.number().int(), '5': z.number().int() }),
  ratedShareBasisPoints: z.number().int().nullable(),
});

const availability = z.enum(['online', 'busy', 'offline']);
export const supportStaffMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(['agent', 'lead']),
  appointedBy: z.string(),
  appointedAt: z.string(),
  availability,
  availabilitySetAt: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
});
const groupRef = z.object({ id: z.string(), name: z.string() });
/** A `staffList` row: the member and the desk groups (teams) they belong to, sorted by name. */
export const supportStaffDirectoryRowSchema = supportStaffMemberSchema.extend({ groups: z.array(groupRef) });
export const supportStaffPolicySchema = z.object({
  automaticOffline: z.enum(['set', 'not_set']),
  heartbeatWindowSeconds: z.number().int().positive().nullable(),
});

export const supportDeskGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  memberIds: z.array(z.string()),
});
export const supportDeskScopeSchema = z.object({ restricted: z.boolean(), groups: z.array(groupRef), seesAllGroups: z.boolean() });

const routingMode = z.enum(SUPPORT_ROUTING_MODES);
/** What one routing pass did with one request. */
export const supportRouteOutcomeSchema = z.union([
  z.object({ status: z.literal('assigned'), ticketId: z.string(), assigneeId: z.string(), groupId: z.string(), mode: routingMode }),
  z.object({ status: z.literal('queued'), ticketId: z.string(), groupId: z.string(), code: z.literal(SUPPORT_NO_AGENT_AVAILABLE) }),
  z.object({
    status: z.literal('skipped'),
    ticketId: z.string(),
    reason: z.enum(['not_found', 'not_queueable', 'already_assigned', 'ungrouped', 'routing_unset', 'routing_off']),
  }),
]);
export const supportGroupRoutingSchema = z.object({
  groupId: z.string(),
  mode: routingMode,
  cursorUserId: z.string().nullable(),
  revision: z.number().int(),
  setBy: z.string(),
  setAt: z.string(),
});
export const supportStaffRoutingSchema = z.object({
  userId: z.string(),
  capacity: z.number().int().nullable(),
  skills: z.array(z.string()),
});
export const supportRoutingOverviewSchema = z.object({
  groups: z.array(
    z.object({
      groupId: z.string(),
      name: z.string(),
      mode: routingMode.nullable(),
      cursorUserId: z.string().nullable(),
      setBy: z.string().nullable(),
      setAt: z.string().nullable(),
    }),
  ),
  staff: z.array(supportStaffRoutingSchema),
  sweepSeconds: z.number().int().positive().nullable(),
});
const routingState = z.enum(['assigned', 'no_agent']).nullable();
export const supportTicketRoutingSchema = z.object({
  ticketId: z.string(),
  requiredSkill: z.string().nullable(),
  state: routingState,
  code: z.literal(SUPPORT_NO_AGENT_AVAILABLE).nullable(),
  stateAt: z.string().nullable(),
});
export const supportRoutingWaitingSchema = z.array(
  z.object({ ticketId: z.string(), code: z.literal(SUPPORT_NO_AGENT_AVAILABLE), since: z.string().nullable() }),
);
export const supportAvailabilityLogSchema = z.array(
  z.object({ userId: z.string(), availability, by: z.string(), reason: z.string().nullable(), at: z.string() }),
);
export const supportGroupLogSchema = z.array(
  z.object({ groupId: z.string(), action: z.string(), subject: z.string().nullable(), by: z.string(), at: z.string() }),
);
const skill = z.string().trim().min(1).max(40);

/** One link from a request to one of the customer's own records. */
export const supportTicketLinkSchema = z.object({
  ticketId: z.string(),
  kind: z.enum(SUPPORT_TICKET_LINK_KINDS),
  recordId: z.string(),
  recoveryRequired: z.boolean(),
  linkedBy: z.string(),
  linkedAt: z.string(),
});

// Saved views.

export const SUPPORT_DESK_VIEWS_COUNTS = defineProcedure({
  ...base,
  name: 'support.viewsCounts',
  kind: 'query',
  path: 'viewsCounts',
  access: OPS,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportViewCountsSchema,
  samples: [{ verdict: 'accept' }],
});

// One request, read by the desk.

export const SUPPORT_DESK_PROPERTY_CHANGES = defineProcedure({
  ...base,
  name: 'support.propertyChanges',
  kind: 'query',
  path: 'propertyChanges',
  access: OPS,
  refusals: refuse('support.not_found'),
  input: z.object({ ticketId: guid, limit: z.number().int().positive().max(500) }),
  output: z.array(supportTicketPropertyChangeSchema),
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, limit: 100 } },
    { verdict: 'refuse', input: { ticketId: TICKET } },
  ],
});

export const SUPPORT_DESK_CASE_FILE = defineProcedure({
  ...base,
  name: 'support.caseFile',
  kind: 'query',
  path: 'caseFile',
  access: OPS,
  refusals: refuse('support.not_found'),
  input: ticketInput,
  /** null: the request was never escalated. */
  output: supportCaseFileSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET } },
    { verdict: 'refuse', input: { ticketId: 'not-a-ticket' } },
  ],
});

export const SUPPORT_DESK_RATING = defineProcedure({
  ...base,
  name: 'support.ratingOps',
  kind: 'query',
  path: 'ratingOps',
  access: OPS,
  refusals: refuse('support.not_found'),
  input: ticketInput,
  /** null: the customer has not rated. */
  output: supportTicketRatingSchema.nullable(),
  accept: {
    scoreInRange: {
      says: 'a rating scores 1 to 5',
      holds: (reply) => {
        const read = supportTicketRatingSchema.nullable().safeParse(reply);
        if (!read.success) return false;
        const rating = read.data;
        return rating === null || (rating.score >= 1 && rating.score <= 5);
      },
    },
  },
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET } },
    { verdict: 'refuse', input: {} },
  ],
});

export const SUPPORT_DESK_TICKET_PROPERTIES = defineProcedure({
  ...base,
  name: 'support.ticketProperties',
  kind: 'query',
  path: 'ticketProperties',
  access: OPS,
  refusals: refuse('support.not_found'),
  input: ticketInput,
  output: supportTicketPropertiesSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET } },
    { verdict: 'refuse', input: { ticketId: 7 } },
  ],
});

export const SUPPORT_DESK_ACCOUNT_STATE = defineProcedure({
  ...base,
  name: 'support.accountState',
  kind: 'query',
  path: 'accountState',
  access: OPS,
  refusals: refuse('support.identity_grounding_unwired', 'support.not_found'),
  /** Strict: a `userId` is refused, never silently dropped. The account comes off the request. */
  input: z.object({ ticketId: guid }).strict(),
  output: supportAccountGroundingSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET } },
    { verdict: 'refuse', input: { ticketId: TICKET, userId: OTHER } },
  ],
});

export const SUPPORT_DESK_TICKET_LINKS = defineProcedure({
  ...base,
  name: 'support.ticketLinks',
  kind: 'query',
  path: 'ticketLinks',
  access: OPS,
  refusals: refuse('support.not_found'),
  input: z.object({ ticketId: guid }).strict(),
  output: z.array(supportTicketLinkSchema),
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET } },
    { verdict: 'refuse', input: { ticketId: TICKET, kind: 'order' } },
  ],
});

export const SUPPORT_DESK_TICKET_LIFECYCLE = defineProcedure({
  ...base,
  name: 'support.ticketLifecycle',
  kind: 'query',
  path: 'ticketLifecycle',
  access: OPS,
  refusals: refuse('support.not_found'),
  input: ticketInput,
  output: supportTicketLifecycleSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET } },
    { verdict: 'refuse', input: { ticketId: '' } },
  ],
});

export const SUPPORT_DESK_RATING_SUMMARY = defineProcedure({
  ...base,
  name: 'support.ratingSummary',
  kind: 'query',
  path: 'ratingSummary',
  access: OPS,
  refusals: refuse('support.rating_window_invalid'),
  input: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
  output: supportRatingSummarySchema,
  accept: {
    countsAddUp: {
      says: 'counts are not negative, the five scores add up to the responses, no more responses than requests solved, and the rated share is blank exactly when nothing was solved (at most 10000 basis points)',
      holds: (reply) => {
        const read = supportRatingSummarySchema.safeParse(reply);
        if (!read.success) return false;
        const s = read.data;
        const scores = Object.values(s.perScore);
        if (s.solved < 0 || s.responses < 0 || scores.some((n) => n < 0)) return false;
        if (scores.reduce((a, b) => a + b, 0) !== s.responses || s.responses > s.solved) return false;
        return s.ratedShareBasisPoints === null ? s.solved === 0 : s.ratedShareBasisPoints >= 0 && s.ratedShareBasisPoints <= 10_000;
      },
    },
  },
  samples: [
    { verdict: 'accept', input: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' } },
    { verdict: 'refuse', input: { from: '2026-11-01' } },
  ],
});

export const SUPPORT_DESK_PREVIEW_MERGE = defineProcedure({
  ...base,
  name: 'support.previewMerge',
  kind: 'query',
  path: 'previewMerge',
  access: OPS,
  refusals: refuse('support.not_found'),
  input: supportMergePreviewInputSchema,
  output: supportMergePreviewSchema,
  samples: [
    { verdict: 'accept', input: { sourceId: TICKET, survivorId: OTHER } },
    { verdict: 'refuse', input: { sourceId: TICKET } },
  ],
});

export const SUPPORT_DESK_BULK_POLICY = defineProcedure({
  ...base,
  name: 'support.bulkPolicy',
  kind: 'query',
  path: 'bulkPolicy',
  access: OPS,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportBulkPolicySchema,
  accept: {
    missingOnlyWhileBlank: {
      says: 'the missing key is named exactly while the batch size is blank',
      holds: (reply) => {
        const read = supportBulkPolicySchema.safeParse(reply);
        if (!read.success) return false;
        const p = read.data;
        return (p.cap === null) === (p.missing !== null);
      },
    },
  },
  samples: [{ verdict: 'accept' }],
});

// One request, changed by the desk.

export const SUPPORT_DESK_CLAIM = defineProcedure({
  ...base,
  name: 'support.claim',
  kind: 'mutation',
  path: 'claim',
  access: OPS,
  refusals: refuse(...CLAIM),
  input: ticketInput,
  output: supportTicketSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET } },
    { verdict: 'refuse', input: { ticketId: 'not-a-ticket' } },
  ],
});

export const SUPPORT_DESK_CLAIM_NEXT = defineProcedure({
  ...base,
  name: 'support.claimNext',
  kind: 'mutation',
  path: 'claimNext',
  access: OPS,
  refusals: refuse(...CLAIM, 'support.claim.queue_empty'),
  input: NO_INPUT,
  output: supportTicketSchema,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_UNCLAIM = defineProcedure({
  ...base,
  name: 'support.unclaim',
  kind: 'mutation',
  path: 'unclaim',
  access: OPS,
  refusals: refuse(...RELEASE, 'support.idempotency_conflict'),
  input: z.object({ ticketId: guid, idempotencyKey: z.string().min(8).max(200) }),
  output: supportTicketSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, idempotencyKey: `admin-unclaim:${TICKET}:${OTHER}:3` } },
    { verdict: 'refuse', input: { ticketId: TICKET, idempotencyKey: 'short' } },
  ],
});

export const SUPPORT_DESK_ASSIGN = defineProcedure({
  ...base,
  name: 'support.assign',
  kind: 'mutation',
  path: 'assign',
  access: OPS,
  refusals: refuse(...ASSIGN, 'support.idempotency_conflict', 'support.not_lead', 'support.not_staff'),
  input: z.object({ ticketId: guid, assigneeId: guid, idempotencyKey: z.string().min(8).max(200) }),
  output: supportTicketSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, assigneeId: OTHER, idempotencyKey: `admin-assign:${TICKET}:${OTHER}:3` } },
    { verdict: 'refuse', input: { ticketId: TICKET, idempotencyKey: `admin-assign:${TICKET}:${OTHER}:3` } },
  ],
});

export const SUPPORT_DESK_INTERNAL_NOTE = defineProcedure({
  ...base,
  name: 'support.addInternalNote',
  kind: 'mutation',
  path: 'addInternalNote',
  access: OPS,
  refusals: refuse(
    'support.client_request_id_required',
    'support.comment_secret_refused',
    'support.idempotency_conflict',
    'support.not_found',
    'support.note_empty',
  ),
  input: supportInternalNoteInputSchema,
  output: supportCommentSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, body: 'Checked the deposit.', clientRequestId: 'admin-note:1' } },
    { verdict: 'refuse', input: { ticketId: TICKET, body: 'Checked the deposit.' } },
  ],
});

export const SUPPORT_DESK_SET_STATUS = defineProcedure({
  ...base,
  name: 'support.setStatus',
  kind: 'mutation',
  path: 'setStatus',
  access: OPS,
  refusals: refuse(...TRANSITION, 'support.comment_secret_refused', 'support.not_found', 'support.stale_ticket'),
  input: z.object({
    ticketId: guid,
    status: supportTicketStatusSchema,
    /** Optional short reason, recorded on the trail row. */
    note: z.string().min(1).max(500).optional(),
    /** The last trail row (`sequence`) the operator read: a newer row by someone else refuses `support.stale_ticket`. */
    expectedSequence: supportExpectedSequenceSchema.optional(),
  }),
  output: supportTicketSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, status: 'pending' } },
    { verdict: 'refuse', input: { ticketId: TICKET, status: 'deleted' } },
  ],
});

export const SUPPORT_DESK_ESCALATE = defineProcedure({
  ...base,
  name: 'support.escalate',
  kind: 'mutation',
  path: 'escalate',
  access: OPS,
  refusals: refuse(
    'support.comment_secret_refused',
    'support.escalation.terminal',
    'support.identity_grounding_unwired',
    'support.not_found',
    'support.case_file.ungrounded',
    'support.case_file.empty_summary',
  ),
  input: escalateTicketInputSchema,
  output: supportCaseFileSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, reason: 'other', summary: 'The customer asks about a deposit.' } },
    { verdict: 'refuse', input: { ticketId: TICKET, reason: 'other', summary: '' } },
  ],
});

export const SUPPORT_DESK_SET_PROPERTIES = defineProcedure({
  ...base,
  name: 'support.setProperties',
  kind: 'mutation',
  path: 'setProperties',
  access: OPS,
  refusals: refuse(
    'support.client_request_id_required',
    'support.idempotency_conflict',
    'support.label_invalid',
    'support.not_found',
    'support.property_invalid',
    'support.stale_ticket',
    'support.ticket_closed',
  ),
  /** Values arrive as text so a bad one reaches svc-support and is refused by name, not by a schema message. */
  input: z.object({
    ticketId: guid,
    priority: z.string().max(40).nullable().optional(),
    ticketType: z.string().max(40).nullable().optional(),
    labels: z.array(z.string().max(200)).max(200).optional(),
    reason: z.string().min(1).max(500).optional(),
    clientRequestId: z.string().min(1).max(200),
    /** The last trail row (`sequence`) the operator read: a newer row by someone else refuses `support.stale_ticket`. */
    expectedSequence: supportExpectedSequenceSchema.optional(),
  }),
  output: supportTicketPropertiesSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, priority: 'high', clientRequestId: 'admin-properties:1' } },
    { verdict: 'refuse', input: { ticketId: TICKET, priority: 'high' } },
  ],
});

export const SUPPORT_DESK_MERGE = defineProcedure({
  ...base,
  name: 'support.mergeTickets',
  kind: 'mutation',
  path: 'mergeTickets',
  access: OPS,
  refusals: refuse('support.merge_not_allowed', 'support.merge_same_ticket', 'support.not_found'),
  input: supportMergeInputSchema,
  output: supportMergeResultSchema,
  samples: [
    { verdict: 'accept', input: { sourceId: TICKET, survivorId: OTHER, reason: 'Same deposit question.' } },
    { verdict: 'refuse', input: { sourceId: TICKET, survivorId: OTHER } },
  ],
});

export const SUPPORT_DESK_BULK_UPDATE = defineProcedure({
  ...base,
  name: 'support.bulkUpdate',
  kind: 'mutation',
  path: 'bulkUpdate',
  access: OPS,
  /** A batch is refused whole only here; each request's own refusal is a row of the answer. */
  refusals: refuse(
    ...ASSIGN,
    ...TRANSITION,
    'support.bulk_cap_unset',
    'support.bulk_too_large',
    'support.client_request_id_required',
    'support.comment_secret_refused',
    'support.idempotency_conflict',
    'support.label_invalid',
    'support.not_found',
    'support.not_lead',
    'support.not_staff',
    'support.property_invalid',
    'support.stale_ticket',
    'support.ticket_closed',
  ),
  input: supportBulkInputSchema,
  checks: { request_once: { at: 'input', says: 'a request appears once in a batch' } },
  output: supportBulkResultSchema,
  samples: [
    { verdict: 'accept', input: { batchKey: 'admin-bulk:1:abcdefgh', ticketIds: [TICKET], change: { kind: 'status', status: 'pending' } } },
    {
      verdict: 'refuse',
      by: 'request_once',
      input: { batchKey: 'admin-bulk:1:abcdefgh', ticketIds: [TICKET, TICKET], change: { kind: 'status', status: 'pending' } },
    },
    { verdict: 'refuse', input: { batchKey: 'admin-bulk:1:abcdefgh', ticketIds: [], change: { kind: 'status', status: 'pending' } } },
  ],
});

// Groups and staff.

export const SUPPORT_DESK_STAFF_LIST = defineProcedure({
  ...base,
  name: 'support.staffList',
  kind: 'query',
  path: 'staffList',
  access: OPS,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.array(supportStaffDirectoryRowSchema),
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_STAFF_POLICY = defineProcedure({
  ...base,
  name: 'support.staffAvailabilityPolicy',
  kind: 'query',
  path: 'staffAvailabilityPolicy',
  access: OPS,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportStaffPolicySchema,
  accept: {
    windowOnlyWhenSet: {
      says: 'automatic offline is set exactly when the window has a value',
      holds: (reply) => {
        const read = supportStaffPolicySchema.safeParse(reply);
        if (!read.success) return false;
        const p = read.data;
        return (p.automaticOffline === 'set') === (p.heartbeatWindowSeconds !== null);
      },
    },
  },
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_STAFF_SET_AVAILABILITY = defineProcedure({
  ...base,
  name: 'support.staffSetAvailability',
  kind: 'mutation',
  path: 'staffSetAvailability',
  access: OPS,
  refusals: refuse('support.availability_invalid', 'support.not_lead', 'support.not_staff'),
  /** Omit `userId` for one's own; a lead may set anyone's. A value outside the three is refused by name. */
  input: z.object({ userId: guid.optional(), availability: z.string().max(20), reason: z.string().max(500).optional() }),
  output: supportStaffMemberSchema,
  samples: [
    { verdict: 'accept', input: { availability: 'busy' } },
    { verdict: 'refuse', input: { availability: 'busy', userId: 'not-a-user' } },
  ],
});

export const SUPPORT_DESK_AVAILABILITY_LOG = defineProcedure({
  ...base,
  name: 'support.staffAvailabilityLog',
  kind: 'query',
  path: 'staffAvailabilityLog',
  access: OPS,
  refusals: refuse('support.not_staff'),
  input: z.object({ userId: z.string().min(1).max(200).optional() }).optional(),
  output: supportAvailabilityLogSchema,
  samples: [{ verdict: 'accept' }, { verdict: 'accept', input: { userId: OTHER } }, { verdict: 'refuse', input: { userId: '' } }],
});

export const SUPPORT_DESK_GROUPS_LIST = defineProcedure({
  ...base,
  name: 'support.groupsList',
  kind: 'query',
  path: 'groupsList',
  access: OPS,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.array(supportDeskGroupSchema),
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_SCOPE = defineProcedure({
  ...base,
  name: 'support.deskScope',
  kind: 'query',
  path: 'deskScope',
  access: OPS,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportDeskScopeSchema,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_GROUPS_SAVE = defineProcedure({
  ...base,
  name: 'support.groupsSave',
  kind: 'mutation',
  path: 'groupsSave',
  access: OPS,
  refusals: refuse('support.group_name_taken', 'support.group_unknown', 'support.idempotency_conflict', 'support.not_lead'),
  /** A new group, or a rename when `groupId` is given. */
  input: z.object({ groupId: guid.optional(), name: z.string().trim().min(1).max(80), idempotencyKey: z.string().min(8).max(200) }),
  output: supportDeskGroupSchema,
  samples: [
    { verdict: 'accept', input: { name: 'Deposits', idempotencyKey: 'group:deposits:1' } },
    { verdict: 'refuse', input: { name: 'Deposits', idempotencyKey: 'short' } },
  ],
});

export const SUPPORT_DESK_GROUPS_ADD_MEMBER = defineProcedure({
  ...base,
  name: 'support.groupsAddMember',
  kind: 'mutation',
  path: 'groupsAddMember',
  access: OPS,
  refusals: refuse('support.group_member_duplicate', 'support.group_unknown', 'support.not_lead', 'support.not_staff'),
  input: z.object({ groupId: guid, userId: guid }),
  output: supportDeskGroupSchema,
  samples: [
    { verdict: 'accept', input: { groupId: TICKET, userId: OTHER } },
    { verdict: 'refuse', input: { groupId: TICKET } },
  ],
});

export const SUPPORT_DESK_GROUPS_REMOVE_MEMBER = defineProcedure({
  ...base,
  name: 'support.groupsRemoveMember',
  kind: 'mutation',
  path: 'groupsRemoveMember',
  access: OPS,
  refusals: refuse('support.group_unknown', 'support.not_lead'),
  input: z.object({ groupId: guid, userId: guid }),
  output: supportDeskGroupSchema,
  samples: [
    { verdict: 'accept', input: { groupId: TICKET, userId: OTHER } },
    { verdict: 'refuse', input: { groupId: TICKET, userId: 'someone' } },
  ],
});

export const SUPPORT_DESK_GROUPS_LOG = defineProcedure({
  ...base,
  name: 'support.groupsLog',
  kind: 'query',
  path: 'groupsLog',
  access: OPS,
  refusals: refuse('support.group_unknown', 'support.not_staff'),
  input: z.object({ groupId: guid }),
  output: supportGroupLogSchema,
  samples: [
    { verdict: 'accept', input: { groupId: TICKET } },
    { verdict: 'refuse', input: {} },
  ],
});

// Routing, capacity and skills (SP-routing-01).

export const SUPPORT_DESK_ROUTING_OVERVIEW = defineProcedure({
  ...base,
  name: 'support.routingOverview',
  kind: 'query',
  path: 'routingOverview',
  access: OPS,
  refusals: refuse('support.not_staff'),
  input: NO_INPUT,
  output: supportRoutingOverviewSchema,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_ROUTING_WAITING = defineProcedure({
  ...base,
  name: 'support.routingWaiting',
  kind: 'query',
  path: 'routingWaiting',
  access: OPS,
  refusals: refuse('support.not_staff'),
  input: NO_INPUT,
  output: supportRoutingWaitingSchema,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_TICKET_ROUTING = defineProcedure({
  ...base,
  name: 'support.ticketRouting',
  kind: 'query',
  path: 'ticketRouting',
  access: OPS,
  refusals: refuse('support.not_staff'),
  input: z.object({ ticketId: guid }),
  output: supportTicketRoutingSchema,
  accept: {
    codeOnlyWhenWaiting: {
      says: 'the no-agent code is present exactly when no agent could take the request',
      holds: (reply) => {
        const read = supportTicketRoutingSchema.safeParse(reply);
        if (!read.success) return false;
        const r = read.data;
        return (r.state === 'no_agent') === (r.code === SUPPORT_NO_AGENT_AVAILABLE);
      },
    },
  },
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET } },
    { verdict: 'refuse', input: { ticketId: 'not-a-ticket' } },
  ],
});

export const SUPPORT_DESK_ROUTING_SET_MODE = defineProcedure({
  ...base,
  name: 'support.routingSetMode',
  kind: 'mutation',
  path: 'routingSetMode',
  access: OPS,
  refusals: refuse('support.group_unknown', 'support.not_lead', 'support.not_staff', 'support.routing_mode_invalid'),
  input: z.object({ groupId: guid, mode: routingMode }),
  output: z.object({ routing: supportGroupRoutingSchema, routed: z.array(supportRouteOutcomeSchema) }),
  samples: [
    { verdict: 'accept', input: { groupId: TICKET, mode: 'round_robin' } },
    { verdict: 'refuse', input: { groupId: TICKET, mode: 'random' } },
  ],
});

export const SUPPORT_DESK_STAFF_SET_ROUTING = defineProcedure({
  ...base,
  name: 'support.staffSetRouting',
  kind: 'mutation',
  path: 'staffSetRouting',
  access: OPS,
  refusals: refuse('support.capacity_invalid', 'support.not_lead', 'support.not_staff', 'support.skill_invalid'),
  /** A blank (null) capacity is never assigned automatically. */
  input: z.object({
    userId: z.string().min(1).max(200),
    capacity: z.number().int().nullable(),
    skills: z.array(skill).max(SUPPORT_SKILLS_MAX),
  }),
  output: supportStaffRoutingSchema,
  samples: [
    { verdict: 'accept', input: { userId: OTHER, capacity: 5, skills: ['deposits'] } },
    { verdict: 'refuse', input: { userId: OTHER, capacity: 1.5, skills: [] } },
  ],
});

export const SUPPORT_DESK_TICKET_SET_SKILL = defineProcedure({
  ...base,
  name: 'support.ticketSetRequiredSkill',
  kind: 'mutation',
  path: 'ticketSetRequiredSkill',
  access: OPS,
  refusals: refuse('support.not_lead', 'support.not_staff', 'support.skill_invalid'),
  input: z.object({ ticketId: guid, skill: skill.nullable() }),
  output: z.object({
    routing: z.object({ ticketId: z.string(), requiredSkill: z.string().nullable(), state: routingState, stateAt: z.string().nullable() }),
    outcome: supportRouteOutcomeSchema,
  }),
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, skill: 'deposits' } },
    { verdict: 'accept', input: { ticketId: TICKET, skill: null } },
    { verdict: 'refuse', input: { ticketId: TICKET } },
  ],
});

// Macros and the agent's own signature (SP-desk-02).

export const SUPPORT_DESK_MACROS = defineProcedure({
  ...base,
  name: 'support.macros',
  kind: 'query',
  path: 'macros',
  access: OPS,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportMacroListSchema,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_MACRO_APPLY = defineProcedure({
  ...base,
  name: 'support.macroApply',
  kind: 'query',
  path: 'macroApply',
  access: OPS,
  refusals: refuse('support.macro_not_found', 'support.not_found'),
  input: supportMacroApplyInputSchema,
  output: supportMacroAppliedSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, macroId: OTHER } },
    { verdict: 'refuse', input: { ticketId: TICKET } },
  ],
});

export const SUPPORT_DESK_SIGNATURE = defineProcedure({
  ...base,
  name: 'support.signature',
  kind: 'query',
  path: 'signature',
  access: OPS,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportSignatureSchema,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_SIGNATURE_SET = defineProcedure({
  ...base,
  name: 'support.signatureSet',
  kind: 'mutation',
  path: 'signatureSet',
  access: OPS,
  refusals: refuse('support.macro_placeholder_blank', 'support.macro_revision_stale'),
  input: supportSignatureSetInputSchema,
  output: supportSignatureSchema,
  samples: [
    { verdict: 'accept', input: { signature: 'The support team', expectedRevision: 0 } },
    { verdict: 'refuse', input: { signature: 'The support team' } },
  ],
});

// Help articles a lead publishes.

export const SUPPORT_DESK_LIST_KB = defineProcedure({
  ...base,
  name: 'support.listKb',
  kind: 'query',
  path: 'listKb',
  /** Anyone may read the published articles; staff also see the staff-only ones. */
  access: { caller: 'public' },
  refusals: refuse('support.list_kb_limit_unset'),
  input: z.object({ limit: pageSize }).optional(),
  output: z.array(supportKbArticleSchema),
  samples: [
    { verdict: 'accept', input: { limit: 100 } },
    { verdict: 'refuse', input: { limit: 501 } },
  ],
});

export const SUPPORT_DESK_PUBLISH_KB = defineProcedure({
  ...base,
  name: 'support.publishKb',
  kind: 'mutation',
  path: 'publishKb',
  access: OPS,
  refusals: refuse(
    'support.kb_invalid',
    'support.kb_revision_stale',
    'support.kb_section_unknown',
    'support.kb_vendor_name',
    'support.kb_version_unknown',
  ),
  input: z.object({
    id: z.string().min(1).max(200),
    titleKey: z.string().min(1).max(200),
    bodyKey: z.string().min(1).max(200),
    /** 0 creates a new published row at revision 1. */
    baseRevision: z.number().int().nonnegative(),
    category: z.string().min(1).max(200).nullable().optional(),
    tags: z.array(z.string().min(1).max(200)).max(20).nullable().optional(),
  }),
  output: supportKbArticleSchema,
  samples: [
    { verdict: 'accept', input: { id: 'deposits', titleKey: 'kb.deposits.title', bodyKey: 'kb.deposits.body', baseRevision: 0 } },
    { verdict: 'refuse', input: { id: 'deposits', titleKey: 'kb.deposits.title', bodyKey: 'kb.deposits.body', baseRevision: -1 } },
  ],
});

export const SUPPORT_DESK_UNPUBLISH_KB = defineProcedure({
  ...base,
  name: 'support.unpublishKb',
  kind: 'mutation',
  path: 'unpublishKb',
  access: OPS,
  refusals: refuse('support.kb_invalid', 'support.kb_revision_stale'),
  input: z.object({ id: z.string().min(1).max(200), baseRevision: z.number().int().positive() }),
  output: supportKbArticleSchema,
  samples: [
    { verdict: 'accept', input: { id: 'deposits', baseRevision: 1 } },
    { verdict: 'refuse', input: { id: 'deposits', baseRevision: 0 } },
  ],
});

export const SUPPORT_DESK_SET_KB_AUDIENCE = defineProcedure({
  ...base,
  name: 'support.setKbAudience',
  kind: 'mutation',
  path: 'setKbAudience',
  access: OPS,
  refusals: refuse('support.kb_audience_invalid', 'support.kb_invalid', 'support.kb_revision_stale'),
  input: setKbAudienceInputSchema,
  output: supportKbArticleSchema,
  samples: [
    { verdict: 'accept', input: { id: 'deposits', baseRevision: 1, audience: 'signed_in' } },
    { verdict: 'refuse', input: { id: 'deposits', baseRevision: 1, audience: 'everyone' } },
  ],
});

/** Every record of svc-support's operator desk. */
export const SUPPORT_DESK_PROCEDURES = [
  SUPPORT_DESK_VIEWS_COUNTS,
  SUPPORT_DESK_PROPERTY_CHANGES,
  SUPPORT_DESK_CASE_FILE,
  SUPPORT_DESK_RATING,
  SUPPORT_DESK_TICKET_PROPERTIES,
  SUPPORT_DESK_ACCOUNT_STATE,
  SUPPORT_DESK_TICKET_LINKS,
  SUPPORT_DESK_TICKET_LIFECYCLE,
  SUPPORT_DESK_RATING_SUMMARY,
  SUPPORT_DESK_PREVIEW_MERGE,
  SUPPORT_DESK_BULK_POLICY,
  SUPPORT_DESK_CLAIM,
  SUPPORT_DESK_CLAIM_NEXT,
  SUPPORT_DESK_UNCLAIM,
  SUPPORT_DESK_ASSIGN,
  SUPPORT_DESK_INTERNAL_NOTE,
  SUPPORT_DESK_SET_STATUS,
  SUPPORT_DESK_ESCALATE,
  SUPPORT_DESK_SET_PROPERTIES,
  SUPPORT_DESK_MERGE,
  SUPPORT_DESK_BULK_UPDATE,
  SUPPORT_DESK_STAFF_LIST,
  SUPPORT_DESK_STAFF_POLICY,
  SUPPORT_DESK_STAFF_SET_AVAILABILITY,
  SUPPORT_DESK_AVAILABILITY_LOG,
  SUPPORT_DESK_GROUPS_LIST,
  SUPPORT_DESK_SCOPE,
  SUPPORT_DESK_GROUPS_SAVE,
  SUPPORT_DESK_GROUPS_ADD_MEMBER,
  SUPPORT_DESK_GROUPS_REMOVE_MEMBER,
  SUPPORT_DESK_GROUPS_LOG,
  SUPPORT_DESK_ROUTING_OVERVIEW,
  SUPPORT_DESK_ROUTING_WAITING,
  SUPPORT_DESK_TICKET_ROUTING,
  SUPPORT_DESK_ROUTING_SET_MODE,
  SUPPORT_DESK_STAFF_SET_ROUTING,
  SUPPORT_DESK_TICKET_SET_SKILL,
  SUPPORT_DESK_MACROS,
  SUPPORT_DESK_MACRO_APPLY,
  SUPPORT_DESK_SIGNATURE,
  SUPPORT_DESK_SIGNATURE_SET,
  SUPPORT_DESK_LIST_KB,
  SUPPORT_DESK_PUBLISH_KB,
  SUPPORT_DESK_UNPUBLISH_KB,
  SUPPORT_DESK_SET_KB_AUDIENCE,
] as const;
