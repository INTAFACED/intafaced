import { useMemo, useState, type ReactNode } from 'react';
import { TIMEFRAME_MS } from '@intafaced/exchange-contract/schemas';
import { BookLadder, Fold, MarketHeader, Segmented, StateBlock, TradeTape } from '@intafaced/ui/lit';
import { TabPanel, Tabs } from '@intafaced/ui/lit/templates';
import { displayAmount, formatAmount, parseAmount } from '../../../shared/money';
import { fractionDigits } from '../../../data/decimal';
import { usePreferences } from '../../../shared/preferences';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import type { VenueCandle, VenueMarket, VenuePrint } from '../../../features/trade/venue-api';
import { ReadProblem, TestMark, VENUE_POLL_MS, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { forwardFill, type OhlcvRow } from '../../../data/derive';
import type { Candle } from '../../../data/types';
import { CHART_INTERVALS, type ChartInterval } from '../chart/candles';
import { PriceChart, type ChartOrderLine } from '../chart/PriceChart';
import type { ChartOrderHost } from '../../charts/chart-host';
import { deskCopy } from './copy';
import { zoneName } from './time';
import { spotVenueCopy } from './venue-copy';

const NO_LINES: readonly ChartOrderLine[] = [];
/** How many book levels a side shows, and how many prints the tape lists. */
const BOOK_DEPTH = 10;
const TAPE_ROWS = 30;
/** Candles the chart asks the venue for. */
const CANDLE_LIMIT = 240;

const intervalLabel = (interval: ChartInterval) => (interval === '1d' ? '1D' : interval === '1w' ? '1W' : interval);

/** The venue's candles as the chart draws them: a silent interval carries the previous close (as today's desk chart). */
export function venueChartCandles(rows: readonly VenueCandle[], interval: ChartInterval, nowMs: number): Candle[] {
  const ohlcv: OhlcvRow[] = rows.map((c) => [Date.parse(c.openAt), c.openPrice, c.highPrice, c.lowPrice, c.closePrice, c.baseVolume]);
  if (interval === '1w') return ohlcv.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, filled: false }));
  const stepMs = TIMEFRAME_MS[interval];
  return forwardFill(ohlcv, { stepMs, nowMs, fromMs: Math.floor(nowMs / stepMs) * stepMs - (CANDLE_LIMIT - 1) * stepMs }).slice(
    -CANDLE_LIMIT,
  );
}

/** The spread between the best bid and ask, and in basis points of the bid (to a tenth). */
function spreadText(
  bid: string | undefined,
  ask: string | undefined,
  t: (key: 'Spread value', values: { spread: string; bps: string }) => string,
): string | undefined {
  if (!bid || !ask) return undefined;
  const b = parseAmount(bid);
  const diff = parseAmount(ask) - b;
  if (b <= 0n || diff < 0n) return undefined;
  const tenths = (diff * 100_000n) / b;
  return t('Spread value', { spread: formatAmount(diff), bps: `${tenths / 10n}.${tenths % 10n}` });
}

/** Each level with its depth bar: the running total from the best level over the deeper side's whole, in thousandths. */
/** A column's formatter: the most decimals among `values`, at most the step's, applied to every row. */
function columnFormat(values: readonly string[], step: string): (value: string) => string {
  const cap = fractionDigits(step) ?? 0;
  const places = Math.min(cap, Math.max(0, ...values.map((v) => fractionDigits(v) ?? 0)));
  return (value) => displayAmount(value, places);
}

function withDepth(asks: readonly VenueLevel[], bids: readonly VenueLevel[]) {
  const total = (levels: readonly VenueLevel[]) => levels.reduce((sum, l) => sum + parseAmount(l.amount), 0n);
  const whole = [total(asks), total(bids)].reduce((a, b) => (a > b ? a : b));
  const side = (levels: readonly VenueLevel[]) => {
    let running = 0n;
    return levels.map((l) => {
      running += parseAmount(l.amount);
      const milli = whole > 0n ? (running * 1000n) / whole : 0n;
      return { ...l, depth: formatAmount(milli * (parseAmount('1') / 1000n)) };
    });
  };
  return { asks: side(asks), bids: side(bids) };
}
type VenueLevel = { price: string; amount: string };

/**
 * The venue market's own ticker, book, chart and tape on the spot desk (J-cex-spot-01 #5): every figure is the venue's,
 * read through svc-trade's user-venue door, with the venue's as-of time. Nothing here comes from our engine.
 */
