import { useMemo } from 'react';
import { ChevronRight, Eye, EyeOff } from 'lucide-react';
import './home.css';
import { homeCopy } from './copy';
import {
  Button,
  ChangeText,
  dec,
  fmtChangeLine,
  fmtUsd,
  HeroNumber,
  isHiddenPath,
  Money,
  refusalCopy,
  roundScaled,
  Skeleton,
  StateBlock,
  toFixedString,
  useFavorites,
  useMarkets,
  useMovers,
  usePortfolio,
  useSparklines,
  useTickers,
  type Loadable,
  type PortfolioSummary,
  type TickerRow,
} from './deps';
import { InfoTip } from './InfoTip';
import { MarketsFailure, MarketsRow, MarketsSkeleton, MoversHeading, MoversRow, MoversSkeleton } from './MarketsSection';
import { listings, topCards, topMovers } from './select';
import { Watchlist } from './Watchlist';
import { savePreferences, usePreferences } from '../../shared/preferences';
import { useSession } from '../../features/session/session';

const ACTIONS = [
  { label: 'Buy', href: '/trade/buy' },
  { label: 'Sell', href: '/trade/buy?side=sell' },
  { label: 'Convert', href: '/trade/convert' },
  { label: 'Send', href: '/pay/send' },
  { label: 'Receive', href: '/pay/receive' },
] as const;

/** A USD decimal rounded half-up to cents, as the string HeroNumber animates. Unknown stays null. */
function cents(value: string | null): string | null {
  const parsed = dec(value);
  return parsed === null ? null : toFixedString(roundScaled(parsed, 2), 2);
}

function clockTime(at: number, zone: 'UTC' | 'UTC+8' | 'device'): string {
  const timeZone = zone === 'UTC' ? 'UTC' : zone === 'UTC+8' ? 'Etc/GMT-8' : undefined;
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(at);
}

function ActionPills({ loading }: { loading: boolean }) {
  const { t } = homeCopy.useCopy();
  const live = ACTIONS.filter((action) => !isHiddenPath(action.href.split('?')[0]!));
  return (
    <nav className="home-actions" aria-label={t('Actions')}>
      {loading
        ? live.map((action) => <Skeleton key={action.label} width={action.label === 'Convert' ? 100 : 80} height={40} circle />)
        : live.map((action, index) => (
            <Button
              key={action.label}
              variant={index === 0 ? 'primary' : 'secondary'}
              size={40}
              nativeButton={false}
              render={<a href={action.href} />}
            >
              {t(action.label)}
            </Button>
          ))}
    </nav>
  );
}

