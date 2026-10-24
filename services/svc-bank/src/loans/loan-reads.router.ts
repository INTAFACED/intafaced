import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { BankServices } from '../bank-service.js';
import { assertSelf } from '../assert-self.js';
import { signedAmountString } from '../router/shared.js';

/**
 * `bank.loans.projection`, `payoffQuote` and `statement` (BK-loan-06, J-bank-11), and `interestRows` and
 * `ledgerCheck` (LOAN-05, J-bank-11 #4).
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

    /**
     * LOAN-05: the loan's interest as rows. Each accrual day as written (newest first, at most a year listed and the
     * rest counted), each approved correction with its reason, and the totals they add up to. Rows are append-only.
     */
    interestRows: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ loanId: z.string().guid() }).strict())
      .output(
        z
          .object({
            loanId: z.string(),
            assetId: z.string(),
            days: z.array(z.object({ date: z.string(), rateBps: z.number().int(), basis: amountString, interest: amountString }).strict()),
            earlierDays: z.number().int().nonnegative(),
            corrections: z.array(z.object({ id: z.string(), at: z.string(), amount: signedAmountString, reason: z.string() }).strict()),
            accrued: amountString,
            corrected: signedAmountString,
            paid: amountString,
            owed: amountString,
          })
          .strict(),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          const rows = await bank.loans.interestRows(loan);
          return {
            loanId: rows.loanId,
            assetId: rows.assetId,
            days: rows.days.map((d) => ({
              date: d.date,
              rateBps: d.rateBps,
              basis: formatAmount(d.basis),
              interest: formatAmount(d.interest),
            })),
            earlierDays: rows.earlierDays,
            corrections: rows.corrections.map((c) => ({
              id: c.id,
              at: c.at.toISOString(),
              amount: formatAmount(c.amount),
              reason: c.reason,
            })),
            accrued: formatAmount(rows.accrued),
            corrected: formatAmount(rows.corrected),
            paid: formatAmount(rows.paid),
            owed: formatAmount(rows.owed),
          };
        }),
      ),

    /**
     * LOAN-05: this loan's settled draw, repayments and collateral movements against the ledger's own transactions,
     * leg by leg, and its collateral pot against them. A read; a difference is reported, never repaired here.
     */
    ledgerCheck: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ loanId: z.string().guid() }).strict())
      .output(
        z
          .object({
            loanId: z.string(),
            status: z.enum(['agrees', 'differs', 'pending']),
            checked: z.number().int().nonnegative(),
            pending: z.number().int().nonnegative(),
            collateralHeld: amountString,
            collateralExpected: signedAmountString,
            mismatches: z.array(z.object({ kind: z.string(), ref: z.string(), problem: z.string() }).strict()),
            checkedAt: z.string(),
          })
          .strict(),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          const check = await bank.loans.ledgerCheck(loan);
          return {
            loanId: check.loanId,
            status: check.status,
            checked: check.checked,
            pending: check.pending,
            collateralHeld: formatAmount(check.collateralHeld),
            collateralExpected: formatAmount(check.collateralExpected),
            // What differs and where; the ledger's account ids stay in the ledger.
            mismatches: check.mismatches.map((m) => ({ kind: m.kind, ref: m.ref, problem: m.problem })),
            checkedAt: check.checkedAt.toISOString(),
          };
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
