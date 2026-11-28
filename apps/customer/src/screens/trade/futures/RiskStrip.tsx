import { displayAmount } from '../../../shared/money';
import type { VenueOrder, VenuePosition } from '../../../features/trade/venue-api';
import { futuresVenueCopy } from './venue-copy';
import { riskOf, type NetAt } from './risk-strip';

/**
 * Desk A's strip at the top: open P&L, and what the positions would make or lose if every stop, or every target,
 * filled at its trigger, after the venue's fee and ours in and out (J-derivatives-32 #1). A position with no stop is
 * named in place of a loss total, so a total never looks safer than it is.
 */
export function RiskStrip({
  positions,
  orders,
  quote,
  netAt,
}: {
  positions: readonly VenuePosition[];
  orders: readonly VenueOrder[];
  quote: string;
  netAt: NetAt;
}) {
  const { t } = futuresVenueCopy.useCopy();
  if (positions.length === 0) return null;
  const r = riskOf(positions, orders, netAt);
  const figure = (value: string, testid: string) => (
    <dd data-testid={testid} data-value={value} data-sign={value.startsWith('-') ? 'down' : value === '0' ? 'flat' : 'up'}>
      {value.startsWith('-') || value === '0' ? '' : '+'}
      {displayAmount(value, 2)} {quote}
    </dd>
  );
  const unknown = (testid: string) => (
    <dd data-testid={testid} data-value="">
      {t('After fees unknown')}
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
          {r.noStop.length > 0 ? (
            <dd data-testid="venue-risk-stops" data-value="">
              {r.noStop.length === r.count ? t('None set') : t('No stop named', { symbols: r.noStop.join(', ') })}
            </dd>
          ) : r.ifStops === null ? (
            unknown('venue-risk-stops')
          ) : (
            figure(r.ifStops, 'venue-risk-stops')
          )}
        </div>
        <div>
          <dt>{t('If every target hits')}</dt>
          {r.noTarget.length === r.count ? (
            <dd data-testid="venue-risk-targets" data-value="">
              {t('None set')}
            </dd>
          ) : r.ifTargets === null ? (
            unknown('venue-risk-targets')
          ) : (
            figure(r.ifTargets, 'venue-risk-targets')
          )}
        </div>
      </dl>
      <p className="xd-risk-note">
        {t('After fees')} · {t('Positions open', { count: String(r.count) })}
        {r.noStop.length > 0 ? (
          <>
            {' '}
            · <span data-testid="venue-risk-no-stop">{t('No stop on', { symbols: r.noStop.join(', ') })}</span>
          </>
        ) : null}
        {r.noTarget.length > 0 && r.noTarget.length < r.count ? (
          <>
            {' '}
            · <span data-testid="venue-risk-no-target">{t('No target on', { symbols: r.noTarget.join(', ') })}</span>
          </>
        ) : null}
      </p>
    </section>
  );
}
