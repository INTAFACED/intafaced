import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { assetIdSchema } from './asset-id.js';
import { jsonValueSchema } from './procedure-strict-schema.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `ops.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const salaryRailsOutput = z.object({
  partner: z
    .object({
      label: z.string(),
      asOf: z.string(),
      lines: z.array(
        z.object({
          currency: z.string(),
          network: z.object({ credits: z.string(), reversals: z.string() }).nullable(),
          app: z.object({ credits: z.string(), reversals: z.string() }),
          matches: z.boolean().nullable(),
          difference: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
});

/**
 * THE RAMP PARTNER'S OWN REPORT (J-bank-28 #3, BK-ord-01).
 *
 * Ramp orders are the partner's: the partner opens each payment, the payer approves it on the partner's page,
 * and the partner says it was paid or sent back. So the finance desk reads ramp metrics from the partner's own report,
 * never from svc-bank's rows: orders by the state the partner gives them, the partner's health, and the orders whose
 * quote ran out at the partner before the payer approved. With no partner wired there is no report, and the desk says
 * "no data", never zero.
 *
 * On the stack the partner is the TEST pay-in stand-in (`payin-sim.ts`), and this is its book: what it opened, what its
 * page saw approved, and what it said was paid or returned, kept in its process. It holds no money.
 */
export const RAMP_PARTNER_ORDER_STATES = ['opened', 'approved', 'paid', 'returned', 'expired'] as const;

export const rampMetricsOutput = z.object({
  partner: z
    .object({
      label: z.string(),
      asOf: z.string(),
      health: z.literal('operational'),
      lastOpenedAt: z.string().nullable(),
      lastPaidAt: z.string().nullable(),
      orders: z.array(z.object({ state: z.enum(RAMP_PARTNER_ORDER_STATES), count: z.number().int().nonnegative() })),
      quoteExpiries: z.object({
        count: z.number().int().nonnegative(),
        latest: z.array(z.object({ orderId: z.string(), expiredAt: z.string() })),
      }),
    })
    .nullable(),
});

export const refundLine = z.object({
  collectionId: z.string(),
  assetId: assetIdSchema,
  amount: z.string(),
  moveId: z.string(),
  refundedAt: z.string(),
});

export const failureLine = z.object({ collectionId: z.string(), code: z.string(), at: z.string() });

export const directDebitMandatesOutput = z.object({
  partner: z
    .object({
      label: z.string(),
      asOf: z.string(),
      mandates: z.array(
        z.object({
          mandateId: z.string(),
          userId: z.string(),
          state: z.enum(['active', 'blocked']),
          blockedAt: z.string().nullable(),
          knownAt: z.string(),
          creditorName: z.string().nullable(),
          reference: z.string().nullable(),
          assetId: assetIdSchema.nullable(),
          refunds: z.array(refundLine),
          failures: z.array(failureLine),
        }),
      ),
      failuresByReason: z.array(z.object({ code: z.string(), count: z.number().int().positive() })),
      refundCount: z.number().int().nonnegative(),
    })
    .nullable(),
});

/**
 * CARD DISPUTES, AS SUPPORT WORKS THEM (J-bank-27; BK-cdisp-02, BK-cdisp-03).
 *
 * A case is one cardholder's dispute of one settled card capture. Support files it, adds evidence, submits a representment,
 * escalates to arbitration (an explicit state, never implied), asks the card partner for a provisional credit, and decides
 * the case. Every step is a row in the case's timeline with who did it and when; evidence added after the representment was
 * submitted is kept with its own time and marked so.
 *
 * The money is the partner's. A provisional credit is the partner's credit to its own cardholder: the partner
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

export const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

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

export const id = z.object({ disputeId: z.string().guid() });

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

export const cardholder = z.object({
  id: z.string().guid(),
  kind: z.enum(['individual', 'business']),
  name: z.string(),
  email: z.string().nullable(),
  country: z.string(),
  userId: z.string().nullable(),
  beneficialOwners: z.array(z.object({ name: z.string(), email: z.string() })),
  status: z.enum(['verified', 'review']),
  gap: z.string().nullable(),
  gapCode: z.string().nullable(),
  screening: z.enum(['clear', 'listed']),
  screenedAt: z.string(),
  test: z.boolean(),
  createdAt: z.string(),
});

export const cardRef = z.object({
  id: z.string().guid(),
  panTail: z.string(),
  status: z.string(),
  assetId: assetIdSchema,
  test: z.boolean(),
});

export const amount = z.string().regex(/^\d+(\.\d{1,18})?$/);

export const signed = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

export const traceStep = z.object({ check: z.string(), result: z.enum(['pass', 'decline', 'skip']), detail: z.string() });

export const words = z.string().min(1);

export const ratioString = z.string().regex(/^(?:\d+(?:\.\d+)?|\d+\/\d+)$/);

export const standingOutput = z.object({
  pending: z.number().int().nonnegative(),
  settled: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  failureRate: ratioString.nullable(),
  oldestPendingAgeSeconds: z.number().int().nonnegative().nullable(),
});

export const signedAmount = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

export const BALANCE_ENTRIES_MAX_LIMIT = 200;

export const BALANCE_ENTRIES_DEFAULT_LIMIT = 50;

/**
 * J-bank-30 #8: the payroll rail, per currency: the network's own credits minus reversals against what the app showed.
 * `partner: null` when no payroll network is wired ("no data", never zero). Read only.
 */
export const BANK_OPS_SALARY_RAILS = defineProcedure({
  ...base,
  name: 'bank.ops.salaryRails',
  kind: 'query',
  path: 'ops.salaryRails',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: salaryRailsOutput,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_RAMP_METRICS = defineProcedure({
  ...base,
  name: 'bank.ops.rampMetrics',
  kind: 'query',
  path: 'ops.rampMetrics',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: rampMetricsOutput,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_DIRECT_DEBIT_MANDATES = defineProcedure({
  ...base,
  name: 'bank.ops.directDebitMandates',
  kind: 'query',
  path: 'ops.directDebitMandates',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: directDebitMandatesOutput,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The queue, newest first; `state` filters it. */
export const BANK_OPS_CARD_DISPUTES = defineProcedure({
  ...base,
  name: 'bank.ops.cardDisputes',
  kind: 'query',
  path: 'ops.cardDisputes',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ state: state.optional() }).strict(),
  output: z.object({ rows: z.array(summary), more: z.boolean() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One case with its whole timeline and the owner's cap for its asset. */
export const BANK_OPS_CARD_DISPUTE = defineProcedure({
  ...base,
  name: 'bank.ops.cardDispute',
  kind: 'query',
  path: 'ops.cardDispute',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: id.strict(),
  output: disputeCase,
  samples: [
    { verdict: 'accept', input: { disputeId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PROGRAMME_CARDHOLDERS = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeCardholders',
  kind: 'query',
  path: 'ops.cardProgrammeCardholders',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ query: z.string().max(120).optional() }).strict(),
  output: z.array(cardholder.extend({ cards: z.array(cardRef) })),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PROGRAMME_AUTHORIZATION = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeAuthorization',
  kind: 'query',
  path: 'ops.cardProgrammeAuthorization',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ id: z.string().max(64) }).strict(),
  output: z.object({
    id: z.string().guid(),
    cardId: z.string().guid(),
    authorizationRef: z.string(),
    panTail: z.string(),
    assetId: assetIdSchema,
    amount,
    channel: z.string(),
    merchantCategory: z.string().nullable(),
    decision: z.enum(['approved', 'declined']),
    declineCode: z.string().nullable(),
    heldBy: z.string(),
    partnerHoldRef: z.string().nullable(),
    test: z.boolean(),
    lifecycle: z.array(z.object({ event: z.string(), amount, at: z.string(), detail: z.string().nullable() })),
    variance: z.object({ authorised: amount, captured: amount, returned: amount, stillHeld: amount, captureVariance: signed }).nullable(),
    trace: z.array(traceStep).nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PROGRAMME_CARDHOLDER = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeCardholder',
  kind: 'query',
  path: 'ops.cardProgrammeCardholder',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ cardholderId: z.string().max(64) }).strict(),
  output: cardholder.extend({
    cards: z.array(cardRef),
    funds: z.array(
      z.object({
        assetId: assetIdSchema,
        appHeld: amount,
        appCaptured: amount,
        appFigure: amount,
        partnerHeld: amount.nullable(),
        partnerCaptured: amount.nullable(),
        partnerFigure: amount.nullable(),
        difference: signed.nullable(),
        status: z.enum(['matches', 'break', 'not_known']),
        test: z.boolean(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { cardholderId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PARTNER_TERMS = defineProcedure({
  ...base,
  name: 'bank.ops.cardPartnerTerms',
  kind: 'query',
  path: 'ops.cardPartnerTerms',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    test: z.boolean(),
    label: z.string(),
    custodyMode: words,
    funder: words,
    reserve: words,
    reserveStatus: z.enum(['reported', 'not_known']),
    lossLiability: words,
    lossLiabilityStatus: z.enum(['reported', 'not_known']),
  }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_OPS_RAMP_HEALTH = defineProcedure({
  ...base,
  name: 'bank.ops.rampHealth',
  kind: 'query',
  path: 'ops.rampHealth',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ windowHours: z.number().int().optional() }),
  output: z.object({
    asOf: z.string(),
    rails: z.array(
      z.object({
        id: z.string(),
        provider: z.string(),
        lastSuccess: z.string().nullable(),
        lastFailure: z.string().nullable(),
        openCount: z.number().int().nonnegative(),
        failureCount: z.number().int().nonnegative(),
        totalCount: z.number().int().nonnegative(),
        failureRate: z
          .string()
          .regex(/^\d+\/\d+$/)
          .nullable(),
        lastProbeAt: z.null(),
        reason: z.literal('no_heartbeat'),
      }),
    ),
  }),
  samples: [
    // The door refuses a read with no window (its `_health_window_unset` refusal), so the accepted sample names one.
    { verdict: 'accept', input: { windowHours: 24 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_TRANSFER_HEALTH = defineProcedure({
  ...base,
  name: 'bank.ops.transferHealth',
  kind: 'query',
  path: 'ops.transferHealth',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ windowHours: z.number().int().optional() }),
  output: z.object({
    asOf: z.string(),
    standingOrders: standingOutput,
    oneOff: z.object({
      available: z.literal(true),
      reserved: z.number().int().nonnegative(),
      posted: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      failureRate: z.null(),
      failureRateReason: z.literal('failures_not_recorded'),
      oldestPendingAgeSeconds: z.number().int().nonnegative().nullable(),
    }),
    p2p: z
      .object({
        available: z.literal(false),
        reason: z.literal('served_by_p2p_ops'),
      })
      .strict(),
    bills: z.object({
      available: z.literal(true),
      submitted: z.number().int().nonnegative(),
      accepted: z.number().int().nonnegative(),
      paid: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      returned: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      failureRate: ratioString.nullable(),
      oldestPendingAgeSeconds: z.number().int().nonnegative().nullable(),
    }),
  }),
  samples: [
    // The door refuses a read with no window (its `_health_window_unset` refusal), so the accepted sample names one.
    { verdict: 'accept', input: { windowHours: 24 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One customer's payments to and from other people, newest first, for the console's customer record (J-ops-console-02 #3). */
export const BANK_OPS_CUSTOMER_TRANSFERS = defineProcedure({
  ...base,
  name: 'bank.ops.customerTransfers',
  kind: 'query',
  path: 'ops.customerTransfers',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ userId: z.string().guid(), limit: z.number().int().min(1).max(200) }).strict(),
  output: z.object({
    userId: z.string(),
    transfers: z.array(
      z.object({
        id: z.string(),
        direction: z.enum(['sent', 'received']),
        counterpartyUserId: z.string(),
        amount: z.string().regex(/^\d+(\.\d{1,18})?$/),
        assetId: assetIdSchema,
        status: z.string(),
        ledgerTxId: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    truncated: z.boolean(),
  }),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 200 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CUSTOMER_BALANCES = defineProcedure({
  ...base,
  name: 'bank.ops.customerBalances',
  kind: 'query',
  path: 'ops.customerBalances',
  access: { caller: 'anyScope', scopes: ['admin:read', 'admin:treasury'] },
  refusals: {},
  input: z.object({ userId: z.string().guid() }).strict(),
  output: z.object({
    userId: z.string(),
    assets: z.array(
      z.object({
        assetId: assetIdSchema,
        total: signedAmount,
        available: signedAmount,
        hold: signedAmount,
        escrow: signedAmount,
        stake: signedAmount,
        collateral: signedAmount,
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * J-derivatives-26 #8: one customer's spending balances as the partner that holds their money reports them, for the
 * founder console (`admin:read`). Each figure is the one the customer's own `spaces.list` shows, with the partner's label
 * as its source and the partner's as-of time; a stale figure says so, and a figure the partner has not reported refuses
 * by name. `heldByPartner: false` with no spaces when no partner holds this person's money: ledger figures are never
 * mixed in. Audited before anything is read; writes nothing.
 */
export const BANK_OPS_CUSTOMER_PARTNER_BALANCES = defineProcedure({
  ...base,
  name: 'bank.ops.customerPartnerBalances',
  kind: 'query',
  path: 'ops.customerPartnerBalances',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: { 'bank.ops_audit_unavailable': 'SERVICE_UNAVAILABLE', 'bank.partner_balance_not_known': 'PRECONDITION_FAILED' },
  input: z.object({ userId: z.string().guid() }).strict(),
  output: z.object({
    userId: z.string(),
    heldByPartner: z.boolean(),
    spaces: z.array(
      z.object({
        spaceId: z.string(),
        assetId: assetIdSchema,
        kind: z.string(),
        name: z.string(),
        balance: signedAmount,
        source: z.string(),
        asOf: z.string(),
        state: z.enum(['known', 'stale']),
        staleAfterMs: z.number(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: { userId: '11111111-1111-4111-8111-111111111111', extra: 1 } },
  ],
});

export const BANK_OPS_CUSTOMER_BALANCE_ENTRIES = defineProcedure({
  ...base,
  name: 'bank.ops.customerBalanceEntries',
  kind: 'query',
  path: 'ops.customerBalanceEntries',
  access: { caller: 'scope', scope: 'admin:treasury' },
  refusals: {},
  input: z
    .object({
      userId: z.string().guid(),
      assetId: assetIdSchema.min(1).max(16),
      cursor: z.string().min(1).max(16).optional(),
      limit: z.number().int().min(1).max(BALANCE_ENTRIES_MAX_LIMIT).default(BALANCE_ENTRIES_DEFAULT_LIMIT),
    })
    .strict(),
  output: z.object({
    assetId: assetIdSchema,
    entries: z.array(
      z.object({
        entryId: z.string().nullable(),
        txId: z.string(),
        accountId: z.string(),
        reason: z.string(),
        direction: z.enum(['debit', 'credit']),
        amount: signedAmount,
        postedAt: z.string(),
      }),
    ),
    nextCursor: z.string().nullable(),
    sumCheck: z.object({ ok: z.literal(true), entriesSum: signedAmount, balance: signedAmount, entryCount: z.number().int() }),
  }),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', assetId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_SET_CARD_STATUS = defineProcedure({
  ...base,
  name: 'bank.ops.setCardStatus',
  kind: 'mutation',
  path: 'ops.setCardStatus',
  access: { caller: 'scope', scope: 'admin:treasury' },
  refusals: {},
  input: z.object({
    cardId: z.string().guid(),
    status: z.enum(['frozen', 'active']),
    reason: z.string(),
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
    clientRequestId: z.string().min(1),
  }),
  output: z.object({ cardId: z.string().guid(), status: z.enum(['frozen', 'active']), frozenBy: z.enum(['operator']).nullable() }),
  samples: [
    {
      verdict: 'accept',
      input: { cardId: '11111111-1111-4111-8111-111111111111', status: 'frozen', reason: 'USDC', clientRequestId: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const figures = z.object({ spend: signed, open: signed });

export const BANK_OPS_RUN_RISK_SWEEP = defineProcedure({
  ...base,
  name: 'bank.ops.runRiskSweep',
  kind: 'mutation',
  path: 'ops.runRiskSweep',
  access: { caller: 'service', callers: ['svc-bank'], forbidden: 'ops job is callable only as svc-bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(10_000).optional() }),
  output: z.object({
    marked: z.number().int(),
    called: z.number().int(),
    liquidated: z.number().int(),
    cleared: z.number().int(),
    // Loans the sweep declined to act on — an unusable mark, no
    // counterparty, a reserve that cannot cover. Surfaced rather than
    // swallowed: a silent refusal is a position nobody is watching.
    refused: z.array(z.object({ loanId: z.string(), reason: z.string() })),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PAY_FROM_RECONCILIATION = defineProcedure({
  ...base,
  name: 'bank.ops.cardPayFromReconciliation',
  kind: 'query',
  path: 'ops.cardPayFromReconciliation',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    test: z.boolean(),
    partnerReports: z.boolean(),
    lines: z.array(
      z.object({
        assetId: assetIdSchema,
        kind: z.enum(['spend', 'open_holds']),
        app: signed,
        partner: signed,
        status: z.enum(['matches', 'break']),
      }),
    ),
    breaks: z.array(
      z.object({
        authorizationRef: z.string(),
        assetId: assetIdSchema,
        reason: z.enum(['not_reported', 'unreadable', 'differs']),
        app: figures,
        partner: figures.nullable(),
      }),
    ),
  }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_OPS_RUN_DUE_TRANSFERS = defineProcedure({
  ...base,
  name: 'bank.ops.runDueTransfers',
  kind: 'mutation',
  path: 'ops.runDueTransfers',
  access: { caller: 'service', callers: ['svc-bank'], forbidden: 'ops job is callable only as svc-bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(10_000).optional() }),
  output: z.object({
    schedulesConsidered: z.number().int(),
    settled: z.number().int(),
    rejected: z.number().int(),
    alreadyFired: z.number().int(),
    /** Schedules looked at only because a claim was left behind. An operator wants zero. */
    strandedSwept: z.number().int(),
    /** Schedules that threw mid-drive; occurrence not consumed; next pass retries. */
    failures: z.array(
      z.object({
        scheduleId: z.string(),
        reason: z.string(),
        code: z.string().optional(),
      }),
    ),
  }),
  samples: [
    // Only svc-bank's own job is let through (the replay's callers are all refused), as its tests send it: one pass, bounded.
    { verdict: 'accept', input: { limit: 10 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Re-drive loans stuck between the collateral lock and the draw. */
export const BANK_OPS_RESUME_PENDING_LOANS = defineProcedure({
  ...base,
  name: 'bank.ops.resumePendingLoans',
  kind: 'mutation',
  path: 'ops.resumePendingLoans',
  access: { caller: 'service', callers: ['svc-bank'], forbidden: 'ops job is callable only as svc-bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(1_000).optional() }),
  output: z.array(z.object({ loanId: z.string(), outcome: z.string(), reason: z.string().optional() })),
  samples: [
    // Only svc-bank's own job is let through (the replay's callers are all refused), as its tests send it: one pass, bounded.
    { verdict: 'accept', input: { limit: 10 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_LOAN_BOOK = defineProcedure({
  ...base,
  name: 'bank.ops.loanBook',
  kind: 'query',
  path: 'ops.loanBook',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    asOf: z.string(),
    openCount: z.number().int().nonnegative(),
    outstandingPrincipal: z.array(z.object({ assetId: assetIdSchema, amount: amountString })),
    bands: z.object({
      healthy: z.number().int().nonnegative(),
      marginCall: z.number().int().nonnegative(),
      liquidation: z.number().int().nonnegative(),
      unpriced: z.number().int().nonnegative(),
    }),
    unpriced: z.array(
      z.object({
        loanId: z.string(),
        reason: z.enum(['bank.loan_health_price_unset', 'bank.loan_opening_thresholds_unset']),
      }),
    ),
    oldestPending: z.object({ id: z.string(), ageSeconds: z.number().int().nonnegative() }).nullable(),
  }),
  samples: [{ verdict: 'accept' }],
});

/**
 * RUNNING THE CARD PROGRAMME (J-bank-26; BK-cops-01 to -03 and -06 to -08), for support and finance on the founder console.
 *
 * The programme, product, BIN, fee and 3DS settings, the authorisation rules (shadow, promote, roll back), the set-up
 * checklist, cardholders behind a KYC and KYB gate with screening and a review queue, the real-time decision log and one
 * authorisation's lifecycle, capture variance and trace, a signed report export, staff roles, the audit log, bulk issue,
 * reassign and the TEST card event simulator.
 *
 * Nothing here holds a balance or posts to the ledger. Card money is the card partner's: the simulator drives
 * the same authorise and capture path a real issuer's message does, and a reassign moves a card, never money. Fees are
 * recorded settings: svc-bank has no fee recipe, so none is charged. Every change writes one audit row, which the
 * database refuses to edit. A staff member with the viewer role reads everything here and changes nothing.
 */
export const setting = z
  .object({ value: jsonValueSchema, version: z.number().int(), updatedBy: z.string(), updatedAt: z.string() })
  .nullable();

export const settings = z.object({ programme: setting, product: setting, bin: setting, fees: setting, threeds: setting });

export const assetId = z.string().regex(/^[A-Z0-9]{2,16}$/);

export const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);

export const ruleParamsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('amount_above'), assetId, amount: decimal }).strict(),
  z.object({ kind: z.literal('merchant_category'), category: z.string().trim().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('channel'), channel: z.enum(['card-present', 'online', 'contactless', 'atm', 'foreign']) }).strict(),
]);

export const rule = z.object({
  id: z.string().guid(),
  ruleKey: z.string(),
  version: z.number().int(),
  name: z.string(),
  params: ruleParamsSchema,
  words: z.string(),
  state: z.enum(['shadow', 'active', 'retired']),
  shadow: z.object({ evaluated: z.number().int(), wouldDecline: z.number().int(), at: z.string() }),
  createdBy: z.string(),
  createdAt: z.string(),
  promotedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
});

export const staff = z.object({
  userId: z.string(),
  email: z.string(),
  role: z.enum(['manager', 'viewer']),
  assignedBy: z.string(),
  assignedAt: z.string(),
});

export const channel = z.enum(['card-present', 'online', 'contactless', 'atm', 'foreign']);

export const BANK_OPS_CARD_PROGRAMME_CLEAR_THREE_DS = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeClearThreeDs',
  kind: 'mutation',
  path: 'ops.cardProgrammeClearThreeDs',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: NO_INPUT,
  output: settings,
  samples: [{ verdict: 'accept' }],
});

export const BANK_OPS_CARD_PROGRAMME_RULE_CREATE = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeRuleCreate',
  kind: 'mutation',
  path: 'ops.cardProgrammeRuleCreate',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: z.object({ ruleKey: z.string().max(64), name: z.string().max(80), params: ruleParamsSchema }).strict(),
  output: rule,
  samples: [
    {
      verdict: 'accept',
      input: { ruleKey: 'placeholder', name: 'placeholder', params: { kind: 'amount_above', assetId: 'BTC', amount: '1.50' } },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PROGRAMME_RULE_PROMOTE = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeRulePromote',
  kind: 'mutation',
  path: 'ops.cardProgrammeRulePromote',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: z.object({ ruleId: z.string().guid() }).strict(),
  output: z.array(rule),
  samples: [
    { verdict: 'accept', input: { ruleId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PROGRAMME_RULE_ROLLBACK = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeRuleRollback',
  kind: 'mutation',
  path: 'ops.cardProgrammeRuleRollback',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: z.object({ ruleKey: z.string().max(64) }).strict(),
  output: z.array(rule),
  samples: [
    { verdict: 'accept', input: { ruleKey: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PROGRAMME_STAFF_ASSIGN = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeStaffAssign',
  kind: 'mutation',
  path: 'ops.cardProgrammeStaffAssign',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: z.object({ email: z.string().max(254), role: z.enum(['manager', 'viewer']) }).strict(),
  output: z.array(staff),
  samples: [
    { verdict: 'accept', input: { email: 'placeholder', role: 'manager' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PROGRAMME_BULK_VALIDATE = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeBulkValidate',
  kind: 'mutation',
  path: 'ops.cardProgrammeBulkValidate',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: z.object({ file: z.string().max(100_000) }).strict(),
  output: z.object({
    batchId: z.string(),
    ok: z.boolean(),
    rows: z.array(
      z.object({
        row: z.number().int(),
        cardholderId: z.string(),
        assetId: assetIdSchema,
        perAuthorizationLimit: z.string(),
        error: z.string().nullable(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { file: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PROGRAMME_REASSIGN = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeReassign',
  kind: 'mutation',
  path: 'ops.cardProgrammeReassign',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: z.object({ cardId: z.string().guid(), toCardholderId: z.string().guid() }).strict(),
  output: z.object({ cardId: z.string().guid(), panTail: z.string(), cardholderId: z.string().guid() }),
  samples: [
    {
      verdict: 'accept',
      input: { cardId: '22222222-2222-4222-8222-222222222222', toCardholderId: '22222222-2222-4222-8222-222222222222' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The card event simulator (TEST): dev and test stacks only, simulated cards only. */
export const BANK_OPS_CARD_PROGRAMME_SIMULATE = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeSimulate',
  kind: 'mutation',
  path: 'ops.cardProgrammeSimulate',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('authorize'),
        cardId: z.string().guid(),
        authorizationRef: z.string().min(4).max(128),
        amount,
        channel: channel.optional(),
        merchantCategory: z.string().max(64).optional(),
        threeDs: z.enum(['authenticated', 'failed']).optional(),
      })
      .strict(),
    z.object({ kind: z.literal('capture'), cardId: z.string().guid(), authorizationRef: z.string().min(4).max(128), amount }).strict(),
    z.object({ kind: z.literal('reverse'), cardId: z.string().guid(), authorizationRef: z.string().min(4).max(128) }).strict(),
  ]),
  output: z.object({
    test: z.literal(true),
    kind: z.enum(['authorize', 'capture', 'reverse']),
    authorizationId: z.string().optional(),
    decision: z.enum(['approved', 'declined']).optional(),
    declineCode: z.string().nullable().optional(),
    captured: amount.optional(),
    returned: amount.optional(),
  }),
  samples: [
    {
      verdict: 'accept',
      input: { kind: 'authorize', cardId: '22222222-2222-4222-8222-222222222222', authorizationRef: 'placeholder', amount: '1.50' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PROGRAMME_EXPORT = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeExport',
  kind: 'mutation',
  path: 'ops.cardProgrammeExport',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ fileName: z.string(), asOf: z.string(), text: z.string(), sha256: z.string(), signature: z.string() }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_OPS_CARD_PROGRAMME_CARDHOLDER_CREATE = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeCardholderCreate',
  kind: 'mutation',
  path: 'ops.cardProgrammeCardholderCreate',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: z
    .object({
      requestKey: z.string().max(128),
      kind: z.enum(['individual', 'business']),
      name: z.string().max(120),
      email: z.string().max(254).optional(),
      country: z.string().max(2),
      beneficialOwners: z
        .array(z.object({ name: z.string().max(120), email: z.string().max(254) }).strict())
        .max(10)
        .optional(),
    })
    .strict(),
  output: cardholder,
  samples: [
    {
      verdict: 'accept',
      input: { requestKey: 'console-cardholder-00000001', kind: 'individual', name: 'Ada TEST', email: 'ada@example.test', country: 'US' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_OPS_CARD_PROGRAMME_BULK_ISSUE = defineProcedure({
  ...base,
  name: 'bank.ops.cardProgrammeBulkIssue',
  kind: 'mutation',
  path: 'ops.cardProgrammeBulkIssue',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: z.object({ file: z.string().max(100_000) }).strict(),
  output: z.object({
    batchId: z.string(),
    cards: z.array(z.object({ row: z.number().int(), cardId: z.string().guid(), panTail: z.string(), cardholderId: z.string().guid() })),
    cardsInBatch: z.number().int(),
    test: z.boolean(),
  }),
  samples: [
    { verdict: 'accept', input: { file: 'cardholder,asset,limit\n22222222-2222-4222-8222-222222222222,USDC,100' } },
    { verdict: 'refuse', input: 42 },
  ],
});
