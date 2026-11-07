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

/** `/support/new?topic=phishing` opens a scam report (J-identity-13 #2): only a topic the form offers is taken. */
export function topicFromAddress(): 'phishing' | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('topic') === 'phishing' ? 'phishing' : null;
}
