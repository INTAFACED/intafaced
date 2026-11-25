// volt-room: /home
import { Suspense, lazy, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, ChevronRight, Eye, EyeOff, QrCode, Send, TrendingUp } from 'lucide-react';
import { ActionButton, ActionRow, Button, Fold, PageColumn, PageGrid } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { commandCopy } from './command-copy';
import { standingCopy } from '../money/standing-copy';
import { ValueChart, ValueRanges, useValueRange } from './ValueChart';
import { AgentSection, LevelsSection, OpenPositions } from './HomeRail';
import { HomeMarkets } from './HomeMarkets';
import { clockTime } from './clock';
import { homeCopy } from './copy';
import {
  dec,
  fmtChangeLine,
  isHiddenPath,
  useActivity,
  useFavorites,
  useMarketCatalogue,
  useMovers,
  moneyUnitOf,
  useHomePortfolio,
  DerivedTotalTag,
  useSparklines,
  type Loadable,
  type HomePortfolio,
} from './deps';
import { balanceRefusal } from './balance-refusal';
import { ChangeText, HeroFigure, StateBlock } from './volt-parts';
import { listings, topCards, topMovers } from './select';
import { GetStarted, NextStepHead } from './GetStarted';
import { RecentActivity } from './RecentActivity';
import { useRecentActivityLimit } from './recent-activity-limit';
import { StandingFigure, StandingScope, StandingSpendable, launchStanding, useHomeStanding, useLaunchVenue } from './HomeStanding';
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
/** Movers where the catalogue is the venue's: none of ours stand in. */
const NO_MOVERS = { status: 'empty' } as const;

/** Which keys make sense for the account: nothing to spend, nothing to trade, or a paused account. */
type ActionMode = 'normal' | 'empty' | 'noMarkets' | 'emptyNoMarkets' | 'refused';
const ACTIONS_FOR: Record<ActionMode, readonly ActionLabel[]> = {
  normal: ['Deposit', 'Withdraw', 'Convert', 'Trade'],
  empty: ['Deposit', 'Receive', 'Buy'],
  noMarkets: ['Deposit', 'Withdraw', 'Send', 'Receive'],
  emptyNoMarkets: ['Deposit', 'Receive'],
  refused: ['Receive'],
};

function ActionKeys({ loading, mode, mainElsewhere = false }: { loading: boolean; mode: ActionMode; mainElsewhere?: boolean }) {
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
                primary={index === 0 && mode !== 'refused' && !mainElsewhere}
                href={action.href}
              />
            );
          })}
        </ActionRow>
      )}
    </nav>
  );
}

/** The one disclosure behind the info key beside the total: closed by default, its lines kept in the page. */

/** The rule the total follows, first inside "How this is worked out". */
function HowLead() {
  const { t } = homeCopy.useCopy();
  return <p className="lt-hint">{t('Total value rule')}</p>;
}

/** The door to Assets, on the figure's line (the family picture keeps the label row to the label and the eye). */
function AssetsLink() {
  const { t } = homeCopy.useCopy();
  if (isHiddenPath('/money')) return null;
  return (
    <a className="hm-link" href="/money">
      {t('Assets')}
      <ChevronRight size={14} aria-hidden="true" />
    </a>
  );
}

/**
 * Today's change in the launch model, the same valuation as the total, from price moves, with the door to Assets at
 * the line's end. With no total there is no change to tell: the line keeps only the door.
 */
function StandingChange({ hidden }: { hidden: boolean }) {
  const { t } = commandCopy.useCopy();
  const standing = useHomeStanding();
  const valuation = standing?.valuation ?? null;
  if (!standing || standing.totalUsd === null)
    return (
      <p className="hm-change">
        <AssetsLink />
      </p>
    );
  return (
    <p data-testid="home-change" className="hm-change">
      {!valuation || valuation.change24hUsd === null ? (
        <span className="lt-hint">{t('Change not known')}</span>
      ) : (
        <ChangeText value={fmtChangeLine(valuation.change24hUsd, valuation.change24hPct)} hidden={hidden} suffix={t('today')} />
      )}
      <AssetsLink />
    </p>
  );
}

