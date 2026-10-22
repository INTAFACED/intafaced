import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import {
  CREDIT_CARD_PREVIEW_ACTIONS,
  CREDIT_CARD_PREVIEW_ENGINE,
  CREDIT_CARD_PREVIEW_LABEL,
  CREDIT_CARD_TABS,
  creditCardPreview,
  refuseCreditCardAction,
} from './credit-card-preview.js';

/**
 * `bank.creditCard.preview` and `bank.creditCard.action` (BK-loan-10). The read
 * serves TEST rows only; every action returns the typed Preview refusal. No
 * store, no ledger, no dispute door is touched, so the router takes no services.
 */
export function createCreditCardPreviewRouter() {
  return router({
    preview: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          label: z.literal(CREDIT_CARD_PREVIEW_LABEL),
          engine: z.literal(CREDIT_CARD_PREVIEW_ENGINE),
          preview: z.literal(true),
          blurred: z.literal(true),
          tabs: z.array(z.enum(CREDIT_CARD_TABS)),
          rows: z.array(z.object({ tab: z.enum(CREDIT_CARD_TABS), item: z.string(), test: z.literal(true) })),
        }),
      )
      .query(() => {
        const view = creditCardPreview();
        return { ...view, tabs: [...view.tabs], rows: view.rows.map((r) => ({ ...r })) };
      }),
    action: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ action: z.enum(CREDIT_CARD_PREVIEW_ACTIONS) }).strict())
      .output(
        z.object({
          kind: z.literal('preview'),
          engine: z.literal(CREDIT_CARD_PREVIEW_ENGINE),
          action: z.enum(CREDIT_CARD_PREVIEW_ACTIONS),
          changed: z.literal(false),
        }),
      )
      .mutation(({ input }) => refuseCreditCardAction(input.action)),
  });
}
