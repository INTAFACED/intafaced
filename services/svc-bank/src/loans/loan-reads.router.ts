import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import type { BankServices } from '../bank-service.js';
import { assertSelf } from '../assert-self.js';

/**
 * `bank.loans.projection`, `payoffQuote` and `statement` (BK-loan-06, J-bank-11).
 * The loan room already lists the loan and offers repay. These reads are what
 * that page asks for before a repay and when a statement is downloaded.
 * Self-only. None of them posts.
 */

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

const projectionRow = z
  .object({
    date: z.string(),
    basis: amountString,
    interest: amountString,
    principal: amountString,
    debt: amountString,
  })
  .strict();

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function loanCustomerReadProcedures(bank: Pick<BankServices, 'loans'>, guard: Guard) {
  return {
    /** Next UTC days of interest, using the accrual rule. Labelled a projection, not a schedule. */
    projection: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            loanId: z.string().guid(),
            days: z.number().int().min(1).max(366),
            extraRepayment: amountString.optional(),
          })
          .strict(),
      )
      .output(
        z
          .object({
            loanId: z.string(),
            kind: z.literal('projection'),
            obligation: z.literal(false),
            aprBps: z.number().int(),
            days: z.number().int(),
            openingPrincipal: amountString,
            openingInterest: amountString,
            extraApplied: amountString.nullable(),
            rows: z.array(projectionRow),
          })
          .strict(),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          return bank.loans.projection({
            loanId: input.loanId,
            days: input.days,
            extraRepayment: input.extraRepayment ? parseAmount(input.extraRepayment) : undefined,
          });
        }),
      ),

    /** Interest through today, then principal, plus the published fee. Valid until the owner's window or the day's end. Not stored. */
    payoffQuote: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ loanId: z.string().guid() }).strict())
      .output(
        z
          .object({
            loanId: z.string(),
            principal: amountString,
            interest: amountString,
            fee: amountString,
            total: amountString,
            assetId: z.string(),
            interestThrough: z.string(),
            validUntil: z.string(),
          })
          .strict(),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          return bank.loans.payoffQuote({ loanId: input.loanId });
        }),
      ),

    /** Signed CSV for one loan over a period. A month still in progress is marked provisional. */
    statement: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            loanId: z.string().guid(),
            from: z.string().datetime({ offset: true }),
            to: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .output(
        z
          .object({
            format: z.literal('csv'),
            filename: z.string(),
            contentType: z.literal('text/csv; charset=utf-8'),
            bodyBase64: z.string(),
            sha256: z.string(),
            signature: z.string(),
            rowCount: z.number().int().nonnegative(),
            provisional: z.boolean(),
            openingPrincipal: amountString,
            openingInterest: amountString,
            closingPrincipal: amountString,
            closingInterest: amountString,
            generatedAt: z.string(),
          })
          .strict(),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          return bank.loans.statement({ loanId: input.loanId, from: input.from, to: input.to });
        }),
      ),
  };
}
