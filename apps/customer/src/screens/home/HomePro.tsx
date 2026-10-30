import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Eye, EyeOff } from 'lucide-react';
import { Tabs, TabsList, TabsTab } from '@intafaced/ui';
import './home-pro.css';
import { clockTime } from './clock';
import { assetName, homeCopy } from './copy';
import {
  Amount,
  Button,
  ChangeText,
  CoinIcon,
  dec,
  decOrNull,
  fmtAmount,
  fmtChangeLine,
  fmtPct,
  fmtUsd,
  HeroNumber,
  isHiddenPath,
  Money,
  Pct,
  ratio,
  refusalCopy,
  Skeleton,
  StateBlock,
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
import { IN_PANEL, STATE_IN_COLUMN } from './panel';
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
import { WorkList } from './WorkList';
import { GetStarted } from './GetStarted';
import { useStartedTile } from './started-data';
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
const ACTION_WIDTH: Record<ActionLabel, number> = { 'Add money': 104, Buy: 56, Sell: 56, Convert: 80, Send: 64, Receive: 80 };

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
    <nav data-testid="hp-actions" className="hp-actions" aria-label={tp('Quick actions')}>
      {loading
        ? ordered.map((action) => (
            <Skeleton key={action.label} width={ACTION_WIDTH[action.label]} height={32} circle className={IN_PANEL} />
          ))
        : ordered.map((action, index) => (
            <Button
              key={action.label}
              variant={index === 0 ? 'primary' : 'secondary'}
              size={32}
              nativeButton={false}
              render={<a href={action.href} />}
            >
              {t(action.label)}
            </Button>
          ))}
    </nav>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="hp-stat">
      <span data-testid="hp-stat__label" className="hp-stat__label">
        {label}
      </span>
      <span data-testid="hp-stat__value" className="hp-stat__value">
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
        <Skeleton width={32} height={20} className={IN_PANEL} />
      </Stat>
    );
  const shown = orders.count >= ORDERS_PAGE ? `${ORDERS_PAGE}+` : String(orders.count);
  return (
    <Stat label={label}>
      {target ? (
        <a data-testid="hp-stat__link" className="hp-stat__link" href={target} aria-label={t('Open orders count', { count: shown })}>
          {shown}
        </a>
      ) : (
        shown
      )}
    </Stat>
  );
}

