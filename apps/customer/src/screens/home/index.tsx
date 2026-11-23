// volt-room: /home
import { Suspense, lazy, useMemo, useState } from 'react';
import { ChevronRight, Eye, EyeOff } from 'lucide-react';
import { Button } from '@intafaced/ui/lit';
import { OverviewTemplate, Skeleton } from '@intafaced/ui/lit/templates';
import { clockTime } from './clock';
import { homeCopy } from './copy';
import {
  dec,
  fmtChangeLine,
  isHiddenPath,
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
} from './deps';
import { InfoTip } from './InfoTip';
import { balanceRefusal } from './balance-refusal';
import { ChangeText, HeroFigure, StateBlock } from './volt-parts';
import { MarketsFailure, MarketsRow, MarketsSkeleton, MoversHeading, MoversRow, MoversSkeleton } from './MarketsSection';
import { YourCrypto, YourCryptoSkeleton } from './YourCrypto';
import { listings, topCards, topMovers } from './select';
import { Watchlist } from './Watchlist';
import { GetStarted } from './GetStarted';
import { LearnStrip } from './LearnStrip';
import { RecentActivity } from './RecentActivity';
import { useRecentActivityLimit } from './recent-activity-limit';
import { HomeStanding, launchStanding, useLaunchVenue } from './HomeStanding';
import { WorkList } from './WorkList';
import { TotalFigure, TotalUnitNote } from './TotalFigure';
import { HOME_LINKS } from './links';
import { useStartedTile } from './started-data';
import type { NeedsYouShown } from './work-list';
import { CustomiseHome } from './CustomiseHome';
import { VoltStack } from './VoltStack';
import { HomeNotices } from './Notices';
import { HomeInbox } from './HomeInbox';
import { useHomeLayout } from './tiles-data';
import { shownTiles } from './tiles';
import { savePreferences, usePreferences } from '../../shared/preferences';
import { TestBuildTag } from './TestBuildTag';
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

function ActionPills({ loading, mode }: { loading: boolean; mode: ActionMode }) {
  const { t } = homeCopy.useCopy();
  const wanted = ACTIONS_FOR[mode];
  // Add money leads the pills of an empty account; an account that holds money reaches Deposit from Money.
  const live = (
    wanted
      ? wanted.map((label) => ACTIONS.find((action) => action.label === label)!)
      : ACTIONS.filter((action) => action.label !== 'Add money')
  ).filter((action) => !isHiddenPath(action.href.split('?')[0]!));
  // While loading, the keys' placeholder row is the whole tray, not one more key beside the others.
  const tray = loading ? undefined : 'lt-actions';
  return (
    <nav data-testid="home-actions" className={tray} aria-label={t('Actions')}>
      {loading ? (
        <Skeleton shape="keys" count={live.length} />
      ) : (
        live.map((action, index) => {
          // The first action is the one main key.
          const look = index === 0 ? 'lt-button lt-button-primary' : 'lt-button lt-button-secondary';
          return (
            <a key={action.label} className={look} href={action.href}>
              {t(action.label)}
            </a>
          );
        })
      )}
    </nav>
  );
}

