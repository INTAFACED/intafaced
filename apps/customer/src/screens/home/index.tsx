// volt-room: /home
import { Suspense, lazy, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, ChevronRight, Eye, EyeOff, QrCode, Send, TrendingUp } from 'lucide-react';
import { ActionButton, ActionRow, Button, PageColumn, PageGrid, Surface } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { commandCopy } from './command-copy';
import { Allocation, ValueChart, ValueRanges, useValueRange } from './ValueChart';
import { HomeMarkets } from './HomeMarkets';
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
import { listings, topCards, topMovers } from './select';
import { GetStarted } from './GetStarted';
import { LearnStrip } from './LearnStrip';
import { RecentActivity } from './RecentActivity';
import { useRecentActivityLimit } from './recent-activity-limit';
import { StandingFigure, StandingScope, StandingSpendable, launchStanding, useLaunchVenue } from './HomeStanding';
import { WorkList } from './WorkList';
import { TotalFigure, TotalUnitNote } from './TotalFigure';
import { HOME_LINKS } from './links';
import { useStartedTile } from './started-data';
import type { NeedsYouShown } from './work-list';
import { CustomiseHome } from './CustomiseHome';
import { HomeNotices } from './Notices';
import { HomeInbox } from './HomeInbox';
import { useHomeLayout } from './tiles-data';
import { shownTiles, type HomeTileId } from './tiles';
import { savePreferences, usePreferences } from '../../shared/preferences';
import { TestBuildTag } from './TestBuildTag';
import { useSession } from '../../features/session/session';

// Pro Home carries Trade's client; Simple Home (the default) does not load it.
const HomePro = lazy(() => import('./HomePro').then((module) => ({ default: module.HomePro })));

/**
 * Simple Home's keys (the owner's Home A): Deposit leads as the one main key, then Withdraw, Convert and Trade. An empty
 * account gets what it can do first (Deposit, Receive, Buy); a paused account only Receive.
 */
const ACTIONS = [
  { label: 'Deposit', href: HOME_LINKS.deposit, icon: ArrowDownToLine },
  { label: 'Withdraw', href: '/uc/withdraw', icon: ArrowUpFromLine },
  { label: 'Convert', href: '/trade/convert', icon: ArrowLeftRight },
  { label: 'Trade', href: '/trade/buy', icon: TrendingUp },
  { label: 'Buy', href: '/trade/buy', icon: TrendingUp },
  { label: 'Send', href: '/pay/send', icon: Send },
  { label: 'Receive', href: '/pay/receive', icon: QrCode },
] as const;

type ActionLabel = (typeof ACTIONS)[number]['label'];
/** Which keys make sense for the account: nothing to spend, nothing to trade, or a paused account. */
type ActionMode = 'normal' | 'empty' | 'noMarkets' | 'emptyNoMarkets' | 'refused';
const ACTIONS_FOR: Record<ActionMode, readonly ActionLabel[]> = {
  normal: ['Deposit', 'Withdraw', 'Convert', 'Trade'],
  empty: ['Deposit', 'Receive', 'Buy'],
  noMarkets: ['Deposit', 'Withdraw', 'Send', 'Receive'],
  emptyNoMarkets: ['Deposit', 'Receive'],
  refused: ['Receive'],
};

