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
