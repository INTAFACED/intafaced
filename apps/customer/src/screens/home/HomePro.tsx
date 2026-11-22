import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Eye, EyeOff } from 'lucide-react';
import { AssetIcon, Button } from '@intafaced/ui/lit';
import { OverviewTemplate, SectionTabs, Skeleton } from '@intafaced/ui/lit/templates';
import { clockTime } from './clock';
import { assetName, homeCopy } from './copy';
import {
  dec,
  decOrNull,
  fmtAmount,
  fmtChangeLine,
  fmtPct,
  fmtUsd,
  isHiddenPath,
  ratio,
  refusalCopy,
  sub,
  useActivity,
  useFavorites,
  useMarkets,
  moneyUnitOf,
  useHomePortfolio,
  DerivedTotalTag,
  useSparklines,
  useTickers,
  type HomeHolding,
  type Loadable,
  type HomePortfolio,
} from './deps';
import { InfoTip } from './InfoTip';
import { TestBuildTag } from './TestBuildTag';
import { Amount, ChangeText, HeroFigure, Money, Pct, StateBlock } from './volt-parts';
import { proCopy } from './pro-copy';
import { MarketsTable } from '../trade/markets/MarketsTable';
import type { FavoriteControl } from '../trade/markets/MarketRow';
import { anyListed, entriesFor, visibleEntries, type Chip, type Sort, type Tab } from '../trade/markets/select';
import type { MarketData } from '../trade/markets/deps';
import { createTradeApi } from '../../features/trade/trade-api';
import { useSession } from '../../features/session/session';
import { normalizePair } from '../../app/navigation';
import { savePreferences, usePreferences } from '../../shared/preferences';
import { HOME_LINKS } from './links';
import { TotalFigure, TotalUnitNote } from './TotalFigure';
import { RecentActivity } from './RecentActivity';
import { useRecentActivityLimit } from './recent-activity-limit';
import { HomeStanding, launchStanding, useLaunchVenue } from './HomeStanding';
import type { VenueUp } from '../../features/trade/venue-api';
import { WorkList } from './WorkList';
import { GetStarted } from './GetStarted';
import { useStartedTile } from './started-data';
import type { NeedsYouShown } from './work-list';
import { CustomiseHome } from './CustomiseHome';
import { HomeNotices } from './Notices';
import { HomeInbox } from './HomeInbox';
import { useHomeLayout } from './tiles-data';
import { shownTiles } from './tiles';

/** How many markets and assets Home Pro lists before it points to the full screen. */
const MARKET_ROWS = 10;
const ASSET_ROWS = 8;
/** One request asks for this many open orders; a full page is shown as "100+". */
const ORDERS_PAGE = 100;
/** The pair the Trade button opens for an asset, as the desk's address. Cash (USDT, USDC) has no market to open. */
const deskFor = (holding: HomeHolding) => (holding.priceSymbol ? `/trade/spot/${normalizePair(holding.priceSymbol)}` : null);

type ActionLabel = 'Add money' | 'Buy' | 'Sell' | 'Convert' | 'Send' | 'Receive';
/** Same addresses as the Simple pills. Only the ones the registry shows are drawn. */
const ACTIONS: readonly { label: ActionLabel; href: string }[] = [
  { label: 'Add money', href: HOME_LINKS.deposit },
  { label: 'Buy', href: '/trade/spot/BTC-USDT' },
  { label: 'Sell', href: '/trade/spot/BTC-USDT?side=sell' },
  { label: 'Convert', href: '/trade/convert' },
  { label: 'Send', href: '/pay/send' },
  { label: 'Receive', href: '/pay/receive' },
];
type ActionMode = 'normal' | 'empty' | 'noMarkets' | 'emptyNoMarkets' | 'refused';
/** Which actions make sense for the account: nothing to spend, nothing to trade, or a paused account. */
const ACTIONS_FOR: Record<ActionMode, readonly ActionLabel[] | null> = {
  normal: null,
  empty: ['Add money', 'Receive', 'Buy'],
  noMarkets: ['Send', 'Receive'],
  emptyNoMarkets: ['Receive'],
  refused: ['Receive'],
};

