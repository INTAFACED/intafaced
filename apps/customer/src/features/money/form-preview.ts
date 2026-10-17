import { displayPlaces, estimateDays, estimateInterest } from './interest-estimate';
import { formPreviewCopy } from './form-preview-copy';
import type { Holding } from './client';

type Row = [string, string];
/** Formats an exact amount with its asset ("1,000 USDT"); the screen passes the one that honours "hide amounts". */
type Format = (value: string, asset: string) => string;

/**
 * What the customer can use of one asset: the `available` figure the bank returned, never a sum or a guess.
 * `holdings` is null while the balances could not be read.
 */
export function availableRow(asset: string, holdings: readonly Holding[] | null, fmt: Format): Row {
  const { t } = formPreviewCopy;
  if (holdings === null) return [t('available'), t('availableUnknown')];
  const found = holdings.find((holding) => holding.assetId === asset);
  return [t('available'), found ? fmt(found.available, asset) : t('availableNone', { asset })];
}

export type EarnPool = { name: string; assetId: string; kind: 'flexible' | 'fixed'; aprBps: number; termDays: number | null };

/** The date a fixed-term deposit made today would mature, about: today + the pool's term. UTC date, never invented for flexible pools. */
export function maturityDate(termDays: number, now: Date): string {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + termDays));
  return at.toISOString().slice(0, 10);
}

function estimateRows(
  values: Record<string, string>,
  field: string,
  asset: string,
  aprBps: number,
  termDays: number | null,
  fmt: Format,
  basis: 'pool' | 'loan',
): Row[] {
  const { t } = formPreviewCopy;
  const days = estimateDays(termDays);
  const estimate = estimateInterest({
    amount: values[field] ?? '',
    aprBps,
    days,
    compounding: basis === 'loan' ? 'daily' : 'simple',
    places: displayPlaces(asset),
  });
  const how =
    basis === 'loan'
      ? t('estimateBasisLoan')
      : termDays !== null && termDays > 0
        ? t('estimateBasisTerm', { days })
        : t('estimateBasisYear');
  const value = !estimate
    ? t('estimateEmpty')
    : estimate.belowDisplay
      ? t('estimateTiny', { amount: fmt(estimate.smallest, asset) })
      : t('estimateValue', { amount: fmt(estimate.interest, asset) });
  return [
    [t('estimate'), value],
    [t('estimateHow'), how],
  ];
}

/** Rows above the Earn deposit form: pool, APR, term and (for a fixed pool) the approximate maturity date, then the balance. */
export function earnFormFacts(pool: EarnPool, available: Row, now: Date, bps: (value: number) => string): Row[] {
  const { t } = formPreviewCopy;
  const rows: Row[] = [
    [t('pool'), pool.name],
    [t('apr'), bps(pool.aprBps)],
    [
      t('term'),
      pool.termDays !== null ? t('termFixed', { days: pool.termDays }) : pool.kind === 'fixed' ? t('termNotStated') : t('termFlexible'),
    ],
  ];
  if (pool.termDays !== null && pool.termDays > 0)
    rows.push([t('maturity'), t('maturityIfToday', { date: maturityDate(pool.termDays, now) })]);
  rows.push(available);
  return rows;
}

export function earnLiveRows(pool: EarnPool, values: Record<string, string>, fmt: Format): Row[] {
  // A fixed pool that does not say how long it runs has no honest day count to estimate over.
  if (pool.kind === 'fixed' && pool.termDays === null) return [[formPreviewCopy.t('estimate'), formPreviewCopy.t('estimateNoTerm')]];
  return estimateRows(values, 'amount', pool.assetId, pool.aprBps, pool.termDays, fmt, 'pool');
}

export type LoanProduct = {
  name: string;
  debtAssetId: string;
  collateralAssetId: string;
  aprBps: number;
  maxLtvBps: number;
  marginCallLtvBps: number;
  liquidationLtvBps: number;
};

/**
 * Rows above the loan form. The product read gives the three LTV limits and the APR, so those are shown. It does not give
 * the price the bank values collateral at, so the starting LTV and the liquidation price are shown with that reason and
 * are never worked out from another price.
 */
export function loanFormFacts(product: LoanProduct, availableCollateral: Row, bps: (value: number) => string): Row[] {
  const { t } = formPreviewCopy;
  return [
    [t('product'), product.name],
    [t('apr'), bps(product.aprBps)],
    availableCollateral,
    [t('loanMaxLtv'), t('ltvOf', { percent: bps(product.maxLtvBps) })],
    [t('loanMarginCall'), t('ltvReaches', { percent: bps(product.marginCallLtvBps) })],
    [t('loanLiquidation'), t('ltvReaches', { percent: bps(product.liquidationLtvBps) })],
    [t('loanPriceRows'), t('loanNoPrice')],
  ];
}

export function loanLiveRows(product: LoanProduct, values: Record<string, string>, fmt: Format): Row[] {
  return estimateRows(values, 'principal', product.debtAssetId, product.aprBps, null, fmt, 'loan');
}
