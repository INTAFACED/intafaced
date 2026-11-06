import { refusalCopy } from '../../data';

/** The bank's typed statement refusals, each named by its statement centre copy key. */
export const STATEMENT_REFUSAL_KEYS = {
  'bank.statement_pdf_one_month': 'pdfOneMonth',
  'bank.statement_range': 'range',
  'bank.statement_too_large': 'tooLarge',
  'bank.statement_unavailable': 'unavailable',
  'bank.statement_balances_unavailable': 'balancesUnavailable',
} as const;

type RefusalKey = (typeof STATEMENT_REFUSAL_KEYS)[keyof typeof STATEMENT_REFUSAL_KEYS];

/** A statement refusal in the centre's own words, or the shared refusal title for any other code. */
export function refusedWords(t: (key: RefusalKey) => string, code: string | null, reason: string): string {
  return code && code in STATEMENT_REFUSAL_KEYS
    ? t(STATEMENT_REFUSAL_KEYS[code as keyof typeof STATEMENT_REFUSAL_KEYS])
    : refusalCopy(code ?? reason).title;
}