/** Today's change of one holding as a ratio of what it was worth a day ago; unknown when either figure is. */
function changeRatio(holding: HomeHolding): string | null {
  const value = dec(holding.usdValue);
  const change = dec(holding.usdChange24h);
  if (value === null || change === null) return null;
  const before = sub(value, change);
  return before > 0n ? decOrNull(ratio(change, before)) : null;
}

type OpenOrders = { status: 'loading' } | { status: 'ready'; count: number } | { status: 'none' };

/**
 * How many orders are waiting on the market: one cheap read of the open orders. It is an extra on the summary, so
 * when it fails the cell is left out rather than showing an error the person cannot act on.
 */
function useOpenOrders(): OpenOrders {
  const { api, userId } = useSession();
  const [state, setState] = useState<OpenOrders>({ status: 'loading' });
  useEffect(() => {
    if (!userId) {
      setState({ status: 'none' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    void createTradeApi(api)
      .orders('open', undefined, ORDERS_PAGE, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setState(result.ok ? { status: 'ready', count: result.data.length } : { status: 'none' });
      });
    return () => controller.abort();
  }, [api, userId]);
  return state;
}

function ActionRow({ loading, mode }: { loading: boolean; mode: ActionMode }) {
  const { t } = homeCopy.useCopy();
  const { t: tp } = proCopy.useCopy();
  const wanted = ACTIONS_FOR[mode];
  const live = (
    wanted ? ACTIONS.filter((action) => wanted.includes(action.label)) : ACTIONS.filter((action) => action.label !== 'Add money')
  ).filter((action) => !isHiddenPath(action.href.split('?')[0]!));
  // The actions come in the order of the mode's list, as in Simple.
  const ordered = wanted ? [...live].sort((a, b) => wanted.indexOf(a.label) - wanted.indexOf(b.label)) : live;
  return (
    <nav data-testid="hp-actions" className="lt-actions" aria-label={tp('Quick actions')}>
      {loading ? (
        <Skeleton shape="keys" count={ordered.length} />
      ) : (
        ordered.map((action, index) => {
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

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="lt-lines">
      <span data-testid="hp-stat__label" className="lt-hint">
        {label}
      </span>
      <span data-testid="hp-stat__value" className="lt-figure">
        {children}
      </span>
    </div>
  );
}

function OrdersStat({ orders }: { orders: OpenOrders }) {
  const { t } = proCopy.useCopy();
  if (orders.status === 'none') return null;
  const target = isHiddenPath('/money/activity') ? null : '/money/activity?tab=orders';
  const label = t('Open orders');
  if (orders.status === 'loading')
    return (
      <Stat label={label}>
        <Skeleton shape="text" count={1} />
      </Stat>
    );
  const shown = orders.count >= ORDERS_PAGE ? `${ORDERS_PAGE}+` : String(orders.count);
  return (
    <Stat label={label}>
      {target ? (
        <a data-testid="hp-stat__link" className="lt-link" href={target} aria-label={t('Open orders count', { count: shown })}>
          {shown}
        </a>
      ) : (
        shown
      )}
    </Stat>
  );
}

/** The label row over the total: its words, the hide-balances key, the rule and the way to Assets. */
function TotalLabel({ hidden }: { hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  return (
    <div data-testid="hp-label" className="lt-actions">
      <span>{t('Est. total value')}</span>
      <Button
        tone="quiet"
        onClick={() => savePreferences({ hideBalances: !hidden })}
        aria-label={hidden ? t('Show balances') : t('Hide balances')}
      >
        {hidden ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </Button>
      <InfoTip text={t('Total value rule')} label={t('How the total is worked out')} side="right" />
      {isHiddenPath('/money') ? null : (
        <a className="lt-link" href="/money">
          {t('Assets')}
          <ChevronRight size={14} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

/** The summary: the total, today's change and its notes, or the refusal that stands where the total would be. */
function Summary({
  portfolio,
  hidden,
  launch,
}: {
  portfolio: Loadable<HomePortfolio>;
  hidden: boolean;
  /** The launch model (OWNER 226): with the user-venue door on, the total is where the person stands, as Assets shows it. */
  launch: VenueUp | null;
}) {
  const { t } = homeCopy.useCopy();
  const { t: tp } = proCopy.useCopy();
  const { timeZone, displayCurrency } = usePreferences();
  const label = <TotalLabel hidden={hidden} />;

  if (launch)
    return (
      <section data-testid="hp-summary" className="lt-stack" aria-label={tp('Home summary')}>
        {label}
        <div data-testid="hp-total__figure">
          <HomeStanding status={launch} hidden={hidden} pro />
        </div>
      </section>
    );

  if (portfolio.status === 'loading')
    return (
      <section data-testid="hp-summary" className="lt-stack" aria-busy="true" aria-label={tp('Home summary')}>
        {label}
        <div data-testid="hp-total__figure">
          <Skeleton shape="figure" />
        </div>
        <Skeleton shape="text" count={1} />
      </section>
    );

  if (portfolio.status === 'error' || portfolio.status === 'refused') {
    const refused = portfolio.status === 'refused' ? refusalCopy(portfolio.code) : null;
    return (
      <section data-testid="hp-summary" className="lt-stack" aria-label={tp('Home summary')}>
        {portfolio.status === 'error' ? (
          <StateBlock kind="error" title={t('Couldn’t load your balance')} onRetry={portfolio.retry} retryLabel={t('Try again')} />
        ) : (
          <StateBlock kind="refused" title={refused!.title} body={refused!.body} code={refused!.reference} action={refused!.action} />
        )}
      </section>
    );
  }

  const empty = portfolio.status === 'empty' || portfolio.data.holdings.length === 0;
  if (empty)
    return (
      <section data-testid="hp-summary" className="lt-stack" aria-label={tp('Home summary')}>
        {label}
        <div data-testid="hp-total__figure">
          {/* The balance call answered with no assets, so zero is correct here and only here. */}
          <HeroFigure value="0.00" decimals={2} prefix="$" unit="USD" hidden={hidden} />
        </div>
        <p data-testid="hp-total__note" className="lt-hint">
          {t('No crypto yet')}
        </p>
      </section>
    );

  const data = portfolio.data;
  const since = data.windowStart ?? null;
  const changeLabel =
    since !== null
      ? t('Since {time}', { time: clockTime(since, timeZone) })
      : data.source === 'derived'
        ? t('Today, from price moves')
        : t('Today');
  const hasCrypto = (dec(data.cryptoUsd) ?? 0n) > 0n;
  const unpriced = data.unpriced.length;
  return (
    <section data-testid="hp-summary" className="lt-stack" aria-label={tp('Home summary')}>
      {label}
      <div data-testid="hp-total__figure" className="lt-actions">
        <TotalFigure data={data} displayCurrency={displayCurrency} hidden={hidden} pro />
        <TestBuildTag />
      </div>
      <TotalUnitNote data={data} displayCurrency={displayCurrency} hidden={hidden} className="lt-hint" testId="hp-total__note" />
      <div className="lt-actions">
        {data.change24hUsd !== null && hasCrypto ? (
          <>
            <ChangeText value={fmtChangeLine(data.change24hUsd, data.change24hPct)} hidden={hidden} suffix={changeLabel} />
            {data.source === 'derived' ? <InfoTip text={t('Today change rule')} label={t('Today change rule label')} /> : null}
          </>
        ) : null}
        {unpriced > 0 ? (
          <span data-testid="hp-total__note" className="lt-hint">
            {unpriced === 1 ? t('Asset not counted') : t('Assets not counted', { count: unpriced })}
            <InfoTip text={t('Not counted list', { assets: data.unpriced.join(', ') })} label={t('Not counted label')} />
          </span>
        ) : null}
        <DerivedTotalTag source={data.source} className="lt-hint" />
      </div>
    </section>
  );
}

/** Pro's figures beside the total: cash, crypto and the orders waiting on the market. */
function ProStats({ portfolio, orders, hidden }: { portfolio: Loadable<HomePortfolio>; orders: OpenOrders; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  if (portfolio.status === 'loading')
    return (
      <div className="lt-actions" aria-hidden="true">
        <Skeleton shape="text" count={2} />
      </div>
    );
  if (portfolio.status !== 'ready' || portfolio.data.holdings.length === 0) return null;
  const data = portfolio.data;
  return (
    <div className="lt-actions">
      <Stat label={t('Cash')}>
        <Money value={fmtUsd(data.cashUsd)} hidden={hidden} />
      </Stat>
      <Stat label={t('Crypto')}>
        <Money value={fmtUsd(data.cryptoUsd)} hidden={hidden} />
      </Stat>
      <OrdersStat orders={orders} />
    </div>
  );
}

function Assets({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const copy = homeCopy.useCopy();
  const { t: tp } = proCopy.useCopy();
  const holdings = portfolio.status === 'ready' ? portfolio.data.holdings : [];
  const rows = holdings.slice(0, ASSET_ROWS);
  const head = [tp('Asset'), tp('Amount'), tp('Value'), tp('Today')];
  return (
    <section data-testid="hp-assets-panel" className="lt-stack" aria-labelledby="hp-assets-title">
      <div className="lt-title-row">
        <h2 id="hp-assets-title">{tp('Your assets')}</h2>
        <a data-testid="hp-link" className="lt-link" href="/money">
          {tp('View all assets')}
        </a>
      </div>
      {portfolio.status === 'loading' ? (
        <div data-testid="hp-assets" aria-busy="true" aria-label={tp('Your assets')}>
          <div data-testid="hp-assets__row">
            <Skeleton shape="rows" count={3} />
          </div>
        </div>
      ) : (
        <table data-testid="hp-assets" className="lt-table" aria-label={tp('Your assets')}>
          <thead>
            <tr data-testid="hp-assets__row--head">
              {head.map((words) => (
                <th key={words} scope="col">
                  {words}
                </th>
              ))}
              <th scope="col">
                <span className="lt-sr">{tp('Trade')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((holding) => {
              const name = assetName(holding.asset, copy);
              const pct = changeRatio(holding);
              const desk = deskFor(holding);
              const target = desk && !isHiddenPath(desk.split('?')[0]!) ? desk : null;
              const assetLabel = (
                <>
                  <AssetIcon asset={holding.asset} />
                  <span>{holding.asset}</span>
                  {name ? <span className="lt-hint">{name}</span> : null}
                </>
              );
              return (
                <tr data-testid="hp-assets__row" key={holding.asset} data-asset={holding.asset}>
                  <td data-label={head[0]}>
                    {/* The desk for coins with a market; cash has none, so no link (the coin page is M3). */}
                    {target ? (
                      <a className="lt-row-link" href={target}>
                        {assetLabel}
                      </a>
                    ) : (
                      <span className="lt-actions">{assetLabel}</span>
                    )}
                  </td>
                  <td data-label={head[1]} data-align="end">
                    <Amount value={fmtAmount(holding.total, { round: 'down' })} hidden={hidden} />
                  </td>
                  <td data-label={head[2]} data-align="end">
                    <Money value={holding.usdValue === null ? null : fmtUsd(holding.usdValue)} hidden={hidden} />
                  </td>
                  <td data-label={head[3]} data-align="end">
                    {/* Cash has no price move: "—", as on Money (critic L7). */}
                    <Pct value={holding.class === 'cash' || pct === null ? null : fmtPct(pct)} />
                  </td>
                  <td data-align="end">
                    {target ? (
                      <a className="lt-button lt-button-secondary" href={target} aria-label={tp('Trade {asset}', { asset: holding.asset })}>
                        {tp('Trade')}
                      </a>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

type MarketTab = 'favorites' | 'all' | 'gainers' | 'losers' | 'new';
const FILTER: Record<MarketTab, { tab: Tab; chip: Chip }> = {
  favorites: { tab: 'favorites', chip: 'all' },
  all: { tab: 'spot', chip: 'all' },
  gainers: { tab: 'spot', chip: 'gainers' },
  losers: { tab: 'spot', chip: 'losers' },
  new: { tab: 'spot', chip: 'new' },
};

function MarketsPanel() {
  const { t } = proCopy.useCopy();
  const { t: th } = homeCopy.useCopy();
  const { timeZone } = usePreferences();
  const { userId } = useSession();
  const { favorites, isFavorite, toggle } = useFavorites(userId);
  const markets = useMarkets();
  const tickers = useTickers();
  const [tab, setTab] = useState<MarketTab>('all');
  const [sort, setSort] = useState<Sort | null>(null);
  const [onScreen, setOnScreen] = useState<readonly string[]>([]);
  const sparklines = useSparklines(onScreen);

  const tickerMap = tickers.status === 'ready' ? tickers.data : undefined;
  const entries = useMemo(() => (markets.status === 'ready' ? entriesFor(markets.data, tickerMap) : []), [markets, tickerMap]);
  const showNew = useMemo(() => anyListed(entries), [entries]);
  const rows = useMemo(() => {
    const { tab: kind, chip } = FILTER[tab];
    return visibleEntries(entries, { tab: kind, chip, quote: null, query: '', sort, favorites }).slice(0, MARKET_ROWS);
  }, [entries, tab, sort, favorites]);

  const signedIn = userId != null;
  const signIn = `/login?redirect=${encodeURIComponent('/home')}`;
  const favorite = (market: MarketData): FavoriteControl =>
    signedIn ? { on: isFavorite(market.symbol), onToggle: () => toggle(market.symbol) } : { signInHref: signIn };

  const loading = markets.status === 'loading' || (markets.status === 'ready' && tickers.status === 'loading');
  // No orderable markets: the section is left out, not shown empty (as in Simple).
  if (markets.status === 'empty' || (markets.status === 'ready' && entries.length === 0)) return null;

  const asOf = tickers.status === 'ready' ? tickers.asOf : null;
  const emptyRows = (() => {
    if (tab === 'favorites')
      return signedIn ? (
        <StateBlock
          kind="empty"
          title={t('Star a market to keep it here.')}
          action={{ label: t('Browse markets'), onClick: () => setTab('all') }}
        />
      ) : (
        <StateBlock kind="empty" title={t('Log in to keep your favorites here.')} action={{ label: t('Log in'), href: signIn }} />
      );
    if (tab === 'gainers') return <StateBlock kind="empty" title={t('Nothing is gaining right now.')} />;
    if (tab === 'losers') return <StateBlock kind="empty" title={t('Nothing is falling right now.')} />;
    if (tab === 'new') return <StateBlock kind="empty" title={t('No new listings.')} />;
    return <StateBlock kind="empty" title={t('No markets are open right now.')} />;
  })();

  const tabs: readonly { value: MarketTab; label: string }[] = [
    { value: 'favorites', label: t('Favorites') },
    { value: 'all', label: t('All') },
    { value: 'gainers', label: t('Gainers') },
    { value: 'losers', label: t('Losers') },
    ...(showNew ? [{ value: 'new' as const, label: t('New') }] : []),
  ];

  return (
    <section data-testid="hp-markets" className="lt-stack" aria-labelledby="hp-markets-title">
      <div className="lt-title-row">
        <h2 id="hp-markets-title">{t('Markets')}</h2>
        <div className="lt-actions">
          {asOf !== null ? <span className="lt-hint">{th('Prices updated {time}', { time: clockTime(asOf, timeZone) })}</span> : null}
          <a data-testid="hp-link" className="lt-link" href="/trade">
            {t('See all markets')}
          </a>
        </div>
      </div>
      {markets.status === 'error' ? (
        <StateBlock kind="error" title={t('Couldn’t load markets')} onRetry={markets.retry} retryLabel={t('Try again')} />
      ) : markets.status === 'refused' ? (
        (() => {
          const refused = refusalCopy(markets.code);
          return <StateBlock kind="refused" title={refused.title} body={refused.body} code={refused.reference} action={refused.action} />;
        })()
      ) : (
        <>
          <SectionTabs items={tabs} value={tab} onChange={setTab} label={t('Market filters')} />
          {tickers.status === 'error' ? (
            <div className="lt-held" role="status">
              <span>{t('Couldn’t load prices')}</span>{' '}
              <Button tone="quiet" onClick={tickers.retry}>
                {t('Try again')}
              </Button>
            </div>
          ) : null}
          <MarketsTable
            label={t('Markets')}
            entries={rows}
            sparklines={sparklines.status === 'ready' ? sparklines.data : undefined}
            mode="pro"
            columns={['name', 'price', 'change', 'spark', 'range', 'action']}
            sort={sort}
            onSortChange={setSort}
            favorite={favorite}
            loading={loading}
            skeletonRows={6}
            onVisibleSymbolsChange={setOnScreen}
            empty={emptyRows}
          />
        </>
      )}
    </section>
  );
}

/**
 * Home in Pro mode (UI-SPEC 5.2, OKX's denser asset overview), on the overview template's Pro form: the summary with the
 * total and today's change, the quick actions, cash, crypto and open orders in the Pro region; then the tiles in the
 * person's order (the assets as a table, the markets table in its Pro form). `index.tsx` picks this one when the layout
 * preference is Pro.
 */
export function HomePro() {
  const { t } = homeCopy.useCopy();
  const { hideBalances, displayCurrency } = usePreferences();
  const portfolio = useHomePortfolio(moneyUnitOf(displayCurrency));
  const orders = useOpenOrders();
  const markets = useMarkets();
  const activity = useActivity();
  const activityLimit = useRecentActivityLimit();
  const launch = launchStanding(useLaunchVenue(), portfolio);
  const home = useHomeLayout();
  const tiles = shownTiles(home.layout, 'pro');
  const started = useStartedTile(portfolio, tiles.includes('started'));
  // What "Needs you" shows, so the inbox row is never a notice it already carries.
  const [needsYou, setNeedsYou] = useState<NeedsYouShown | null>(null);

  const noMarkets = markets.status === 'empty' || (markets.status === 'ready' && !markets.data.some((market) => market.orderable));
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
  // Assets sit under the summary while there is something to list; an empty or refused account says so in the summary.
  const showAssets = portfolio.status === 'loading' || (portfolio.status === 'ready' && portfolio.data.holdings.length > 0);
  // The launch model and a balance that failed to load have no actions; a refused account keeps only Receive.
  const actions =
    launch || portfolio.status === 'error' ? undefined : (
      <ActionRow loading={portfolio.status === 'loading'} mode={portfolio.status === 'loading' ? 'normal' : actionMode} />
    );
  const stats = launch ? undefined : <ProStats portfolio={portfolio} orders={orders} hidden={hideBalances} />;

  return (
    <OverviewTemplate
      title={t('Home')}
      state={{ kind: 'ready' }}
      mode="pro"
      roomAction={<CustomiseHome home={home} mode="pro" />}
      rooms={
        <>
          <HomeNotices />
          <HomeInbox needsYou={needsYou} />
        </>
      }
      hero={<Summary portfolio={portfolio} hidden={hideBalances} launch={launch} />}
      actions={actions}
      pro={stats}
      sections={
        <div data-testid="if-home-pro" className="lt-stack">
          {tiles.map((id) => {
            switch (id) {
              case 'started':
                return started.show ? (
                  <div data-testid="hp-started" key={id}>
                    <GetStarted steps={started.steps} onHide={started.hide} />
                  </div>
                ) : null;
              case 'work':
                return <WorkList key={id} hidden={hideBalances} testId="hp-work" onShown={setNeedsYou} />;
              case 'holdings':
                // On the launch model the holdings are the parts of the total, each read from its own source.
                return showAssets && !launch ? <Assets key={id} portfolio={portfolio} hidden={hideBalances} /> : null;
              case 'activity':
                return <RecentActivity key={id} activity={activity} limit={activityLimit} hidden={hideBalances} testId="hp-activity" />;
              case 'markets':
                return <MarketsPanel key={id} />;
              default:
                return null;
            }
          })}
        </div>
      }
    />
  );
}
