/**
 * A cardholder disputes their own card charge (J-bank-15; BK-cdisp-01). Reads are `bank:read`, steps `bank:write`, and
 * every one is the signed-in person's own card and case: another person's reads as not found. The case is the same one
 * support works (J-bank-27, `ops/card-disputes.ts`); the cardholder sees its states with their dates, who took each step
 * (them or support, never an operator's id), the partner's provisional credit and its reversal as the partner reports
 * them, and the decision with its reason. Nothing here posts to the ledger.
 */
import { router, scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import { assertSelf } from '../assert-self.js';
import type { BankServices } from '../bank-service.js';
import { CARDHOLDER_DISPUTE_STANDINGS, DISPUTE_CLOSURES, DISPUTE_EVENT_KINDS, DISPUTE_STATES, type DisputeCase } from './card-disputes.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);
const state = z.enum(DISPUTE_STATES);
const caseOutput = z.object({
  id: z.string().guid(),
  cardId: z.string().guid(),
  authorizationRef: z.string(),
  assetId: z.string(),
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
type CaseOutput = z.infer<typeof caseOutput>;

/** The case as its cardholder reads it. */
export function cardholderCase(userId: string, c: DisputeCase): CaseOutput {
  return {
    id: c.id,
    cardId: c.cardId,
    authorizationRef: c.authorizationRef,
    assetId: c.assetId,
    amount: c.amount,
    reason: c.reason,
    state: c.state,
    test: c.test,
    provisionalCredit: c.provisionalCredit,
    decision: c.decision
      ? {
          outcome: c.decision.outcome,
          reason: c.decision.reason,
          creditSettlement: c.decision.creditSettlement,
          creditSettlementPartnerRef: c.decision.creditSettlementPartnerRef,
          closedAt: c.decision.closedAt,
        }
      : null,
    createdAt: c.createdAt,
    events: c.events.map((e) => {
      const mine = e.actor === userId;
      return {
        sequence: e.sequence,
        kind: e.kind,
        fromState: e.fromState,
        toState: e.toState,
        by: mine ? ('you' as const) : ('support' as const),
        detail: mine ? e.detail : null,
        afterSubmission: e.afterSubmission,
        at: e.at,
      };
    }),
  };
}

const formOutput = z.object({
  test: z.boolean(),
  rules: z.object({ windowDays: z.number().int().positive(), evidenceAfterSubmission: z.boolean() }).nullable(),
  charge: z.object({
    authorizationRef: z.string(),
    assetId: z.string(),
    merchant: z.string().nullable(),
    captured: amountString,
    disputable: amountString,
    settledAt: z.string().nullable(),
  }),
  deadline: z.string().nullable(),
  standing: z.enum(CARDHOLDER_DISPUTE_STANDINGS),
  disputeId: z.string().nullable(),
});

const charge = z.object({ cardId: z.string().guid(), authorizationRef: z.string().min(1).max(128) });
const one = z.object({ disputeId: z.string().guid() });

export function cardholderDisputeRouter(bank: BankServices, guard: Guard) {
  const d = () => bank.cardDisputes;
  const ownCard = async (userId: string, cardId: string) => assertSelf(userId, (await bank.cards.card(cardId)).userId);
  return router({
    /** The prefilled form for one charge: the partner's window and evidence rule, and where this charge stands. */
    form: scopedProcedure('bank:read', { module: 'bank' })
      .input(charge.strict())
      .output(formOutput)
      .query(({ ctx, input }) =>
        guard(async () => {
          await ownCard(ctx.principal.userId, input.cardId);
          return d().cardholderForm(input.cardId, input.authorizationRef);
        }),
      ),
    /** File a dispute of all or part of one charge, with a reason. */
    open: scopedProcedure('bank:write', { module: 'bank' })
      .input(charge.extend({ amount: z.string(), reason: z.string() }).strict())
      .output(caseOutput)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          await ownCard(ctx.principal.userId, input.cardId);
          return cardholderCase(ctx.principal.userId, await d().cardholderOpen({ ...input, userId: ctx.principal.userId }));
        }),
      ),
    /** The person's cases on one card, newest first. */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ cardId: z.string().guid() }).strict())
      .output(z.array(caseOutput.omit({ events: true })))
      .query(({ ctx, input }) =>
        guard(async () => {
          await ownCard(ctx.principal.userId, input.cardId);
          const rows = await d().cardholderList(ctx.principal.userId, input.cardId);
          return rows.map((r) => {
            const { events: _events, ...rest } = cardholderCase(ctx.principal.userId, { ...r, events: [], cap: null });
            return rest;
          });
        }),
      ),
    /** One case with its tracker. */
    get: scopedProcedure('bank:read', { module: 'bank' })
      .input(one.strict())
      .output(caseOutput)
      .query(({ ctx, input }) =>
        guard(async () => cardholderCase(ctx.principal.userId, await d().cardholderGet(ctx.principal.userId, input.disputeId))),
      ),
    /** Evidence: taken while open; after the representment only where the partner's rules take it. */
    evidence: scopedProcedure('bank:write', { module: 'bank' })
      .input(one.extend({ description: z.string() }).strict())
      .output(caseOutput)
      .mutation(({ ctx, input }) =>
        guard(async () => cardholderCase(ctx.principal.userId, await d().cardholderEvidence({ ...input, userId: ctx.principal.userId }))),
      ),
    /** Withdraw the case, with a reason: any provisional credit is reversed by the partner. */
    withdraw: scopedProcedure('bank:write', { module: 'bank' })
      .input(one.extend({ reason: z.string() }).strict())
      .output(caseOutput)
      .mutation(({ ctx, input }) =>
        guard(async () => cardholderCase(ctx.principal.userId, await d().cardholderWithdraw({ ...input, userId: ctx.principal.userId }))),
      ),
  });
}
