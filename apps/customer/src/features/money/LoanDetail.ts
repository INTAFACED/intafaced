import type { ApiResult } from '../../shared/api';
import type { loanDetailCopy } from './loan-detail-copy';

type Copy = ReturnType<typeof loanDetailCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** What a refused loan read says, by the bank's code, with the code as a reference. Anything else keeps its own message. */
export function loanRefusal(t: Copy, failure: Pick<Failed, 'code' | 'message' | 'reason'>): string {
  const code = failure.code ?? '';
  const words =
    code === 'bank.loan_fee_unset'
      ? t('feeUnset')
      : code === 'bank.loan_payoff_window_unset'
        ? t('windowUnset')
        : code === 'bank.loan_closed'
          ? t('closed')
          : code === 'bank.loan_liquidating'
            ? t('liquidating')
            : code === 'bank.loan_fee_unsupported'
              ? t('feeUnsupported')
              : code === 'bank.loan_terms_missing'
                ? t('termsMissing')
                : code === 'bank.statement_too_large'
                  ? t('stTooLarge')
                  : code === 'bank.statement_range'
                    ? t('stRange')
                    : code === 'bank.ledger_outcome_unknown'
                      ? t('outcomeUnknown')
                      : code === 'bank.accrual_backlog'
                        ? t('backlog')
                        : code === 'bank.loan_not_drawable'
                          ? t('notDrawn')
                          : code === 'bank.loan_not_found'
                            ? t('notYours')
                            : failure.message;
  return code.includes('.') ? `${words} ${t('reference', { code })}` : words;
}

/**
 * One UTC month as the bank's loan statement reads a period: from its first instant to the next month's first instant,
 * the end not included. The bank charges interest by day and leaves out the day `to` falls on, so an end of 23:59:59.999
 * on the last day would drop that day's interest from the month.
 */
export function loanStatementMonth(month: string): { from: string; to: string } | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  return { from: new Date(Date.UTC(year, index, 1)).toISOString(), to: new Date(Date.UTC(year, index + 1, 1)).toISOString() };
}
