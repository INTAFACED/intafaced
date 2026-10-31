import { t as copyText } from './copy';

/** A request category in the reader's words; an unknown one as it came. */
const CATEGORY_KEYS = {
  account: 'support.category.account',
  trading: 'support.category.trading',
  deposit_withdraw: 'support.category.deposit_withdraw',
  phishing: 'support.category.phishing',
  fraud_report: 'support.category.fraud_report',
  other: 'support.category.other',
} as const;
export const categoryLabel = (value: string): string =>
  value in CATEGORY_KEYS ? copyText(CATEGORY_KEYS[value as keyof typeof CATEGORY_KEYS]) : value;
