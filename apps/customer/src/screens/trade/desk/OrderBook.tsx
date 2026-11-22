import { memo, useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import type { OrderBook as WireBook, Trade } from '@intafaced/exchange-contract/schemas';
import { buildBook, buyShare, type BookRow } from './book-math';
import { deskCopy } from './copy';
import {
  Bone,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StateBlock,
  Tab,
  TabList,
  TabPanel,
  TabSet,
} from '@intafaced/ui/lit';
import { fmtAmount, fmtPrice, refusalCopy, type Loadable, type TickerRow } from '../../../data';
import { useTape } from './data';
import { useFlash, useNow, useTickDirection } from './hooks';
import type { DeskMarket } from './market';
import { scaleStep } from './order-math';
import { clockSeconds } from './time';
import { dollarPrice, placesOf } from './text';
import type { Preferences } from '../../../shared/preferences';

/** Kit classes for each side of the book: bids in the gain colour, asks in the loss colour. */
const SIDE_TONE = { bid: 'lt-up', ask: 'lt-down' } as const;
const SIDE_METER = { bid: 'lt-meter lt-meter-up', ask: 'lt-meter lt-meter-down' } as const;
const MID_TONE = { up: 'lt-num lt-strong lt-up', down: 'lt-num lt-strong lt-down', none: 'lt-num lt-strong' } as const;
const midTone = (direction: 'up' | 'down' | null) => MID_TONE[direction ?? 'none'];
const printTone = (side: Trade['side']) => SIDE_TONE[side === 'buy' ? 'bid' : 'ask'];

const ROW_H = 22;
const MAX_ROWS = 20;
/** Tools (40) + column heading (24) + mid price (40) + the buy/sell ratio bar with its margins (36) around the rows. */
const CHROME_H = 40 + 24 + 40 + 36;
export const STALE_BOOK_MS = 15_000;

type View = 'both' | 'bids' | 'asks';

export interface BookPick {
  price: string;
  /** Running total at that row, used when Shift is held. */
  amount: string;
  nonce: number;
  /** Flatten from Assets: a market sell of `amount` (all that is free), reviewed at once. No price. */
  flatten?: true;
  /**
   * A DOM ladder click or a chart Buy/Sell (J-charts-desk-14): only `side`'s ticket takes it, as `type`, and opens its
   * review once the order check allows it. Nothing is sent without the person's confirm.
   */
  review?: true;
  side?: 'buy' | 'sell';
  type?: 'limit' | 'market';
  /**
   * Instant placement is on (J-charts-desk-14 #6 and #7): the ticket sends once the order check and its preview allow it,
   * with no review sheet. Set only from the account's own `trade.instant` record.
   */
  instant?: true;
}

const Row = memo(function Row({
  row,
  side,
  priceDecimals,
  amountDecimals,
  baseAsset,
  onPick,
}: {
  row: BookRow;
  side: 'ask' | 'bid';
  priceDecimals: string;
  amountDecimals: number;
  baseAsset: string;
  onPick: (row: BookRow, shift: boolean) => void;
}) {
  return (
    <div
      data-testid="dk-bk-row"
      className="lt-level"
      data-side={side}
      data-depth={row.depth}
      role="row"
      tabIndex={0}
      onClick={(event) => onPick(row, event.shiftKey)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onPick(row, event.shiftKey);
        }
      }}
    >
      <meter data-testid="dk-bk-bar" className={SIDE_METER[side]} min={0} max={1000} value={row.depth} aria-hidden="true" />
      <span data-testid="dk-bk-price" className={SIDE_TONE[side]} role="gridcell">
        {fmtPrice(row.price, priceDecimals)}
      </span>
      <span
        className="lt-num"
        role="gridcell"
        aria-label={`${fmtAmount(row.amount, { places: amountDecimals, fixed: true })} ${baseAsset}`}
      >
        {fmtAmount(row.amount, { places: amountDecimals, fixed: true })}
      </span>
      <span className="lt-num" role="gridcell">
        {fmtAmount(row.total, { places: amountDecimals, fixed: true })}
      </span>
    </div>
  );
});