function HoldingsCard({ portfolio, hidden }: { portfolio: PortfolioSummary; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  const rows = [
    { id: 'cash', label: t('Cash'), glyph: '$', value: portfolio.cashUsd },
    { id: 'crypto', label: t('Crypto'), glyph: '₿', value: portfolio.cryptoUsd },
  ] as const;
  return (
    <section className="home-holdings" aria-label={t('Your holdings')}>
      {rows.map((row) => (
        <a key={row.id} className="home-holdings__row" href={`/money#${row.id}`}>
          <span className="home-holdings__glyph" aria-hidden="true">
            {row.glyph}
          </span>
          <span className="home-holdings__label">{row.label}</span>
          <Money className="home-holdings__value" value={fmtUsd(row.value)} hidden={hidden} />
          <ChevronRight size={20} aria-hidden="true" className="home-holdings__chev" />
        </a>
      ))}
    </section>
  );
}

function HoldingsSkeleton() {
  return (
    <section className="home-holdings" aria-hidden="true">
      {[0, 1].map((index) => (
        <div key={index} className="home-holdings__row">
          <Skeleton width={32} height={32} circle />
          <span className="home-holdings__label">
            <Skeleton width={64} height={20} />
          </span>
          <Skeleton width={96} height={20} />
        </div>
      ))}
    </section>
  );
}

function Balance({ portfolio, hidden }: { portfolio: Loadable<PortfolioSummary>; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  const { timeZone } = usePreferences();

  if (portfolio.status === 'loading')
    return (
      <div aria-busy="true" aria-label={t('Est. total value')}>
        <div className="home-hero">
          <Skeleton width={240} height={56} />
        </div>
        <div className="home-change">
          <Skeleton width={180} height={20} />
        </div>
      </div>
    );

  if (portfolio.status === 'error')
    return <StateBlock kind="error" title={t('Couldn’t load your balance')} onRetry={portfolio.retry} retryLabel={t('Try again')} />;

  if (portfolio.status === 'refused') {
    const copy = refusalCopy(portfolio.code);
    return <StateBlock kind="refused" title={copy.title} body={copy.body} code={portfolio.code} action={copy.action} />;
  }

  const empty = portfolio.status === 'empty' || portfolio.data.holdings.length === 0;
  if (empty)
    return (
      <>
        <div className="home-hero">
          {/* The balance call answered with no assets, so zero is correct here and only here. */}
          <HeroNumber value="0.00" decimals={2} prefix="$" unit="USD" hidden={hidden} />
        </div>
        <p className="home-note home-note--lg">{t('No crypto yet')}</p>
      </>
    );

  const data = portfolio.data;
  const since = data.windowStart ?? null;
  const changeLabel =
    since !== null
      ? t('Since {time}', { time: clockTime(since, timeZone) })
      : data.source === 'derived'
        ? t('Today, from price moves')
        : t('Today');
  const unpriced = data.unpriced.length;
  return (
    <>
      <div className="home-hero">
        <HeroNumber value={cents(data.totalUsd)} decimals={2} prefix="$" unit="USD" hidden={hidden} />
      </div>
      {data.change24hUsd !== null ? (
        <p className="home-change">
          <ChangeText value={fmtChangeLine(data.change24hUsd, data.change24hPct)} hidden={hidden} suffix={changeLabel} />
          {data.source === 'derived' ? <InfoTip text={t('Today change rule')} label={t('Today change rule label')} /> : null}
        </p>
      ) : null}
      {unpriced > 0 ? (
        <p className="home-note">
          {unpriced === 1 ? t('Asset not counted') : t('Assets not counted', { count: unpriced })}
          <InfoTip text={t('Not counted list', { assets: data.unpriced.join(', ') })} label={t('Not counted label')} />
        </p>
      ) : null}
    </>
  );
}

export default function Home() {
  const { t } = homeCopy.useCopy();
  const { hideBalances } = usePreferences();
  const portfolio = usePortfolio();
  const markets = useMarkets();
  const tickers = useTickers();
  const movers = useMovers(6);
  const { userId } = useSession();
  const { favorites } = useFavorites(userId);

  const all = useMemo(() => (markets.status === 'ready' ? listings(markets.data) : []), [markets]);
  const tickerData = tickers.status === 'ready' ? tickers.data : undefined;
  const cards = useMemo(() => topCards(all, tickerData, 4), [all, tickerData]);
  const favoriteItems = useMemo(() => {
    if (markets.status !== 'ready') return [];
    const orderable = markets.data.filter((market) => market.orderable);
    return favorites.flatMap((symbol) => {
      const market = orderable.find((candidate) => candidate.symbol === symbol);
      return market ? [{ base: market.base, symbol: market.symbol, market }] : [];
    });
  }, [markets, favorites]);
  const popular = favoriteItems.length === 0;
  const watchItems = popular ? all.slice(0, 8) : favoriteItems;
  const sparkSymbols = useMemo(() => [...new Set([...cards, ...watchItems].map((item) => item.symbol))], [cards, watchItems]);
  const sparklines = useSparklines(sparkSymbols);

  const baseOf = useMemo(() => {
    const map = new Map(all.map((item) => [item.symbol, item.base]));
    if (markets.status === 'ready') for (const market of markets.data) if (!map.has(market.symbol)) map.set(market.symbol, market.base);
    return (symbol: string) => map.get(symbol) ?? null;
  }, [all, markets]);
  const moverItems = useMemo(
    () =>
      movers.status === 'ready' && markets.status === 'ready' ? topMovers([...movers.data.gainers, ...movers.data.losers], baseOf, 6) : [],
    [movers, markets, baseOf],
  );

  // "No orderable markets": Markets, Top movers and Watchlist are omitted, not shown empty.
  const noMarkets = markets.status === 'empty' || (markets.status === 'ready' && all.length === 0);
  const marketsLoading = markets.status === 'loading';
  const marketsBroken = markets.status === 'error' || markets.status === 'refused';
  const showMarkets = !noMarkets;

  return (
    <div className="if-home">
      <h1 className="if-sr">{t('Home')}</h1>
      <div className="home-grid">
        <div className="home-main">
          <div className="home-label">
            <span>{t('Est. total value')}</span>
            <button
              type="button"
              className="home-eye"
              onClick={() => savePreferences({ hideBalances: !hideBalances })}
              aria-label={hideBalances ? t('Show balances') : t('Hide balances')}
            >
              {hideBalances ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
            </button>
            <InfoTip text={t('Total value rule')} label={t('How the total is worked out')} />
          </div>

          <Balance portfolio={portfolio} hidden={hideBalances} />
          <ActionPills loading={portfolio.status === 'loading'} />
          {portfolio.status === 'loading' ? <HoldingsSkeleton /> : null}
          {portfolio.status === 'ready' && portfolio.data.holdings.length > 0 ? (
            <HoldingsCard portfolio={portfolio.data} hidden={hideBalances} />
          ) : null}

          {showMarkets ? (
            <section className="home-section" aria-labelledby="home-markets-title">
              <h2 className="home-h2" id="home-markets-title">
                {t('Markets')}
              </h2>
              {marketsLoading ? (
                <MarketsSkeleton />
              ) : marketsBroken ? (
                <MarketsFailure retry={markets.status === 'error' ? markets.retry : undefined} />
              ) : (
                <MarketsRow cards={cards} tickers={tickers} sparklines={sparklines} />
              )}
            </section>
          ) : null}

          {showMarkets && (marketsLoading || moverItems.length > 0) ? (
            <section className="home-section home-section--movers">
              <MoversHeading />
              {marketsLoading || movers.status === 'loading' ? <MoversSkeleton /> : <MoversRow movers={moverItems} />}
            </section>
          ) : null}
        </div>

        {showMarkets && !marketsBroken ? (
          <aside className="home-side">
            <Watchlist items={watchItems} popular={popular} tickers={tickers} sparklines={sparklines} loading={marketsLoading} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