function Balance({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const standing = standingCopy.useCopy();
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
        <p className="hm-change">
          <AssetsLink />
        </p>
        <Fold title={standing.t('Worked out')} data-testid="home-worked-out">
          <HowLead />
        </Fold>
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
      {data.change24hUsd !== null && hasCrypto ? (
        <p data-testid="home-change" className="hm-change">
          <ChangeText value={fmtChangeLine(data.change24hUsd, data.change24hPct)} hidden={hidden} suffix={changeLabel} />
          <AssetsLink />
        </p>
      ) : (
        <p className="hm-change">
          <AssetsLink />
        </p>
      )}
      <TotalUnitNote data={data} displayCurrency={displayCurrency} hidden={hidden} className="lt-hint" testId="home-note" />
      <Fold title={standing.t('Worked out')} data-testid="home-worked-out">
        <HowLead />
        {data.source === 'derived' ? (
          <p className="lt-hint">
            {t('Today change rule')} <DerivedTotalTag source={data.source} className="lt-hint" />
          </p>
        ) : null}
        {unpriced > 0 ? (
          <p data-testid="home-unpriced-note" className="lt-hint">
            {unpriced === 1 ? t('Asset not counted') : t('Assets not counted', { count: unpriced })}{' '}
            {t('Not counted list', { assets: data.unpriced.join(', ') })}
          </p>
        ) : null}
      </Fold>
    </>
  );
}

