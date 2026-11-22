import type { Reputation } from '../schemas';
import { completionCopy } from './completion-copy';

/** "95.24" → "95.24%", or a dash when nothing is counted: no finished order is not 0%. */
const percent = (value: string | null | undefined) => (value ? `${value}%` : '—');

/**
 * P-trade-orders-21: the 30-day and all-time completion rates, as the service computed them from trades, with the
 * service's own words for what they count.
 */
export function CompletionRatesByPeriod({ data }: { data: Reputation }) {
  const { t } = completionCopy.useCopy();
  const definition = data.completionDefinition;
  const none = !data.completionRate30d && !data.completionRateTotal;
  return (
    <section aria-label={t('byPeriod')} className="stack" data-testid="completion-rates">
      <h3>{t('byPeriod')}</h3>
      <dl className="pay-details">
        <div>
          <dt>{t('last30')}</dt>
          <dd>
            <strong data-counterparty-metric="completion-30d">{percent(data.completionRate30d)}</strong>
          </dd>
        </div>
        <div>
          <dt>{t('allTime')}</dt>
          <dd>
            <strong data-counterparty-metric="completion-total">{percent(data.completionRateTotal)}</strong>
          </dd>
        </div>
      </dl>
      {definition ? (
        <details>
          <summary>{t('howCounted')}</summary>
          <ul lang="en">
            <li>{t('completedLine', { text: definition.numerator })}</li>
            <li>{t('countedLine', { text: definition.denominator })}</li>
            <li>{t('windowLine', { text: definition.window30d })}</li>
            {none ? <li>{definition.noHistory}</li> : null}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
