import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { loanServicingPreviewProcedures } from '../loans/loan-servicing-preview.js';
import { loanCustomerReadProcedures } from '../loans/loan-reads.router.js';
import { loanApplyProcedures } from '../loans/loan-apply.router.js';
import { assertSelf } from '../assert-self.js';
import { amountString } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

export function createLoansRouter(c: BankRouterContext) {
  const { bank, options } = c;
  /**
   * LOANS (§8.1).
   *
   * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
   *
   * There is no user-callable `liquidate`, and no user-callable `mark`. Both are
   * operator surface, in `ops`, for the same reason the standing-order runner and
   * the accrual are: a user who can choose WHEN a mark is taken is a user who can
   * choose the price their own — or somebody else's — collateral is valued at.
   * The whole point of the deviation breaker and the staleness window in
   * `prices.ts` is that the mark is not the caller's to pick.
   *
   * Settled release stays all-or-nothing on `close`. Partial release of excess
   * (`releaseExcess`) is the exception: it asks for a mark and refuses
   * `bank.ltv_exceeded` if the remainder would sit above the product cap. A
   * missing mark refuses before any post. No invented rate.
   */
  return router({
    ...loanCustomerReadProcedures(bank, guard),
    ...loanApplyProcedures(bank, guard),
    products: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16).optional(),
          /**
           * Page size. Optional so omit reaches `bank.loan_products_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            debtAssetId: z.string(),
            collateralAssetId: z.string(),
            quoteAssetId: z.string(),
            aprBps: z.number().int(),
            maxLtvBps: z.number().int(),
            marginCallLtvBps: z.number().int(),
            liquidationLtvBps: z.number().int(),
            minPrincipal: amountString,
          }),
        ),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const products = await bank.loans.listProducts(input.assetId, input.limit);
          return products.map((p) => ({
            id: p.id,
            name: p.name,
            debtAssetId: p.debtAssetId,
            collateralAssetId: p.collateralAssetId,
            quoteAssetId: p.quoteAssetId,
            aprBps: p.aprBps,
            maxLtvBps: p.maxLtvBps,
            // The two thresholds a borrower must be able to see BEFORE they
            // borrow. Publishing the liquidation level is not a courtesy: a
            // leveraged product whose liquidation price is discoverable only by
            // being liquidated is not a product anyone can manage.
            marginCallLtvBps: p.policy.marginCallLtvBps,
            liquidationLtvBps: p.policy.liquidationLtvBps,
            minPrincipal: formatAmount(p.minPrincipal),
          }));
        }),
      ),

    /**
     * `loanId` is supplied by the client so a retried request is the same loan,
     * not a second one (§5). A timeout on this call must not leave a borrower with
     * two leveraged positions against collateral they meant to pledge once.
     */
    open: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          loanId: z.string().guid(),
          productId: z.string().guid(),
          collateralAmount: amountString,
          principal: amountString,
        }),
      )
      .output(z.object({ loanId: z.string(), status: z.string(), ltvBps: z.number().int(), drawLedgerTxId: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          // Pre-flight: a desk pause on either asset of the product refuses before collateral is locked.
          const product = await bank.loans.product(input.productId);
          await bank.assetPauses.assertBorrowOpen([product.debtAssetId, product.collateralAssetId]);
          const result = await bank.loans.open({
            loanId: input.loanId,
            productId: input.productId,
            userId: ctx.principal.userId,
            collateralAmount: parseAmount(input.collateralAmount),
            principal: parseAmount(input.principal),
          });
          return {
            loanId: result.loan.id,
            status: result.loan.status,
            ltvBps: result.ltvBps,
            drawLedgerTxId: result.drawLedgerTxId,
          };
        }),
      ),

    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.loans_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            productId: z.string(),
            debtAssetId: z.string(),
            collateralAssetId: z.string(),
            principal: amountString,
            outstandingPrincipal: amountString,
            outstandingInterest: amountString,
            collateral: amountString,
            aprBps: z.number().int(),
            status: z.string(),
            marginCalledAt: z.string().nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.loans.loansOf(ctx.principal.userId, input?.limit);
          return Promise.all(
            rows.map(async (loan) => {
              const debt = await bank.loans.outstanding(loan.id);
              return {
                id: loan.id,
                productId: loan.productId,
                debtAssetId: loan.debtAssetId,
                collateralAssetId: loan.collateralAssetId,
                principal: formatAmount(loan.principal),
                // Derived at read time from write-once rows. There is no
                // `outstanding` column, and the schema comments say why.
                outstandingPrincipal: formatAmount(debt.principal),
                outstandingInterest: formatAmount(debt.interest),
                collateral: formatAmount(await bank.loans.collateralOf(loan)),
                aprBps: loan.aprBps,
                status: loan.status,
                marginCalledAt: loan.marginCalledAt?.toISOString() ?? null,
              };
            }),
          );
        }),
      ),

    /**
     * The borrower's own risk view.
     *
     * Read-only and portfolio-wide, so someone can see a margin call coming
     * rather than learning about it from the liquidation. It marks; it never acts.
     */
    health: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          debtValue: amountString,
          collateralValue: amountString,
          portfolioLtvBps: z.number().int(),
          loans: z.array(
            z.object({
              loanId: z.string(),
              debtValue: amountString,
              collateralValue: amountString,
              ltvBps: z.number().int(),
            }),
          ),
        }),
      )
      .query(async ({ ctx }) =>
        guard(async () => {
          const mark = await bank.loans.markUser(ctx.principal.userId);
          return {
            debtValue: formatAmount(mark.debtValue),
            collateralValue: formatAmount(mark.collateralValue),
            portfolioLtvBps: mark.portfolioLtvBps,
            loans: mark.loans.map((l) => ({
              loanId: l.loanId,
              debtValue: formatAmount(l.debtValue),
              collateralValue: formatAmount(l.collateralValue),
              ltvBps: l.ltvBps,
            })),
          };
        }),
      ),

    /**
     * `eventId` is the client retry key (§5). Required: omit used to allocate
     * MAX+1 and post a second loanCollateralLock. Same eventId + amount is one lock.
     */
    addCollateral: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ loanId: z.string().guid(), eventId: z.string().guid(), amount: amountString }))
      .output(z.object({ ledgerTxId: z.string(), sequence: z.number().int() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          return bank.loans.addCollateral({
            loanId: input.loanId,
            eventId: input.eventId,
            amount: parseAmount(input.amount),
          });
        }),
      ),

    /**
     * `eventId` is the client retry key (§5). Required: omit used to allocate
     * MAX+1 and post a second loanCollateralRelease. Same eventId + amount is
     * one release. Overlapping releases share the loan row lock, so they cannot
     * each pass the product cap.
     */
    /**
     * Redeem-excess read (BK-loan-05): the most collateral `releaseExcess` would
     * release now under the product's max LTV. Self-only. Posts nothing.
     */
    releasable: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ loanId: z.string().guid() }))
      .output(
        z.object({
          loanId: z.string(),
          held: amountString,
          releasable: amountString,
          maxLtvBps: z.number().int(),
          ltvBps: z.number().int(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          const read = await bank.loans.releasable(input.loanId);
          return {
            loanId: input.loanId,
            held: formatAmount(read.held),
            releasable: formatAmount(read.releasable),
            maxLtvBps: read.maxLtvBps,
            ltvBps: read.ltvBps,
          };
        }),
      ),

    releaseExcess: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ loanId: z.string().guid(), eventId: z.string().guid(), amount: amountString }))
      .output(z.object({ ledgerTxId: z.string(), sequence: z.number().int() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          return bank.loans.releaseExcess({
            loanId: input.loanId,
            eventId: input.eventId,
            amount: parseAmount(input.amount),
          });
        }),
      ),

    repay: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ loanId: z.string().guid(), amount: amountString, eventId: z.string().guid() }))
      .output(
        z.object({
          ledgerTxId: z.string(),
          interestPaid: amountString,
          principalPaid: amountString,
          remainingPrincipal: amountString,
          remainingInterest: amountString,
          closed: z.boolean(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          const result = await bank.loans.repay({
            loanId: input.loanId,
            amount: parseAmount(input.amount),
            eventId: input.eventId,
          });
          return {
            ledgerTxId: result.ledgerTxId,
            interestPaid: formatAmount(result.interestPaid),
            principalPaid: formatAmount(result.principalPaid),
            remainingPrincipal: formatAmount(result.remaining.principal),
            remainingInterest: formatAmount(result.remaining.interest),
            closed: result.closed,
          };
        }),
      ),

    /** Release collateral on a loan that owes nothing. Refuses otherwise. */
    close: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ loanId: z.string().guid() }))
      .output(z.object({ released: amountString, ledgerTxId: z.string().nullable() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          const result = await bank.loans.releaseSettled(input.loanId);
          return { released: formatAmount(result.released), ledgerTxId: result.ledgerTxId };
        }),
      ),
    // BK-loan-09: unsecured-loan servicing previews (typed Preview refusals) and the owner missed-payment policy.
    ...loanServicingPreviewProcedures(options.loanMissedPaymentPolicy),
  });
}
