import { InfoTip } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { coinCopy } from './copy';
import {
  Amount,
  fmtAmount,
  fmtPrice,
  fmtUsd,
  Money,
  partialWindowStart,
  sinceLabel,
  usePreferences,
  useSupportedAssets,
  useTicker,
  type Holding,
  type Loadable,
  type PortfolioSummary,
} from './deps';

/** A row's label with the kit's (i) beside it: the rule opens on hover, keyboard focus and a tap, and is in the page for screen readers. */
function Term({ label, rule }: { label: string; rule: string }) {
  const { t } = coinCopy.useCopy();
  return (
    <dt>
      {label} <InfoTip text={rule} label={t('About {label}', { label })} data-testid="coin-term" />
    </dt>
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
  const { timeZone, hideBalances } = usePreferences();
  const held = holdingOf(portfolio, asset);
  return (
    <section data-testid="coin-stats" className="lt-stack" aria-label={t('Key stats')}>
      <dl className="lt-kv">
        {symbol ? <MarketRows symbol={symbol} asset={asset} tickSize={tickSize} timeZone={timeZone} /> : null}
        <div data-testid="stat-balance">
          <Term label={t('Your balance')} rule={t('Your balance rule')} />
          <dd data-testid="coin-stats__value">
            {portfolio.status === 'loading' ? (
              <Skeleton shape="text" count={1} />
            ) : held === 'unknown' ? (
              '—'
            ) : held === null ? (
              <Amount value={`0 ${asset}`} hidden={hideBalances} />
            ) : (
              <>
                <Amount value={`${fmtAmount(held.total, { places: 8 })} ${asset}`} hidden={hideBalances} />
                <Money value={held.usdValue === null ? null : fmtUsd(held.usdValue)} hidden={hideBalances} />
              </>
            )}
          </dd>
        </div>
        <div data-testid="stat-market-cap">
          <Term label={t('Market cap')} rule={t('Market cap rule')} />
          <dd data-testid="coin-stats__value">{t('not published')}</dd>
        </div>
        <CoinNetworks asset={asset} />
      </dl>
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
  const cell = (value: string) => (loading ? <Skeleton shape="text" count={1} /> : value);
  return (
    <>
      <div data-testid="stat-high">
        <Term label={t('24h high')} rule={t('24h high rule')} />
        <dd data-testid="coin-stats__value">{cell(price(row?.high24h))}</dd>
      </div>
      <div data-testid="stat-low">
        <Term label={t('24h low')} rule={t('24h low rule')} />
        <dd data-testid="coin-stats__value">{cell(price(row?.low24h))}</dd>
      </div>
      <div data-testid="stat-volume">
        <Term label={t('24h volume', { asset })} rule={t('24h volume rule')} />
        <dd data-testid="coin-stats__value">{cell(row?.baseVolume24h ? fmtAmount(row.baseVolume24h, { places: 4 }) : '—')}</dd>
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
    <p className="lt-hint" data-testid="stat-young">
      {t('Younger than a day', { time: sinceLabel(partial, timeZone) })}
    </p>
  );
}

/**
 * The networks this coin moves on, as the platform's asset registry names them (svc-bank `assets.list`, J-portfolio-10
 * #3), then, for each network where the registry knows them, its contract and links. A network with neither shows no
 * row; nothing is guessed. A coin the registry does not list says so.
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
  const known = (row?.networks ?? []).filter((network) => network.contract !== null || network.links.length > 0);
  return (
    <>
      <div data-testid="coin-network">
        <Term label={t('Networks')} rule={t('Networks rule')} />
        <dd data-testid="coin-stats__value">
          {registry.resource.status === 'loading'
            ? '—'
            : registry.resource.status === 'failed'
              ? t('not read')
              : row === null || row.networks.length === 0
                ? t('not listed')
                : row.networks.map((network) => network.label).join(', ')}
        </dd>
      </div>
      {known.map((network) => (
        <div key={network.networkId} data-testid="coin-network-detail" data-network={network.networkId}>
          <Term label={t('On {network}', { network: network.label })} rule={t('Network detail rule')} />
          <dd data-testid="coin-stats__value">
            {network.contract !== null ? (
              <span
                className="lt-mono lt-wrap"
                data-testid="coin-contract"
                aria-label={t('Contract on {network}', { network: network.label })}
              >
                {network.contract}
              </span>
            ) : null}
            {network.links.map((link) => (
              <a key={link.url} className="lt-link" data-testid="coin-link" href={link.url} target="_blank" rel="noopener noreferrer">
                {link.label}
              </a>
            ))}
          </dd>
        </div>
      ))}
    </>
  );
}
