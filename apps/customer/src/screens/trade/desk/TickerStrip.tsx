import { memo } from 'react';
import { Star } from 'lucide-react';
import { deskCopy } from './copy';
import { Bone, ChangeText, CoinIcon, direction as signOf, fmtAmount, type Loadable, type TickerRow } from './deps';
import { useFlash, useTickDirection } from './hooks';
import { tradingMode, type DeskMarket } from './market';
import { changeLine, dollarPrice, partialWindowStart, placesOf, turnoverText } from './text';
import { clockMinutes, dayTime } from './time';
import { maintenanceWhen } from '../../../shared/market-maintenance';
import { useMarketLifecycle } from '../../charts/market-state';
import { TEST_EVIDENCE_PREFIX } from '../../charts/data-status';
import type { Preferences } from '../../../shared/preferences';
import type { ReactNode } from 'react';

interface Props {
  market: DeskMarket;
  ticker: Loadable<TickerRow>;
  favorite: boolean;
  onToggleFavorite: () => void;
  zone: Preferences['timeZone'];
  /** The pair picker (a popover with the markets list) for widths where the left panel is hidden. */
  picker: ReactNode;
  /** The data status chip, at the strip's right edge. */
  status?: ReactNode;
}

function Stat({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{loading ? <Bone size="word" /> : <span className="lt-num">{value}</span>}</dd>
    </div>
  );
}

/** The market's maintenance window on the ticket (J-cex-spot-14 #5): how far away it is, and its end or "End time not set". */
function MaintenanceStat({ window, zone }: { window: NonNullable<DeskMarket['maintenance']>; zone: Preferences['timeZone'] }) {
  const { t } = deskCopy.useCopy();
  const when = maintenanceWhen(window, Date.now());
  const text =
    when.kind === 'now'
      ? t('Maintenance now')
      : when.kind === 'hours'
        ? when.n === 1
          ? t('Maintenance in one hour')
          : t('Maintenance in hours', { n: when.n })
        : t('Maintenance in minutes', { n: when.n });
  return (
    <div data-testid="dk-maintenance">
      <dt>{text}</dt>
      <dd>{window.endsAt === null ? t('Maintenance end not set') : t('Maintenance until', { time: clockMinutes(window.endsAt, zone) })}</dd>
    </div>
  );
}

