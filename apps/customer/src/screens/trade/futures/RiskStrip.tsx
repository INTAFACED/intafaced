import { displayAmount } from '../../../shared/money';
import type { VenueOrder, VenuePosition } from '../../../features/trade/venue-api';
import { futuresVenueCopy } from './venue-copy';
import { riskOf } from './risk-strip';

/**
 * Desk A's strip at the top: open P&L, and what the positions would make or lose if every stop, or every target,
 * filled at its trigger. A position with nothing resting is named, so a total never looks safer than it is.
 */
export function RiskStrip({
  positions,
  orders,
  quote,
}: {
  positions: readonly VenuePosition[];
  orders: readonly VenueOrder[];
  quote: string;
}) {
  const { t } = futuresVenueCopy.useCopy();
  if (positions.length === 0) return null;
  const r = riskOf(positions, orders);
  const figure = (value: string, testid: string) => (
    <dd data-testid={testid} data-sign={value.startsWith('-') ? 'down' : value === '0' ? 'flat' : 'up'}>
      {value.startsWith('-') || value === '0' ? '' : '+'}
      {displayAmount(value, 2)} {quote}
    </dd>
  );
  return (
    <section className="xd-risk" aria-label={t('Risk now')} data-testid="venue-risk-strip">
      <dl>
        <div>
          <dt>{t('Open result')}</dt>
          {figure(r.open, 'venue-risk-open')}
        </div>
        <div>
          <dt>{t('If every stop hits')}</dt>
          {/* Nothing resting at all: no total to show, never the open result passed off as one. */}
          {r.noStop === r.count ? <dd data-testid="venue-risk-stops">{t('None set')}</dd> : figure(r.ifStops, 'venue-risk-stops')}
        </div>
        <div>
          <dt>{t('If every target hits')}</dt>
          {r.noTarget === r.count ? <dd data-testid="venue-risk-targets">{t('None set')}</dd> : figure(r.ifTargets, 'venue-risk-targets')}
        </div>
      </dl>
      <p className="xd-risk-note">
        {t('Before fees')} · {t('Positions open', { count: String(r.count) })}
        {r.noStop > 0 ? (
          <>
            {' '}
            · <span data-testid="venue-risk-no-stop">{t('No stop on', { count: String(r.noStop) })}</span>
          </>
        ) : null}
        {r.noTarget > 0 ? <> · {t('No target on', { count: String(r.noTarget) })}</> : null}
      </p>
    </section>
  );
}
