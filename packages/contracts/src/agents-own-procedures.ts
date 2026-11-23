import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  OWN_AGENT_DATA_CLASSES,
  OWN_AGENT_RULE_CHOICES,
  ownAgentAcceptSchema,
  ownAgentAccessSchema,
  ownAgentAnalyticsSchema,
  ownAgentAssistantSchema,
  ownAgentCatalogueSchema,
  ownAgentConsentSchema,
  ownAgentCoOwnerSchema,
  ownAgentDeletedSchema,
  ownAgentDeleteSchema,
  ownAgentDraftRequestSchema,
  ownAgentEvalRunSchema,
  ownAgentEvalsSchema,
  ownAgentEvalStartSchema,
  ownAgentIdentitySchema,
  ownAgentIssuedTokenSchema,
  ownAgentKeepTranscriptsSchema,
  ownAgentLimitsSchema,
  ownAgentMemoryClearSchema,
  ownAgentMemorySchema,
  ownAgentMemorySetEnabledSchema,
  ownAgentOrderDraftSchema,
  ownAgentPaymentMethodInputSchema,
  ownAgentPaymentMethodSchema,
  ownAgentPolicySchema,
  ownAgentPrivacySchema,
  ownAgentProposalSchema,
  ownAgentPublicationSchema,
  ownAgentPublishSchema,
  ownAgentReviewerSchema,
  ownAgentReviewRowSchema,
  ownAgentRuleSchema,
  ownAgentRunResultSchema,
  ownAgentRunRowSchema,
  ownAgentScheduleCreateSchema,
  ownAgentScheduleSchema,
  ownAgentSchema,
  ownAgentSessionClosedSchema,
  ownAgentSessionSchema,
  ownAgentShareCheckInputSchema,
  ownAgentShareCheckSchema,
  ownAgentSharedSchema,
  ownAgentShareSchema,
  ownAgentShareSetSchema,
  ownAgentTestApproveSchema,
  ownAgentTestRunSchema,
  ownAgentTestRunStartSchema,
  ownAgentTokenSchema,
  ownAgentToolTestStartSchema,
  ownAgentTriggerCreateSchema,
  ownAgentTriggerSchema,
  ownAgentUsageDaySchema,
  ownAgentUsageWindowSchema,
  OWN_AGENT_POLICY_EFFECTS,
  OWN_AGENT_POLICY_ACTIONS,
  OWN_AGENT_POLICY_SCOPES,
  ownAgentSchedulesSchema,
  ownAgentInboxRowSchema,
  ownAgentApprovalApprovedSchema,
  ownAgentApprovalRequestSchema,
  ownAgentApprovalEditedSchema,
  ownAgentToolCallSchema,
  ownAgentReviewCheckSchema,
  ownAgentDryRunStartSchema,
} from './agents-own.js';
import { ownAgentUsageLimitsInputSchema, ownAgentUsageLimitsSchema } from './agents-usage-limits.js';
import { idInput, ownBackgroundRunSchema } from './agents-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `own.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