function Balance({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  const { timeZone, displayCurrency } = usePreferences();

  if (portfolio.status === 'loading')
    return (
      <div aria-busy="true" aria-label={t('Est. total value')}>
        <div data-testid="home-total">
          <Skeleton shape="figure" />
        </div>
        <div data-testid="home-change">
          <Skeleton shape="text" count={1} />
        </div>
      </div>
    );

  if (portfolio.status === 'error')
    return <StateBlock kind="error" title={t('Couldn’t load your balance')} onRetry={portfolio.retry} retryLabel={t('Try again')} />;

  if (portfolio.status === 'refused') {
    // The raw service code never reaches the screen: only a short reference a customer can quote to support.
    const copy = balanceRefusal(portfolio.code);
    return <StateBlock kind="refused" title={copy.title} body={copy.body} code={copy.reference} action={copy.action} />;
  }

  const empty = portfolio.status === 'empty' || portfolio.data.holdings.length === 0;
  if (empty)
    return (
      <>
        <div data-testid="home-total">
          {/* The balance call answered with no assets, so zero is correct here and only here. */}
          <HeroFigure value="0.00" decimals={2} prefix="$" hidden={hidden} />
        </div>
        <p data-testid="home-note" className="lt-hint">
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
      <div data-testid="home-total" className="lt-actions">
        <TotalFigure data={data} displayCurrency={displayCurrency} hidden={hidden} pro={false} />
        <TestBuildTag />
      </div>
      <TotalUnitNote data={data} displayCurrency={displayCurrency} hidden={hidden} className="lt-hint" testId="home-note" />
      {(data.change24hUsd !== null && hasCrypto) || data.source === 'derived' ? (
        <p data-testid="home-change">
          {data.change24hUsd !== null && hasCrypto ? (
            <>
              <ChangeText value={fmtChangeLine(data.change24hUsd, data.change24hPct)} hidden={hidden} suffix={changeLabel} />
              {data.source === 'derived' ? <InfoTip text={t('Today change rule')} label={t('Today change rule label')} /> : null}
            </>
          ) : null}
          <DerivedTotalTag source={data.source} className="lt-hint" />
        </p>
      ) : null}
      {unpriced > 0 ? (
        <p data-testid="home-unpriced-note" className="lt-hint">
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
  const activityLimit = useRecentActivityLimit();
  // The launch model (OWNER 226): with the user-venue door on, the total is where the person stands, as Assets shows it.
  const launch = launchStanding(useLaunchVenue(), portfolio);
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
  // What "Needs you" shows, so the inbox row is never a notice it already carries.
  const [needsYou, setNeedsYou] = useState<NeedsYouShown | null>(null);
  // The total and its label: the template's hero, one stack the template keeps at one height (heroReserve). The actions
  // are its own region.
  const hero = (
    <div className="lt-stack">
      <div data-testid="home-label" className="lt-actions">
        <span>{t('Est. total value')}</span>
        <Button
          tone="quiet"
          onClick={() => savePreferences({ hideBalances: !hideBalances })}
          aria-label={hideBalances ? t('Show balances') : t('Hide balances')}
        >
          {hideBalances ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </Button>
        <InfoTip text={t('Total value rule')} label={t('How the total is worked out')} side="right" />
        {isHiddenPath('/money') ? null : (
          <a className="lt-link" href="/money">
            {t('Assets')}
            <ChevronRight size={14} aria-hidden="true" />
          </a>
        )}
      </div>
      {launch ? <HomeStanding status={launch} hidden={hideBalances} /> : <Balance portfolio={portfolio} hidden={hideBalances} />}
    </div>
  );

  const tile = (id: (typeof main)[number]) => {
    switch (id) {
      case 'work':
        return <WorkList key={id} hidden={hideBalances} onShown={setNeedsYou} />;
      case 'holdings':
        // Volt draws the holdings as its card stack. On the launch model the holdings are the parts of the
        // total above, each read from its own source.
        return launch ? null : <VoltStack key={id} portfolio={portfolio} hidden={hideBalances} />;
      case 'markets':
        return showMarkets ? (
          <section key={id} className="lt-stack" aria-labelledby="home-markets-title">
            <div className="lt-title-row">
              <h2 id="home-markets-title">{t('Markets')}</h2>
              {pricesAsOf !== null ? (
                <p data-testid="home-fresh" className="lt-hint">
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
          <section key={id} className="lt-stack">
            <MoversHeading />
            {marketsLoading || movers.status === 'loading' ? <MoversSkeleton /> : <MoversRow movers={moverItems} />}
          </section>
        ) : null;
      case 'activity':
        return <RecentActivity key={id} activity={activity} limit={activityLimit} hidden={hideBalances} />;
      case 'learn':
        return <LearnStrip key={id} />;
      default:
        return null;
    }
  };
  // "Needs you" takes the template's own region when it leads the person's order; otherwise every tile keeps its place
  // in the order they chose, under the actions.
  const lead = main[0] === 'work' ? main[0] : null;
  const rest = lead ? main.slice(1) : main;
  const showSide = showMarkets && !marketsBroken;
  const watching =
    started.show || showSide ? (
      <>
        {started.show ? <GetStarted steps={started.steps} onHide={started.hide} /> : null}
        {showSide ? (
          <aside data-testid="home-side" className="lt-stack">
            {side.map((id) =>
              id === 'your-crypto' ? (
                launch ? null : portfolio.status === 'loading' ? (
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
      </>
    ) : undefined;

  return (
    <div data-testid="if-home">
      <OverviewTemplate
        title={t('Home')}
        state={{ kind: 'ready' }}
        mode="simple"
        roomAction={<CustomiseHome home={home} mode="simple" />}
        rooms={
          <>
            <HomeNotices />
            <HomeInbox needsYou={needsYou} />
          </>
        }
        hero={hero}
        // The label row, the figure and two lines under it (a unit note and today's change): one height while loading
        // and once loaded, so nothing below moves when the balance arrives.
        heroReserve={2}
        actions={<ActionPills loading={portfolio.status === 'loading'} mode={actionMode} />}
        needsYou={lead ? tile(lead) : undefined}
        sections={
          rest.length > 0 ? (
            <div data-testid="home-main" className="lt-stack">
              {rest.map(tile)}
            </div>
          ) : undefined
        }
        watching={watching}
      />
    </div>
  );
}

/** The layout preference decides which Home is drawn (UI-SPEC 3.3); a switch in the top bar flips it at once. */
export default function Home() {
  const { layoutMode } = usePreferences();
  return layoutMode === 'pro' ? (
    <Suspense fallback={<Skeleton shape="rows" />}>
      <HomePro />
    </Suspense>
  ) : (
    <HomeSimple />
  );
}
