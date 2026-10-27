import { useId } from 'react';
import { coinCopy } from './copy';
import {
  Amount,
  fmtAmount,
  fmtPrice,
  fmtUsd,
  Money,
  partialWindowStart,
  sinceLabel,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  usePreferences,
  useTicker,
  type Holding,
  type Loadable,
  type PortfolioSummary,
} from './deps';

/** A label with a dotted underline that opens a Tooltip on hover and on keyboard focus; the words also sit in the page for screen readers. */
function Term({ label, rule }: { label: string; rule: string }) {
  const id = useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger data-testid="coin-term" className="coin-term" render={<button type="button" aria-describedby={id} />}>
          {label}
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start">
          {rule}
        </TooltipContent>
      </Tooltip>
      <span id={id} className="if-sr">
        {rule}
      </span>
    </>
  );
}

/** What the person holds of this coin, from the portfolio: null while unknown, a zero holding when they hold none. */
export function holdingOf(portfolio: Loadable<PortfolioSummary>, asset: string): Holding | null | 'unknown' {
  if (portfolio.status === 'ready') return portfolio.data.holdings.find((h) => h.asset === asset) ?? null;
  if (portfolio.status === 'empty') return null;
  return 'unknown';
}

export function KeyStats({
  asset,
  symbol,
  tickSize,
  portfolio,
}: {
  asset: string;
  /** The coin's market, or null for a coin with none (USDT, USDC or a closed market): only the balance row is drawn. */
  symbol: string | null;
  tickSize: string | null;
  portfolio: Loadable<PortfolioSummary>;
}) {
  const { t } = coinCopy.useCopy();
  const { timeZone } = usePreferences();
  const held = holdingOf(portfolio, asset);
  return (
    <section data-testid="coin-stats" className="coin-card coin-stats" aria-label={t('Key stats')}>
      {symbol ? <MarketRows symbol={symbol} asset={asset} tickSize={tickSize} timeZone={timeZone} /> : null}
      <div className="coin-stats__row coin-stats__row--balance" data-testid="stat-balance">
        <Term label={t('Your balance')} rule={t('Your balance rule')} />
        <span className="coin-stats__value">
          {portfolio.status === 'loading' ? (
            <Skeleton width={96} height={18} className="bg-field" />
          ) : held === 'unknown' ? (
            '—'
          ) : held === null ? (
            <Amount value={`0 ${asset}`} />
          ) : (
            <>
              <Amount value={`${fmtAmount(held.total, { places: 8 })} ${asset}`} />
              <Money className="coin-stats__sub" value={held.usdValue === null ? null : fmtUsd(held.usdValue)} />
            </>
          )}
        </span>
      </div>
      {symbol ? <YoungNote symbol={symbol} timeZone={timeZone} /> : null}
    </section>
  );
}

function MarketRows({
  symbol,
  asset,
  tickSize,
  timeZone,
}: {
  symbol: string;
  asset: string;
  tickSize: string | null;
  timeZone: Parameters<typeof sinceLabel>[1];
}) {
  const { t } = coinCopy.useCopy();
  const ticker = useTicker(symbol);
  const row = ticker.status === 'ready' ? ticker.data : null;
  const loading = ticker.status === 'loading';
  const price = (value: string | null | undefined) => (value ? `$${fmtPrice(value, tickSize)}` : '—');
  const cell = (value: string) => (loading ? <Skeleton width={96} height={18} className="bg-field" /> : value);
  return (
    <>
      <div className="coin-stats__row" data-testid="stat-high">
        <Term label={t('24h high')} rule={t('24h high rule')} />
        <span className="coin-stats__value">{cell(price(row?.high24h))}</span>
      </div>
      <div className="coin-stats__row" data-testid="stat-low">
        <Term label={t('24h low')} rule={t('24h low rule')} />
        <span className="coin-stats__value">{cell(price(row?.low24h))}</span>
      </div>
      <div className="coin-stats__row" data-testid="stat-volume">
        <Term label={t('24h volume', { asset })} rule={t('24h volume rule')} />
        <span className="coin-stats__value">{cell(row?.baseVolume24h ? fmtAmount(row.baseVolume24h, { places: 4 }) : '—')}</span>
      </div>
    </>
  );
}

/** One line under the card when the market is less than a day old, so "24h" is not read as a full day. */
function YoungNote({ symbol, timeZone }: { symbol: string; timeZone: Parameters<typeof sinceLabel>[1] }) {
  const { t } = coinCopy.useCopy();
  const ticker = useTicker(symbol);
  const partial = partialWindowStart(ticker.status === 'ready' ? ticker.data : undefined, Date.now());
  if (partial === null) return null;
  return (
    <p className="coin-stats__note" data-testid="stat-young">
      {t('Younger than a day', { time: sinceLabel(partial, timeZone) })}
    </p>
  );
}