function ActionKeys({ loading, mode }: { loading: boolean; mode: ActionMode }) {
  const { t } = commandCopy.useCopy();
  const live = ACTIONS_FOR[mode]
    .map((label) => ACTIONS.find((action) => action.label === label)!)
    .filter((action) => !isHiddenPath(action.href.split('?')[0]!));
  return (
    <nav data-testid="home-actions" aria-label={t('Trade')} data-count={live.length}>
      {loading ? (
        <Skeleton shape="keys" count={4} />
      ) : (
        <ActionRow>
          {live.map((action, index) => {
            const Icon = action.icon;
            return (
              <ActionButton
                key={action.label}
                icon={<Icon />}
                label={t(action.label)}
                primary={index === 0 && mode !== 'refused'}
                href={action.href}
              />
            );
          })}
        </ActionRow>
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
  const { hideBalances, displayCurrency } = usePreferences();
  const portfolio = useHomePortfolio(moneyUnitOf(displayCurrency));
  const markets = useMarkets();
  const tickers = useTickers();
  const movers = useMovers(6);
  const { userId } = useSession();
  const activity = useActivity();
  const activityLimit = useRecentActivityLimit();
  // The launch model (OWNER 226): with the user-venue door on, the total is where the person stands, as Assets shows it.
  const launch = launchStanding(useLaunchVenue(), portfolio);
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
  const cardSymbols = useMemo(() => new Set(cards.map((card) => card.symbol)), [cards]);
  // Popular skips the coins already shown as Markets cards, so a short market list is not repeated (critic N3).
  const watchItems = popular ? all.filter((item) => !cardSymbols.has(item.symbol)).slice(0, 8) : favoriteItems;
  // Popular on Home A's table: the busiest markets, cards included (the table replaces the cards).
  const popularRows = useMemo(() => topCards(all, tickerData, 8), [all, tickerData]);
  const sparkSymbols = useMemo(() => [...new Set([...popularRows, ...watchItems].map((item) => item.symbol))], [popularRows, watchItems]);
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

  const moverListings = useMemo(() => moverItems.flatMap((m) => all.filter((item) => item.base === m.base).slice(0, 1)), [moverItems, all]);
  // "No orderable markets": Markets, Top movers and Watchlist are omitted, not shown empty.
  const noMarkets = markets.status === 'empty' || (markets.status === 'ready' && all.length === 0);
  const marketsLoading = markets.status === 'loading';
  const marketsBroken = markets.status === 'error' || markets.status === 'refused';
  const showMarkets = !noMarkets;

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

  const home = useHomeLayout();
  const main = shownTiles(home.layout, 'simple', 'main');
  const side = shownTiles(home.layout, 'simple', 'side');
  const started = useStartedTile(side.includes('started'));
  // What "Needs you" shows, so the inbox row is never a notice it already carries.
  const [needsYou, setNeedsYou] = useState<NeedsYouShown | null>(null);
  const [range, setRange] = useValueRange();
  // The total, its label and the value over time: the panel Home A leads with. The eye, the rule and Assets stay beside
  // the label (J-home-ia-01).
  const hero = (
    <Surface className="hm-hero" data-testid="home-hero">
      <div className="hm-hero-top">
        <div className="hm-hero-figure">
          <div data-testid="home-label" className="hm-label">
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
              <a className="hm-link" href="/money">
                {t('Assets')}
                <ChevronRight size={14} aria-hidden="true" />
              </a>
            )}
          </div>
          {launch ? <StandingFigure hidden={hideBalances} /> : <Balance portfolio={portfolio} hidden={hideBalances} />}
        </div>
        {portfolio.status === 'refused' ? null : <ValueRanges range={range} onRange={setRange} />}
      </div>
      {portfolio.status === 'refused' ? null : <ValueChart range={range} />}
      {portfolio.status === 'ready' && !launch ? <Allocation holdings={portfolio.data.holdings} hidden={hideBalances} /> : null}
      <ActionKeys loading={portfolio.status === 'loading'} mode={actionMode} />
    </Surface>
  );

  const marketsPanel = showMarkets ? (
    <HomeMarkets
      watch={popular ? popularRows : favoriteItems}
      popular={popular}
      movers={moverListings}
      tickers={tickers}
      sparklines={sparklines}
      loading={marketsLoading}
      broken={marketsBroken}
      retry={markets.status === 'error' ? markets.retry : undefined}
    />
  ) : null;

  const tile = (id: HomeTileId) => {
    switch (id) {
      case 'work':
        return (
          <Surface key={id} className="hm-side-panel">
            <WorkList hidden={hideBalances} onShown={setNeedsYou} />
          </Surface>
        );
      case 'activity':
        return (
          <Surface key={id} className="hm-side-panel">
            <RecentActivity activity={activity} limit={activityLimit} hidden={hideBalances} />
          </Surface>
        );
      case 'started':
        return started.show ? (
          <Surface key={id} className="hm-side-panel hm-next">
            <GetStarted steps={started.steps} onHide={started.hide} />
          </Surface>
        ) : null;
      case 'learn':
        // Learn opens the Academy; a build that hides the Academy (the beta) shows no Learn.
        return isHiddenPath(HOME_LINKS.academy) ? null : (
          <Surface key={id} className="hm-side-panel">
            <LearnStrip />
          </Surface>
        );
      default:
        return null;
    }
  };
  // The side column, in the person's order: the next step, what needs them, what happened, then the rest.
  const shown = new Set<HomeTileId>([...main, ...side]);
  const SIDE: readonly HomeTileId[] = ['started', 'work', 'activity', 'learn'];
  const sideTiles = SIDE.filter((id) => shown.has(id));

  return (
    <StandingScope status={launch}>
      <div data-testid="if-home" className="hm">
        <PageGrid layout="split">
          <PageColumn span="all" className="hm-band">
            <HomeNotices />
            <HomeInbox needsYou={needsYou} />
          </PageColumn>
          <PageColumn className="hm-main">
            {hero}
            {shown.has('markets') ? marketsPanel : null}
          </PageColumn>
          <PageColumn className="hm-side" data-testid="home-side">
            {/* Where the person stands, spendable today, beside the total (J-bank-31). */}
            <StandingSpendable hidden={hideBalances} panel="hm-side-panel" />
            {sideTiles.map(tile)}
            <div className="hm-room-action">
              <CustomiseHome home={home} mode="simple" />
            </div>
          </PageColumn>
        </PageGrid>
      </div>
    </StandingScope>
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
