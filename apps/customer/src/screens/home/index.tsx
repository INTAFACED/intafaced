import { Fragment, Suspense, lazy, useMemo } from 'react';
import { ChevronRight, Eye, EyeOff } from 'lucide-react';
import './home.css';
import { clockTime } from './clock';
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
  Skeleton,
  StateBlock,
  useActivity,
  useFavorites,
  useMarkets,
  useMovers,
  moneyUnitOf,
  useHomePortfolio,
  DerivedTotalTag,
  useSparklines,
  useTickers,
  type Loadable,
  type HomePortfolio,
  type TickerRow,
  Loading,
} from './deps';
import { InfoTip } from './InfoTip';
import { IN_PANEL, STATE_IN_COLUMN } from './panel';
import { MarketsFailure, MarketsRow, MarketsSkeleton, MoversHeading, MoversRow, MoversSkeleton } from './MarketsSection';
import { YourCrypto, YourCryptoSkeleton } from './YourCrypto';
import { listings, topCards, topMovers } from './select';
import { Watchlist } from './Watchlist';
import { GetStarted } from './GetStarted';
import { LearnStrip } from './LearnStrip';
import { RecentActivity } from './RecentActivity';
import { WorkList } from './WorkList';
import { TotalFigure, TotalUnitNote } from './TotalFigure';
import { HOME_LINKS } from './links';
import { useStartedTile } from './started-data';
import { CustomiseHome } from './CustomiseHome';
import { LitSphere } from './LitSphere';
import { HomeNotices } from './Notices';
import { useHomeLayout } from './tiles-data';
import { shownTiles } from './tiles';
import { savePreferences, usePreferences } from '../../shared/preferences';
import { useSession } from '../../features/session/session';

// Pro Home carries Trade's client; Simple Home (the default) does not load it.
const HomePro = lazy(() => import('./HomePro').then((module) => ({ default: module.HomePro })));

/** Simple Home: Buy and Sell open the Buy card (Pro Home goes to the desk, `HomePro.tsx`). */
const ACTIONS = [
  { label: 'Add money', href: HOME_LINKS.deposit },
  { label: 'Buy', href: '/trade/buy' },
  { label: 'Sell', href: '/trade/buy?side=sell' },
  { label: 'Convert', href: '/trade/convert' },
  { label: 'Send', href: '/pay/send' },
  { label: 'Receive', href: '/pay/receive' },
] as const;

type ActionLabel = (typeof ACTIONS)[number]['label'];
/** Which pills make sense for the account: nothing to spend, nothing to trade, or a paused account. */
type ActionMode = 'normal' | 'empty' | 'noMarkets' | 'emptyNoMarkets' | 'refused';
const ACTIONS_FOR: Record<ActionMode, readonly ActionLabel[] | null> = {
  normal: null,
  empty: ['Add money', 'Receive', 'Buy'],
  noMarkets: ['Send', 'Receive'],
  emptyNoMarkets: ['Receive'],
  refused: ['Receive'],
};
/** Real pill widths, so the skeletons are the final size (critic M4). */
const PILL_WIDTH: Record<ActionLabel, number> = { 'Add money': 112, Buy: 64, Sell: 60, Convert: 88, Send: 72, Receive: 88 };

