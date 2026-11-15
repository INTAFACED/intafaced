import { useMemo, useState } from 'react';
import { TIMEFRAME_MS } from '@intafaced/exchange-contract/schemas';
import { DataTable } from '../../../shared/ui';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import type { VenueCandle, VenueMarket, VenuePrint } from '../../../features/trade/venue-api';
import { ReadProblem, TestMark, VENUE_POLL_MS, useAsOfText, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { forwardFill, type OhlcvRow } from '../../../data/derive';
import type { Candle } from '../../../data/types';
import { CHART_INTERVALS, type ChartInterval } from '../chart/candles';
import { PriceChart } from '../chart/PriceChart';
import { deskCopy } from './copy';
import { StateBlock, Tabs, TabsList, TabsPanel, TabsTab } from './deps';
import { zoneName } from './time';
import { spotVenueCopy } from './venue-copy';

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

/**
 * The venue market's own ticker, book, chart and tape on the spot desk (J-cex-spot-01 #5): every figure is the venue's,
 * read through svc-trade's user-venue door, with the venue's as-of time. Nothing here comes from our engine.
 */
export function VenueMarketPanel({ market, test, venueName }: { market: VenueMarket; test: boolean; venueName: string }) {
  const { t } = spotVenueCopy.useCopy();
  const d = deskCopy.useCopy().t;
  const venue = useVenueApi();
  const asOfText = useAsOfText();
  const { timeZone } = usePreferences();
  const [tab, setTab] = useState<'book' | 'tape'>('book');
  const [interval, setChartInterval] = useState<ChartInterval>('15m');
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

  return (
    <section className="dk-panel form-stack" aria-label={t('Venue market')} data-testid="venue-market" data-market={market.symbol}>
      <ReadProblem failure={failure} venueName={venueName} />
      <dl className="protocol-facts" data-testid="venue-ticker">
        <div>
          <dt>{t('Last price')}</dt>
          <dd className="numeric" data-testid="venue-last" data-trade-id={last?.tradeId}>
            {last ? `${price(last.price)} ${market.quoteAsset}` : t('No print')}
          </dd>
        </div>
        <div>
          <dt>{t('Best bid')}</dt>
          <dd className="numeric" data-testid="venue-best-bid">
            {bid ? price(bid.price) : t('Side empty')}
          </dd>
        </div>
        <div>
          <dt>{t('Best ask')}</dt>
          <dd className="numeric" data-testid="venue-best-ask">
            {ask ? price(ask.price) : t('Side empty')}
          </dd>
        </div>
        <div>
          <dt>{t('Market data as of')}</dt>
          <dd data-testid="venue-market-as-of">{book.data ? asOfText(book.data.asOf) : '…'}</dd>
        </div>
      </dl>
      <TestMark test={test} />

      <div className="dk-chart" data-testid="venue-chart">
        <div className="dk-chart-bar">
          <div className="dk-chips" role="group" aria-label={d('Chart intervals')}>
            {CHART_INTERVALS.map((id) => (
              <button key={id} type="button" aria-pressed={interval === id} onClick={() => setChartInterval(id)}>
                {intervalLabel(id)}
              </button>
            ))}
          </div>
        </div>
        <div className="dk-chart-body">
          {chart === null ? (
            <p className="muted" role="status">
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
              orderLines={[]}
              fills={[]}
              timeZone={zoneName(timeZone)}
              labels={labels}
            />
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={(x) => setTab(x as typeof tab)} data-testid="venue-book-tape">
        <TabsList divider className="dk-tabs">
          <TabsTab value="book">{t('Order book')}</TabsTab>
          <TabsTab value="tape">{t('Last trades')}</TabsTab>
        </TabsList>
        <TabsPanel value="book">
          {book.data ? (
            <DataTable
              label={t('Order book')}
              headers={[t('Side'), t('Price col', { quote: market.quoteAsset }), t('Size col', { base: market.baseAsset })]}
            >
              {[
                ...[...book.data.value.asks].reverse().map((l) => ({ side: 'ask' as const, ...l })),
                ...book.data.value.bids.map((l) => ({ side: 'bid' as const, ...l })),
              ].map((l) => (
                <tr key={`${l.side}:${l.price}`} data-testid="venue-book-row" data-side={l.side}>
                  <td>{l.side === 'bid' ? t('Bid') : t('Ask')}</td>
                  <td className="numeric" data-testid="venue-book-price">
                    {price(l.price)}
                  </td>
                  <td className="numeric" data-testid="venue-book-amount">
                    {price(l.amount)}
                  </td>
                </tr>
              ))}
            </DataTable>
          ) : (
            <p className="muted" role="status">
              {t('Reading the venue')}
            </p>
          )}
        </TabsPanel>
        <TabsPanel value="tape">
          {tape.data && tape.data.value.length === 0 ? (
            <p className="muted">{t('No print')}</p>
          ) : tape.data ? (
            <DataTable
              label={t('Last trades')}
              headers={[t('Time'), t('Side'), t('Price col', { quote: market.quoteAsset }), t('Size col', { base: market.baseAsset })]}
            >
              {tape.data.value.map((p) => (
                <tr key={p.tradeId} data-testid="venue-tape-row" data-trade-id={p.tradeId} data-side={p.takerSide ?? 'unknown'}>
                  <td>{new Date(p.tradedAt).toLocaleTimeString('en-GB', { timeZone: zoneName(timeZone), hourCycle: 'h23' })}</td>
                  <td>{p.takerSide === 'buy' ? t('Taker buy') : p.takerSide === 'sell' ? t('Taker sell') : t('Side not published')}</td>
                  <td className="numeric" data-testid="venue-tape-price">
                    {price(p.price)}
                  </td>
                  <td className="numeric" data-testid="venue-tape-amount">
                    {price(p.amount)}
                  </td>
                </tr>
              ))}
            </DataTable>
          ) : (
            <p className="muted" role="status">
              {t('Reading the venue')}
            </p>
          )}
        </TabsPanel>
      </Tabs>
    </section>
  );
}
