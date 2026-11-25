import { StatStrip, type StatCell } from '@intafaced/ui/lit';
import { displayAmount } from '../../../shared/money';
import type { VenueOrder, VenuePosition } from '../../../features/trade/venue-api';
import { futuresVenueCopy } from './venue-copy';
import { riskOf } from './risk-strip';

/**
 * Desk A's figures at the top, beside the contracts: the contract's funding, open P&L, and what the positions would make
 * or lose if every stop, or every target, filled at its trigger. Always drawn, so the top row keeps its shape: with no
 * position each total says so. A position with nothing resting is named, so a total never looks safer than it is.
 */
export function RiskStrip({
  positions,
  orders,
  quote,
  funding,
}: {
  positions: readonly VenuePosition[];
  orders: readonly VenueOrder[];
  quote: string;
  /** The chosen contract's funding, as the venue publishes it, or null when it publishes none. */
  funding: string | null;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const r = positions.length === 0 ? null : riskOf(positions, orders);
  const figure = (value: string) => `${value.startsWith('-') || value === '0' ? '' : '+'}${displayAmount(value, 2)} ${quote}`;
  const tone = (value: string): StatCell['tone'] => (value.startsWith('-') ? 'down' : value === '0' ? undefined : 'up');
  const cells: StatCell[] = [
    { key: 'funding', label: t('Funding'), value: funding ?? t('Not published'), 'data-testid': 'venue-risk-funding' },
    r
      ? { key: 'open', label: t('Open result'), value: figure(r.open), tone: tone(r.open), 'data-testid': 'venue-risk-open' }
      : { key: 'open', label: t('Open result'), value: t('No position'), num: false, 'data-testid': 'venue-risk-open' },
    // Nothing resting at all: no total to show, never the open result passed off as one.
    !r || r.noStop === r.count
      ? { key: 'stops', label: t('If every stop hits'), value: t('None set'), num: false, 'data-testid': 'venue-risk-stops' }
      : {
          key: 'stops',
          label: t('If every stop hits'),
          value: figure(r.ifStops),
          tone: tone(r.ifStops),
          'data-testid': 'venue-risk-stops',
        },
    !r || r.noTarget === r.count
      ? { key: 'targets', label: t('If every target hits'), value: t('None set'), num: false, 'data-testid': 'venue-risk-targets' }
      : {
          key: 'targets',
          label: t('If every target hits'),
          value: figure(r.ifTargets),
          tone: tone(r.ifTargets),
          'data-testid': 'venue-risk-targets',
        },
  ];
  return (
    <section className="xd-risk" aria-label={t('Risk now')} data-testid="venue-risk-strip">
      <StatStrip cells={cells} dense />
      {r ? (
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
      ) : null}
    </section>
  );
}
