import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ScreenProps } from '../../../app/screen-types';
import { useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import { useTicker as useTickerRow } from './deps';
import './desk.css';
import '../chart/chart.css';
import { BookPanel, STALE_BOOK_MS, Tape, type BookPick } from './OrderBook';
import { ArrangeBar, ArrangeChrome, DeskLayoutMenu, dropTarget, useDeskLayout } from './DeskLayout';
import { gridColumns, isUntouched, type WidgetId } from './workspace';
import { BottomTabs, type BottomTab } from './BottomTabs';
import { ChartPanel } from './ChartPanel';
import { FeedStatus } from './FeedStatus';
import { MarketsPanel } from './MarketsPanel';
import { OrderPanel } from './OrderForm';
import { TickerStrip } from './TickerStrip';
import { deskCopy } from './copy';
import { DESK_INTERVALS, useBalances, useBook, useDeskMarkets, useFills, useOpenOrders } from './data';
import {
  defaultDeskPair,
  Popover,
  PopoverContent,
  PopoverTrigger,
  refusalCopy,
  Skeleton,
  StateBlock,
  normalizePair,
  useFavorites,
} from './deps';
import { findMarket, type DeskMarket } from './market';
import { useNow } from './hooks';
import { useDeviceSetting } from '../../../features/trade/hooks';
import { OrderFlow, type LadderPick } from './OrderFlow';
import { ChartTrade, clickAmountOk, type ChartPick } from './ChartTrade';
import { DEFAULT_DOM, isDomSetting, type DomSetting } from './order-flow';
import { useInstantPlacement } from './instant';
import { OneClickBar } from './OneClick';
import { floorToLot } from './order-math';
import type { Reference, Side } from './order-math';
import { EmailProofNotice } from '../../../features/account/EmailProofNotice';

function PairPicker({ selected }: { selected: string }) {
  const { t } = deskCopy.useCopy();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="dk-icon-btn dk-picker" aria-label={t('Choose a market')}>
        <ChevronDown size={16} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="dk-picker-pop">
        <MarketsPanel selected={selected} compact onChoose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function Desk({ market, markets, side }: { market: DeskMarket; markets: DeskMarket[]; side: Side | null }) {
  const { t } = deskCopy.useCopy();
  const { userId } = useSession();
  const { timeZone, quickSizes } = usePreferences();
  const ticker = useTickerRow(market.symbol, { intervalMs: DESK_INTERVALS.ticker });
  const book = useBook(market.symbol);
  const balances = useBalances();
  const openOrders = useOpenOrders();
  const { isFavorite, toggle } = useFavorites(userId);
  const [tab, setTab] = useState<BottomTab>('open');
  // Fills refresh quickly while Trade history shows, and for a minute after an order was sent.
  const [justSent, setJustSent] = useState(false);
  useEffect(() => {
    if (!justSent) return;
    const timer = setTimeout(() => setJustSent(false), 60_000);
    return () => clearTimeout(timer);
  }, [justSent]);
  const fills = useFills(tab === 'trades' || justSent);
  const [suggestion, setSuggestion] = useState<BookPick | null>(null);

  // Stable props, so a book or ticker update re-renders only the panels that show it (UI-SPEC 3.6: a tick never re-renders the desk).
  const now = useNow(2_000);
  const bookData = book.status === 'ready' ? book.data : null;
  const bestBid = bookData?.bids[0]?.[0] ?? null;
  const bestAsk = bookData?.asks[0]?.[0] ?? null;
  const reference = useMemo<Reference | null>(() => (bookData ? { bestBid, bestAsk } : null), [bookData !== null, bestBid, bestAsk]); // eslint-disable-line react-hooks/exhaustive-deps
  const referenceFresh = bookData !== null && now - bookData.timestamp < STALE_BOOK_MS;
  const symbol = market.symbol;
  // Only a stop waiting in Open orders shows the last price, so the bottom strip re-renders on a print only then.
  const waitingStop =
    openOrders.status === 'ready' &&
    openOrders.data.some((order) => (order.type === 'stop' || order.type === 'stop_limit') && order.triggered === null);
  const lastPrice = waitingStop && ticker.status === 'ready' ? ticker.data.last : null;
  const desk = useDeskLayout(userId);
  const { layout, arranging } = desk;
  const custom = !isUntouched(layout) || layout.preset !== 'classic';
  // A widget's place: its order on the grid when the layout is not today's Classic, and the drop target while arranging.
  const frame = (id: WidgetId) => ({
    'data-widget': id,
    // The place in the order is a variable the wide-screen grid reads; narrower screens keep their own stacking.
    ...(custom ? { style: { '--dk-order': layout.order.indexOf(id) } as CSSProperties } : {}),
    ...dropTarget(desk, id),
  });
  const widgetName = (id: WidgetId) =>
    id === 'markets' ? t('Markets') : id === 'chart' ? t('Chart') : id === 'book' ? t('Order book') : t('Market trades');
  const chrome = (id: WidgetId) => <ArrangeChrome desk={desk} id={id} name={widgetName(id)} />;
  const bookFrame = useMemo(() => frame('book'), [custom, layout, arranging]); // eslint-disable-line react-hooks/exhaustive-deps
  const bookChrome = useMemo(() => chrome('book'), [layout, arranging, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = useMemo(
    () => (
      <>
        <FeedStatus symbol={symbol} />
        <DeskLayoutMenu desk={desk} />
      </>
    ),
    [symbol, desk.layout, desk.arranging], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const toggleFavorite = useCallback(() => toggle(symbol), [toggle, symbol]);
  const picker = useMemo(() => <PairPicker selected={symbol} />, [symbol]);
  const onPlaced = useCallback(() => {
    setTab('open');
    setJustSent(true);
  }, []);
  const onFlatten = useCallback(
    (amount: string) => setSuggestion((previous) => ({ price: '', amount, flatten: true, nonce: (previous?.nonce ?? 0) + 1 })),
    [],
  );
  // Instant placement (J-charts-desk-14 #6): the account's own setting. Off unless the account holds the agreement.
  const instant = useInstantPlacement();
  const instantOn = instant.on;
  // One-click close (J-charts-desk-14 #7): every free lot of the base, sold as a limit at the best bid, so its price is
  // the one the button shows; reviewed unless instant placement is on. It is a limit, never a market order: a market
  // order always opens the review, because its price can move (SP-desk-account-01).
  const onCloseAll = useCallback(
    (amount: string, price: string) =>
      setSuggestion((previous) => ({
        price,
        amount,
        nonce: (previous?.nonce ?? 0) + 1,
        review: true,
        side: 'sell',
        type: 'limit',
        ...(instantOn ? { instant: true as const } : {}),
      })),
    [instantOn],
  );
  const onPickPrice = useCallback(
    (price: string) => setSuggestion((previous) => ({ price, amount: '', nonce: (previous?.nonce ?? 0) + 1 })),
    [],
  );
  // The DOM (J-charts-desk-14): open or not and its ladder and tape settings are kept per device; the symbol is never
  // kept, it is always the chart's, so a new market re-binds the DOM with the same settings.
  const [dom, setDom] = useDeviceSetting<DomSetting>('trade-desk-dom', DEFAULT_DOM, isDomSetting);
  const toggleDom = useCallback(() => setDom((now) => ({ ...now, open: !now.open })), [setDom]);
  const closeDom = useCallback(() => setDom((now) => ({ ...now, open: false })), [setDom]);
  // The amount a ladder click or a chart Buy/Sell puts on the ticket.
  const [clickAmount, setClickAmount] = useState('');
  const lot = market.lotSize;
  const onLadderPick = useCallback(
    (pick: LadderPick) =>
      setSuggestion((previous) => ({
        price: pick.price,
        amount: clickAmountOk(clickAmount, lot) ? clickAmount.trim() : '',
        nonce: (previous?.nonce ?? 0) + 1,
        review: true,
        side: pick.side,
        type: 'limit',
        ...(instantOn ? { instant: true as const } : {}),
      })),
    [clickAmount, lot, instantOn],
  );
  const onChartTrade = useCallback(
    (pick: ChartPick) =>
      setSuggestion((previous) => ({
        price: pick.price,
        amount: pick.amount,
        nonce: (previous?.nonce ?? 0) + 1,
        review: true,
        side: pick.side,
        type: pick.type,
        // A market order always opens the review, instant placement or not: its price can move (SP-desk-account-01).
        ...(instantOn && pick.type === 'limit' ? { instant: true as const } : {}),
      })),
    [instantOn],
  );
  const freeBase = balances.status === 'ready' ? floorToLot(balances.data[market.base]?.free ?? '0', market.lotSize) : null;
  const oneClick = (
    <OneClickBar
      market={market}
      instant={instant}
      zone={timeZone}
      presets={quickSizes}
      clickAmount={clickAmount}
      onAmount={setClickAmount}
      free={userId ? freeBase : null}
      bestBid={reference?.bestBid ?? null}
      onCloseAll={onCloseAll}
    />
  );
  const chartTrade = useMemo(
    () => <ChartTrade market={market} reference={reference} amount={clickAmount} onAmount={setClickAmount} onTrade={onChartTrade} />,
    [market, reference, clickAmount, onChartTrade],
  );

  return (
    <div
      data-testid="if-desk"
      className="if-desk"
      data-market={market.symbol}
      data-preset={layout.preset}
      data-arranging={arranging ? 'true' : undefined}
    >
      <TickerStrip
        market={market}
        ticker={ticker}
        favorite={isFavorite(market.symbol)}
        onToggleFavorite={toggleFavorite}
        zone={timeZone}
        picker={picker}
        status={status}
      />
      <EmailProofNotice />
      {desk.recovered ? (
        <p className="dk-layout-note" role="status">
          {t('Desk layout recovered')}
        </p>
      ) : null}
      <ArrangeBar desk={desk} />
      <div
        className="dk-grid"
        data-layout={custom ? 'custom' : undefined}
        style={custom ? ({ '--dk-columns': gridColumns(layout) } as CSSProperties) : undefined}
      >
        <aside data-testid="dk-left" className="dk-panel dk-left" aria-label={t('Markets')} {...frame('markets')}>
          {chrome('markets')}
          <div className="dk-fill">
            <div className="dk-tab-title">
              <span>{t('Markets')}</span>
            </div>
            <MarketsPanel selected={market.symbol} />
          </div>
        </aside>
        <div data-testid="dk-centre" className="dk-centre" {...frame('chart')}>
          {chrome('chart')}
          <ChartPanel market={market} openOrders={openOrders} fills={fills} domOpen={dom.open} onToggleDom={toggleDom} trade={chartTrade} />
          {dom.open ? (
            <OrderFlow
              market={market}
              book={book}
              openOrders={openOrders}
              zone={timeZone}
              setting={dom}
              onSetting={setDom}
              onPick={onLadderPick}
              onClose={closeDom}
              instant={instantOn}
              oneClick={oneClick}
              onCancelled={onPlaced}
            />
          ) : null}
          <OrderPanel
            market={market}
            reference={reference}
            referenceFresh={referenceFresh}
            balances={balances}
            suggestion={suggestion}
            focusSide={side}
            onPlaced={onPlaced}
          />
        </div>
        <BookPanel
          market={market}
          book={book}
          ticker={ticker}
          zone={timeZone}
          onPick={setSuggestion}
          onPickPrice={onPickPrice}
          frame={bookFrame}
          chrome={bookChrome}
        />
        {layout.order.includes('trades') ? (
          <section className="dk-panel dk-trades" aria-labelledby="dk-trades-title" {...frame('trades')}>
            {chrome('trades')}
            <h2 id="dk-trades-title" className="dk-tab-title">
              {t('Market trades')}
            </h2>
            <div className="dk-panel-body">
              <Tape market={market} zone={timeZone} onPickPrice={onPickPrice} active />
            </div>
          </section>
        ) : null}
      </div>
      <BottomTabs
        market={market}
        markets={markets}
        openOrders={openOrders}
        fills={fills}
        balances={balances}
        tab={tab}
        onTab={setTab}
        onFlatten={onFlatten}
        lastPrice={lastPrice}
      />
    </div>
  );
}

function DeskSkeleton() {
  return (
    <div data-testid="if-desk" className="if-desk" role="status" aria-busy="true">
      <div data-testid="dk-ticker" className="dk-ticker">
        <Skeleton width={160} height={24} className="bg-field" />
      </div>
      <div className="dk-grid">
        <div data-testid="dk-left" className="dk-panel dk-left">
          <Skeleton height={500} className="bg-field" />
        </div>
        <div data-testid="dk-centre" className="dk-centre">
          <div data-testid="dk-chart" className="dk-panel dk-chart">
            <Skeleton height={440} className="bg-field" />
          </div>
          <div data-testid="dk-order" className="dk-panel dk-order">
            <Skeleton height={330} className="bg-field" />
          </div>
        </div>
        <div data-testid="dk-book" className="dk-panel dk-book">
          <Skeleton height={500} className="bg-field" />
        </div>
      </div>
    </div>
  );
}

/** Pro desk, `/trade/spot/:pair` (UI-SPEC 5.7). */
export default function TradeDeskScreen({ params, search }: ScreenProps) {
  const { t } = deskCopy.useCopy();
  const markets = useDeskMarkets();
  const pair = normalizePair(params.pair ?? defaultDeskPair);
  const side: Side | null =
    new URLSearchParams(search).get('side') === 'sell' ? 'sell' : new URLSearchParams(search).get('side') === 'buy' ? 'buy' : null;

  if (markets.status === 'loading') return <DeskSkeleton />;
  if (markets.status === 'error')
    return (
      <div data-testid="if-desk" className="if-desk if-desk--state">
        <StateBlock kind="error" title={t('Couldn’t load this market')} onRetry={markets.retry} retryLabel={t('Try again')} />
      </div>
    );
  if (markets.status === 'refused') {
    const words = refusalCopy(markets.code, { pair });
    return (
      <div data-testid="if-desk" className="if-desk if-desk--state">
        <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />
      </div>
    );
  }
  const market = markets.status === 'ready' ? findMarket(markets.data, pair) : undefined;
  if (!market || markets.status !== 'ready')
    return (
      <div data-testid="if-desk" className="if-desk if-desk--state">
        <StateBlock
          kind="empty"
          title={t('Market not found title')}
          body={t('Market not found body')}
          action={{ label: t('See all markets'), href: '/trade' }}
        />
      </div>
    );
  return <Desk key={market.symbol} market={market} markets={markets.data} side={side} />;
}
