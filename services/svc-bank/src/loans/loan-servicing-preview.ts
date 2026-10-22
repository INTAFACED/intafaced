/**
 * Unsecured-loan servicing previews (BK-loan-09): repayment schedule changes, extra payments, repayment from an
 * external bank, and the missed-payment policy.
 *
 * The crypto-backed loan has no repayment schedule, due dates, grace or late fees (LOAN-ENGINE-SPEC AL-4), so these
 * rows are a preview engine (IA-SPEC 3.3). Every engine action refuses with the typed Preview refusal from
 * `@intafaced/contracts`, never an allowlist NotConnected code. The refusal is decided before anything is read or
 * written: no row is created and no ledger call is made, whatever loan id is sent.
 *
 * The missed-payment policy is owner data. Blank (the only state in this build) reads `not_set`; nothing is defaulted.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { PREVIEW_REFUSAL_CODE, previewRefusal, scopedProcedure, type PreviewRefusal } from '@intafaced/contracts';

export const LOAN_SCHEDULE_ENGINE = 'bank.loan_schedule' as const;
export const LOAN_EXTERNAL_REPAY_ENGINE = 'bank.loan_external_repay' as const;

/** Owner-published missed-payment policy. Decimal strings for any amount; never a JS number for money. */
export type LoanMissedPaymentPolicy = {
  readonly graceDays: number;
  readonly catchUpDays: number;
  /** Late fee as a decimal string in the loan's debt asset; '0' is a deliberate no-fee policy. */
  readonly lateFee: string;
};

export function throwPreviewRefusal(engine: string, action: string): never {
  const refusal: PreviewRefusal = previewRefusal(engine, action);
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: `${PREVIEW_REFUSAL_CODE} — ${refusal.engine}:${refusal.action}`,
    cause: Object.assign(new Error(refusal.label), refusal),
  });
}

const loanIdInput = z.object({ loanId: z.string().uuid() }).strict();

const policyOutput = z.union([
  z.object({ status: z.literal('not_set') }).strict(),
  z
    .object({
      status: z.literal('set'),
      graceDays: z.number().int().nonnegative(),
      catchUpDays: z.number().int().nonnegative(),
      lateFee: z.string().regex(/^\d+(\.\d{1,18})?$/),
    })
    .strict(),
]);

export function loanServicingPreviewProcedures(policy: LoanMissedPaymentPolicy | null | undefined) {
  return {
    /** Preview: change the repayment date. Always the typed Preview refusal. */
    changeRepaymentDate: scopedProcedure('bank:write', { module: 'bank' })
      .input(loanIdInput.extend({ date: z.string().date() }).strict())
      .mutation((): never => throwPreviewRefusal(LOAN_SCHEDULE_ENGINE, 'change_repayment_date')),

    /** Preview: pay extra or early. Always the typed Preview refusal. */
    payExtra: scopedProcedure('bank:write', { module: 'bank' })
      .input(loanIdInput.extend({ amount: z.string().regex(/^\d+(\.\d{1,18})?$/) }).strict())
      .mutation((): never => throwPreviewRefusal(LOAN_SCHEDULE_ENGINE, 'pay_extra')),

    /** Preview: repay from another bank. The preview refusal, not the `rail.bank` notice. */
    repayFromExternalBank: scopedProcedure('bank:write', { module: 'bank' })
      .input(loanIdInput)
      .mutation((): never => throwPreviewRefusal(LOAN_EXTERNAL_REPAY_ENGINE, 'repay_from_external_bank')),

    /** Missed-payment policy: owner data; blank reads `not_set`. */
    missedPaymentPolicy: scopedProcedure('bank:read', { module: 'bank' })
      .output(policyOutput)
      .query(() =>
        policy
          ? { status: 'set' as const, graceDays: policy.graceDays, catchUpDays: policy.catchUpDays, lateFee: policy.lateFee }
          : { status: 'not_set' as const },
      ),
  };
}
