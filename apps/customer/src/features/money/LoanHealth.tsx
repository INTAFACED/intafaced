import type { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import { parseAmount } from '../../shared/money';
import { Button } from '../../shared/ui';
import { bankReads, type loanSchema } from './contracts';
import { amount, bps, type ActionSpec } from './components';
import { loanCopy } from './loan-copy';
import './loan.css';

type Loan = z.infer<typeof loanSchema>;
type Health = z.infer<(typeof bankReads)['loans.health']>;
type LoanAction = 'repay' | 'addCollateral' | 'releaseExcess' | 'close';
const statuses = ['pending', 'active', 'margin_call', 'liquidating', 'repaid', 'liquidated'];

/** Status admission is per method. Marks, funds and other service guards still apply. */
export function loanActionAllowed(loan: Loan, action: LoanAction): boolean {
  if (!statuses.includes(loan.status)) return false;
  if (action === 'close') return parseAmount(loan.outstandingPrincipal) === 0n && parseAmount(loan.outstandingInterest) === 0n;
  if (action === 'addCollateral') return !['repaid', 'liquidated'].includes(loan.status);
  if (action === 'releaseExcess')
    return ['active', 'margin_call', 'liquidating'].includes(loan.status) && parseAmount(loan.collateral) > 0n;
  return (
    ['active', 'margin_call'].includes(loan.status) && parseAmount(loan.outstandingPrincipal) + parseAmount(loan.outstandingInterest) > 0n
  );
}

export function loanStatusNote(status: string): string | null {
  if (status === 'pending') return loanCopy.t('pending');
  if (status === 'margin_call') return loanCopy.t('marginCall');
  if (status === 'liquidating') return loanCopy.t('liquidating');
  if (status === 'repaid' || status === 'liquidated') return loanCopy.t('closed');
  return status === 'active' ? null : loanCopy.t('unsupported');
}

export function currentLoanPreflight(api: ApiClient, loan: Loan, action: LoanAction, limit: number): NonNullable<ActionSpec['preflight']> {
  return async (input): Promise<ApiResult<null>> => {
    const latest = await api.query('bank', 'loans.list', { limit }, bankReads['loans.list']);
    if (!latest.ok)
      return { ok: false, reason: 'error', code: 'money.loan_read_unavailable', message: loanCopy.t('readFailed', { loanId: loan.id }) };
    const matches = latest.data.filter((row) => row.id === loan.id);
    const current = matches.length === 1 ? matches[0] : undefined;
    if (!current || JSON.stringify(current) !== JSON.stringify(loan) || !loanActionAllowed(current, action))
      return { ok: false, reason: 'error', code: 'money.loan_review_changed', message: loanCopy.t('changed', { loanId: loan.id }) };
    if (action === 'releaseExcess' && (typeof input.amount !== 'string' || parseAmount(input.amount) > parseAmount(current.collateral)))
      return { ok: false, reason: 'error', code: 'money.loan_release_exceeds_collateral', message: loanCopy.t('releaseTooLarge') };
    return { ok: true, data: null };
  };
}

/**
 * The release review's terms (BK-loan-05): the bank's own answer to how much collateral it would release now. The amount
 * asked for above that, or any amount when it would release none, holds Confirm with the reason; nothing is worked out here.
 */
export async function readReleasable(
  api: ApiClient,
  loanId: string,
  assetId: string,
  asked: unknown,
  signal?: AbortSignal,
): Promise<{ rows: [string, string][]; blocked: string | null }> {
  const read = await api.query('bank', 'loans.releasable', { loanId }, bankReads['loans.releasable'], { signal });
  if (!read.ok)
    return {
      rows: [],
      blocked: read.code?.includes('.') ? loanCopy.t('releasableRefused', { code: read.code }) : loanCopy.t('releasableFailed'),
    };
  const most = parseAmount(read.data.releasable);
  const shown = amount(read.data.releasable, assetId);
  const rows: [string, string][] = [[loanCopy.t('releasableNow'), shown]];
  if (most === 0n) return { rows, blocked: loanCopy.t('releasableNone') };
  if (typeof asked !== 'string' || parseAmount(asked) > most) return { rows, blocked: loanCopy.t('releasableOver', { releasable: shown }) };
  return { rows, blocked: null };
}

export function LoanHealth({ loan, resource, reload }: { loan: Loan; resource: Resource<Health>; reload: () => void }) {
  const { t } = loanCopy.useCopy();
  const matches = resource.status === 'ready' ? resource.data.loans.filter((row) => row.loanId === loan.id) : [];
  const ratio = matches.length === 1 ? matches[0]!.ltvBps : undefined;
  const valid = ratio !== undefined && Number.isSafeInteger(ratio) && ratio >= 0;
  const ranged = ratio === Number.MAX_SAFE_INTEGER;
  return (
    <section data-testid="money-loan-risk" className="money-loan-risk" aria-label={t('riskFor', { loanId: loan.id })}>
      <div className="money-loan-risk-value">
        <h4>{t('riskLabel')}</h4>
        <strong className={valid && !ranged ? 'numeric' : 'money-loan-risk-message'}>
          {resource.status === 'loading' ? t('riskLoading') : valid ? (ranged ? t('riskRange') : bps(ratio)) : t('riskUnavailable')}
        </strong>
      </div>
      <div className="money-loan-risk-detail">
        <p className="muted">{valid ? t('riskNote') : t('riskUnavailableNote')}</p>
        {resource.status === 'failed' && (
          <Button variant="ghost" onClick={reload}>
            {t('riskRefresh')}
          </Button>
        )}
      </div>
    </section>
  );
}
