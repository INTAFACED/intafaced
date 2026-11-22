import { z } from 'zod';
import { previewRefusalSchema } from '@intafaced/contracts/preview-refusal';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts/trpc';
import { BANK_CREDIT_CARD_APPLICATION, BANK_CREDIT_CARD_PREVIEW } from '@intafaced/contracts/bank-credit-preview-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { previewRefusalOnly } from './loan-servicing-preview.js';
import {
  CREDIT_CARD_REPAYMENT_OPTIONS,
  CREDIT_CARD_RESTRICTIONS,
  creditCardPreview,
  refuseCreditCardAction,
  type CreditCardPreviewAction,
} from './credit-card-preview.js';

/**
 * `bank.creditCard.*` (BK-loan-10). `preview` serves TEST rows only;
 * `statements` returns the typed Preview refusal as its read answer; every
 * mutation (`application`, `limit`, `repay`, `rules`, `dispute`) throws
 * PRECONDITION_FAILED `preview.engine_not_built — <engine>:<action>` with the
 * parsed refusal as the cause. No store, no ledger and no dispute door
 * (`activity.dispute.open`) is touched, so the router takes no services.
 */
function refuse(action: CreditCardPreviewAction): never {
  const refusal = refuseCreditCardAction(action);
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: `${refusal.code} — ${refusal.engine}:${refusal.action}`,
    cause: refusal,
  });
}

const refusedOutput = z.never();

export function createCreditCardPreviewRouter() {
  const write = scopedProcedure('bank:write', { module: 'bank' });
  return router({
    preview: mountRecord(
      BANK_CREDIT_CARD_PREVIEW,
      () => {
        const view = creditCardPreview();
        return { ...view, tabs: [...view.tabs], rows: view.rows.map((r) => ({ ...r })) };
      },
      previewRefusalOnly,
    ),
    /** Statements read: answers with the typed Preview refusal, never an empty list. */
    statements: scopedProcedure('bank:read', { module: 'bank' })
      .output(previewRefusalSchema)
      .query(() => refuseCreditCardAction('read_statements')),
    application: mountRecord(BANK_CREDIT_CARD_APPLICATION, () => refuse('apply'), previewRefusalOnly),
    limit: write
      .input(z.object({ change: z.literal('request') }).strict())
      .output(refusedOutput)
      .mutation(() => refuse('change_limit')),
    repay: write
      .input(z.object({ option: z.enum(CREDIT_CARD_REPAYMENT_OPTIONS) }).strict())
      .output(refusedOutput)
      .mutation(({ input }) =>
        refuse(
          (
            {
              pay_in_full: 'repay_in_full',
              pay_early: 'repay_early',
              pay_extra: 'repay_extra',
              choose_date: 'set_payment_date',
            } as const
          )[input.option],
        ),
      ),
    rules: write
      .input(z.object({ restriction: z.enum(CREDIT_CARD_RESTRICTIONS) }).strict())
      .output(refusedOutput)
      .mutation(() => refuse('set_usage_rule')),
    dispute: write
      .input(z.object({ statementLine: z.string().min(1).max(64) }).strict())
      .output(refusedOutput)
      .mutation(() => refuse('open_dispute')),
  });
}
