import { z } from 'zod';
import { spineIdSchema, spineVersionSchema } from './spine.js';

/** PX-S01 market/rule lifecycle facts shared by gateways, trading, data, and operators. */

export const marketLifecycleStateSchema = z.enum([
  'DRAFT',
  'REVIEW',
  'APPROVED',
  'PRELAUNCH',
  'AUCTION',
  'OPEN',
  'POST_ONLY',
  /** Limit orders only: a market order is refused; limit, post-only, amend and cancel work. */
  'LIMIT_ONLY',
  'CANCEL_ONLY',
  'REDUCE_ONLY',
  'HALTED',
  'EXPIRING',
  'EXPIRED',
  'SETTLING',
  'SETTLED',
  'DELISTING',
  'REFUSED',
  'ARCHIVED',
]);
export type MarketLifecycleState = z.infer<typeof marketLifecycleStateSchema>;

export const marketActionSchema = z.enum(['PLACE', 'PLACE_POST_ONLY', 'AMEND', 'CANCEL', 'REDUCE', 'CLOSE', 'TRIGGER', 'QUOTE', 'RFQ']);
export type MarketAction = z.infer<typeof marketActionSchema>;

export const marketStateReasonCategorySchema = z.enum([
  'NORMAL',
  'REGULATORY',
  'TECHNICAL',
  'ORACLE_INDEX',
  'CUSTODY_CHAIN',
  'LIQUIDITY_DISORDERLY_MARKET',
  'SECURITY',
  'SETTLEMENT',
  'OPERATOR',
  'WIND_DOWN',
]);

const NO_ACTION_STATES = new Set<MarketLifecycleState>([
  'DRAFT',
  'REVIEW',
  'APPROVED',
  /**
   * Auction is not a live book. Ordinary PLACE would silently match as if OPEN.
   * Uncross is an evidenced transition off AUCTION, never a permitted PLACE.
   */
  'AUCTION',
  'REFUSED',
  'EXPIRED',
  'SETTLING',
  'SETTLED',
  'ARCHIVED',
]);
const RISK_REDUCTION_ACTIONS = new Set<MarketAction>(['CANCEL', 'REDUCE', 'CLOSE']);
const CANCEL_ONLY_ACTIONS = new Set<MarketAction>(['CANCEL']);
/** A pending listing is not a live book. Cancel frees a resting order. Place stays refused. */
const PRELAUNCH_ACTIONS = new Set<MarketAction>(['CANCEL']);
const POST_ONLY_ACTIONS = new Set<MarketAction>(['PLACE_POST_ONLY', 'AMEND', 'CANCEL', 'REDUCE', 'CLOSE', 'QUOTE']);

/**
 * Authoritative market status. Consumers use `allowedActions`; they never infer
 * healthy/open from an empty book, a restart, or a transport acknowledgement.
 */
export const marketStateSnapshotSchema = z
  .object({
    marketId: spineIdSchema,
    ruleVersion: spineVersionSchema,
    instrumentId: spineIdSchema,
    instrumentVersion: spineVersionSchema,
    state: marketLifecycleStateSchema,
    reasonCategory: marketStateReasonCategorySchema,
    reasonCode: spineIdSchema,
    effectiveAt: z.string().datetime({ offset: true }),
    observedAt: z.string().datetime({ offset: true }),
    lastGoodState: marketLifecycleStateSchema.nullable(),
    allowedActions: z.array(marketActionSchema).max(marketActionSchema.options.length),
    transitionId: spineIdSchema,
    evidenceRefs: z.array(spineIdSchema).min(1),
  })
  .superRefine((snapshot, context) => {
    if (new Set(snapshot.allowedActions).size !== snapshot.allowedActions.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedActions'], message: 'allowed actions must be unique' });
    }
    if (NO_ACTION_STATES.has(snapshot.state) && snapshot.allowedActions.length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedActions'], message: `${snapshot.state} permits no trading action` });
    }
    const permitted =
      snapshot.state === 'PRELAUNCH'
        ? PRELAUNCH_ACTIONS
        : snapshot.state === 'HALTED' || snapshot.state === 'REDUCE_ONLY' || snapshot.state === 'EXPIRING' || snapshot.state === 'DELISTING'
          ? RISK_REDUCTION_ACTIONS
          : snapshot.state === 'CANCEL_ONLY'
            ? CANCEL_ONLY_ACTIONS
            : snapshot.state === 'POST_ONLY'
              ? POST_ONLY_ACTIONS
              : null;
    if (permitted !== null) {
      for (const [index, action] of snapshot.allowedActions.entries()) {
        if (!permitted.has(action)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['allowedActions', index],
            message: `${snapshot.state} cannot permit ${action}`,
          });
        }
      }
    }
  });
export type MarketStateSnapshot = z.infer<typeof marketStateSnapshotSchema>;

const readinessReadySchema = z.object({
  status: z.literal('READY'),
  evidenceRefs: z.array(spineIdSchema).min(1),
});

const readinessSocketSchema = z.object({
  status: z.literal('SOCKET'),
  socketId: spineIdSchema,
  reasonCode: spineIdSchema,
  evidenceRefs: z.array(spineIdSchema),
});

export const admissionReadinessSchema = z.discriminatedUnion('status', [readinessReadySchema, readinessSocketSchema]);
export type AdmissionReadiness = z.infer<typeof admissionReadinessSchema>;