export const AGENTS_OWN_POLICY_GET = defineProcedure({
  ...base,
  name: 'agents.own.policy.get',
  kind: 'query',
  path: 'own.policy.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentPolicySchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_ACCESS_GET = defineProcedure({
  ...base,
  name: 'agents.own.access.get',
  kind: 'query',
  path: 'own.access.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentAccessSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_ACCESS_GRANT = defineProcedure({
  ...base,
  name: 'agents.own.access.grant',
  kind: 'mutation',
  path: 'own.access.grant',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({
    grantKey: z.string().uuid(),
    venueId: z.string().min(1).max(64),
    owner: z.string().max(64),
    subAccounts: z.array(z.object({ subAccount: z.string().max(64), name: z.string().max(120) })).max(32),
    endsInDays: z.string().max(16).nullable(),
  }),
  output: ownAgentAccessSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        id: 'USDC',
        grantKey: '11111111-1111-4111-8111-111111111111',
        venueId: 'USDC',
        owner: 'USDC',
        subAccounts: [],
        endsInDays: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_TRADE_DRAFT = defineProcedure({
  ...base,
  name: 'agents.own.trade.draft',
  kind: 'mutation',
  path: 'own.trade.draft',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ ask: z.string().min(1).max(500) }),
  output: ownAgentOrderDraftSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', ask: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * A new schedule, due at once and then every interval. Blank cadence values of the owner refuse
 * `agents.schedule_cadence_unset`; a repeating schedule with a blank interval refuses
 * `agents.schedule.min_interval_unset`. Either way nothing is stored. The same create key is the same schedule.
 */
export const AGENTS_OWN_SCHEDULES_CREATE = defineProcedure({
  ...base,
  name: 'agents.own.schedules.create',
  kind: 'mutation',
  path: 'own.schedules.create',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: ownAgentScheduleCreateSchema,
  output: ownAgentScheduleSchema,
  samples: [
    {
      verdict: 'accept',
      input: { id: 'USDC', createKey: 'ethereum', repeat: 'once', intervalMinutes: 'USDC', perRunCap: 'USDC', ask: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** A new trigger on one of the offered subjects; any other refuses `agents.trigger_subject_invalid`. */
export const AGENTS_OWN_TRIGGERS_CREATE = defineProcedure({
  ...base,
  name: 'agents.own.triggers.create',
  kind: 'mutation',
  path: 'own.triggers.create',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: ownAgentTriggerCreateSchema,
  output: ownAgentTriggerSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', createKey: 'ethereum', subject: 'USDC', perRunCap: 'USDC', ask: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The templates and the tools a draft may be given, with the ones that move money marked so they can be refused. */
export const AGENTS_OWN_CATALOGUE = defineProcedure({
  ...base,
  name: 'agents.own.catalogue',
  kind: 'query',
  path: 'own.catalogue',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: NO_INPUT,
  output: ownAgentCatalogueSchema,
  samples: [{ verdict: 'accept' }],
});

export const AGENTS_OWN_CREATE = defineProcedure({
  ...base,
  name: 'agents.own.create',
  kind: 'mutation',
  path: 'own.create',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({ template: z.string().min(1).max(64), createKey: z.string().min(8).max(128) }),
  output: ownAgentSchema,
  samples: [
    { verdict: 'accept', input: { template: 'USDC', createKey: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_SAVE = defineProcedure({
  ...base,
  name: 'agents.own.save',
  kind: 'mutation',
  path: 'own.save',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({
    id: z.string().min(1).max(64),
    name: z.string().max(200),
    instructions: z.string().max(20_000),
    tools: z.array(z.string().max(120)).max(50),
    perSessionCap: z.string().max(64).nullable(),
  }),
  output: ownAgentSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', name: 'USDC', instructions: 'USDC', tools: [], perSessionCap: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_GET = defineProcedure({
  ...base,
  name: 'agents.own.get',
  kind: 'query',
  path: 'own.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({ id: z.string().min(1).max(64) }),
  output: ownAgentSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Whether the agent may start new work: `active`, or the operator's switch that stops it (AG-control-02). The owner
 * reads it; only an operator sets it, and only two founders lift it.
 */
export const AGENTS_OWN_STATUS = defineProcedure({
  ...base,
  name: 'agents.own.status',
  kind: 'query',
  path: 'own.status',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: z.object({ status: z.enum(['active', 'quarantined', 'disabled_by_kind']) }),
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_LIMITS_GET = defineProcedure({
  ...base,
  name: 'agents.own.limits.get',
  kind: 'query',
  path: 'own.limits.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentLimitsSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** All three caps or none. Blank refuses `agents.spend.cap_unset`; above the agent's own cap is refused, not lowered. */
export const AGENTS_OWN_LIMITS_SET = defineProcedure({
  ...base,
  name: 'agents.own.limits.set',
  kind: 'mutation',
  path: 'own.limits.set',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({
    perCall: z.string().max(64).nullable(),
    perSession: z.string().max(64).nullable(),
    perPeriod: z.string().max(64).nullable(),
  }),
  output: ownAgentLimitsSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', perCall: 'USDC', perSession: 'USDC', perPeriod: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_USAGE_LIMITS_GET = defineProcedure({
  ...base,
  name: 'agents.own.usageLimits.get',
  kind: 'query',
  path: 'own.usageLimits.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({ id: z.string().min(1).max(64) }),
  output: ownAgentUsageLimitsSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Blank clears one. The alert must sit below the hard limit; a bad amount refuses `agents.usage.limit_invalid`. */
export const AGENTS_OWN_USAGE_LIMITS_SET = defineProcedure({
  ...base,
  name: 'agents.own.usageLimits.set',
  kind: 'mutation',
  path: 'own.usageLimits.set',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentUsageLimitsInputSchema,
  output: ownAgentUsageLimitsSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', alertAt: 'USDC', hardLimit: 'USDC', email: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_PAYMENT_METHOD_GET = defineProcedure({
  ...base,
  name: 'agents.own.paymentMethod.get',
  kind: 'query',
  path: 'own.paymentMethod.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentPaymentMethodSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_PAYMENT_METHOD_SET = defineProcedure({
  ...base,
  name: 'agents.own.paymentMethod.set',
  kind: 'mutation',
  path: 'own.paymentMethod.set',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentPaymentMethodInputSchema,
  output: ownAgentPaymentMethodSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', address: '0x1111111111111111111111111111111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Opens a session of the person's own agent. Refused `agents.spend.cap_unset`, with no session made, until the
 * agent has its own cap and the person has set theirs for it: nothing of an own agent runs uncapped.
 */
export const AGENTS_OWN_SESSION_OPEN = defineProcedure({
  ...base,
  name: 'agents.own.session.open',
  kind: 'mutation',
  path: 'own.session.open',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: idInput,
  output: ownAgentSessionSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * One run: the agent's instructions and the person's question, held against the agent's caps and the person's
 * balance before the engine is called. The same request id twice is one run and one charge.
 */
export const AGENTS_OWN_RUN = defineProcedure({
  ...base,
  name: 'agents.own.run',
  kind: 'mutation',
  path: 'own.run',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: idInput.extend({
    sessionId: z.string().uuid(),
    requestId: z.string().min(8).max(200),
    ask: z.string().min(1).max(4000),
  }),
  output: ownAgentRunResultSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', sessionId: '11111111-1111-4111-8111-111111111111', requestId: 'ethereum', ask: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Every run asked of this agent by the person, newest first: admitted, refused with its code, or failed; and each
 * tool call a rule holds for the person, waiting for approval, which has not run.
 */
export const AGENTS_OWN_RUNS = defineProcedure({
  ...base,
  name: 'agents.own.runs',
  kind: 'query',
  path: 'own.runs',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ limit: z.number().int().min(1).max(200) }),
  output: z.array(ownAgentRunRowSchema),
  samples: [
    { verdict: 'accept', input: { id: 'USDC', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Closes a session of the person's own agent once its windows are paid, each on its own charge key. A window the
 * ledger refuses for funds stays unpaid and the session stays open: refused `agents.window_unpaid`.
 */
export const AGENTS_OWN_SESSION_CLOSE = defineProcedure({
  ...base,
  name: 'agents.own.session.close',
  kind: 'mutation',
  path: 'own.session.close',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: idInput.extend({ sessionId: z.string().uuid() }),
  output: ownAgentSessionClosedSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', sessionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The agent's background test runs, newest first, each with its state and the code that stopped it. */
export const AGENTS_OWN_BACKGROUND_RUNS = defineProcedure({
  ...base,
  name: 'agents.own.backgroundRuns',
  kind: 'query',
  path: 'own.backgroundRuns',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ limit: z.number().int().min(1).max(200) }),
  output: z.array(ownBackgroundRunSchema),
  samples: [
    { verdict: 'accept', input: { id: 'USDC', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The usage windows of this agent's sessions, newest first: open, unpaid (retried on its charge key) or settled. */
export const AGENTS_OWN_USAGE = defineProcedure({
  ...base,
  name: 'agents.own.usage',
  kind: 'query',
  path: 'own.usage',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ limit: z.number().int().min(1).max(200) }),
  output: z.array(ownAgentUsageWindowSchema),
  samples: [
    { verdict: 'accept', input: { id: 'USDC', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The sealed usage of every agent the person built, by agent, UTC day and task. Each row is the exact sum of the
 * sealed windows it covers, so an agent's rows add up to the amounts its Usage windows show.
 */
export const AGENTS_OWN_USAGE_BY_DAY = defineProcedure({
  ...base,
  name: 'agents.own.usageByDay',
  kind: 'query',
  path: 'own.usageByDay',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: NO_INPUT,
  output: z.array(ownAgentUsageDaySchema),
  samples: [{ verdict: 'accept' }],
});

/** The agent's published versions, the version each surface carries, and each open session's version (AG-builder-03). */
export const AGENTS_OWN_PUBLICATION = defineProcedure({
  ...base,
  name: 'agents.own.publication',
  kind: 'query',
  path: 'own.publication',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentPublicationSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Publishes the agent's current version to the chosen surfaces (AG-builder-03; J-agents-03 #7). A finding that blocks
 * publishing refuses with its code; a surface the policy forbids refuses `agents.own.surface_not_reviewed`. Either
 * way nothing is published and no surface moves. Only the chosen surfaces move; the rest keep their version.
 */
export const AGENTS_OWN_PUBLISH = defineProcedure({
  ...base,
  name: 'agents.own.publish',
  kind: 'mutation',
  path: 'own.publish',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentPublishSchema,
  output: ownAgentPublicationSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', surfaces: ['USDC'] } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_CO_OWNERS_LIST = defineProcedure({
  ...base,
  name: 'agents.own.coOwners.list',
  kind: 'query',
  path: 'own.coOwners.list',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: z.array(ownAgentCoOwnerSchema),
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_CO_OWNERS_ADD = defineProcedure({
  ...base,
  name: 'agents.own.coOwners.add',
  kind: 'mutation',
  path: 'own.coOwners.add',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ coOwner: z.string().max(200) }),
  output: z.array(ownAgentCoOwnerSchema),
  samples: [
    { verdict: 'accept', input: { id: 'USDC', coOwner: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_CO_OWNERS_REMOVE = defineProcedure({
  ...base,
  name: 'agents.own.coOwners.remove',
  kind: 'mutation',
  path: 'own.coOwners.remove',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ coOwner: z.string().max(200) }),
  output: z.array(ownAgentCoOwnerSchema),
  samples: [
    { verdict: 'accept', input: { id: 'USDC', coOwner: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_LIST = defineProcedure({
  ...base,
  name: 'agents.own.list',
  kind: 'query',
  path: 'own.list',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(200) }),
  output: z.array(ownAgentSchema),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Other people's agents this person co-owns, newest first, read only. */
export const AGENTS_OWN_SHARED_WITH_ME = defineProcedure({
  ...base,
  name: 'agents.own.sharedWithMe',
  kind: 'query',
  path: 'own.sharedWithMe',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(200) }),
  output: z.array(ownAgentSharedSchema),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Deletes a draft for good (J-agents-03 #8), only with the person's confirmation, sent as `delete for good`; without it the
 * service refuses `agents.own.delete_unconfirmed` and keeps it. A published agent, or one that has opened a
 * session, is refused and kept whole.
 */
export const AGENTS_OWN_DELETE = defineProcedure({
  ...base,
  name: 'agents.own.delete',
  kind: 'mutation',
  path: 'own.delete',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentDeleteSchema,
  output: ownAgentDeletedSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', confirm: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_EVALS_GET = defineProcedure({
  ...base,
  name: 'agents.own.evals.get',
  kind: 'query',
  path: 'own.evals.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ limit: z.number().int().min(1).max(50) }),
  output: ownAgentEvalsSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_EVALS_START = defineProcedure({
  ...base,
  name: 'agents.own.evals.start',
  kind: 'mutation',
  path: 'own.evals.start',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentEvalStartSchema,
  output: ownAgentEvalRunSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', requestId: 'ethereum', cases: [], repeats: 'USDC', threshold: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_RULES_LIST = defineProcedure({
  ...base,
  name: 'agents.own.rules.list',
  kind: 'query',
  path: 'own.rules.list',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: z.array(ownAgentRuleSchema),
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_RULES_SAVE = defineProcedure({
  ...base,
  name: 'agents.own.rules.save',
  kind: 'mutation',
  path: 'own.rules.save',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ tool: z.string().min(1).max(120), choice: z.enum(OWN_AGENT_RULE_CHOICES) }),
  output: ownAgentRuleSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', tool: 'USDC', choice: 'hand_off' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_CONSENTS_LIST = defineProcedure({
  ...base,
  name: 'agents.own.consents.list',
  kind: 'query',
  path: 'own.consents.list',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: z.array(ownAgentConsentSchema),
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_CONSENTS_REVOKE = defineProcedure({
  ...base,
  name: 'agents.own.consents.revoke',
  kind: 'mutation',
  path: 'own.consents.revoke',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ dataClass: z.enum(OWN_AGENT_DATA_CLASSES) }),
  output: ownAgentConsentSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', dataClass: 'own_data' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_CONSENTS_GRANT = defineProcedure({
  ...base,
  name: 'agents.own.consents.grant',
  kind: 'mutation',
  path: 'own.consents.grant',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ dataClass: z.enum(OWN_AGENT_DATA_CLASSES) }),
  output: ownAgentConsentSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', dataClass: 'own_data' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_IDENTITY_GET = defineProcedure({
  ...base,
  name: 'agents.own.identity.get',
  kind: 'query',
  path: 'own.identity.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentIdentitySchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_IDENTITY_ISSUE = defineProcedure({
  ...base,
  name: 'agents.own.identity.issue',
  kind: 'mutation',
  path: 'own.identity.issue',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentIssuedTokenSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_IDENTITY_REVOKE = defineProcedure({
  ...base,
  name: 'agents.own.identity.revoke',
  kind: 'mutation',
  path: 'own.identity.revoke',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentTokenSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_ASSISTANT_STATE = defineProcedure({
  ...base,
  name: 'agents.own.assistant.state',
  kind: 'query',
  path: 'own.assistant.state',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: NO_INPUT,
  output: ownAgentAssistantSchema,
  samples: [{ verdict: 'accept' }],
});

export const AGENTS_OWN_ASSISTANT_DRAFT = defineProcedure({
  ...base,
  name: 'agents.own.assistant.draft',
  kind: 'mutation',
  path: 'own.assistant.draft',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentDraftRequestSchema,
  output: ownAgentProposalSchema,
  samples: [
    { verdict: 'accept', input: { description: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_ASSISTANT_ACCEPT = defineProcedure({
  ...base,
  name: 'agents.own.assistant.accept',
  kind: 'mutation',
  path: 'own.assistant.accept',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentAcceptSchema,
  output: ownAgentSchema,
  samples: [
    { verdict: 'accept', input: { name: 'USDC', instructions: 'USDC', tools: [], acceptKey: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_MEMORY_GET = defineProcedure({
  ...base,
  name: 'agents.own.memory.get',
  kind: 'query',
  path: 'own.memory.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ limit: z.number().int().min(1).max(200) }),
  output: ownAgentMemorySchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Switches memory on or off for this agent; while off, a run writes nothing and says so. */
export const AGENTS_OWN_MEMORY_SET_ENABLED = defineProcedure({
  ...base,
  name: 'agents.own.memory.setEnabled',
  kind: 'mutation',
  path: 'own.memory.setEnabled',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentMemorySetEnabledSchema,
  output: ownAgentMemorySchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', enabled: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Clears one item: only it goes; the run that remembered it keeps its log. Not the person's: not found. */
export const AGENTS_OWN_MEMORY_CLEAR = defineProcedure({
  ...base,
  name: 'agents.own.memory.clear',
  kind: 'mutation',
  path: 'own.memory.clear',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentMemoryClearSchema,
  output: ownAgentMemorySchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', itemId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_PRIVACY_GET = defineProcedure({
  ...base,
  name: 'agents.own.privacy.get',
  kind: 'query',
  path: 'own.privacy.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentPrivacySchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_PRIVACY_KEEP_TRANSCRIPTS = defineProcedure({
  ...base,
  name: 'agents.own.privacy.keepTranscripts',
  kind: 'mutation',
  path: 'own.privacy.keepTranscripts',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentKeepTranscriptsSchema,
  output: ownAgentPrivacySchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', keep: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_SHARE_GET = defineProcedure({
  ...base,
  name: 'agents.own.share.get',
  kind: 'query',
  path: 'own.share.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentShareSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_SHARE_CHECK = defineProcedure({
  ...base,
  name: 'agents.own.share.check',
  kind: 'query',
  path: 'own.share.check',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentShareCheckInputSchema,
  output: ownAgentShareCheckSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', includeTranscripts: true, includeMemory: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_SHARE_SET = defineProcedure({
  ...base,
  name: 'agents.own.share.set',
  kind: 'mutation',
  path: 'own.share.set',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentShareSetSchema,
  output: ownAgentShareSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', includeTranscripts: true, includeMemory: true, confirmed: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_REVIEWER_GET = defineProcedure({
  ...base,
  name: 'agents.own.reviewer.get',
  kind: 'query',
  path: 'own.reviewer.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentReviewerSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The reviewer's decisions on this agent's calls, newest first, each with its coded reason and input digest. */
export const AGENTS_OWN_REVIEW_LIST = defineProcedure({
  ...base,
  name: 'agents.own.review.list',
  kind: 'query',
  path: 'own.review.list',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ limit: z.number().int().min(1).max(200) }),
  output: z.array(ownAgentReviewRowSchema),
  samples: [
    { verdict: 'accept', input: { id: 'USDC', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_REVIEWER_SET = defineProcedure({
  ...base,
  name: 'agents.own.reviewer.set',
  kind: 'mutation',
  path: 'own.reviewer.set',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ on: z.boolean() }),
  output: ownAgentReviewerSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', on: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The person approves a test run's value-moving action (AG-guardrails-03; J-agents-10 #2). Only the payload approved
 * here counts: it must be the request's own, and the step the engine drafted must match it, or the run is refused
 * `agents.payload.mismatch`. A test run sends nothing either way: no session, no reservation and no ledger call.
 * Approving a decided run again returns its decision.
 */
export const AGENTS_OWN_TEST_APPROVE = defineProcedure({
  ...base,
  name: 'agents.own.testApprove',
  kind: 'mutation',
  path: 'own.testApprove',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentTestApproveSchema,
  output: ownAgentTestRunSchema,
  samples: [
    {
      verdict: 'accept',
      input: { id: 'USDC', runId: '11111111-1111-4111-8111-111111111111', payload: { amount: '1', assetId: 'USDC', destination: 'USDC' } },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * A test run that goes on in the background, one step at a time, on the test engine (AG-control-02; J-agents-14 #3):
 * mode test, cost 0, labelled TEST, never billed. Before each step it re-reads the agent's switches, so a quarantine
 * stops it at its next step. The same request id again is that run.
 */
export const AGENTS_OWN_BACKGROUND_RUN = defineProcedure({
  ...base,
  name: 'agents.own.backgroundRun',
  kind: 'mutation',
  path: 'own.backgroundRun',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({ id: z.string().min(1).max(64), requestId: z.string().min(8).max(200), ask: z.string().max(4000) }),
  output: ownBackgroundRunSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', requestId: 'ethereum', ask: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_TEST_RUN = defineProcedure({
  ...base,
  name: 'agents.own.testRun',
  kind: 'mutation',
  path: 'own.testRun',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentTestRunStartSchema,
  output: ownAgentTestRunSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', requestId: 'ethereum', ask: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * A tool that moves value, tested (AG-testing-01; J-agents-04 #2): what a call of it would do, and that a real call by
 * the person's own agent is refused `agents.own.money_tool`. Nothing is sent: no ledger call, no session, no
 * reservation and no intent. The same request id again is that test.
 */
export const AGENTS_OWN_TOOL_TEST = defineProcedure({
  ...base,
  name: 'agents.own.toolTest',
  kind: 'mutation',
  path: 'own.toolTest',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentToolTestStartSchema,
  output: ownAgentTestRunSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', requestId: 'ethereum', tool: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The agent's test runs, newest first, apart from its live runs (`own.runs`). Each is labelled TEST and cost 0. */
export const AGENTS_OWN_TEST_RUNS = defineProcedure({
  ...base,
  name: 'agents.own.testRuns',
  kind: 'query',
  path: 'own.testRuns',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ limit: z.number().int().min(1).max(200) }),
  output: z.array(ownAgentTestRunSchema),
  samples: [
    { verdict: 'accept', input: { id: 'USDC', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The agent's runs by outcome and their cost: live runs only, unless the person includes test runs. */
export const AGENTS_OWN_ANALYTICS = defineProcedure({
  ...base,
  name: 'agents.own.analytics',
  kind: 'query',
  path: 'own.analytics',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ includeTest: z.boolean().optional() }),
  output: ownAgentAnalyticsSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_POLICY_ADD = defineProcedure({
  ...base,
  name: 'agents.own.policy.add',
  kind: 'mutation',
  path: 'own.policy.add',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({
    effect: z.enum(OWN_AGENT_POLICY_EFFECTS),
    action: z.enum(OWN_AGENT_POLICY_ACTIONS),
    scope: z.enum(OWN_AGENT_POLICY_SCOPES),
  }),
  output: ownAgentPolicySchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', effect: 'allow', action: 'place_order', scope: 'all' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_POLICY_REMOVE = defineProcedure({
  ...base,
  name: 'agents.own.policy.remove',
  kind: 'mutation',
  path: 'own.policy.remove',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ ruleId: z.string().uuid() }),
  output: ownAgentPolicySchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', ruleId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_POLICY_REQUIRE = defineProcedure({
  ...base,
  name: 'agents.own.policy.require',
  kind: 'mutation',
  path: 'own.policy.require',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ rulesRequired: z.boolean() }),
  output: ownAgentPolicySchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', rulesRequired: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The agent's schedules, newest first, each with its status, next occurrence and recent occurrences. */
export const AGENTS_OWN_SCHEDULES_LIST = defineProcedure({
  ...base,
  name: 'agents.own.schedules.list',
  kind: 'query',
  path: 'own.schedules.list',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: ownAgentSchedulesSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Cancels a schedule: no further occurrence is due. A run already running goes on. */
export const AGENTS_OWN_SCHEDULES_CANCEL = defineProcedure({
  ...base,
  name: 'agents.own.schedules.cancel',
  kind: 'mutation',
  path: 'own.schedules.cancel',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: idInput.extend({ scheduleId: z.string().min(1).max(64) }),
  output: ownAgentScheduleSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC', scheduleId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The agent's triggers, newest first, each with the events delivered to it and the runs they made. */
export const AGENTS_OWN_TRIGGERS_LIST = defineProcedure({
  ...base,
  name: 'agents.own.triggers.list',
  kind: 'query',
  path: 'own.triggers.list',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput,
  output: z.array(ownAgentTriggerSchema),
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The Approvals inbox (AG-approvals-01): the calls a rule held for the person across all their own agents, newest
 * first, each with its agent. None of them has run.
 */
export const AGENTS_OWN_INBOX = defineProcedure({
  ...base,
  name: 'agents.own.inbox',
  kind: 'query',
  path: 'own.inbox',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(200) }),
  output: z.array(ownAgentInboxRowSchema),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_APPROVAL_APPROVE = defineProcedure({
  ...base,
  name: 'agents.own.approval.approve',
  kind: 'mutation',
  path: 'own.approval.approve',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: z.object({ requestId: z.string().uuid() }),
  output: ownAgentApprovalApprovedSchema,
  samples: [
    { verdict: 'accept', input: { requestId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_APPROVAL_REJECT = defineProcedure({
  ...base,
  name: 'agents.own.approval.reject',
  kind: 'mutation',
  path: 'own.approval.reject',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({ requestId: z.string().uuid() }),
  output: ownAgentApprovalRequestSchema,
  samples: [
    { verdict: 'accept', input: { requestId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The calls of this agent's tools that a rule held for the person, newest first. None of them has run. */
export const AGENTS_OWN_APPROVALS = defineProcedure({
  ...base,
  name: 'agents.own.approvals',
  kind: 'query',
  path: 'own.approvals',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({ limit: z.number().int().min(1).max(200) }),
  output: z.array(ownAgentApprovalRequestSchema),
  samples: [
    { verdict: 'accept', input: { id: 'x', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_OWN_APPROVAL_EDIT = defineProcedure({
  ...base,
  name: 'agents.own.approval.edit',
  kind: 'mutation',
  path: 'own.approval.edit',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({
    requestId: z.string().uuid(),
    input: z.record(z.string().max(64), z.string().max(4000)).refine((args) => Object.keys(args).length <= 8),
  }),
  checks: { at_most_eight_keys: { at: 'input.input', says: 'at most eight keys' } },
  output: ownAgentApprovalEditedSchema,
  samples: [
    { verdict: 'accept', input: { requestId: '33333333-3333-4333-8333-333333333333', input: {} } },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'at_most_eight_keys',
      input: {
        requestId: '33333333-3333-4333-8333-333333333333',
        input: { k1: 'x', k2: 'x', k3: 'x', k4: 'x', k5: 'x', k6: 'x', k7: 'x', k8: 'x', k9: 'x' },
      },
    },
  ],
});

/**
 * One call of one of the agent's tools in its open session: consent for the tool's class, then the owner's
 * baseline, then the person's rule, then the session's own guardrail. A call a rule asks about is stored as an
 * approval request, once per request id, and the tool does not run. A tool with no door refuses
 * `agents.tool_not_wired` and runs nothing.
 */
export const AGENTS_OWN_TOOL_TRY = defineProcedure({
  ...base,
  name: 'agents.own.tool.try',
  kind: 'mutation',
  path: 'own.tool.try',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: idInput.extend({
    sessionId: z.string().uuid(),
    requestId: z.string().min(8).max(200),
    tool: z.string().min(1).max(120),
    input: z.record(z.string().max(64), z.string().max(4000)).refine((args) => Object.keys(args).length <= 8),
  }),
  checks: { at_most_eight_keys: { at: 'input.input', says: 'at most eight keys' } },
  output: ownAgentToolCallSchema,
  samples: [
    {
      verdict: 'accept',
      input: { id: 'x', sessionId: '33333333-3333-4333-8333-333333333333', requestId: 'xxxxxxxx', tool: 'x', input: {} },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'at_most_eight_keys',
      input: {
        id: 'x',
        sessionId: '33333333-3333-4333-8333-333333333333',
        requestId: 'xxxxxxxx',
        tool: 'x',
        input: { k1: 'x', k2: 'x', k3: 'x', k4: 'x', k5: 'x', k6: 'x', k7: 'x', k8: 'x', k9: 'x' },
      },
    },
  ],
});

/**
 * What the reviewer would decide for one call of a catalogue tool, without running it or storing anything. A tool
 * that can move value goes to the person and the reviewer is not asked.
 */
export const AGENTS_OWN_REVIEW_CHECK = defineProcedure({
  ...base,
  name: 'agents.own.review.check',
  kind: 'query',
  path: 'own.review.check',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: idInput.extend({
    tool: z.string().min(1).max(120),
    input: z.record(z.string().max(64), z.string().max(4000)).refine((args) => Object.keys(args).length <= 8),
  }),
  checks: { at_most_eight_keys: { at: 'input.input', says: 'at most eight keys' } },
  output: ownAgentReviewCheckSchema,
  samples: [
    { verdict: 'accept', input: { id: 'x', tool: 'x', input: {} } },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'at_most_eight_keys',
      input: { id: 'x', tool: 'x', input: { k1: 'x', k2: 'x', k3: 'x', k4: 'x', k5: 'x', k6: 'x', k7: 'x', k8: 'x', k9: 'x' } },
    },
  ],
});

/**
 * A dry run of one call of one of the agent's tools (AG-spend-04): every check a real call meets, in its order, and
 * what the call would do. It opens no session and calls no tool, runtime, spend gate or ledger, so no ledger entry,
 * intent or reservation is made; it is stored as a test run, labelled TEST and never billed. The same request id
 * again is the same dry run.
 */
export const AGENTS_OWN_DRY_RUN = defineProcedure({
  ...base,
  name: 'agents.own.dryRun',
  kind: 'mutation',
  path: 'own.dryRun',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: ownAgentDryRunStartSchema,
  checks: { at_most_eight_keys: { at: 'input.input', says: 'at most eight keys' } },
  output: ownAgentTestRunSchema,
  samples: [
    { verdict: 'accept', input: { id: 'x', requestId: 'xxxxxxxx', tool: 'x', input: {} } },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'at_most_eight_keys',
      input: {
        id: 'x',
        requestId: 'xxxxxxxx',
        tool: 'x',
        input: { k1: 'x', k2: 'x', k3: 'x', k4: 'x', k5: 'x', k6: 'x', k7: 'x', k8: 'x', k9: 'x' },
      },
    },
  ],
});
