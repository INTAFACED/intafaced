import { displayAmount, parseAmount } from '../../../../shared/money';
import { uiCopy } from './copy';

/**
 * An exact amount with its asset code, kept on one line. `hideZero` is for per-asset lists, where a zero line is
 * noise. Test or sandbox money carries a TEST tag. Use `MoneyDisplay` instead where a compact figure is right.
 */
export function MoneyText({
  value,
  asset,
  hideZero = false,
  test = false,
}: {
  value: string;
  asset: string;
  hideZero?: boolean;
  test?: boolean;
}) {
  const { t } = uiCopy.useCopy();
  if (hideZero && parseAmount(value) === 0n) return null;
  return (
    <span className="numeric pp-money pp-nowrap">
      {displayAmount(value)}{' '}
      <span className="pp-unit" lang="zxx">
        {asset}
      </span>
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