function ActionPills({ loading, mode }: { loading: boolean; mode: ActionMode }) {
  const { t } = homeCopy.useCopy();
  const wanted = ACTIONS_FOR[mode];
  // Add money leads the pills of an empty account; an account that holds money reaches Deposit from Money.
  const live = (
    wanted
      ? wanted.map((label) => ACTIONS.find((action) => action.label === label)!)
      : ACTIONS.filter((action) => action.label !== 'Add money')
  ).filter((action) => !isHiddenPath(action.href.split('?')[0]!));
  return (
    <nav data-testid="home-actions" className="home-actions" aria-label={t('Actions')}>
      {loading
        ? live.map((action) => <Skeleton key={action.label} width={PILL_WIDTH[action.label]} height={40} circle />)
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

function HoldingsCard({ portfolio, hidden }: { portfolio: HomePortfolio; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  const rows = [
    { id: 'cash', label: t('Cash'), glyph: '$', value: portfolio.cashUsd },
    { id: 'crypto', label: t('Crypto'), glyph: '₿', value: portfolio.cryptoUsd },
  ] as const;
  return (
    <section data-testid="home-holdings" className="home-holdings" aria-label={t('Your holdings')}>
      {rows.map((row) => (
        <a key={row.id} data-testid="home-holdings__row" className="home-holdings__row" href={`/money#${row.id}`}>
          <span className="home-holdings__glyph" aria-hidden="true">
            {row.glyph}
          </span>
          <span className="home-holdings__label">{row.label}</span>
          <Money data-testid="home-holdings__value" className="home-holdings__value" value={fmtUsd(row.value)} hidden={hidden} />
          <ChevronRight size={20} aria-hidden="true" className="home-holdings__chev" />
        </a>
      ))}
    </section>
  );
}

function HoldingsSkeleton() {
  return (
    <section data-testid="home-holdings" className="home-holdings" aria-hidden="true">
      {[0, 1].map((index) => (
        <div key={index} data-testid="home-holdings__row" className="home-holdings__row">
          <Skeleton width={32} height={32} circle className={IN_PANEL} />
          <span className="home-holdings__label">
            <Skeleton width={64} height={20} className={IN_PANEL} />
          </span>
          <Skeleton width={96} height={20} className={IN_PANEL} />
        </div>
      ))}
    </section>
  );
}

function Balance({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  const { timeZone, displayCurrency } = usePreferences();

  if (portfolio.status === 'loading')
    return (
      <div aria-busy="true" aria-label={t('Est. total value')}>
        <div data-testid="home-total" className="home-total">
          <Skeleton width={240} height={56} />
        </div>
        <div data-testid="home-change" className="home-change">
          <Skeleton width={180} height={20} />
        </div>
      </div>
    );

  if (portfolio.status === 'error')
    return (
      <StateBlock
        kind="error"
        className={STATE_IN_COLUMN}
        title={t('Couldn’t load your balance')}
        onRetry={portfolio.retry}
        retryLabel={t('Try again')}
      />
    );

  if (portfolio.status === 'refused') {
    // The raw service code never reaches the screen: only a short reference a customer can quote to support.
    const copy = refusalCopy(portfolio.code);
    return (
      <StateBlock
        kind="refused"
        className={STATE_IN_COLUMN}
        title={copy.title}
        body={copy.body}
        code={copy.reference}
        action={copy.action}
      />
    );
  }

  const empty = portfolio.status === 'empty' || portfolio.data.holdings.length === 0;
  if (empty)
    return (
      <>
        <div data-testid="home-total" className="home-total">
          {/* The balance call answered with no assets, so zero is correct here and only here. */}
          <HeroNumber value="0.00" decimals={2} prefix="$" hidden={hidden} />
        </div>
        <p data-testid="home-note" className="home-note home-note--lg">
          {t('No crypto yet')}
        </p>
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
  // A cash-only account has no price moves: "$0.00 (0.00%) Today" would say nothing (critic M9).
  const hasCrypto = (dec(data.cryptoUsd) ?? 0n) > 0n;
  return (
    <>
      <div data-testid="home-total" className="home-total">
        <TotalFigure data={data} displayCurrency={displayCurrency} hidden={hidden} pro={false} />
      </div>
      <TotalUnitNote data={data} displayCurrency={displayCurrency} hidden={hidden} className="home-note" testId="home-note" />
      {(data.change24hUsd !== null && hasCrypto) || data.source === 'derived' ? (
        <p data-testid="home-change" className="home-change">
          {data.change24hUsd !== null && hasCrypto ? (
            <>
              <ChangeText value={fmtChangeLine(data.change24hUsd, data.change24hPct)} hidden={hidden} suffix={changeLabel} />
              {data.source === 'derived' ? <InfoTip text={t('Today change rule')} label={t('Today change rule label')} /> : null}
            </>
          ) : null}
          <DerivedTotalTag source={data.source} className="home-change__tag" />
        </p>
      ) : null}
      {unpriced > 0 ? (
        <p data-testid="home-unpriced-note" className="home-note">
          {unpriced === 1 ? t('Asset not counted') : t('Assets not counted', { count: unpriced })}
          <InfoTip text={t('Not counted list', { assets: data.unpriced.join(', ') })} label={t('Not counted label')} />
        </p>
      ) : null}
    </>
  );
}

/** Simple Home (UI-SPEC 5.1). Pro mode draws `HomePro` instead; see `Home` below. */
function HomeSimple() {
  const { t } = homeCopy.useCopy();
  const { hideBalances, timeZone, displayCurrency } = usePreferences();
  const portfolio = useHomePortfolio(moneyUnitOf(displayCurrency));
  const markets = useMarkets();
  const tickers = useTickers();
  const movers = useMovers(6);
  const { userId } = useSession();
  const activity = useActivity();
  const { favorites, isFavorite, toggle } = useFavorites(userId);
  const favoriting = useMemo(() => ({ isFavorite, toggle }), [isFavorite, toggle]);

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
  const cardSymbols = useMemo(() => new Set(cards.map((card) => card.symbol)), [cards]);
  // Popular skips the coins already shown as Markets cards, so a short market list is not repeated (critic N3).
  const watchItems = popular ? all.filter((item) => !cardSymbols.has(item.symbol)).slice(0, 8) : favoriteItems;
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
  // With four markets or fewer the movers are the cards again, so the section would only repeat them (critic M1).
  const showMovers = showMarkets && (marketsLoading || (all.length > 4 && moverItems.length > 0));

  const accountEmpty = portfolio.status === 'empty' || (portfolio.status === 'ready' && portfolio.data.holdings.length === 0);
  const actionMode: ActionMode =
    portfolio.status === 'refused'
      ? 'refused'
      : accountEmpty
        ? noMarkets
          ? 'emptyNoMarkets'
          : 'empty'
        : noMarkets && portfolio.status === 'ready'
          ? 'noMarkets'
          : 'normal';
  const pricesAsOf = tickers.status === 'ready' ? tickers.asOf : null;

  const home = useHomeLayout();
  const main = shownTiles(home.layout, 'simple', 'main');
  const side = shownTiles(home.layout, 'simple', 'side');
  const started = useStartedTile(portfolio, side.includes('started'));

  return (
    <div data-testid="if-home" className="if-home">
      <h1 className="if-sr">{t('Home')}</h1>
      <HomeNotices />
      <div className="home-grid">
        <div data-testid="home-main" className="home-main">
          <div data-testid="home-label" className="home-label">
            <span>{t('Est. total value')}</span>
            <button
              type="button"
              className="home-eye"
              onClick={() => savePreferences({ hideBalances: !hideBalances })}
              aria-label={hideBalances ? t('Show balances') : t('Hide balances')}
            >
              {hideBalances ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
            </button>
            <InfoTip text={t('Total value rule')} label={t('How the total is worked out')} side="right" />
            {isHiddenPath('/money') ? null : (
              <a className="home-tile-link" href="/money">
                {t('Assets')}
                <ChevronRight size={14} aria-hidden="true" />
              </a>
            )}
            <CustomiseHome home={home} mode="simple" />
          </div>

          <Balance portfolio={portfolio} hidden={hideBalances} />
          <ActionPills loading={portfolio.status === 'loading'} mode={actionMode} />
          {main.map((id) => {
            switch (id) {
              case 'work':
                return <WorkList key={id} hidden={hideBalances} />;
              case 'holdings':
                return portfolio.status === 'loading' ? (
                  // the sphere's section keeps its place while the holdings load (no split, no figures), so it doesn't
                  // arrive late and push the rows below it down
                  <Fragment key={id}>
                    <LitSphere portfolio={portfolio} hidden={hideBalances} />
                    <HoldingsSkeleton />
                  </Fragment>
                ) : portfolio.status === 'ready' && portfolio.data.holdings.length > 0 ? (
                  <Fragment key={id}>
                    <LitSphere portfolio={portfolio} hidden={hideBalances} />
                    <HoldingsCard portfolio={portfolio.data} hidden={hideBalances} />
                  </Fragment>
                ) : null;
              case 'markets':
                return showMarkets ? (
                  <section key={id} className="home-section" aria-labelledby="home-markets-title">
                    <div className="home-section__head">
                      <h2 className="home-h2" id="home-markets-title">
                        {t('Markets')}
                      </h2>
                      {pricesAsOf !== null ? (
                        <p data-testid="home-fresh" className="home-fresh">
                          {t('Prices updated {time}', { time: clockTime(pricesAsOf, timeZone) })}
                        </p>
                      ) : null}
                    </div>
                    {marketsLoading ? (
                      <MarketsSkeleton count={all.length || 4} />
                    ) : marketsBroken ? (
                      <MarketsFailure retry={markets.status === 'error' ? markets.retry : undefined} />
                    ) : (
                      <MarketsRow cards={cards} tickers={tickers} sparklines={sparklines} favoriting={favoriting} />
                    )}
                  </section>
                ) : null;
              case 'movers':
                return showMovers ? (
                  <section key={id} className="home-section home-section--movers">
                    <MoversHeading />
                    {marketsLoading || movers.status === 'loading' ? <MoversSkeleton /> : <MoversRow movers={moverItems} />}
                  </section>
                ) : null;
              case 'activity':
                return <RecentActivity key={id} activity={activity} hidden={hideBalances} />;
              case 'learn':
                return <LearnStrip key={id} />;
              default:
                return null;
            }
          })}
        </div>

        {started.show ? (
          <div className="home-started-slot">
            <GetStarted steps={started.steps} onHide={started.hide} />
          </div>
        ) : null}

        {showMarkets && !marketsBroken ? (
          <aside data-testid="home-side" className="home-side">
            {side.map((id) =>
              id === 'your-crypto' ? (
                portfolio.status === 'loading' ? (
                  <YourCryptoSkeleton key={id} />
                ) : portfolio.status === 'ready' || portfolio.status === 'empty' ? (
                  <YourCrypto key={id} holdings={portfolio.status === 'ready' ? portfolio.data.holdings : []} hidden={hideBalances} />
                ) : null
              ) : id === 'watchlist' && (marketsLoading || !popular || watchItems.length > 0) ? (
                <Watchlist
                  key={id}
                  items={watchItems}
                  popular={popular}
                  tickers={tickers}
                  sparklines={sparklines}
                  loading={marketsLoading}
                  favoriting={favoriting}
                />
              ) : null,
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** The layout preference decides which Home is drawn (UI-SPEC 3.3); a switch in the top bar flips it at once. */
export default function Home() {
  const { layoutMode } = usePreferences();
  return layoutMode === 'pro' ? (
    <Suspense fallback={<Loading />}>
      <HomePro />
    </Suspense>
  ) : (
    <HomeSimple />
  );
}
