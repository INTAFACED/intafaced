import { z } from 'zod';
import {
  router,
  scopedProcedure,
  BUSINESS_RECEIPT_TYPES,
  businessCardLimitRequestSchema,
  businessCardPurchaseSchema,
  businessCardSchema,
  businessExpensePolicySchema,
  businessExpensesOverviewSchema,
  businessReceiptsZipSchema,
  businessReimbursementSchema,
} from '@intafaced/contracts';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import {
  MAX_RECEIPT_BYTES,
  type BusinessCard,
  type CardPurchase,
  type ExpensePolicy,
  type LimitRequest,
  type ReimbursementClaim,
} from '../business/business-cards.js';
import { reimbursementPayBinding } from '../step-up/money-out-fields.js';
import { amountString, stepUpApprovalField } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const opt = (a: Amount | null) => (a === null ? null : formatAmount(a));

const cardView = (c: BusinessCard) => ({ ...c, perPurchaseLimit: formatAmount(c.perPurchaseLimit), createdAt: c.createdAt.toISOString() });
const requestView = (r: LimitRequest) => ({ ...r, amount: formatAmount(r.amount), createdAt: r.createdAt.toISOString() });
const purchaseView = (p: CardPurchase) => ({
  ...p,
  amount: formatAmount(p.amount),
  receiptOver: opt(p.receiptOver),
  limitRequest: p.limitRequest ? requestView(p.limitRequest) : null,
  createdAt: p.createdAt.toISOString(),
  capturedAt: iso(p.capturedAt),
});
const claimView = (c: ReimbursementClaim) => ({
  ...c,
  amount: formatAmount(c.amount),
  receipt: { ...c.receipt, createdAt: c.receipt.createdAt.toISOString() },
  memberBefore: opt(c.memberBefore),
  memberAfter: opt(c.memberAfter),
  createdAt: c.createdAt.toISOString(),
  paidAt: iso(c.paidAt),
});
const policyView = (p: ExpensePolicy) => ({ receiptOver: opt(p.receiptOver) });

/** Base64 of at most 512 KiB. */
const base64 = z
  .string()
  .min(4)
  .max(Math.ceil(MAX_RECEIPT_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
const receiptFields = {
  receiptId: z.string().guid(),
  fileName: z.string().min(1).max(120),
  contentType: z.enum(BUSINESS_RECEIPT_TYPES),
  contentBase64: base64,
};

/**
 * J-bank-22: a business gives its team cards and handles their expenses (BK-bcard-01, BK-bexp-01, BK-bexp-02). Every door
 * is the signed-in member's; what each may do is their permissions on that business, checked by the service. A captured
 * purchase and a paid reimbursement are each one partner move, sent once. The ledger posts nothing.
 */
export function createBusinessCardsRouter(c: BankRouterContext) {
  const { bank, stepUpEnforced, requireStepUp } = c;
  // Read on each call, never at mount: a router built over a partial service (the preview doors) must not touch it.
  const cards = () => bank.businessCards;
  const accountInput = z.object({ accountId: z.string().guid() }).strict();
  return router({
    overview: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(businessExpensesOverviewSchema)
      .query(({ ctx, input }) =>
        guard(async () => {
          const o = await cards().overview(input.accountId, ctx.principal.userId);
          return {
            policy: policyView(o.policy),
            permissions: o.permissions,
            cards: o.cards.map(cardView),
            purchases: o.purchases.map(purchaseView),
            limitRequests: o.limitRequests.map(requestView),
            claims: o.claims.map(claimView),
            myBalance: o.myBalance ? { label: o.myBalance.label, amount: opt(o.myBalance.amount) } : null,
          };
        }),
      ),
    /** Issues a TEST card to a member of the business with a per-purchase limit. */
    issueCard: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId: z.string().guid(),
            cardId: z.string().guid(),
            memberUserId: z.string().min(1).max(128),
            perPurchaseLimit: amountString,
          })
          .strict(),
      )
      .output(businessCardSchema)
      .mutation(({ ctx, input }) => guard(async () => cardView(await cards().issueCard({ ...input, userId: ctx.principal.userId })))),
    /** A purchase on the TEST card network (the `rail.card` stand-in), by the card's holder. Refused off the TEST stack. */
    testPurchase: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({ cardId: z.string().guid(), purchaseId: z.string().guid(), merchant: z.string().min(1).max(80), amount: amountString })
          .strict(),
      )
      .output(businessCardPurchaseSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => purchaseView(await cards().testPurchase({ ...input, userId: ctx.principal.userId }))),
      ),
    decideLimitRequest: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ purchaseId: z.string().guid(), approve: z.boolean() }).strict())
      .output(businessCardLimitRequestSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => requestView(await cards().decideLimitRequest({ ...input, userId: ctx.principal.userId }))),
      ),
    setPolicy: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), receiptOver: amountString }).strict())
      .output(businessExpensePolicySchema)
      .mutation(({ ctx, input }) => guard(async () => policyView(await cards().setPolicy({ ...input, userId: ctx.principal.userId })))),
    attachReceipt: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ purchaseId: z.string().guid(), ...receiptFields }).strict())
      .output(businessCardPurchaseSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => purchaseView(await cards().attachReceipt({ ...input, userId: ctx.principal.userId }))),
      ),
    /** Every receipt of the business in one ZIP file, base64 on the wire. */
    receiptsZip: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(businessReceiptsZipSchema)
      .query(({ ctx, input }) =>
        guard(async () => {
          const out = await cards().receiptsZip(input.accountId, ctx.principal.userId);
          return { fileName: out.fileName, count: out.count, zipBase64: out.zip.toString('base64') };
        }),
      ),
    submitClaim: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId: z.string().guid(),
            claimId: z.string().guid(),
            amount: amountString,
            description: z.string().min(1).max(200),
            ...receiptFields,
          })
          .strict(),
      )
      .output(businessReimbursementSchema)
      .mutation(({ ctx, input }) => guard(async () => claimView(await cards().submitClaim({ ...input, userId: ctx.principal.userId })))),
    /** An approver's yes, never the claimant's: one partner move to the member's own account, sent once. */
    approveAndPay: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ claimId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }).strict())
      .output(businessReimbursementSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              reimbursementPayBinding({ actor: ctx.principal.userId, claimId: input.claimId }),
              input.stepUpApprovalId,
            );
          }
          return claimView(await cards().approveAndPay({ claimId: input.claimId, userId: ctx.principal.userId }));
        }),
      ),
  });
}
