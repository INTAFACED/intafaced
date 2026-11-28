import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `ops.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const offerState = z.enum(['offered', 'not_offered', 'not_known']);

export const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

/** The app's side of a programme figure when the app holds no record for the asset. */
export const MISSING = 'missing' as const;

export const appSide = z.union([amountString, z.literal(MISSING)]);

/** The words every surface shows for an unknown. One constant so no surface can print a 0 or a guess instead. */
export const NOT_KNOWN = 'not known' as const;

export const known = z.union([amountString, z.literal(NOT_KNOWN)]);

export const signed = z.union([z.string().regex(/^-?\d+(\.\d{1,18})?$/), z.literal(NOT_KNOWN)]);

export const fundingKind = z.enum(['fund', 'defund', 'auto_reload']);

export const fundingRequestOutput = z.object({
  clientRequestId: z.string(),
  kind: fundingKind,
  assetId: assetIdSchema,
  amount: amountString,
  threshold: amountString.nullable(),
  partnerRef: z.string(),
  createdAt: z.string(),
});

export const partyOutput = z.object({
  handle: z.string().nullable(),
  reason: z.literal('handle_unresolved').nullable(),
});

export const BANK_OPS_CARD_PROGRAMME_FUNDING = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeFunding',
  kind: 'query',
  path: 'ops.cardProgrammeFunding',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    test: z.boolean(),
    fundingAssetId: z.string().min(1),
    offers: z.object({ fund: offerState, defund: offerState, auto_reload: offerState }),
    rows: z.array(
      z.object({
        assetId: assetIdSchema,
        // An asset the app holds no record of says "missing" in each app figure, never 0.
        appHeld: appSide,
        appCaptured: appSide,
        appFigure: appSide,
        partnerFigure: known,
        /** The partner's own time for its figure, or "not known" when it sent none (b2 change 6). */
        partnerAsOf: z.string().min(1),
        partnerState: z.enum(['known', 'stale', 'unknown']),
        difference: signed,
        status: z.enum(['matches', 'break', 'missing', 'not_known']),
        fundingRate: known,
        fundingRateAsOf: z.string().min(1),
        appFigureInFunding: known,
      }),
    ),
    requests: z.array(fundingRequestOutput),
  }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_OPS_POOL_TOTALS = defineProcedure({
  ...base,
  name: 'bank.ops.poolTotals',
  kind: 'query',
  path: 'ops.poolTotals',
  access: { caller: 'anyScope', scopes: ['admin:read', 'admin:treasury'] },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    asOf: z.string(),
    pools: z.array(
      z.object({
        poolId: z.string(),
        assetId: assetIdSchema,
        amountHeld: amountString.nullable(),
        amountReason: z.enum(['ledger_unavailable']).nullable(),
        depositorCount: z.number().int().nonnegative(),
        utilisation: z.null(),
        utilisationReason: z.literal('utilisation_not_recorded'),
      }),
    ),
  }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_OPS_CARD_PROGRAMME = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgramme',
  kind: 'query',
  path: 'ops.cardProgramme',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ from: z.string().optional(), to: z.string().optional() }),
  output: z.object({
    simulated: z.boolean(),
    issued: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    frozen: z.number().int().nonnegative(),
    days: z.array(
      z.object({
        day: z.string(),
        volume: z.array(z.object({ assetId: assetIdSchema, amount: amountString })),
        declines: z.number().int().nonnegative(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_BUSINESS_APPROVALS = defineProcedure({
  ...base,
  name: 'bank.ops.businessApprovals',
  kind: 'query',
  path: 'ops.businessApprovals',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
    limit: z.number().int().optional(),
    cursor: z.string().optional(),
  }),
  output: z.object({
    approvals: z.array(
      z.object({
        businessId: z.string().guid(),
        amount: amountString,
        assetId: assetIdSchema,
        ageSeconds: z.number().int().nonnegative(),
        makerHandle: z.string().nullable(),
        makerHandleReason: z.enum(['handle_unresolved']).nullable(),
        rule: amountString,
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_FAILED_TRANSFERS = defineProcedure({
  ...base,
  name: 'bank.ops.failedTransfers',
  kind: 'query',
  path: 'ops.failedTransfers',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: z.object({
    windowHours: z.number().int().optional(),
    limit: z.number().optional(),
    cursor: z.string().optional(),
  }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        kind: z.literal('standing_order'),
        amount: amountString,
        assetId: assetIdSchema,
        status: z.literal('rejected'),
        rejectionCode: z.string(),
        reason: z.string(),
        attemptedAt: z.string(),
        sender: partyOutput,
        receiver: partyOutput,
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_TRANSFER_DETAIL = defineProcedure({
  ...base,
  name: 'bank.ops.transferDetail',
  kind: 'query',
  path: 'ops.transferDetail',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: z.object({ id: z.string() }),
  output: z.object({
    id: z.string(),
    kind: z.enum(['standing_order', 'one_off']),
    senderUserId: z.string(),
    receiverUserId: z.string(),
    amount: amountString,
    assetId: assetIdSchema,
    status: z.string(),
    rejectionCode: z.string().nullable(),
    reason: z.string().nullable(),
    ledgerTxId: z.string().nullable(),
    scheduleId: z.string().nullable(),
    occurrence: z.number().int().nullable(),
    attemptedAt: z.string(),
    settledAt: z.string().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const id = z.object({ disputeId: z.string().guid() });

/**
 * CARD DISPUTES, AS SUPPORT WORKS THEM (J-bank-27; BK-cdisp-02, BK-cdisp-03).
 *
 * A case is one cardholder's dispute of one settled card capture. Support files it, adds evidence, submits a representment,
 * escalates to arbitration (an explicit state, never implied), asks the card partner for a provisional credit, and decides
 * the case. Every step is a row in the case's timeline with who did it and when; evidence added after the representment was
 * submitted is kept with its own time and marked so.
 *
 * The money is the partner's (OWNER 226). A provisional credit is the partner's credit to its own cardholder: the partner
 * answers with its reference and the amount it credited, and the cardholder's available, as the partner reports it, rises
 * by that amount. Who bears a fraud loss is the partner's terms at the moment of the decision, or "not known"; it is never
 * assumed to be the partner. Nothing here posts to the ledger, and no figure here is summed into a balance.
 *
 * The dispute cap is the owner's (`BANK_CARD_DISPUTE_CAP_JSON`): the most one dispute may be credited or decided for the
 * cardholder, per asset. Blank refuses `bank.card_dispute_cap_unset`; above it refuses `bank.card_dispute_cap_exceeded`.
 * A decision for the merchant needs no cap: nothing is given to the cardholder.
 */
export const DISPUTE_STATES = ['opened', 'representment', 'arbitration', 'closed'] as const;

export const state = z.enum(DISPUTE_STATES);

export const DISPUTE_OUTCOMES = ['cardholder', 'merchant'] as const;

/** How a case closed: decided by support for one side, or withdrawn by the cardholder who filed it (J-bank-15 #4). */
export const DISPUTE_CLOSURES = [...DISPUTE_OUTCOMES, 'withdrawn'] as const;

export const LOSS_BEARERS = ['partner', 'programme', 'cardholder'] as const;

export const summary = z.object({
  id: z.string().guid(),
  caseKey: z.string(),
  cardId: z.string().guid(),
  userId: z.string(),
  authorizationRef: z.string(),
  assetId: assetIdSchema,
  amount: amountString,
  reason: z.string(),
  state,
  test: z.boolean(),
  provisionalCredit: z.object({
    state: z.enum(['none', 'asked', 'credited']),
    amount: amountString.nullable(),
    partnerRef: z.string().nullable(),
    at: z.string().nullable(),
  }),
  decision: z
    .object({
      outcome: z.enum(DISPUTE_CLOSURES),
      reason: z.string().nullable(),
      lossStatus: z.enum(['reported', 'not_known']),
      lossBearer: z.enum(LOSS_BEARERS).nullable(),
      lossTerms: z.string().nullable(),
      creditSettlement: z.enum(['final', 'reversed']).nullable(),
      creditSettlementPartnerRef: z.string().nullable(),
      closedAt: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
});

export const DISPUTE_EVENT_KINDS = ['opened', 'evidence', 'representment', 'arbitration', 'provisional_credit', 'closed'] as const;

export const disputeCase = summary.extend({
  cap: amountString.nullable(),
  events: z.array(
    z.object({
      sequence: z.number().int().positive(),
      kind: z.enum(DISPUTE_EVENT_KINDS),
      fromState: state.nullable(),
      toState: state,
      actor: z.string(),
      detail: z.string().nullable(),
      afterSubmission: z.boolean(),
      at: z.string(),
    }),
  ),
});

export const BANK_OPS_CARD_DISPUTE_EVIDENCE = defineProcedure({
  ...base,
  name: 'bank.ops.cardDisputeEvidence',
  kind: 'mutation',
  path: 'ops.cardDisputeEvidence',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: id.extend({ stepKey: z.string(), description: z.string() }).strict(),
  output: disputeCase,
  samples: [
    { verdict: 'accept', input: { disputeId: '22222222-2222-4222-8222-222222222222', stepKey: 'placeholder', description: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_DISPUTE_REPRESENTMENT = defineProcedure({
  ...base,
  name: 'bank.ops.cardDisputeRepresentment',
  kind: 'mutation',
  path: 'ops.cardDisputeRepresentment',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: id.extend({ stepKey: z.string(), description: z.string() }).strict(),
  output: disputeCase,
  samples: [
    { verdict: 'accept', input: { disputeId: '22222222-2222-4222-8222-222222222222', stepKey: 'placeholder', description: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_DISPUTE_ARBITRATION = defineProcedure({
  ...base,
  name: 'bank.ops.cardDisputeArbitration',
  kind: 'mutation',
  path: 'ops.cardDisputeArbitration',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: id.extend({ stepKey: z.string() }).strict(),
  output: disputeCase,
  samples: [
    { verdict: 'accept', input: { disputeId: '22222222-2222-4222-8222-222222222222', stepKey: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_DISPUTE_CREDIT = defineProcedure({
  ...base,
  name: 'bank.ops.cardDisputeCredit',
  kind: 'mutation',
  path: 'ops.cardDisputeCredit',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: id.strict(),
  output: disputeCase,
  samples: [
    { verdict: 'accept', input: { disputeId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_DISPUTE_DECIDE = defineProcedure({
  ...base,
  name: 'bank.ops.cardDisputeDecide',
  kind: 'mutation',
  path: 'ops.cardDisputeDecide',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: id.extend({ outcome: z.enum(DISPUTE_OUTCOMES), reason: z.string().optional() }).strict(),
  output: disputeCase,
  samples: [
    { verdict: 'accept', input: { disputeId: '22222222-2222-4222-8222-222222222222', outcome: 'cardholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
