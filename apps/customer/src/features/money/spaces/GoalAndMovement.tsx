import { Meter } from '@intafaced/ui/lit/templates';
import { currentPreferences } from '../../../shared/preferences';
import { displayAmount } from '../../../shared/money';
import { goalChartCopy } from '../goal-chart-copy';
import { goalShare, movementShares } from '../goal-progress';

/** A bar for a space that has a saving target: "0 of 0.01 BTC". Skipped when balances are hidden or there is no usable target. */
export function GoalProgress({ balance, target, assetId }: { balance: string; target: string | null; assetId: string }) {
  const { t, languageFor } = goalChartCopy.useCopy();
  const share = goalShare(balance, target);
  if (!share || target === null || currentPreferences().hideBalances) return null;
  const text = t('goalProgress', { current: displayAmount(balance), target: displayAmount(target), asset: assetId });
  return (
    <div className="lt-stack" lang={languageFor('goalLabel')}>
      <Meter label={t('goalLabel')} value={Math.floor(share.basisPoints / 100)} text={text} />
      <p className="lt-hint lt-mono">
        {text}
        {share.reached ? ` · ${t('goalReached')}` : ''}
      </p>
    </div>
  );
}

/**
 * Inflow against outflow over the chosen window, drawn from the two totals the bank returned. The bank does not return a
 * point per day, so there is no line and no invented step. A table carries the same figures for screen readers.
 */
export function MovementBars({ inflow, outflow, net, assetId }: { inflow: string; outflow: string; net: string; assetId: string }) {
  const { t, languageFor } = goalChartCopy.useCopy();
  const shares = movementShares(inflow, outflow);
  if (!shares || currentPreferences().hideBalances) return null;
  const rows = [
    { key: 'inflow', label: t('inflow'), value: inflow, width: shares.inflow },
    { key: 'outflow', label: t('outflow'), value: outflow, width: shares.outflow },
  ] as const;
  return (
    <figure className="lt-stack" lang={languageFor('chartTitle')}>
      <figcaption>{t('chartTitle')}</figcaption>
      <div className="lt-stack" aria-hidden="true">
        {rows.map((row) => (
          <div className="lt-stack" key={row.key}>
            <span>{row.label}</span>
            <Meter label={row.label} value={row.width / 100} text={`${displayAmount(row.value)} ${assetId}`} />
            <strong className="lt-mono">
              {displayAmount(row.value)} {assetId}
            </strong>
          </div>
        ))}
      </div>
      <table className="lt-sr">
        <caption>{t('chartTable')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('chartRow')}</th>
            <th scope="col">{t('chartAmount')}</th>
          </tr>
        </thead>
        <tbody>
          {[...rows, { key: 'net', label: t('net'), value: net }].map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>
                {displayAmount(row.value)} {assetId}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="lt-hint">{t('chartCaption')}</p>
    </figure>
  );
}
