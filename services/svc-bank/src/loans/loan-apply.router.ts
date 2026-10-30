import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { BankServices } from '../bank-service.js';
import { assertSelf } from '../assert-self.js';
import { BankError } from '../errors.js';
import { originationFeeOn } from './loan-apply.js';

/**
 * The loan application's reads (BK-loan-01, J-bank-09 #2, #3 and #5): `loans.quote`, `loans.eligibility`, `loans.fees`
 * and `loans.terms`. None of them posts or holds anything; `open` re-checks every figure on its own marks.
 */

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

/** One eligibility condition: met, not met (with the code `open` would refuse), or not set by the owner. */
const reason = z
  .object({
    key: z.enum(['lending_policy', 'product_open', 'assets_open', 'origination_fee', 'jurisdiction_rules']),
    state: z.enum(['met', 'unmet', 'not_set']),
    code: z.string().nullable(),
  })
  .strict();

export function loanApplyProcedures(bank: Pick<BankServices, 'loans' | 'assetPauses'>, guard: Guard) {
  return {
    /**
     * Collateral needed now for a target draw, the starting LTV and the liquidation price, from the marks `open` accepts.
     * A missing or stale mark refuses `bank.mark_missing`; the lending policy off refuses `bank.loans_disabled`.
     */
    quote: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ productId: z.string().guid(), principal: amountString }).strict())
      .output(
        z
          .object({
            productId: z.string(),
            debtAssetId: z.string(),
            collateralAssetId: z.string(),
            quoteAssetId: z.string(),
            principal: amountString,
            requiredCollateral: amountString,
            startingLtvBps: z.number().int(),
            maxLtvBps: z.number().int(),
            liquidationLtvBps: z.number().int(),
            liquidationPrice: amountString,
            debtPrice: amountString,
            collateralPrice: amountString,
            pricedAt: z.string(),
          })
          .strict(),
      )
      .query(({ input }) =>
        guard(async () => {
          const q = await bank.loans.quote({ productId: input.productId, principal: parseAmount(input.principal) });
          const older = q.debtMark.asOf < q.collateralMark.asOf ? q.debtMark.asOf : q.collateralMark.asOf;
          return {
            productId: q.product.id,
            debtAssetId: q.product.debtAssetId,
            collateralAssetId: q.product.collateralAssetId,
            quoteAssetId: q.product.quoteAssetId,
            principal: formatAmount(q.principal),
            requiredCollateral: formatAmount(q.requiredCollateral),
            startingLtvBps: q.startingLtvBps,
            maxLtvBps: q.product.maxLtvBps,
            liquidationLtvBps: q.product.policy.liquidationLtvBps,
            liquidationPrice: formatAmount(q.liquidationPrice),
            debtPrice: formatAmount(q.debtMark.price),
            collateralPrice: formatAmount(q.collateralMark.price),
            // The older of the two marks: the quote is only as fresh as it.
            pricedAt: older.toISOString(),
          };
        }),
      ),

    /** Why a new loan on this product would or would not open now, condition by condition. */
    eligibility: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ productId: z.string().guid() }).strict())
      .output(z.object({ productId: z.string(), eligible: z.boolean(), reasons: z.array(reason) }).strict())
      .query(({ input }) =>
        guard(async () => {
          const product = await bank.loans.product(input.productId);
          let paused: string | null = null;
          try {
            await bank.assetPauses.assertBorrowOpen([product.debtAssetId, product.collateralAssetId]);
          } catch (err) {
            if (!(err instanceof BankError)) throw err;
            paused = err.code;
          }
          const feeRefusal = bank.loans.originationFeeRefusal();
          const reasons: Array<z.infer<typeof reason>> = [
            bank.loans.lendingOpen()
              ? { key: 'lending_policy', state: 'met', code: null }
              : { key: 'lending_policy', state: 'unmet', code: 'bank.loans_disabled' },
            product.status === 'open'
              ? { key: 'product_open', state: 'met', code: null }
              : { key: 'product_open', state: 'unmet', code: 'bank.loan_product_closed' },
            paused === null ? { key: 'assets_open', state: 'met', code: null } : { key: 'assets_open', state: 'unmet', code: paused },
            feeRefusal
              ? { key: 'origination_fee', state: 'unmet', code: feeRefusal }
              : { key: 'origination_fee', state: 'met', code: null },
            // No owner table of per-jurisdiction rules exists, so none is applied and the page says so.
            { key: 'jurisdiction_rules', state: 'not_set', code: null },
          ];
          return { productId: product.id, eligible: reasons.every((r) => r.state !== 'unmet'), reasons };
        }),
      ),

    /**
     * The owner's fee table for a new loan: the origination fee, or not set (and `open` refuses `bank.loan_fee_unset`).
     * `collectable` is false when a non-zero fee is published, because no ledger leg collects it yet and `open` refuses
     * `bank.loan_fee_unwired`.
     */
    fees: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ productId: z.string().guid(), principal: amountString.optional() }).strict())
      .output(
        z
          .object({
            productId: z.string(),
            assetId: z.string(),
            origination: z.union([
              z.object({ status: z.literal('not_set') }).strict(),
              z
                .object({
                  status: z.literal('published'),
                  bps: z.number().int(),
                  amount: amountString.nullable(),
                  collectable: z.boolean(),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .query(({ input }) =>
        guard(async () => {
          const product = await bank.loans.product(input.productId);
          const fee = bank.loans.originationFee();
          return {
            productId: product.id,
            assetId: product.debtAssetId,
            origination:
              fee.status === 'not_set'
                ? { status: 'not_set' as const }
                : {
                    status: 'published' as const,
                    bps: fee.bps,
                    amount: input.principal ? formatAmount(originationFeeOn(parseAmount(input.principal), fee.bps)) : null,
                    collectable: bank.loans.originationFeeRefusal() === null,
                  },
          };
        }),
      ),

    /** The terms written on this loan at open: its rate and thresholds, never the product's current ones. Self-only. */
    terms: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ loanId: z.string().guid() }).strict())
      .output(
        z
          .object({
            loanId: z.string(),
            productId: z.string(),
            debtAssetId: z.string(),
            collateralAssetId: z.string(),
            principal: amountString,
            openingCollateral: amountString.nullable(),
            aprBps: z.number().int(),
            marginCallLtvBps: z.number().int().nullable(),
            liquidationLtvBps: z.number().int().nullable(),
            openedAt: z.string(),
          })
          .strict(),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const t = await bank.loans.terms(input.loanId);
          assertSelf(ctx.principal.userId, t.loan.userId);
          return {
            loanId: t.loan.id,
            productId: t.loan.productId,
            debtAssetId: t.loan.debtAssetId,
            collateralAssetId: t.loan.collateralAssetId,
            principal: formatAmount(t.loan.principal),
            openingCollateral: t.loan.openingCollateral === null ? null : formatAmount(t.loan.openingCollateral),
            aprBps: t.loan.aprBps,
            marginCallLtvBps: t.marginCallLtvBps,
            liquidationLtvBps: t.liquidationLtvBps,
            openedAt: t.loan.openedAt.toISOString(),
          };
        }),
      ),
  };
}
