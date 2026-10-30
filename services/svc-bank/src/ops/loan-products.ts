/**
 * Operator loan product creation (BK-loan-02, crypto-credit-earn-005).
 *
 * `createProduct` existed in the service with no procedure. This exposes it to
 * treasury with a second person: an identity approval bound to every term,
 * consumed only after the terms pass the checks, so a bad form never burns an
 * approval. Every term is required; nothing is defaulted (a minimum principal
 * of zero must be typed as "0"). The caller names the product id, so a retry is
 * the same product. A product already used by open loans is never edited here;
 * loans snapshot their thresholds at opening.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { assertLoanParams } from '../loans/loan-service.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');
const bps = z.number().int();

export const CREATE_LOAN_PRODUCT_ACTION = 'bank.ops.createLoanProduct';

const productInput = z.object({
  productId: z.string().guid(),
  name: z.string().max(120),
  debtAssetId: z.string().min(1).max(16),
  collateralAssetId: z.string().min(1).max(16),
  quoteAssetId: z.string().min(1).max(16),
  aprBps: bps,
  maxLtvBps: bps,
  minPrincipal: amountString,
  marginCallLtvBps: bps,
  liquidationLtvBps: bps,
  insolvencyLtvBps: bps,
  targetLtvBps: bps,
  penaltyBps: bps,
  maxTrancheBps: bps,
  graceSeconds: z.number().int(),
});

export type CreateLoanProductInput = z.infer<typeof productInput>;

/** The fields the approval is bound to. The client hashes the same strings. */
export function createLoanProductFields(input: CreateLoanProductInput): Record<string, string> {
  return {
    productId: input.productId,
    name: input.name,
    debtAssetId: input.debtAssetId,
    collateralAssetId: input.collateralAssetId,
    quoteAssetId: input.quoteAssetId,
    aprBps: String(input.aprBps),
    maxLtvBps: String(input.maxLtvBps),
    minPrincipal: formatAmount(parseAmount(input.minPrincipal)),
    marginCallLtvBps: String(input.marginCallLtvBps),
    liquidationLtvBps: String(input.liquidationLtvBps),
    insolvencyLtvBps: String(input.insolvencyLtvBps),
    targetLtvBps: String(input.targetLtvBps),
    penaltyBps: String(input.penaltyBps),
    maxTrancheBps: String(input.maxTrancheBps),
    graceSeconds: String(input.graceSeconds),
  };
}

export function createLoanProductProcedure(
  bank: BankServices,
  consumeOpsApproval: (
    input: { approvalId?: string | null; operationId?: string | null },
    actionType: string,
    fields: Record<string, string>,
  ) => Promise<string>,
  guard: Guard,
) {
  return scopedProcedure('admin:treasury')
    .input(
      productInput.extend({
        approvalId: z.string().max(128).nullish(),
        operationId: z.string().max(128).nullish(),
      }),
    )
    .output(
      z.object({
        productId: z.string().guid(),
        status: z.string(),
        aprBps: z.number().int(),
        maxLtvBps: z.number().int(),
        minPrincipal: amountString,
        replayed: z.boolean(),
        approvedBy: z.string(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => {
        const terms = {
          productId: input.productId,
          name: input.name.trim(),
          debtAssetId: input.debtAssetId,
          collateralAssetId: input.collateralAssetId,
          quoteAssetId: input.quoteAssetId,
          aprBps: input.aprBps,
          maxLtvBps: input.maxLtvBps,
          minPrincipal: parseAmount(input.minPrincipal),
          policy: {
            marginCallLtvBps: input.marginCallLtvBps,
            liquidationLtvBps: input.liquidationLtvBps,
            insolvencyLtvBps: input.insolvencyLtvBps,
            targetLtvBps: input.targetLtvBps,
            penaltyBps: input.penaltyBps,
            maxTrancheBps: input.maxTrancheBps,
            graceSeconds: input.graceSeconds,
          },
        };
        // Checked before the approval is consumed, so a wrong form does not spend the second person.
        assertLoanParams(terms);
        const approvedBy = await consumeOpsApproval(input, CREATE_LOAN_PRODUCT_ACTION, createLoanProductFields(input));
        const { product, replayed } = await bank.loans.createProductOnce(terms);
        return {
          productId: product.id,
          status: product.status,
          aprBps: product.aprBps,
          maxLtvBps: product.maxLtvBps,
          minPrincipal: formatAmount(product.minPrincipal),
          replayed,
          approvedBy,
        };
      }),
    );
}

export const SET_LOAN_PRODUCT_RATE_ACTION = 'bank.ops.setLoanProductRate';

const rateInput = z.object({
  productId: z.string().guid(),
  /** The rate this change replaces, as the requester read it: the approval is bound to it, so it can't be spent once the rate has moved. */
  fromAprBps: bps,
  aprBps: bps,
  reason: z.string().trim().min(3).max(300),
});

export type SetLoanProductRateInput = z.infer<typeof rateInput>;

/** The fields the approval is bound to. The client hashes the same strings. */
export function setLoanProductRateFields(input: SetLoanProductRateInput): Record<string, string> {
  return {
    productId: input.productId,
    fromAprBps: String(input.fromAprBps),
    aprBps: String(input.aprBps),
    reason: input.reason.trim(),
  };
}

/**
 * An operator's change to a loan product's rate (BK-loan-02, J-bank-09 #5): treasury with a second person, bound to the
 * product, the rate it replaces, the new rate and the reason. New loans open at the new rate; an open loan keeps the rate
 * written on it at open. A retry with an approval already spent on this change reads the recorded change back; otherwise the
 * change is checked (range, the rate it replaces, a real change) before the approval is spent, and again under the row's
 * lock when it is made.
 */
export function setLoanProductRateProcedure(
  bank: BankServices,
  consumeOpsApproval: (
    input: { approvalId?: string | null; operationId?: string | null },
    actionType: string,
    fields: Record<string, string>,
  ) => Promise<string>,
  guard: Guard,
) {
  return scopedProcedure('admin:treasury')
    .input(
      rateInput.extend({
        approvalId: z.string().max(128).nullish(),
        operationId: z.string().max(128).nullish(),
      }),
    )
    .output(
      z.object({
        productId: z.string().guid(),
        aprBps: z.number().int(),
        previousAprBps: z.number().int(),
        approvedBy: z.string(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => {
        const change = { productId: input.productId, fromAprBps: input.fromAprBps, aprBps: input.aprBps, reason: input.reason };
        if (input.approvalId) {
          const recorded = await bank.loans.rateChangeByApproval(input.approvalId, change);
          if (recorded) return recorded;
        }
        await bank.loans.checkRateChange(change);
        const approvedBy = await consumeOpsApproval(input, SET_LOAN_PRODUCT_RATE_ACTION, setLoanProductRateFields(input));
        const changed = await bank.loans.setProductRate({ ...change, approvalId: input.approvalId ?? '', approvedBy });
        return { productId: changed.product.id, aprBps: changed.product.aprBps, previousAprBps: changed.previousAprBps, approvedBy };
      }),
    );
}
