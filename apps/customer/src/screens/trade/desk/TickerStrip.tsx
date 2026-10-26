import { memo } from 'react';
import { Star } from 'lucide-react';
import { deskCopy } from './copy';
import { ChangeText, CoinIcon, direction as signOf, fmtAmount, Skeleton, type Loadable, type TickerRow } from './deps';
import { useFlash, useTickDirection } from './hooks';
import { tradingMode, type DeskMarket } from './market';
import { changeLine, dollarPrice, partialWindowStart, placesOf, turnoverText } from './text';
import { clockMinutes } from './time';
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
    <div className="dk-stat">
      <span className="dk-stat-label">{label}</span>
      {loading ? <Skeleton width={64} height={16} className="bg-field" /> : <span className="dk-stat-value if-num">{value}</span>}
    </div>
  );
}

/** Ticker strip, 48 px (UI-SPEC 5.7): pair, last price, 24h change, low, high, volume, turnover from /ticker; the trading mode from the listing. */
export const TickerStrip = memo(function TickerStrip({ market, ticker, favorite, onToggleFavorite, zone, picker, status }: Props) {
  const { t } = deskCopy.useCopy();
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
  const modeText =
    mode.kind === 'open'
      ? t('Trading mode value', { state: t('Mode OPEN') })
      : mode.kind === 'named'
        ? t('Trading mode no orders', { state: t(`Mode ${mode.mode}`) })
        : t('Trading mode value', { state: mode.kind === 'unlisted' ? t('Mode unlisted') : t('Mode other') });
  return (
    <header data-testid="dk-ticker" className="dk-ticker" aria-label={t('Spot desk')}>
      <div className="dk-ticker-pair">
        <CoinIcon asset={market.base} size={24} />
        <h1 data-testid="dk-pair" className="dk-pair">
          {pair}
        </h1>
        {picker}
        <button
          type="button"
          className="dk-icon-btn"
          aria-pressed={favorite}
          aria-label={favorite ? t('Pair favourite remove', { pair }) : t('Pair favourite add', { pair })}
          onClick={onToggleFavorite}
        >
          <Star size={16} aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} />
        </button>
      </div>
      <div className="dk-ticker-last">
        {loading ? (
          <>
            <Skeleton width={96} height={20} className="bg-field" />
            <Skeleton width={72} height={14} className="bg-field" />
          </>
        ) : (
          <>
            <span
              data-testid="dk-last"
              className="dk-last if-num"
              data-direction={colour ?? undefined}
              data-flash={flash ?? undefined}
              aria-label={t('Last price')}
            >
              {dollarPrice(last, market)}
            </span>
            <ChangeText value={row ? changeLine(row, market.tickSize) : '—'} sensitive={false} className="dk-change" />
          </>
        )}
      </div>
      <div data-testid="dk-stats" className="dk-stats">
        {/* First, so a narrow strip clips a volume figure before it hides that the market is halted. */}
        <Stat label={t('Trading mode')} value={modeText} loading={false} />
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
      </div>
      {status ? <div className="dk-ticker-status">{status}</div> : null}
    </header>
  );
});