/** Ticker strip, 48 px (UI-SPEC 5.7): pair, last price, 24h change, low, high, volume, turnover from /ticker; the trading mode from the listing. */
export const TickerStrip = memo(function TickerStrip({ market, ticker, favorite, onToggleFavorite, zone, picker, status }: Props) {
  const { t } = deskCopy.useCopy();
  // The TEST label follows the market's own lifecycle evidence, the same read and marker the chart's label uses, so the
  // chart and the price header never disagree. A lifecycle not read names no TEST and claims nothing either way.
  const lifecycle = useMarketLifecycle(market.symbol);
  const test = lifecycle.status === 'ready' && lifecycle.data.evidenceRefs.some((ref) => ref.startsWith(TEST_EVIDENCE_PREFIX));
  const row = ticker.status === 'ready' ? ticker.data : null;
  const last = row?.last ?? null;
  const direction = useTickDirection(last, market.symbol);
  const flash = useFlash(last, market.symbol);
  const partial = row ? partialWindowStart(row, Date.now()) : null;
  const since = partial !== null ? clockMinutes(partial, zone) : null;
  const sign = signOf(row?.changePct24h ?? null);
  const colour = direction ?? (sign === 'up' || sign === 'down' ? sign : null);
  const loading = ticker.status === 'loading';
  const pair = `${market.base}/${market.quote}`;
  const mode = tradingMode(market);
  // A shut session is said as itself, with when it opens: never the lifecycle's bare refusal (J-cex-spot-14 #6).
  const modeText = market.sessionShut
    ? market.opensAt != null
      ? t('Trading mode session shut opens', { time: dayTime(market.opensAt, zone) })
      : t('Trading mode session shut')
    : mode.kind === 'open'
      ? t('Trading mode value', { state: t('Mode OPEN') })
      : mode.kind === 'named'
        ? t(mode.newOrders ? 'Trading mode value' : 'Trading mode no orders', { state: t(`Mode ${mode.mode}`) })
        : t('Trading mode value', { state: mode.kind === 'unlisted' ? t('Mode unlisted') : t('Mode other') });
  return (
    <header data-testid="dk-ticker" className="lt-stack" aria-label={t('Spot desk')}>
      <div className="lt-row lt-row-between">
        <div className="lt-row">
          <CoinIcon asset={market.base} size="md" />
          <p data-testid="dk-pair" className="lt-panel-title">
            {pair}
          </p>
          {test ? (
            <span data-testid="dk-test" className="lt-test" title={t('Test market title')}>
              {t('Test market')}
            </span>
          ) : null}
          {picker}
          <button
            type="button"
            className="lt-icon-button"
            aria-pressed={favorite}
            aria-label={favorite ? t('Pair favourite remove', { pair }) : t('Pair favourite add', { pair })}
            onClick={onToggleFavorite}
          >
            <Star size={16} aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} />
          </button>
        </div>
        <div className="lt-row lt-row-baseline">
          {loading ? (
            <>
              <Bone size="word" />
              <Bone size="word" />
            </>
          ) : (
            <>
              <span
                data-testid="dk-last"
                className="lt-num lt-signed lt-strong"
                data-direction={colour ?? undefined}
                data-flash={flash ?? undefined}
                aria-label={t('Last price')}
              >
                {dollarPrice(last, market)}
              </span>
              <ChangeText value={row ? changeLine(row, market.tickSize) : '—'} sensitive={false} />
            </>
          )}
        </div>
        {status ? <div className="lt-row">{status}</div> : null}
      </div>
      <dl data-testid="dk-stats" className="lt-stats">
        {/* First, so a narrow strip clips a volume figure before it hides that the market is halted. */}
        <Stat label={t('Trading mode')} value={modeText} loading={false} />
        {market.maintenance ? <MaintenanceStat window={market.maintenance} zone={zone} /> : null}
        {market.openingWindowEndsAt != null && market.openingWindowEndsAt > Date.now() ? (
          // A new listing's opening window (J-cex-spot-14 #7): limit orders only until it ends.
          <div data-testid="dk-opening-window">
            <dt>{t('Opening window')}</dt>
            <dd>{t('Opening window until', { time: dayTime(market.openingWindowEndsAt, zone) })}</dd>
          </div>
        ) : null}
        {market.zone === 'higher_risk' ? (
          // The higher-risk zone (J-cex-spot-14 #7): flagged, capped and disclosed. Limit orders only, under the owner cap.
          <div data-testid="dk-zone">
            <dt>{t('Higher-risk zone')}</dt>
            <dd>
              {market.zoneOrderCap != null
                ? t('Zone cap', { cap: fmtAmount(market.zoneOrderCap, { places: 8 }), asset: market.quote })
                : t('Zone cap not set')}
            </dd>
          </div>
        ) : null}
        <Stat
          label={since ? t('Low since', { time: since }) : t('24h low')}
          value={dollarPrice(row?.low24h ?? null, market)}
          loading={loading}
        />
        <Stat
          label={since ? t('High since', { time: since }) : t('24h high')}
          value={dollarPrice(row?.high24h ?? null, market)}
          loading={loading}
        />
        <Stat
          label={since ? t('Volume since', { asset: market.base, time: since }) : t('24h volume', { asset: market.base })}
          value={fmtAmount(row?.baseVolume24h ?? null, { places: Math.min(placesOf(market.lotSize), 4) })}
          loading={loading}
        />
        <Stat
          label={since ? t('Turnover since', { asset: market.quote, time: since }) : t('24h turnover', { asset: market.quote })}
          value={turnoverText(row?.quoteVolume24h ?? null, market.quote)}
          loading={loading}
        />
        {/* SP-markets-data-04 is blocked on the engine's priority-class note and the owner's retail decision: the layer
            is named, never implied, and the place door refuses an order that asks for it (`trade.rpi_unavailable`). */}
        {/* A sentence, not a figure: it wraps like words (an lt-num figure never wraps, and pushed a long translation off a
            phone). */}
        <div>
          <dt>{t('Price improvement')}</dt>
          <dd>{t('Price improvement not available')}</dd>
        </div>
      </dl>
    </header>
  );
});
