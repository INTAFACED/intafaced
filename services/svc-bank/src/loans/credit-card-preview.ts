/**
 * BK-loan-10: the credit card as a labelled preview.
 *
 * The card programme is a debit-style spend card against a held balance (card
 * limits are spending ceilings), so a credit card is a separate engine that
 * needs a licence. Until it exists the back end serves only a labelled preview
 * and refuses every engine action with the typed Preview refusal
 * (`kind: 'preview'`). Nothing is stored, nothing reaches the ledger, and the
 * spend-card dispute door (`activity.dispute.open`) is never called.
 *
 * No numbers are invented. APR, limit, repayment dates and the
 * foreign-transaction fee are owner values we do not have, so each row names
 * what it is and is marked TEST instead of carrying a sampled figure.
 */

import { PREVIEW_LABEL, previewRefusal, type PreviewRefusal } from '@intafaced/contracts';

export const CREDIT_CARD_PREVIEW_LABEL = PREVIEW_LABEL;
/** Engine id for the typed Preview refusal (`<module>.<engine>`). */
export const CREDIT_CARD_PREVIEW_ENGINE = 'bank.credit_card' as const;

export const CREDIT_CARD_TABS = ['application', 'limit', 'repayment', 'usage_rules', 'statements'] as const;
export type CreditCardTab = (typeof CREDIT_CARD_TABS)[number];

export const CREDIT_CARD_VARIANTS = ['credit_card', 'charge_card'] as const;
export const CREDIT_CARD_REPAYMENT_OPTIONS = ['pay_in_full', 'pay_early', 'pay_extra', 'choose_date'] as const;
export const CREDIT_CARD_RESTRICTIONS = ['cash_withdrawal', 'gambling', 'crypto', 'balance_transfer', 'money_transfer'] as const;
export const CREDIT_CARD_REPAYMENT_VARIANTS = ['daily', 'thirty_day'] as const;
export const CREDIT_CARD_FEES = ['foreign_transaction'] as const;

export interface CreditCardPreviewRow {
  readonly tab: CreditCardTab;
  readonly item: string;
  /** Every row is sample data. */
  readonly test: true;
}

export interface CreditCardPreview {
  readonly label: typeof CREDIT_CARD_PREVIEW_LABEL;
  readonly engine: typeof CREDIT_CARD_PREVIEW_ENGINE;
  readonly preview: true;
  readonly blurred: true;
  readonly tabs: readonly CreditCardTab[];
  readonly rows: readonly CreditCardPreviewRow[];
}

function rows(tab: CreditCardTab, items: readonly string[]): CreditCardPreviewRow[] {
  return items.map((item) => Object.freeze({ tab, item, test: true as const }));
}

/** Fixed TEST fixture served from the back end; frozen so no caller can turn a row live. */
const TEST_ROWS: readonly CreditCardPreviewRow[] = Object.freeze([
  ...rows('application', ['soft_eligibility_check', 'personalised_rate', 'representative_apr', ...CREDIT_CARD_VARIANTS]),
  ...rows('limit', ['credit_limit', 'change_limit']),
  ...rows('repayment', [...CREDIT_CARD_REPAYMENT_OPTIONS, ...CREDIT_CARD_REPAYMENT_VARIANTS.map((v) => `variant:${v}`)]),
  ...rows('usage_rules', [...CREDIT_CARD_FEES.map((f) => `fee:${f}`), ...CREDIT_CARD_RESTRICTIONS.map((r) => `restricted:${r}`)]),
  ...rows('statements', ['statement', 'dispute_entry', 'zero_liability_notice']),
]);

export function creditCardPreview(): CreditCardPreview {
  return {
    label: CREDIT_CARD_PREVIEW_LABEL,
    engine: CREDIT_CARD_PREVIEW_ENGINE,
    preview: true,
    blurred: true,
    tabs: CREDIT_CARD_TABS,
    rows: TEST_ROWS,
  };
}

export const CREDIT_CARD_PREVIEW_ACTIONS = [
  'apply',
  'change_limit',
  'repay_in_full',
  'repay_early',
  'repay_extra',
  'set_payment_date',
  'set_usage_rule',
  'read_statements',
  'open_dispute',
] as const;
export type CreditCardPreviewAction = (typeof CREDIT_CARD_PREVIEW_ACTIONS)[number];

/** The typed Preview refusal from contracts (`kind: 'preview'`, `preview.engine_not_built`). Nothing is read or written. */
export function refuseCreditCardAction(action: CreditCardPreviewAction): PreviewRefusal {
  return previewRefusal(CREDIT_CARD_PREVIEW_ENGINE, action);
}
