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
  useSupportedAssets,
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
  /** The coin's market, or null for a coin with none (USDT, USDC or a closed market): the market rows are left out. */
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
      <div className="coin-stats__row" data-testid="stat-market-cap">
        <Term label={t('Market cap')} rule={t('Market cap rule')} />
        <span className="coin-stats__value">{t('not published')}</span>
      </div>
      <CoinNetworks asset={asset} />
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

/**
 * The networks this coin moves on, as the platform's asset registry names them (svc-bank `assets.list`, J-portfolio-10
 * #3). The registry holds no contract address or links, so none is shown; a coin the registry does not list says so.
 */
function CoinNetworks({ asset }: { asset: string }) {
  const { t } = coinCopy.useCopy();
  const registry = useSupportedAssets();
  // Only networks a customer can move the coin on now: an active asset that allows a deposit or a withdrawal.
  const row =
    registry.resource.status === 'ready'
      ? (registry.resource.data.assets.find(
          (entry) =>
            entry.assetId === asset &&
            entry.state === 'active' &&
            (entry.allowedActions.includes('deposit') || entry.allowedActions.includes('withdraw')),
        ) ?? null)
      : null;
  return (
    <div className="coin-stats__row" data-testid="coin-network">
      <Term label={t('Networks')} rule={t('Networks rule')} />
      <span className="coin-stats__value">
        {registry.resource.status === 'loading'
          ? '—'
          : registry.resource.status === 'failed'
            ? t('not read')
            : row === null || row.networks.length === 0
              ? t('not listed')
              : row.networks.map((network) => network.label).join(', ')}
      </span>
    </div>
  );
}
