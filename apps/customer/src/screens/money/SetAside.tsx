import { Amount } from './ui-deps';
import { fmtAmount } from './deps';
import { moneyCopy } from './copy';
import { setAsideLabel, setAsideLines, setAsideRef, setAsideSum } from './set-aside';
import { useLockSplits } from './portfolio-source';

/**
 * W-balances-01: every amount of the coin that is set aside, one line per claim as the bank names it (an open order's
 * hold names the order), and the check that available plus set aside is the coin's whole balance.
 */
export function SetAside({ asset, hidden }: { asset: string; hidden: boolean }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const splits = useLockSplits(true);
  let body: React.ReactNode;
  if (splits.status === 'loading') {
    body = null;
  } else if (splits.status !== 'ready' && splits.status !== 'empty') {
    body = <p className="lt-hint">{t('Set aside unavailable')}</p>;
  } else {
    const split = splits.status === 'ready' ? splits.data[asset] : undefined;
    const lines = setAsideLines(split);
    if (lines.length === 0) {
      body = <p className="lt-hint">{t('Set aside none', { asset })}</p>;
    } else {
      const sum = split?.total === undefined ? null : setAsideSum(split, split.total);
      const figure = (value: string) => (hidden ? '••••' : fmtAmount(value));
      body = (
        <>
          <table className="money-table money-table--activity" data-testid="set-aside">
            <thead>
              <tr>
                <th scope="col">{t('Set aside column what')}</th>
                <th scope="col" className="money-num">
                  {t('Set aside column amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index}>
                  <td title={setAsideRef(line.what)}>{setAsideLabel(line.what, copy)}</td>
                  <td className="money-num">
                    <Amount value={`${fmtAmount(line.amount)} ${asset}`} hidden={hidden} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sum && split?.total !== undefined && (
            <p className="lt-hint" data-testid="set-aside-sum">
              {t(sum.adds ? 'Set aside adds up' : 'Set aside does not add up', {
                available: figure(split.available),
                setAside: figure(sum.setAside),
                total: figure(split.total),
                asset,
              })}
            </p>
          )}
        </>
      );
    }
  }
  return (
    <section data-testid="money-card" className="money-card money-detail__card" aria-label={t('Set aside title')}>
      <h2 className="money-detail__h">{t('Set aside title')}</h2>
      <p className="lt-hint">{t('Set aside intro')}</p>
      {body}
    </section>
  );
}
