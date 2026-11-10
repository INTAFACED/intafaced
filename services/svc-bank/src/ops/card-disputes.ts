/**
 * Card disputes for support (J-bank-27; BK-cdisp-02, BK-cdisp-03). Reads are `admin:read`; every step is `support:ops` and
 * records the signed-in operator as its actor. The provisional credit and the decision are the card partner's to carry out:
 * nothing here posts to the ledger.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { DISPUTE_EVENT_KINDS, DISPUTE_OUTCOMES, DISPUTE_STATES } from '../cards/card-disputes.js';
import { LOSS_BEARERS } from '../cards/partner-terms.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);
const state = z.enum(DISPUTE_STATES);
const summary = z.object({
  id: z.string().guid(),
  caseKey: z.string(),
  cardId: z.string().guid(),
  userId: z.string(),
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
      outcome: z.enum(DISPUTE_OUTCOMES),
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
const disputeCase = summary.extend({
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
const id = z.object({ disputeId: z.string().guid() });

export function cardDisputeProcedures(bank: BankServices, guard: Guard) {
  const d = () => bank.cardDisputes;
  return {
    /** The queue, newest first; `state` filters it. */
    cardDisputes: scopedProcedure('admin:read')
      .input(z.object({ state: state.optional() }).strict())
      .output(z.object({ rows: z.array(summary), more: z.boolean() }))
      .query(({ input }) => guard(() => d().list(input.state))),
    /** One case with its whole timeline and the owner's cap for its asset. */
    cardDispute: scopedProcedure('admin:read')
      .input(id.strict())
      .output(disputeCase)
      .query(({ input }) => guard(() => d().get(input.disputeId))),
    cardDisputeOpen: scopedProcedure('support:ops')
      .input(
        z
          .object({
            caseKey: z.string(),
            cardId: z.string().guid(),
            authorizationRef: z.string().min(1).max(128),
            amount: z.string(),
            reason: z.string(),
          })
          .strict(),
      )
      .output(disputeCase)
      .mutation(({ ctx, input }) => guard(() => d().open({ ...input, actor: ctx.principal.userId }))),
    cardDisputeEvidence: scopedProcedure('support:ops')
      .input(id.extend({ stepKey: z.string(), description: z.string() }).strict())
      .output(disputeCase)
      .mutation(({ ctx, input }) => guard(() => d().addEvidence({ ...input, actor: ctx.principal.userId }))),
    cardDisputeRepresentment: scopedProcedure('support:ops')
      .input(id.extend({ stepKey: z.string(), description: z.string() }).strict())
      .output(disputeCase)
      .mutation(({ ctx, input }) => guard(() => d().submitRepresentment({ ...input, actor: ctx.principal.userId }))),
    cardDisputeArbitration: scopedProcedure('support:ops')
      .input(id.extend({ stepKey: z.string() }).strict())
      .output(disputeCase)
      .mutation(({ ctx, input }) => guard(() => d().escalateToArbitration({ ...input, actor: ctx.principal.userId }))),
    cardDisputeCredit: scopedProcedure('support:ops')
      .input(id.strict())
      .output(disputeCase)
      .mutation(({ ctx, input }) => guard(() => d().grantProvisionalCredit({ ...input, actor: ctx.principal.userId }))),
    cardDisputeDecide: scopedProcedure('support:ops')
      .input(id.extend({ outcome: z.enum(DISPUTE_OUTCOMES) }).strict())
      .output(disputeCase)
      .mutation(({ ctx, input }) => guard(() => d().decide({ ...input, actor: ctx.principal.userId }))),
  };
}