export function VenueMarketPanel({
  market,
  test,
  venueName,
  chartTools,
  chartTrade,
  chartOrders,
  chartLines,
  onPickPrice,
}: {
  market: VenueMarket;
  test: boolean;
  venueName: string;
  /** Controls on the chart's bar (J-charts-desk-14: the chart's market and Open DOM). */
  chartTools?: ReactNode;
  /** Buy and Sell on the chart, under it (J-charts-desk-14 #5). */
  chartTrade?: ReactNode;
  /** Placing and moving orders on the chart itself (J-charts-desk-15), drawn with the chart's host once it is ready. */
  chartOrders?: (host: ChartOrderHost | null) => ReactNode;
  /** A click on a book level or a print puts its price on the ticket. */
  onPickPrice?: (price: string) => void;
  /** Lines the desk draws on the chart: a position's entry, stop, target and liquidation (desk A). */
  chartLines?: readonly ChartOrderLine[];
}) {
  const { t } = spotVenueCopy.useCopy();
  const d = deskCopy.useCopy().t;
  const venue = useVenueApi();
  const { timeZone } = usePreferences();
  // The venue's time on the person's own clock ("15 Nov 2026, 17:33:51"), as the venue account panel shows it.
  const asOfText = (iso: string) => {
    try {
      const text = new Intl.DateTimeFormat('en-GB', { timeZone: zoneName(timeZone), dateStyle: 'medium', timeStyle: 'medium' }).format(
        new Date(iso),
      );
      return timeZone === 'device' ? text : `${text} ${timeZone}`;
    } catch {
      return iso;
    }
  };
  const printTime = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: zoneName(timeZone), hourCycle: 'h23' });
  const [tab, setTab] = useState<'book' | 'tape'>('book');
  const [interval, setChartInterval] = useState<ChartInterval>('15m');
  const [host, setHost] = useState<ChartOrderHost | null>(null);
  const book = usePolled((signal) => venue.book(market.symbol, BOOK_DEPTH, signal), `venue-book:${market.symbol}`, VENUE_POLL_MS);
  const tape = usePolled((signal) => venue.trades(market.symbol, TAPE_ROWS, signal), `venue-tape:${market.symbol}`, VENUE_POLL_MS);
  const candles = usePolled(
    (signal) => venue.candles(market.symbol, interval, CANDLE_LIMIT, signal),
    `venue-candles:${market.symbol}:${interval}`,
    VENUE_POLL_MS,
  );
  const chart = useMemo(
    () => (candles.data ? venueChartCandles(candles.data.value, interval, Date.parse(candles.data.asOf)) : null),
    [candles.data, interval],
  );
  const labels = useMemo(
    () => ({
      buy: d('Side buy'),
      sell: d('Side sell'),
      open: d('O'),
      high: d('H'),
      low: d('L'),
      close: d('C'),
      change: d('Change'),
      chart: d('Chart of {pair}', { pair: market.symbol }),
    }),
    [d, market.symbol],
  );

  const last: VenuePrint | undefined = tape.data?.value[0];
  const bid = book.data?.value.bids[0];
  const ask = book.data?.value.asks[0];
  const failure = book.failure ?? tape.failure ?? candles.failure;
  const price = (value: string) => displayAmount(value);
  // An exchange column reads straight down: every row padded to the most decimals any row in view has, never past the
  // market's tick (prices) or lot (sizes). Padding only: a figure is never rounded (displayAmount).
  const levels = [...(book.data?.value.bids ?? []), ...(book.data?.value.asks ?? []), ...(tape.data?.value ?? [])];
  const onTick = columnFormat(
    levels.map((l) => l.price),
    market.tickSize,
  );
  const onLot = columnFormat(
    levels.map((l) => l.amount),
    market.lotSize,
  );

  return (
    <section className="lt-panel" aria-label={t('Venue market')} data-testid="venue-market" data-market={market.symbol}>
      {/* One head line: the market's name, then its live figures, so the chart starts right under it. */}
      {/* The kit's market line: the pair, its last print large, then best bid and ask and the venue's as-of time. The
          newest print's trade id rides on the line, so a reader can match the figure to the venue's print. */}
      <div className="xd-market-head" data-testid="venue-ticker" data-trade-id={last?.tradeId}>
        <MarketHeader
          label={market.symbol}
          asset={market.baseAsset}
          symbol={market.symbol}
          badges={<TestMark test={test} />}
          price={last ? price(last.price) : null}
          priceTestId="venue-last"
          change={null}
          stats={[
            { key: 'bid', label: t('Best bid'), value: bid ? price(bid.price) : t('Side empty'), 'data-testid': 'venue-best-bid' },
            { key: 'ask', label: t('Best ask'), value: ask ? price(ask.price) : t('Side empty'), 'data-testid': 'venue-best-ask' },
            {
              key: 'asof',
              label: t('Market data as of'),
              value: book.data ? asOfText(book.data.asOf) : '…',
              num: false,
              'data-testid': 'venue-market-as-of',
            },
          ]}
          aside={last ? null : <span className="lt-note">{t('No print')}</span>}
        />
      </div>
      <ReadProblem failure={failure} venueName={venueName} />

      {/* The chart with the book and tape beside it, as today's desk sets them. */}
      <div className="xd-market-split">
        <div className="lt-stack">
          {/* A flex column, as today's desk chart is (ChartPanel): the canvas takes the height the bar and Buy/Sell leave. */}
          <div className="lt-stack" data-testid="venue-chart">
            <div className="lt-row lt-row-between">
              <Segmented
                label={d('Chart intervals')}
                options={CHART_INTERVALS.map((id) => ({ value: id, label: intervalLabel(id) }))}
                value={interval}
                onChange={setChartInterval}
              />
            </div>
            <div className="lt-canvas">
              {chart === null && candles.failure ? (
                <StateBlock kind="empty" title={t('No chart from venue', { venue: venueName })} body={candles.failure.message} />
              ) : chart === null ? (
                <p className="lt-note" role="status">
                  {t('Reading the venue')}
                </p>
              ) : chart.length === 0 ? (
                <StateBlock kind="empty" title={d('No trades in this period')} />
              ) : (
                <PriceChart
                  candles={chart}
                  mode="candles"
                  interval={interval}
                  resetKey={`${market.symbol}:${interval}`}
                  tickSize={market.tickSize}
                  orderLines={chartLines ?? NO_LINES}
                  fills={[]}
                  timeZone={zoneName(timeZone)}
                  labels={labels}
                  onHost={chartOrders ? setHost : undefined}
                />
              )}
            </div>
          </div>
          {/* Trading from the chart (the chart's market, the DOM, click trading and orders placed on the chart) behind one
              disclosure under it, so the chart sits right under its title. Below the chart's fixed-height box: the
              ticket and reviews would otherwise take the chart's own height. */}
          {chartTools || chartTrade || chartOrders ? (
            <Fold title={t('Chart trading')} data-testid="venue-chart-trading">
              <div className="lt-stack">
                {chartTools}
                {chartTrade}
                {chartOrders?.(chart !== null && chart.length > 0 ? host : null)}
              </div>
            </Fold>
          ) : null}
        </div>

        <div className="xd-book-tape" data-testid="venue-book-tape">
          <Tabs
            id="venue-book-tape"
            items={[
              { value: 'book', label: t('Order book') },
              { value: 'tape', label: t('Last trades') },
            ]}
            value={tab}
            onChange={(x) => setTab(x as typeof tab)}
          />
          <TabPanel id="venue-book-tape" value="book" current={tab}>
            {book.data ? (
              <BookLadder
                {...withDepth(book.data.value.asks, book.data.value.bids)}
                formatPrice={onTick}
                formatAmount={onLot}
                spread={spreadText(book.data.value.bids[0]?.price, book.data.value.asks[0]?.price, t)}
                labels={{
                  caption: t('Order book'),
                  price: t('Price col', { quote: market.quoteAsset }),
                  amount: t('Size col', { base: market.baseAsset }),
                  spread: t('Spread'),
                  pick: (p) => t('Pick price', { price: p }),
                }}
                onPick={onPickPrice ? (p) => onPickPrice(p) : undefined}
                rowMarks={(_, side) => ({ 'data-testid': 'venue-book-row', 'data-side': side })}
                priceMarks={{ 'data-testid': 'venue-book-price' }}
                amountMarks={{ 'data-testid': 'venue-book-amount' }}
              />
            ) : (
              <p className="lt-note" role="status">
                {t('Reading the venue')}
              </p>
            )}
          </TabPanel>
          <TabPanel id="venue-book-tape" value="tape" current={tab}>
            {tape.data && tape.data.value.length === 0 ? (
              <p className="lt-note">{t('No print')}</p>
            ) : tape.data ? (
              <TradeTape
                prints={tape.data.value.map((p) => ({
                  id: p.tradeId,
                  price: p.price,
                  amount: p.amount,
                  side: p.takerSide ?? null,
                  time: printTime(p.tradedAt),
                }))}
                formatPrice={onTick}
                formatAmount={onLot}
                labels={{
                  caption: t('Last trades'),
                  time: t('Time'),
                  price: t('Price col', { quote: market.quoteAsset }),
                  amount: t('Size col', { base: market.baseAsset }),
                  side: (side) => (side === 'buy' ? t('Taker buy') : side === 'sell' ? t('Taker sell') : t('Side not published')),
                }}
                onPick={onPickPrice}
                rowMarks={(p) => ({ 'data-testid': 'venue-tape-row', 'data-trade-id': p.id, 'data-side': p.side ?? 'unknown' })}
                priceMarks={{ 'data-testid': 'venue-tape-price' }}
                amountMarks={{ 'data-testid': 'venue-tape-amount' }}
              />
            ) : (
              <p className="lt-note" role="status">
                {t('Reading the venue')}
              </p>
            )}
          </TabPanel>
        </div>
      </div>
    </section>
  );
}
