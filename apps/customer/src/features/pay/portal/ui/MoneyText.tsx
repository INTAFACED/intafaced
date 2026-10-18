import { parseAmount } from '../../../../shared/money';
import { uiCopy } from './copy';
import { useExactMoneyScope } from './ExactMoneyScope';
import { formatMoney, isRounded } from './format';

/** True for a zero amount. A string that is not an amount is not zero: the line is drawn as the service sent it, and nothing throws. */
function isZero(value: string): boolean {
  try {
    return parseAmount(value) === 0n;
  } catch {
    return false;
  }
}

/**
 * An amount with its asset code, kept on one line, formatted by `formatMoney` (see ./format.ts): fiat and stablecoins
 * at 2 places, thousands separators, never a float. Inside a review (`ExactMoneyScope`) it shows every digit; elsewhere a
 * rounded figure carries the exact one in its tooltip.
 * - `hideZero`: for per-asset lists, where a zero line is noise.
 * - `sign="minus"`: a fee taken or a debit, shown "−1.20 USDT".
 * - `test`: sandbox money carries a TEST tag.
 * Use `MoneyDisplay` instead where a compact figure with a "Show exact" toggle is right.
 */
export function MoneyText({
  value,
  asset,
  hideZero = false,
  test = false,
  sign,
}: {
  value: string;
  asset: string;
  hideZero?: boolean;
  test?: boolean;
  sign?: 'minus' | 'plus';
}) {
  const { t } = uiCopy.useCopy();
  const exactScope = useExactMoneyScope();
  if (hideZero && isZero(value)) return null;
  const text = formatMoney(value, asset, { exact: exactScope, sign });
  const rounded = !exactScope && isRounded(value, asset);
  // Inside a review the figure shows every digit, so a figure that differs from the rounded one in the list says so.
  const exactTag = exactScope && isRounded(value, asset);
  return (
    <span className="numeric pp-money pp-nowrap" title={rounded ? `${formatMoney(value, asset, { exact: true })} ${asset}` : undefined}>
      {text}{' '}
      <span className="pp-unit" lang="zxx">
        {asset}
      </span>
      {exactTag && <span className="pp-exact-tag"> ({t('exactTag')})</span>}
      {test && (
        <>
          {' '}
          <span className="pp-test" title={t('testTip')}>
            {t('testTag')}
          </span>
        </>
      )}
    </span>
  );
}

/** One line per asset. Two assets are never added together; an empty list is "nothing yet" (a dash), not zero. */
export function MoneyList({
  items,
  emptyLabel,
  test = false,
  sign,
}: {
  items: readonly { assetCode: string; amount: string }[];
  emptyLabel?: string;
  test?: boolean;
  sign?: 'minus' | 'plus';
}) {
  if (items.length === 0)
    return (
      <span className="pp-none" title={emptyLabel}>
        —
      </span>
    );
  return (
    <span className="pp-lines">
      {items.map((item) => (
        <span key={item.assetCode} className="pp-line">
          <MoneyText value={item.amount} asset={item.assetCode} test={test} sign={sign} />
        </span>
      ))}
    </span>
  );
}