function Summary({
  portfolio,
  orders,
  hidden,
  actionMode,
}: {
  portfolio: Loadable<HomePortfolio>;
  orders: OpenOrders;
  hidden: boolean;
  actionMode: ActionMode;
}) {
  const { t } = homeCopy.useCopy();
  const { t: tp } = proCopy.useCopy();
  const { timeZone, displayCurrency } = usePreferences();

  const label = (
    <div data-testid="hp-label" className="hp-label">
      <span>{t('Est. total value')}</span>
      <button
        type="button"
        className="hp-eye"
        onClick={() => savePreferences({ hideBalances: !hidden })}
        aria-label={hidden ? t('Show balances') : t('Hide balances')}
      >
        {hidden ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </button>
      <InfoTip text={t('Total value rule')} label={t('How the total is worked out')} side="right" />
      {isHiddenPath('/money') ? null : (
        <a className="hp-tile-link" href="/money">
          {t('Assets')}
          <ChevronRight size={14} aria-hidden="true" />
        </a>
      )}
    </div>
  );

  if (portfolio.status === 'loading')
    return (
      <section data-testid="hp-summary" className="hp-summary" aria-busy="true" aria-label={tp('Home summary')}>
        <div className="hp-total">
          {label}
          <div data-testid="hp-total__figure" className="hp-total__figure">
            <Skeleton width={200} height={40} className={IN_PANEL} />
          </div>
          <div className="hp-total__change">
            <Skeleton width={160} height={20} className={IN_PANEL} />
          </div>
        </div>
        <div className="hp-stats">
          {[0, 1].map((index) => (
            <div className="hp-stat" key={index}>
              <Skeleton width={48} height={16} className={IN_PANEL} />
              <Skeleton width={72} height={20} className={IN_PANEL} />
            </div>
          ))}
        </div>
        <ActionRow loading mode="normal" />
      </section>
    );

  if (portfolio.status === 'error' || portfolio.status === 'refused') {
    const refused = portfolio.status === 'refused' ? refusalCopy(portfolio.code) : null;
    return (
      <section data-testid="hp-summary" className="hp-summary hp-summary--block" aria-label={tp('Home summary')}>
        {portfolio.status === 'error' ? (
          <StateBlock
            kind="error"
            className={STATE_IN_COLUMN}
            title={t('Couldn’t load your balance')}
            onRetry={portfolio.retry}
            retryLabel={t('Try again')}
          />
        ) : (
          <StateBlock
            kind="refused"
            className={STATE_IN_COLUMN}
            title={refused!.title}
            body={refused!.body}
            code={refused!.reference}
            action={refused!.action}
          />
        )}
        {portfolio.status === 'refused' ? <ActionRow loading={false} mode="refused" /> : null}
      </section>
    );
  }

  const empty = portfolio.status === 'empty' || portfolio.data.holdings.length === 0;
  if (empty)
    return (
      <section data-testid="hp-summary" className="hp-summary" aria-label={tp('Home summary')}>
        <div className="hp-total">
          {label}
          <div data-testid="hp-total__figure" className="hp-total__figure">
            {/* The balance call answered with no assets, so zero is correct here and only here. */}
            <HeroNumber value="0.00" decimals={2} prefix="$" unit="USD" size="hero-pro" hidden={hidden} />
          </div>
          <p data-testid="hp-total__note" className="hp-total__note">
            {t('No crypto yet')}
          </p>
        </div>
        <ActionRow loading={false} mode={actionMode} />
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
    <section data-testid="hp-summary" className="hp-summary" aria-label={tp('Home summary')}>
      <div className="hp-total">
        {label}
        <div data-testid="hp-total__figure" className="hp-total__figure">
          <TotalFigure data={data} displayCurrency={displayCurrency} hidden={hidden} pro />
          <TestBuildTag />
        </div>
        <TotalUnitNote data={data} displayCurrency={displayCurrency} hidden={hidden} className="hp-total__note" testId="hp-total__note" />
        <div className="hp-total__change">
          {data.change24hUsd !== null && hasCrypto ? (
            <>
              <ChangeText value={fmtChangeLine(data.change24hUsd, data.change24hPct)} hidden={hidden} suffix={changeLabel} />
              {data.source === 'derived' ? <InfoTip text={t('Today change rule')} label={t('Today change rule label')} /> : null}
            </>
          ) : null}
          {unpriced > 0 ? (
            <span data-testid="hp-total__note" className="hp-total__note">
              {unpriced === 1 ? t('Asset not counted') : t('Assets not counted', { count: unpriced })}
              <InfoTip text={t('Not counted list', { assets: data.unpriced.join(', ') })} label={t('Not counted label')} />
            </span>
          ) : null}
          <DerivedTotalTag source={data.source} className="hp-total__note" />
        </div>
      </div>
      <div className="hp-stats">
        <Stat label={t('Cash')}>
          <Money value={fmtUsd(data.cashUsd)} hidden={hidden} />
        </Stat>
        <Stat label={t('Crypto')}>
          <Money value={fmtUsd(data.cryptoUsd)} hidden={hidden} />
        </Stat>
        <OrdersStat orders={orders} />
      </div>
      <ActionRow loading={false} mode={actionMode} />
    </section>
  );
}

function AssetsSkeleton() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div data-testid="hp-assets__row" className="hp-assets__row" key={index}>
          <div className="hp-assets__cell hp-assets__cell--asset">
            <Skeleton width={28} height={28} circle className={IN_PANEL} />
            <Skeleton width={96} height={20} className={IN_PANEL} />
          </div>
          <div className="hp-assets__cell hp-assets__cell--num hp-assets__cell--amount">
            <Skeleton width={80} height={20} className={IN_PANEL} />
          </div>
          <div className="hp-assets__cell hp-assets__cell--num">
            <Skeleton width={72} height={20} className={IN_PANEL} />
          </div>
          <div className="hp-assets__cell hp-assets__cell--num">
            <Skeleton width={56} height={20} className={IN_PANEL} />
          </div>
          <div className="hp-assets__cell hp-assets__cell--action hp-assets__cell--trade">
            <Skeleton width={56} height={28} circle className={IN_PANEL} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Assets({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const copy = homeCopy.useCopy();
  const { t: tp } = proCopy.useCopy();
  const holdings = portfolio.status === 'ready' ? portfolio.data.holdings : [];
  const rows = holdings.slice(0, ASSET_ROWS);
  return (
    <section data-testid="hp-assets-panel" className="hp-panel" aria-labelledby="hp-assets-title">
      <div className="hp-panel__head">
        <h2 id="hp-assets-title">{tp('Your assets')}</h2>
        <a data-testid="hp-link" className="hp-link" href="/money">
          {tp('View all assets')}
        </a>
      </div>
      <div
        role="table"
        aria-label={tp('Your assets')}
        aria-busy={portfolio.status === 'loading' || undefined}
        data-testid="hp-assets"
        className="hp-assets"
      >
        <div role="row" data-testid="hp-assets__row--head" className="hp-assets__row hp-assets__row--head">
          <div role="columnheader" className="hp-assets__cell hp-assets__cell--asset">
            {tp('Asset')}
          </div>
          <div role="columnheader" className="hp-assets__cell hp-assets__cell--num hp-assets__cell--amount">
            {tp('Amount')}
          </div>
          <div role="columnheader" className="hp-assets__cell hp-assets__cell--num">
            {tp('Value')}
          </div>
          <div role="columnheader" className="hp-assets__cell hp-assets__cell--num">
            {tp('Today')}
          </div>
          <div role="columnheader" className="hp-assets__cell hp-assets__cell--action hp-assets__cell--trade">
            <span className="if-sr">{tp('Trade')}</span>
          </div>
        </div>
        {portfolio.status === 'loading' ? (
          <AssetsSkeleton />
        ) : (
          <div role="rowgroup">
            {rows.map((holding) => {
              const name = assetName(holding.asset, copy);
              const pct = changeRatio(holding);
              const desk = deskFor(holding);
              const target = desk && !isHiddenPath(desk.split('?')[0]!) ? desk : null;
              const assetLabel = (
                <>
                  <CoinIcon asset={holding.asset} size={28} />
                  <span className="hp-assets__ticker">{holding.asset}</span>
                  {name ? <span className="hp-assets__name">{name}</span> : null}
                </>
              );
              return (
                <div role="row" data-testid="hp-assets__row" className="hp-assets__row" key={holding.asset} data-asset={holding.asset}>
                  <div role="cell" className="hp-assets__cell hp-assets__cell--asset">
                    {/* The desk for coins with a market; cash has none, so no link (the coin page is M3). */}
                    {target ? (
                      <a className="hp-assets__asset" href={target}>
                        {assetLabel}
                      </a>
                    ) : (
                      <span className="hp-assets__asset">{assetLabel}</span>
                    )}
                  </div>
                  <div role="cell" className="hp-assets__cell hp-assets__cell--num hp-assets__cell--amount">
                    <Amount value={fmtAmount(holding.total, { round: 'down' })} hidden={hidden} />
                  </div>
                  <div role="cell" className="hp-assets__cell hp-assets__cell--num">
                    <Money value={holding.usdValue === null ? null : fmtUsd(holding.usdValue)} hidden={hidden} />
                  </div>
                  <div role="cell" className="hp-assets__cell hp-assets__cell--num">
                    {/* Cash has no price move: "—", as on Money (critic L7). */}
                    <Pct value={holding.class === 'cash' || pct === null ? null : fmtPct(pct)} />
                  </div>
                  <div role="cell" className="hp-assets__cell hp-assets__cell--action hp-assets__cell--trade">
                    {target ? (
                      <Button
                        variant="secondary"
                        size={28}
                        nativeButton={false}
                        render={<a href={target} aria-label={tp('Trade {asset}', { asset: holding.asset })} />}
                      >
                        {tp('Trade')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
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
    <section data-testid="hp-markets" className="hp-panel hp-markets" aria-labelledby="hp-markets-title">
      <div className="hp-panel__head">
        <h2 id="hp-markets-title">{t('Markets')}</h2>
        <div className="hp-panel__aside">
          {asOf !== null ? <span className="hp-fresh">{th('Prices updated {time}', { time: clockTime(asOf, timeZone) })}</span> : null}
          <a data-testid="hp-link" className="hp-link" href="/trade">
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
          <Tabs value={tab} onValueChange={(value) => setTab(value as MarketTab)}>
            <TabsList divider aria-label={t('Market filters')} className="hp-tabs">
              {tabs.map((item) => (
                <TabsTab key={item.value} value={item.value}>
                  {item.label}
                </TabsTab>
              ))}
            </TabsList>
          </Tabs>
          {tickers.status === 'error' ? (
            <div className="hp-notice" role="status">
              <span>{t('Couldn’t load prices')}</span>
              <Button variant="ghost" size={28} onClick={tickers.retry}>
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
 * Home in Pro mode (UI-SPEC 5.2, OKX's denser asset overview): a summary strip with the total, today's change,
 * cash, crypto, open orders and quick actions; the assets as a table; then the markets table in its Pro form.
 * Simple Home is untouched; `index.tsx` picks this one when the layout preference is Pro.
 */
export function HomePro() {
  const { t } = homeCopy.useCopy();
  const { hideBalances, displayCurrency } = usePreferences();
  const portfolio = useHomePortfolio(moneyUnitOf(displayCurrency));
  const orders = useOpenOrders();
  const markets = useMarkets();
  const activity = useActivity();
  const home = useHomeLayout();
  const tiles = shownTiles(home.layout, 'pro');
  const started = useStartedTile(portfolio, tiles.includes('started'));

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

  return (
    <div data-testid="if-home-pro" className="if-home-pro">
      <h1 className="if-sr">{t('Home')}</h1>
      <HomeNotices />
      <HomeInbox />
      {/* Above the summary, so it is there in every state of the account (an unverified one has no total row). */}
      <div className="hp-toolbar">
        <CustomiseHome home={home} mode="pro" />
      </div>
      <Summary portfolio={portfolio} orders={orders} hidden={hideBalances} actionMode={actionMode} />
      {tiles.map((id) => {
        switch (id) {
          case 'started':
            return started.show ? (
              <div data-testid="hp-started" className="hp-started" key={id}>
                <GetStarted steps={started.steps} onHide={started.hide} />
              </div>
            ) : null;
          case 'work':
            return <WorkList key={id} hidden={hideBalances} className="hp-panel hp-work" testId="hp-work" />;
          case 'holdings':
            return showAssets ? <Assets key={id} portfolio={portfolio} hidden={hideBalances} /> : null;
          case 'activity':
            return (
              <RecentActivity key={id} activity={activity} hidden={hideBalances} className="hp-panel hp-activity" testId="hp-activity" />
            );
          case 'markets':
            return <MarketsPanel key={id} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
