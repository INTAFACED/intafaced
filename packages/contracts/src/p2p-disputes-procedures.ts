import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { P2P_MODERATION } from './p2p-procedures.js';
import { disputeOutput, evidenceOutput, MAX_EVIDENCE_PER_CALL } from './p2p-call-schemas.js';
import { jsonValueSchema } from './procedure-strict-schema.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-p2p `disputes.*`, one record per call: svc-p2p mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-p2p', module: 'p2p', transport: 'trpc' } as const;

/**
 * OPERATOR COUNTS for the queue — open / overdue / escalated / neverSeen.
 *
 * `/internal/moderation-backlog` already serves this to service callers.
 * Without a tRPC surface, an allowlisted moderator with ordinary
 * `p2p:read` could list rows but not see the SLA shape of the backlog
 * (the number that grows when nobody is on shift). Same gate as `list`.
 */
export const P2P_DISPUTES_BACKLOG = defineProcedure({
  ...base,
  name: 'p2p.disputes.backlog',
  kind: 'query',
  path: 'disputes.backlog',
  access: { caller: 'scope', scope: 'p2p:read', module: 'p2p' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    open: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
    neverSeen: z.number().int().nonnegative(),
    moderationConfigured: z.boolean(),
    moderation: P2P_MODERATION,
  }),
  samples: [{ verdict: 'accept' }],
});

/**
 * THE MODERATOR QUEUE. Open disputes, most overdue first, paginated.
 *
 * Before this existed a moderator could only call `.get({ tradeId })` and
 * had to already know the id — which meant, in practice, that nobody
 * could reach a dispute at all, and a seven-day timer refunded every one
 * of them without a person ever seeing it.
 *
 * Scoped to `p2p:read` (a real session can hold it) and then gated by
 * `assertModerator`: either `admin:compliance` or membership of
 * `P2P_MODERATOR_USER_IDS`. An empty allowlist honest-refuses with
 * `p2p.moderation_unreachable` — mounted is not the same as reachable.
 */
export const P2P_DISPUTES_LIST = defineProcedure({
  ...base,
  name: 'p2p.disputes.list',
  kind: 'query',
  path: 'disputes.list',
  access: { caller: 'scope', scope: 'p2p:read', module: 'p2p', check: 'merchantApi' },
  refusals: {},
  input: z
    .object({
      status: z.enum(['open', 'resolved']).optional(),
      /**
       * Page size. Optional here so omit reaches the service named
       * refuse (`p2p.dispute_list_limit_unset`) instead of a Zod
       * "Required" that looks like a typo. Blank is not 50; pass 50
       * explicitly when that is the page you want.
       */
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().max(200).nullable().optional(),
    })
    .optional(),
  output: z.object({ disputes: z.array(disputeOutput), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * A moderator re-arms an open dispute the way the timeout sweep does.
 * No escrow movement. The same clientRequestId returns the first result.
 */
export const P2P_DISPUTES_ESCALATE = defineProcedure({
  ...base,
  name: 'p2p.disputes.escalate',
  kind: 'mutation',
  path: 'disputes.escalate',
  access: { caller: 'scope', scope: 'p2p:read', module: 'p2p', check: 'merchantApi' },
  refusals: {},
  input: z.object({
    disputeId: z.string().guid(),
    reason: z.string().min(1).max(2000),
    clientRequestId: z.string().min(1).max(128),
  }),
  output: z.object({
    disputeId: z.string().guid(),
    tradeId: z.string().guid(),
    escalatedAt: z.string(),
    escalations: z.number().int(),
    deadlineAt: z.string(),
    actorId: z.string(),
    reason: z.string(),
    replay: z.boolean(),
  }),
  samples: [
    { verdict: 'accept', input: { disputeId: '11111111-1111-4111-8111-111111111111', reason: 'USDC', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const P2P_DISPUTES_GET = defineProcedure({
  ...base,
  name: 'p2p.disputes.get',
  kind: 'query',
  path: 'disputes.get',
  access: { caller: 'scope', scope: 'p2p:read', module: 'p2p', check: 'merchantApi' },
  refusals: {},
  input: z.object({ tradeId: z.string().guid() }),
  output: disputeOutput,
  samples: [
    { verdict: 'accept', input: { tradeId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const P2P_DISPUTES_OPEN = defineProcedure({
  ...base,
  name: 'p2p.disputes.open',
  kind: 'mutation',
  path: 'disputes.open',
  access: { caller: 'scope', scope: 'p2p:write', module: 'p2p', check: 'merchantApi' },
  refusals: {},
  input: z.object({
    tradeId: z.string().guid(),
    reason: z.string().min(1).max(2000),
    evidence: z.array(jsonValueSchema).max(MAX_EVIDENCE_PER_CALL).optional(),
  }),
  output: z.object({
    disputeId: z.string().guid(),
    tradeId: z.string().guid(),
    chatThreadId: z.string().guid(),
    deadlineAt: z.string(),
    /**
     * THE DISPOSITION, DISCLOSED BEFORE IT CAN HAPPEN.
     *
     * The ADR asks that a party entering a dispute be told what happens
     * if nobody rules. The honest answer is now short, and it is this
     * literal rather than a configurable string because there is no
     * configuration that could make it say anything else.
     */
    ifNobodyRules: z.literal('escalated_and_held'),
    /**
     * Whether this deployment has named human moderators. False means
     * the dispute will escalate-and-hold with nobody able to resolve
     * until an operator sets `P2P_MODERATOR_USER_IDS` — disclosed here
     * so a client never implies a console is watching. Named ids are
     * configured, not a live probe of a person on shift.
     */
    moderationConfigured: z.boolean(),
    moderation: P2P_MODERATION,
  }),
  samples: [
    { verdict: 'accept', input: { tradeId: '11111111-1111-4111-8111-111111111111', reason: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * ADD EVIDENCE TO AN OPEN DISPUTE. A party, and append-only.
 *
 * There is no edit and no remove, here or anywhere: not a missing feature
 * but the shape of the thing. A dispute record whose earlier entries can
 * change is a record whose last writer decides what was said.
 */
export const P2P_DISPUTES_APPEND_EVIDENCE = defineProcedure({
  ...base,
  name: 'p2p.disputes.appendEvidence',
  kind: 'mutation',
  path: 'disputes.appendEvidence',
  access: { caller: 'scope', scope: 'p2p:write', module: 'p2p', check: 'merchantApi' },
  refusals: {},
  input: z.object({
    tradeId: z.string().guid(),
    evidence: z.array(jsonValueSchema).min(1).max(MAX_EVIDENCE_PER_CALL),
  }),
  output: z.object({ disputeId: z.string().guid(), tradeId: z.string().guid(), evidence: z.array(evidenceOutput) }),
  samples: [
    { verdict: 'accept', input: { tradeId: '11111111-1111-4111-8111-111111111111', evidence: [{}] } },
    { verdict: 'refuse', input: 42 },
  ],
});