function Glyph({ top, bottom }: { top: string; bottom: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="2" width="6" height="5" rx="1" fill={top} />
      <rect x="1" y="9" width="6" height="5" rx="1" fill={bottom} />
      <rect x="9" y="3" width="6" height="2" rx="1" fill={top} opacity="0.55" />
      <rect x="9" y="6" width="6" height="2" rx="1" fill={top} opacity="0.55" />
      <rect x="9" y="9" width="6" height="2" rx="1" fill={bottom} opacity="0.55" />
      <rect x="9" y="12" width="6" height="2" rx="1" fill={bottom} opacity="0.55" />
    </svg>
  );
}

interface BookProps {
  market: DeskMarket;
  book: Loadable<WireBook>;
  ticker: Loadable<TickerRow>;
  zone: Preferences['timeZone'];
  onPick: (pick: BookPick) => void;
  onPickPrice: (price: string) => void;
  /** The widget's place on the desk (C-workspace-01): its attributes, and the arrange controls when arranging. */
  frame?: HTMLAttributes<HTMLDivElement> & { 'data-widget'?: string };
  chrome?: ReactNode;
}

function BookView({ market, book, ticker, onPick }: Omit<BookProps, 'zone' | 'onPickPrice'>) {
  const { t } = deskCopy.useCopy();
  const [view, setView] = useState<View>('both');
  const [places, setPlaces] = useState(0);
  const [rows, setRows] = useState(10);
  const body = useRef<HTMLDivElement>(null);
  const nonce = useRef(0);
  const now = useNow(1000);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      const free = el.clientHeight - CHROME_H;
      const each = view === 'both' ? Math.floor(free / 2 / ROW_H) : Math.floor(free / ROW_H);
      setRows(Math.max(3, Math.min(MAX_ROWS, each)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);

  const group = useMemo(() => scaleStep(market.tickSize, places), [market.tickSize, places]);
  const groupItems = useMemo(
    () => Object.fromEntries([0, 1, 2].map((p) => [String(p), fmtPrice(scaleStep(market.tickSize, p), scaleStep(market.tickSize, p))])),
    [market.tickSize],
  );
  const amountDecimals = placesOf(market.lotSize);
  const data = book.status === 'ready' ? book.data : null;
  const built = useMemo(
    () => (data ? buildBook(data.bids, data.asks, places === 0 ? null : group, rows) : null),
    [data, group, places, rows],
  );
  const last = ticker.status === 'ready' ? ticker.data.last : null;
  const direction = useTickDirection(last, market.symbol);
  const flash = useFlash(last, market.symbol);
  const share = built ? buyShare(built.bidTotal, built.askTotal) : null;
  const old = data !== null && now - data.timestamp >= STALE_BOOK_MS;
  const empty = data !== null && data.bids.length === 0 && data.asks.length === 0;

  const pick = (row: BookRow, shift: boolean) => {
    nonce.current += 1;
    onPick({ price: row.price, amount: shift ? row.total : '', nonce: nonce.current });
  };
  const stepLabel = (value: number) => groupItems[String(value)];

  // A grid owns rows only (axe aria-required-children): the notes and the buy and sell share sit after it, and a state
  // with no rows (loading, error, refused) is drawn in its place.
  let content: React.ReactNode;
  let after: React.ReactNode = null;
  let grid = false;
  if (book.status === 'loading') {
    content = (
      <div data-testid="dk-bk-skeleton" className="lt-stack-tight" role="status" aria-busy="true" aria-label={t('Order book')}>
        {Array.from({ length: 16 }, (_, i) => (
          <Bone key={i} size="row" />
        ))}
      </div>
    );
  } else if (book.status === 'error') {
    content = <StateBlock kind="error" title={t('Couldn’t load the order book')} onRetry={book.retry} retryLabel={t('Try again')} />;
  } else if (book.status === 'refused') {
    const words = refusalCopy(book.code, { pair: market.symbol.replace('/', '-') });
    content = <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  } else {
    grid = true;
    content = (
      <>
        <div className="lt-level lt-level-head" role="row">
          <span role="columnheader">{t('Price column', { asset: market.quote })}</span>
          <span role="columnheader">{t('Amount column', { asset: market.base })}</span>
          <span role="columnheader">{t('Total column', { asset: market.base })}</span>
        </div>
        <div className="lt-levels" role="rowgroup">
          {view !== 'bids' ? (
            <div className="lt-levels" data-side="ask">
              {built?.asks.map((row) => (
                <Row
                  key={`a${row.price}`}
                  row={row}
                  side="ask"
                  priceDecimals={group}
                  amountDecimals={amountDecimals}
                  baseAsset={market.base}
                  onPick={pick}
                />
              ))}
            </div>
          ) : null}
          <div
            data-testid="dk-bk-mid"
            className="lt-row lt-row-between"
            data-direction={direction ?? undefined}
            data-flash={flash ?? undefined}
          >
            <span className={midTone(direction)}>
              {last === null || empty ? '—' : dollarPrice(last, market)}
              {direction && !empty ? (
                <span aria-label={direction === 'up' ? t('Price up') : t('Price down')}>{direction === 'up' ? '▲' : '▼'}</span>
              ) : null}
            </span>
          </div>
          {view !== 'asks' ? (
            <div className="lt-levels" data-side="bid">
              {built?.bids.map((row) => (
                <Row
                  key={`b${row.price}`}
                  row={row}
                  side="bid"
                  priceDecimals={group}
                  amountDecimals={amountDecimals}
                  baseAsset={market.base}
                  onPick={pick}
                />
              ))}
            </div>
          ) : null}
        </div>
      </>
    );
    after = (
      <>
        {empty ? (
          <p data-testid="dk-bk-note" className="lt-note">
            {t('No orders')}
          </p>
        ) : null}
        {old && !empty ? (
          <p data-testid="dk-bk-note" className="lt-note lt-note-warn">
            {t('Book may be old')}
          </p>
        ) : null}
        {share ? (
          <div
            data-testid="dk-bk-ratio"
            className="lt-stack-tight"
            role="img"
            aria-label={t('Buy and sell share', { buy: share.buy, sell: share.sell })}
          >
            <meter className="lt-meter lt-meter-up lt-meter-inline" min={0} max={100} value={share.buy} aria-hidden="true" />
            <span className="lt-row lt-row-between lt-small">
              <span className="lt-up">{t('Buy share', { value: share.buy })}</span>
              <span className="lt-down">{t('Sell share', { value: share.sell })}</span>
            </span>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div data-testid="dk-bk" className="lt-stack" ref={body}>
      <div className="lt-row lt-row-between">
        <div className="lt-row" role="group" aria-label={t('Order book')}>
          <button
            type="button"
            className="lt-icon-button"
            aria-pressed={view === 'both'}
            aria-label={t('Book view both')}
            onClick={() => setView('both')}
          >
            <Glyph top="var(--lit-down-text)" bottom="var(--lit-up-text)" />
          </button>
          <button
            type="button"
            className="lt-icon-button"
            aria-pressed={view === 'bids'}
            aria-label={t('Book view bids')}
            onClick={() => setView('bids')}
          >
            <Glyph top="var(--lit-up-text)" bottom="var(--lit-up-text)" />
          </button>
          <button
            type="button"
            className="lt-icon-button"
            aria-pressed={view === 'asks'}
            aria-label={t('Book view asks')}
            onClick={() => setView('asks')}
          >
            <Glyph top="var(--lit-down-text)" bottom="var(--lit-down-text)" />
          </button>
        </div>
        <Select items={groupItems} value={String(places)} onValueChange={(value) => setPlaces(parseInt(value ?? '0', 10))}>
          <SelectTrigger size="sm" aria-label={t('Group prices by')}>
            <SelectValue>{stepLabel(places)}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            {[0, 1, 2].map((p) => (
              <SelectItem key={p} value={String(p)}>
                {stepLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {grid ? (
        <div className="lt-stack-tight" role="grid" aria-label={t('Order book')}>
          {content}
        </div>
      ) : (
        content
      )}
      {after}
    </div>
  );
}

export function Tape({
  market,
  zone,
  onPickPrice,
  active,
}: {
  market: DeskMarket;
  zone: Preferences['timeZone'];
  onPickPrice: (price: string) => void;
  active: boolean;
}) {
  const { t } = deskCopy.useCopy();
  const tape = useTape(market.symbol, active);
  const amountDecimals = placesOf(market.lotSize);
  if (tape.status === 'loading' || tape.status === 'empty')
    return (
      <div data-testid="dk-bk-skeleton" className="lt-stack-tight" role="status" aria-busy="true" aria-label={t('Last trades')}>
        {Array.from({ length: 16 }, (_, i) => (
          <Bone key={i} size="row" />
        ))}
      </div>
    );
  if (tape.status === 'error')
    return <StateBlock kind="error" title={t('Couldn’t load trades')} onRetry={tape.retry} retryLabel={t('Try again')} />;
  if (tape.status === 'refused') {
    const words = refusalCopy(tape.code);
    return <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  }
  const rows: Trade[] = [...tape.data].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  if (rows.length === 0) return <StateBlock kind="empty" title={t('No trades')} />;
  return (
    <div className="lt-levels" role="grid" aria-label={t('Last trades')}>
      <div className="lt-level lt-level-head" role="row">
        <span>{t('Time column')}</span>
        <span>{t('Price column', { asset: market.quote })}</span>
        <span>{t('Amount column', { asset: market.base })}</span>
      </div>
      <div className="lt-levels" role="rowgroup">
        {rows.map((trade) => (
          <div
            key={trade.id}
            data-testid="dk-bk-row--tape"
            className="lt-level"
            role="row"
            tabIndex={0}
            onClick={() => onPickPrice(trade.price)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onPickPrice(trade.price);
              }
            }}
          >
            <span className="lt-quiet" role="gridcell">
              {clockSeconds(trade.timestamp, zone)}
            </span>
            <span
              data-testid="dk-bk-price"
              className={printTone(trade.side)}
              data-side={trade.side === 'buy' ? 'bid' : 'ask'}
              role="gridcell"
            >
              {fmtPrice(trade.price, market.tickSize)}
            </span>
            <span className="lt-num" role="gridcell">
              {fmtAmount(trade.amount, { places: amountDecimals, fixed: true })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Right column (UI-SPEC 5.7): Order book and Last trades. Trades are fetched only while their tab is showing. */
export const BookPanel = memo(function BookPanel({ market, book, ticker, zone, onPick, onPickPrice, frame, chrome }: BookProps) {
  const { t } = deskCopy.useCopy();
  const [tab, setTab] = useState<'book' | 'trades'>('book');
  return (
    <div data-testid="dk-book" className="lt-stack" {...frame}>
      {chrome}
      <TabSet value={tab} onValueChange={(value) => setTab(value as 'book' | 'trades')}>
        <TabList>
          <Tab value="book">{t('Order book')}</Tab>
          <Tab value="trades">{t('Last trades')}</Tab>
        </TabList>
        <TabPanel value="book">
          <BookView market={market} book={book} ticker={ticker} onPick={onPick} />
        </TabPanel>
        <TabPanel value="trades">
          <Tape market={market} zone={zone} onPickPrice={onPickPrice} active={tab === 'trades'} />
        </TabPanel>
      </TabSet>
    </div>
  );
});
