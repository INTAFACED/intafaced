import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString } from './bank-ops-2-procedures.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `cards.disputes.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

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

export const DISPUTE_OUTCOMES = ['cardholder', 'merchant'] as const;

/** How a case closed: decided by support for one side, or withdrawn by the cardholder who filed it (J-bank-15 #4). */
export const DISPUTE_CLOSURES = [...DISPUTE_OUTCOMES, 'withdrawn'] as const;

export const DISPUTE_EVENT_KINDS = ['opened', 'evidence', 'representment', 'arbitration', 'provisional_credit', 'closed'] as const;

export const caseOutput = z.object({
  id: z.string().guid(),
  cardId: z.string().guid(),
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
      creditSettlement: z.enum(['final', 'reversed']).nullable(),
      creditSettlementPartnerRef: z.string().nullable(),
      closedAt: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
  events: z.array(
    z.object({
      sequence: z.number().int().positive(),
      kind: z.enum(DISPUTE_EVENT_KINDS),
      fromState: state.nullable(),
      toState: state,
      by: z.enum(['you', 'support']),
      /** The cardholder's own words (their reason or evidence); support's notes stay with support. */
      detail: z.string().nullable(),
      afterSubmission: z.boolean(),
      at: z.string(),
    }),
  ),
});

export const charge = z.object({ cardId: z.string().guid(), authorizationRef: z.string().min(1).max(128) });

export const CARDHOLDER_DISPUTE_STANDINGS = [
  'disputable',
  'declined',
  'not_settled',
  'refunded',
  'already_disputed',
  'window_closed',
  'rules_unset',
] as const;

export const formOutput = z.object({
  test: z.boolean(),
  rules: z.object({ windowDays: z.number().int().positive(), evidenceAfterSubmission: z.boolean() }).nullable(),
  charge: z.object({
    authorizationRef: z.string(),
    assetId: assetIdSchema,
    merchant: z.string().nullable(),
    captured: amountString,
    disputable: amountString,
    settledAt: z.string().nullable(),
  }),
  deadline: z.string().nullable(),
  standing: z.enum(CARDHOLDER_DISPUTE_STANDINGS),
  disputeId: z.string().nullable(),
});

export const one = z.object({ disputeId: z.string().guid() });

/** The person's cases on one card, newest first. */
export const BANK_CARDS_DISPUTES_LIST = defineProcedure({
  ...base,
  name: 'bank.cards.disputes.list',
  kind: 'query',
  path: 'cards.disputes.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid() }).strict(),
  output: z.array(caseOutput.omit({ events: true })),
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The prefilled form for one charge: the partner's window and evidence rule, and where this charge stands. */
export const BANK_CARDS_DISPUTES_FORM = defineProcedure({
  ...base,
  name: 'bank.cards.disputes.form',
  kind: 'query',
  path: 'cards.disputes.form',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: charge.strict(),
  output: formOutput,
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111', authorizationRef: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** File a dispute of all or part of one charge, with a reason. */
export const BANK_CARDS_DISPUTES_OPEN = defineProcedure({
  ...base,
  name: 'bank.cards.disputes.open',
  kind: 'mutation',
  path: 'cards.disputes.open',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: charge.extend({ amount: z.string(), reason: z.string() }).strict(),
  output: caseOutput,
  samples: [
    {
      verdict: 'accept',
      input: { cardId: '11111111-1111-4111-8111-111111111111', authorizationRef: 'USDC', amount: 'USDC', reason: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One case with its tracker. */
export const BANK_CARDS_DISPUTES_GET = defineProcedure({
  ...base,
  name: 'bank.cards.disputes.get',
  kind: 'query',
  path: 'cards.disputes.get',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: one.strict(),
  output: caseOutput,
  samples: [
    { verdict: 'accept', input: { disputeId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Evidence: taken while open; after the representment only where the partner's rules take it. */
export const BANK_CARDS_DISPUTES_EVIDENCE = defineProcedure({
  ...base,
  name: 'bank.cards.disputes.evidence',
  kind: 'mutation',
  path: 'cards.disputes.evidence',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: one.extend({ description: z.string() }).strict(),
  output: caseOutput,
  samples: [
    { verdict: 'accept', input: { disputeId: '11111111-1111-4111-8111-111111111111', description: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Withdraw the case, with a reason: any provisional credit is reversed by the partner. */
export const BANK_CARDS_DISPUTES_WITHDRAW = defineProcedure({
  ...base,
  name: 'bank.cards.disputes.withdraw',
  kind: 'mutation',
  path: 'cards.disputes.withdraw',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: one.extend({ reason: z.string() }).strict(),
  output: caseOutput,
  samples: [
    { verdict: 'accept', input: { disputeId: '11111111-1111-4111-8111-111111111111', reason: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