/** Simple Home (UI-SPEC 5.1): the owner's Home A as picked on 25 Nov 2026. Pro mode draws `HomePro` instead; see `Home` below. */
function HomeSimple() {
  const { t } = homeCopy.useCopy();
  const command = commandCopy.useCopy();
  const { hideBalances, displayCurrency } = usePreferences();
  const portfolio = useHomePortfolio(moneyUnitOf(displayCurrency));
  // The one markets catalogue, as Markets reads it: with the venue on, its markets at its prices.
  const { markets, tickers, source } = useMarketCatalogue();
  // Our own engine's movers rank our own book's markets, so they show only where the catalogue is ours.
  const ownMovers = useMovers(6);
  const movers = source === 'own' ? ownMovers : NO_MOVERS;
  const { userId } = useSession();
  const activity = useActivity();
  const activityLimit = useRecentActivityLimit();
  // The launch model: with the user-venue door on, the total is where the person stands, as Assets shows it.
  const launch = launchStanding(useLaunchVenue(), portfolio);
  const { favorites } = useFavorites(userId);

  const all = useMemo(() => (markets.status === 'ready' ? listings(markets.data) : []), [markets]);
  const tickerData = tickers.status === 'ready' ? tickers.data : undefined;
  const favoriteItems = useMemo(() => {
    if (markets.status !== 'ready') return [];
    const orderable = markets.data.filter((market) => market.orderable);
    return favorites.flatMap((symbol) => {
      const market = orderable.find((candidate) => candidate.symbol === symbol);
      return market ? [{ base: market.base, symbol: market.symbol, market }] : [];
    });
  }, [markets, favorites]);
  const popular = favoriteItems.length === 0;
  // Popular on Home A's table: the busiest markets.
  const popularRows = useMemo(() => topCards(all, tickerData, 8), [all, tickerData]);

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
  const startedOpen = side.includes('started') && started.show;
  // What "Needs you" shows, so the inbox row is never a notice it already carries.
  const [needsYou, setNeedsYou] = useState<NeedsYouShown | null>(null);
  const [range, setRange] = useValueRange();
  const shown = new Set<HomeTileId>([...main, ...side]);

  // The total, its label and the value over time, straight on the page (the family picture): the eye beside the label,
  // the range chips on the label's line, Assets on the figure's line, the chart right under the figure's lines and the
  // total's closed "How this is worked out" under the four keys (laid out in command.css; the fold stays in its place
  // in the page, inside the total it explains).
  const hero = (
    <section className="hm-hero" data-testid="home-hero" aria-label={command.t(launch ? 'Net worth wallet venue' : 'Net worth')}>
      <div className="hm-hero-top">
        {/* "home-label": the label, the figure and its line with Assets (J-home-ia-01's Assets link is read inside it). */}
        <div className="hm-hero-figure" data-testid="home-label">
          <div className="hm-label">
            <span>{command.t(launch ? 'Net worth wallet venue' : 'Net worth')}</span>
            <Button
              tone="quiet"
              onClick={() => savePreferences({ hideBalances: !hideBalances })}
              aria-label={hideBalances ? t('Show balances') : t('Hide balances')}
            >
              {hideBalances ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
            </Button>
          </div>
          {launch ? (
            <StandingFigure hidden={hideBalances} headline change={<StandingChange hidden={hideBalances} />} foldLead={<HowLead />} />
          ) : (
            <Balance portfolio={portfolio} hidden={hideBalances} />
          )}
        </div>
        {portfolio.status === 'refused' ? null : (
          <div className="hm-ranges">
            <ValueRanges range={range} onRange={setRange} />
          </div>
        )}
      </div>
      {portfolio.status === 'refused' ? null : <ValueChart range={range} hidden={hideBalances} />}
      <ActionKeys loading={portfolio.status === 'loading'} mode={actionMode} mainElsewhere={startedOpen} />
    </section>
  );

  const marketsPanel = showMarkets ? (
    <MarketsPanel
      watch={popular ? popularRows : favoriteItems}
      popular={popular}
      movers={moverListings}
      count={all.length}
      tickers={tickers}
      loading={marketsLoading}
      broken={marketsBroken}
      retry={markets.status === 'error' ? markets.retry : undefined}
    />
  ) : null;

  // Your next step heads the rail (the family picture): Get started's next open step, or, with none, its progress and
  // what needs the person.
  const nextStep =
    startedOpen || shown.has('work') ? (
      <section className="hm-rail-sec hm-next" data-testid="home-next" aria-label={command.t('Your next step')}>
        {startedOpen ? (
          <GetStarted steps={started.steps} onHide={started.hide} main />
        ) : (
          <NextStepHead steps={shown.has('started') ? started.steps : []} />
        )}
        {shown.has('work') ? <WorkList hidden={hideBalances} onShown={setNeedsYou} quietTitle /> : null}
      </section>
    ) : null;

  return (
    <StandingScope status={launch}>
      <div data-testid="if-home" className="hm">
        {/* The room's name for screen readers and the page outline: Home A draws no title row. */}
        <h1 data-sr-only="">{t('Home')}</h1>
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
            {nextStep}
            <OpenPositions hidden={hideBalances} />
            <AgentSection />
            <LevelsSection hidden={hideBalances} />
            {shown.has('activity') ? (
              <div className="hm-rail-sec">
                <RecentActivity activity={activity} limit={activityLimit} hidden={hideBalances} />
              </div>
            ) : null}
            {/* Spendable now, Locked in trades and Pay yourself (J-bank-31). */}
            <StandingSpendable hidden={hideBalances} panel="hm-rail-sec hm-spendable" fold />
            <div className="hm-rail-foot">
              <CustomiseHome home={home} mode="simple" />
            </div>
          </PageColumn>
        </PageGrid>
      </div>
    </StandingScope>
  );
}

/** The markets panel: the watchlist (or the busiest markets) and the biggest movers, each with its last day's line. */
function MarketsPanel({ watch, movers, ...rest }: Omit<Parameters<typeof HomeMarkets>[0], 'sparklines'>) {
  const symbols = useMemo(() => [...new Set([...watch, ...movers].map((item) => item.symbol))], [watch, movers]);
  const sparklines = useSparklines(symbols);
  return <HomeMarkets {...rest} watch={watch} movers={movers} sparklines={sparklines} />;
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