/** Every mandatory admission family is present as evidence or an explicit closed socket. */
export const marketAdmissionDossierSchema = z.object({
  dossierId: spineIdSchema,
  marketId: spineIdSchema,
  ruleVersion: spineVersionSchema,
  instrumentVersion: spineVersionSchema,
  legalEntityAndJurisdiction: admissionReadinessSchema,
  counterpartyRole: admissionReadinessSchema,
  deterministicSettlement: admissionReadinessSchema,
  custodyAndTransferSupport: admissionReadinessSchema,
  oracleIndexAndDisruption: admissionReadinessSchema,
  liquidityAndMarketQuality: admissionReadinessSchema,
  surveillanceAndRetention: admissionReadinessSchema,
  riskAndLimits: admissionReadinessSchema,
  operationsAndIncidentOwner: admissionReadinessSchema,
  windDownAndResiduals: admissionReadinessSchema,
  approvedAt: z.string().datetime({ offset: true }),
  approvalRefs: z.array(spineIdSchema).min(1),
});
export type MarketAdmissionDossier = z.infer<typeof marketAdmissionDossierSchema>;

export const marketAdmissionDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('ELIGIBLE'),
    dossierId: spineIdSchema,
    checkedAt: z.string().datetime({ offset: true }),
    blockingSockets: z.tuple([]),
  }),
  z.object({
    decision: z.literal('REFUSED'),
    dossierId: spineIdSchema,
    checkedAt: z.string().datetime({ offset: true }),
    blockingSockets: z.array(spineIdSchema).min(1),
  }),
]);
export type MarketAdmissionDecision = z.infer<typeof marketAdmissionDecisionSchema>;

const READINESS_FIELDS = [
  'legalEntityAndJurisdiction',
  'counterpartyRole',
  'deterministicSettlement',
  'custodyAndTransferSupport',
  'oracleIndexAndDisruption',
  'liquidityAndMarketQuality',
  'surveillanceAndRetention',
  'riskAndLimits',
  'operationsAndIncidentOwner',
  'windDownAndResiduals',
] as const satisfies readonly (keyof MarketAdmissionDossier)[];

/** Pure admission gate: a named blank is durable refusal, never an invented default. */
export function decideMarketAdmission(dossier: MarketAdmissionDossier, checkedAt: string): MarketAdmissionDecision {
  const parsed = marketAdmissionDossierSchema.parse(dossier);
  const sockets = READINESS_FIELDS.flatMap((field) => {
    const readiness = parsed[field];
    return readiness.status === 'SOCKET' ? [readiness.socketId] : [];
  });
  return marketAdmissionDecisionSchema.parse(
    sockets.length === 0
      ? { decision: 'ELIGIBLE', dossierId: parsed.dossierId, checkedAt, blockingSockets: [] }
      : { decision: 'REFUSED', dossierId: parsed.dossierId, checkedAt, blockingSockets: [...new Set(sockets)] },
  );
}

export const marketTransitionOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('APPLIED'), appliedTargets: z.array(spineIdSchema).min(1), unresolvedTargets: z.tuple([]) }),
  z.object({
    outcome: z.literal('PARTIAL'),
    appliedTargets: z.array(spineIdSchema).min(1),
    unresolvedTargets: z.array(spineIdSchema).min(1),
  }),
  z.object({ outcome: z.literal('REFUSED'), appliedTargets: z.tuple([]), unresolvedTargets: z.array(spineIdSchema).min(1) }),
  z.object({
    outcome: z.literal('OUTCOME_UNKNOWN'),
    appliedTargets: z.array(spineIdSchema),
    unresolvedTargets: z.array(spineIdSchema).min(1),
  }),
]);
export type MarketTransitionOutcome = z.infer<typeof marketTransitionOutcomeSchema>;

/** Immutable, idempotent transition request/result; unsupported transitions stay refused. */
export const marketTransitionRecordSchema = z
  .object({
    transitionId: spineIdSchema,
    idempotencyKey: spineIdSchema,
    marketId: spineIdSchema,
    expectedState: marketLifecycleStateSchema,
    expectedRuleVersion: spineVersionSchema,
    requestedState: marketLifecycleStateSchema,
    resolvedState: marketLifecycleStateSchema.nullable(),
    reasonCategory: marketStateReasonCategorySchema,
    reasonCode: spineIdSchema,
    actorId: spineIdSchema,
    authorityRef: spineIdSchema,
    approvalRefs: z.array(spineIdSchema),
    requestedAt: z.string().datetime({ offset: true }),
    effectiveAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    recoveryEvidenceRefs: z.array(spineIdSchema),
    outcome: marketTransitionOutcomeSchema,
  })
  .superRefine((transition, context) => {
    const reopening =
      transition.expectedState === 'HALTED' && (transition.requestedState === 'AUCTION' || transition.requestedState === 'OPEN');
    if (reopening && transition.recoveryEvidenceRefs.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recoveryEvidenceRefs'],
        message: 'reopening a halted market requires recovery evidence',
      });
    }
    const uncrossing =
      transition.expectedState === 'AUCTION' && transition.requestedState === 'OPEN' && transition.outcome.outcome === 'APPLIED';
    if (uncrossing && transition.recoveryEvidenceRefs.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recoveryEvidenceRefs'],
        message: 'leaving auction for open requires uncross evidence; an uncross price is not invented here',
      });
    }
    if (transition.outcome.outcome === 'APPLIED') {
      if (transition.effectiveAt === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['effectiveAt'],
          message: 'an applied transition requires an effective time',
        });
      }
      if (transition.resolvedState !== transition.requestedState) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolvedState'],
          message: 'an applied transition must resolve to its requested state',
        });
      }
    } else if (transition.outcome.outcome === 'REFUSED') {
      if (transition.resolvedState !== transition.expectedState) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolvedState'],
          message: 'a refused transition must retain its expected state',
        });
      }
    } else if (transition.resolvedState !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolvedState'],
        message: 'partial or unknown transition cannot collapse to one resolved state',
      });
    }
  });
export type MarketTransitionRecord = z.infer<typeof marketTransitionRecordSchema>;
