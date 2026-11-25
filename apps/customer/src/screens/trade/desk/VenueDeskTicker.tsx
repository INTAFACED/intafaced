import type { VenueMarket } from '../../../features/trade/venue-api';
import { maintenanceOf, maintenanceWhen, type MaintenanceWindowSoon } from '../../../shared/market-maintenance';
import type { Preferences } from '../../../shared/preferences';
import { opensLabel } from '../markets/listing-status';
import { spotVenueCopy } from './venue-copy';

/** Format an upcoming maintenance window for the venue spot desk ticker and ticket (J-cex-spot-14 #5). */
export function venueMaintenanceLine(
  maintenance: MaintenanceWindowSoon | null,
  t: ReturnType<typeof spotVenueCopy.useCopy>['t'],
): string | null {
  if (!maintenance) return null;
  const when = maintenanceWhen(maintenance, Date.now());
  if (when.kind === 'now') return t('Maintenance now');
  if (when.kind === 'hours') return when.n === 1 ? t('Maintenance in one hour') : t('Maintenance in hours', { n: when.n });
  return t('Maintenance in minutes', { n: when.n });
}

/** Market state strip shown at the top of the venue spot desk (J-cex-spot-14 #3-#7, #9-#11). */
export function VenueDeskTicker({ market, timeZone }: { market: VenueMarket; timeZone: Preferences['timeZone'] }) {
  const { t } = spotVenueCopy.useCopy();
  const openingWindowEndsMs = market.openingWindowEndsAt ? Date.parse(market.openingWindowEndsAt) : Number.NaN;
  const openingWindowActive = !Number.isNaN(openingWindowEndsMs) && openingWindowEndsMs > Date.now();
  const higherRisk = market.zone === 'higher_risk';
  const sessionClosed = market.session.known && market.session.value.state === 'closed';
  const sessionReopensMs =
    sessionClosed && market.session.known && market.session.value.reopensAt ? Date.parse(market.session.value.reopensAt) : Number.NaN;
  const maintenanceLine = venueMaintenanceLine(maintenanceOf(market.upcomingMaintenance), t);

  return (
    <div className="lt-row" data-testid="dk-ticker">
      <strong data-testid="dk-pair">
        {market.baseAsset}/{market.quoteAsset}
      </strong>
      {market.status === 'limit_only' ? <span className="lt-note">{t('Mode limit only')}</span> : null}
      {market.status === 'cancel_only' ? <span className="lt-note">{t('Mode cancel only')}</span> : null}
      {sessionClosed ? (
        <span className="lt-note">
          {!Number.isNaN(sessionReopensMs)
            ? t('Session closed', { time: opensLabel(sessionReopensMs, timeZone) })
            : t('Session closed no time')}{' '}
          · {t('Session closed note')}
        </span>
      ) : null}
      {maintenanceLine ? <span className="lt-note">{maintenanceLine}</span> : null}
      {openingWindowActive ? (
        <span className="lt-note" data-testid="dk-opening-window">
          {t('Opening window')} · {t('Opening window rule', { time: opensLabel(openingWindowEndsMs, timeZone) })}
        </span>
      ) : null}
      {higherRisk ? (
        <span className="lt-note" data-testid="dk-zone">
          {t('Higher risk zone')} ·{' '}
          {market.zoneOrderCap
            ? t('Higher risk zone rule', { cap: market.zoneOrderCap, quote: market.quoteAsset })
            : t('Higher risk zone rule uncapped')}
        </span>
      ) : null}
      <a className="lt-link" data-testid="dk-analytics-link" href={`/trade/analytics/${market.symbol}`}>
        {t('Market analytics')}
      </a>
    </div>
  );
}

/** The venue's retail price improvement, as a line Market details shows (off the desk's face). */
export function VenueRpiLine() {
  const { t } = spotVenueCopy.useCopy();
  return (
    <p className="lt-hint" data-testid="dk-rpi">
      {t('Rpi label')}: {t('Rpi unavailable')}
    </p>
  );
}
