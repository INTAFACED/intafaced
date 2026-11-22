import type { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { parseAmount } from '../../shared/money';
import { useSession } from '../session';
import { bankReads, type loanSchema } from './contracts';
import { amount, bps, funds, positiveMoney, useBankRead, usePageLimit, type ActionSpec } from './components';
import { t as copyText } from './copy';
import { availableRow, loanFormFacts, loanLiveRows } from './form-preview';
import { useHoldings } from './holdings';
import { loanCopy, loanStatusLabel } from './loan-copy';
import './loan.css';

type Loan = z.infer<typeof loanSchema>;
type Product = z.infer<(typeof bankReads)['loans.products']>[number];
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

function currentLoanPreflight(api: ApiClient, loan: Loan, action: LoanAction, limit: number): NonNullable<ActionSpec['preflight']> {
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
async function readReleasable(
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

/**
 * What the Loans room (`/bank/loans`, loans/LoansRoom.tsx) reads and the reviews it opens: the products, the person's loans
 * and their health, and each borrowing, repayment and collateral review with the checks it runs again before it is sent.
 */
export function useLoansRoom() {
  const { api } = useSession();
  const [limit, setLimit] = usePageLimit();
  const products = useBankRead('loans.products', { limit });
  const loans = useBankRead('loans.list', { limit });
  const health = useBankRead('loans.health', undefined);
  const held = useHoldings();
  const heldRows = held.resource.status === 'ready' ? held.resource.data.holdings : null;
  return {
    limit,
    setLimit,
    products,
    loans,
    health,
    review: {
      open: (product: Product): ActionSpec => ({
        title: copyText('rooms.open.loan'),
        procedure: 'loans.open',
        fields: [
          positiveMoney(product.debtAssetId, 'principal', copyText('rooms.principal.to.borrow')),
          positiveMoney(product.collateralAssetId, 'collateralAmount', copyText('rooms.collateral.to.pledge')),
        ],
        formFacts: loanFormFacts(product, availableRow(product.collateralAssetId, heldRows, funds), bps),
        liveRows: (values) => loanLiveRows(product, values, funds),
        facts: [
          [copyText('rooms.product'), product.name],
          [copyText('rooms.apr.2'), bps(product.aprBps)],
          [copyText('rooms.maximum.ltv'), bps(product.maxLtvBps)],
          [copyText('rooms.margin.call'), bps(product.marginCallLtvBps)],
          [copyText('rooms.liquidation'), bps(product.liquidationLtvBps)],
        ],
        notes: [
          copyText('rooms.collateral.moves.from.your.user.available.account'),
          copyText('rooms.the.service.obtains.acceptable.current.marks.and'),
        ],
        validate: (input) =>
          parseAmount(String(input.principal)) >= parseAmount(product.minPrincipal)
            ? null
            : copyText('rooms.principal.is.below.the.product.minimum'),
        input: (values, requestId) => ({
          loanId: requestId,
          productId: product.id,
          principal: values.principal,
          collateralAmount: values.collateralAmount,
        }),
        submit: copyText('rooms.confirm.loan.request'),
      }),
      repay: (loan: Loan): ActionSpec => ({
        title: copyText('rooms.repay.loan'),
        procedure: 'loans.repay',
        preflight: currentLoanPreflight(api, loan, 'repay', limit),
        fields: [positiveMoney(loan.debtAssetId)],
        facts: [
          [loanCopy.t('loan'), loan.id],
          [loanCopy.t('status'), loanStatusLabel(loan.status)],
          [loanCopy.t('debtAsset'), loan.debtAssetId],
          [loanCopy.t('collateralAsset'), loan.collateralAssetId],
          [copyText('rooms.principal.at.last.read'), amount(loan.outstandingPrincipal, loan.debtAssetId)],
          [copyText('rooms.interest.at.last.read'), amount(loan.outstandingInterest, loan.debtAssetId)],
        ],
        notes: [loanCopy.t('repaymentOffer'), copyText('rooms.your.request.reference.remains.stable.an.uncertain')],
        input: (values, requestId) => ({ loanId: loan.id, eventId: requestId, amount: values.amount }),
        // svc-bank `loans.repay` answers a repeated eventId with the first repayment, never a second one.
        resendSame: true,
      }),
      addCollateral: (loan: Loan): ActionSpec => ({
        title: copyText('rooms.add.collateral'),
        procedure: 'loans.addCollateral',
        preflight: currentLoanPreflight(api, loan, 'addCollateral', limit),
        fields: [positiveMoney(loan.collateralAssetId)],
        facts: [
          [loanCopy.t('loan'), loan.id],
          [loanCopy.t('status'), loanStatusLabel(loan.status)],
          [loanCopy.t('debtAsset'), loan.debtAssetId],
          [loanCopy.t('collateralAsset'), loan.collateralAssetId],
        ],
        notes: [copyText('rooms.additional.collateral.is.locked.from.your.user')],
        input: (values, requestId) => ({ loanId: loan.id, eventId: requestId, amount: values.amount }),
      }),
      releaseExcess: (loan: Loan): ActionSpec => ({
        title: copyText('rooms.release.excess.collateral'),
        procedure: 'loans.releaseExcess',
        preflight: currentLoanPreflight(api, loan, 'releaseExcess', limit),
        validate: (input) =>
          typeof input.amount === 'string' && parseAmount(input.amount) <= parseAmount(loan.collateral)
            ? null
            : loanCopy.t('releaseTooLarge'),
        fields: [positiveMoney(loan.collateralAssetId)],
        facts: [
          [loanCopy.t('loan'), loan.id],
          [loanCopy.t('status'), loanStatusLabel(loan.status)],
          [loanCopy.t('debtAsset'), loan.debtAssetId],
          [loanCopy.t('collateralAsset'), loan.collateralAssetId],
          [copyText('rooms.collateral.at.last.read'), amount(loan.collateral, loan.collateralAssetId)],
        ],
        notes: [
          copyText('rooms.the.service.obtains.current.marks.before.releasing'),
          copyText('rooms.no.available.amount.is.optimistically.increased.refresh'),
        ],
        reviewTerms: {
          checking: loanCopy.t('releasableChecking'),
          read: (input, signal) => readReleasable(api, loan.id, loan.collateralAssetId, input.amount, signal),
        },
        // svc-bank `loans.releaseExcess` keys the release by this eventId, so a retry never releases twice.
        input: (values, requestId) => ({ loanId: loan.id, eventId: requestId, amount: values.amount }),
      }),
      close: (loan: Loan): ActionSpec => ({
        title: copyText('rooms.release.settled.collateral'),
        unit: loan.collateralAssetId,
        procedure: 'loans.close',
        preflight: currentLoanPreflight(api, loan, 'close', limit),
        facts: [
          [loanCopy.t('loan'), loan.id],
          [loanCopy.t('status'), loanStatusLabel(loan.status)],
          [loanCopy.t('debtAsset'), loan.debtAssetId],
          [loanCopy.t('collateralAsset'), loan.collateralAssetId],
          [copyText('rooms.collateral.at.last.read'), amount(loan.collateral, loan.collateralAssetId)],
        ],
        notes: [copyText('rooms.the.service.releases.collateral.only.after.verifying')],
        input: () => ({ loanId: loan.id }),
      }),
    },
  };
}
