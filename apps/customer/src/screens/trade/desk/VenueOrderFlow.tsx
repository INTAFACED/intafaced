/**
 * The DOM on the venue spot desk (J-charts-desk-14 under the launch money model, docs/adr/2026-11-10-launch-money-model.md):
 * the same ladder, time and sales, depth chart and one-click strip as today's desk (OrderFlow.tsx, OneClick.tsx), drawn
 * from the venue's own book and prints and the person's own venue orders, every figure read through svc-trade's
 * user-venue door. One book read feeds the ladder, the depth chart and my place in the queue. Nothing here holds a
 * balance or sends an order: a ladder click asks the venue ticket for a draft (VenueSpotDesk.tsx), and a one-click cancel
 * is the desk's own signed venue cancel.
 */
import { useMemo, type ReactNode } from 'react';
import type { OrderBook } from '@intafaced/exchange-contract/schemas';
import type { Loadable } from '../../../data/types';
import type { ApiResult } from '../../../shared/api';
import type { Preferences } from '../../../shared/preferences';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import type { VenueMarket, VenueOrder } from '../../../features/trade/venue-api';
import { TestMark, VENUE_POLL_MS, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { ownerValue, useChartOwnerCounts } from '../../charts/owner-values';
import { fmtAmount, fmtPct, fmtPrice } from './deps';
import { flowCopy } from './order-flow-copy';
import { OrderFlowView, type LadderPick } from './OrderFlow';
import { RowCancelView, type CancelOutcome } from './OneClick';
import type { DomSetting, FlowMarket, TapePrint } from './order-flow';
import { placesOf } from './text';
import { flowMarketOf, printsReach, venueBookAsOrderBook, venuePrintsAsTape, venueQueueEstimate } from './venue-flow';

/** The levels a side the DOM reads (the door's most), and the prints the tape and the queue estimate read (its most). */
export const DOM_BOOK_DEPTH = 50;
export const DOM_TAPE_LIMIT = 500;

/** A polled read as the DOM's loadable: the data once read, a typed refusal by its code, else an error to try again. */
function loadableOf<T, U>(
  read: { data: T | null; failure: Extract<ApiResult<T>, { ok: false }> | null; reload: () => void },
  map: (data: T) => U,
): Loadable<U> {
  if (read.data !== null) return { status: 'ready', data: map(read.data), asOf: Date.now() };
  if (read.failure?.code) return { status: 'refused', code: read.failure.code };
  if (read.failure) return { status: 'error', retry: read.reload };
  return { status: 'loading' };
}

/** One of my venue orders on the ladder: what the row sums and the cancel review names, with the venue's own record. */
export interface VenueRow {
  id: string;
  side: 'buy' | 'sell';
  price: string;
  remaining: string;
  order: VenueOrder;
}

const working = (o: VenueOrder) => o.status === 'open' || o.status === 'partially_filled';

interface Props {
  market: VenueMarket;
  test: boolean;
  /** The person's open orders on the venue (all markets), or null while unread. */
  openOrders: readonly VenueOrder[] | null;
  zone: Preferences['timeZone'];
  setting: DomSetting;
  onSetting: (next: DomSetting) => void;
  onPick: (pick: LadderPick) => void;
  onClose: () => void;
  instant: boolean;
  oneClick: ReactNode;
  /** One signed venue cancel for one of my orders (VenueSpotDesk `cancel`), never retried here. */
  cancelOne: (order: VenueOrder) => Promise<CancelOutcome>;
  onCancelled: () => void;
}

export function VenueOrderFlow({
  market,
  test,
  openOrders,
  zone,
  setting,
  onSetting,
  onPick,
  onClose,
  instant,
  oneClick,
  cancelOne,
  onCancelled,
}: Props) {
  const venue = useVenueApi();
  const flow = useMemo(() => flowMarketOf(market), [market]);
  const bookRead = usePolled(
    (signal) => venue.book(market.symbol, DOM_BOOK_DEPTH, signal),
    `venue-dom-book:${market.symbol}`,
    VENUE_POLL_MS,
  );
  const tapeRead = usePolled(
    (signal) => venue.trades(market.symbol, DOM_TAPE_LIMIT, signal),
    `venue-dom-tape:${market.symbol}`,
    VENUE_POLL_MS,
  );
  const book = useMemo(() => loadableOf(bookRead, venueBookAsOrderBook), [bookRead.data, bookRead.failure]); // eslint-disable-line react-hooks/exhaustive-deps
  const tape = useMemo<Loadable<readonly TapePrint[]>>(
    () => loadableOf(tapeRead, (read) => venuePrintsAsTape(read.value)),
    [tapeRead.data, tapeRead.failure], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const mine = useMemo<VenueRow[]>(
    () =>
      (openOrders ?? [])
        .filter((o) => o.symbol === market.symbol && working(o) && o.venueClientOrderId)
        .map((o) => ({ id: o.venueClientOrderId!, side: o.side, price: o.price, remaining: o.remaining, order: o })),
    [openOrders, market.symbol],
  );
  const renderCancel = (orders: VenueRow[]) => (
    <RowCancelView market={flow} orders={orders} instant={instant} onDone={onCancelled} cancelOne={(row) => cancelOne(row.order)} />
  );
  const tapeAsOf = tapeRead.data ? Date.parse(tapeRead.data.asOf) : null;
  return (
    <OrderFlowView
      market={flow}
      book={book}
      mine={mine}
      tape={tape}
      queue={
        <VenueQueue
          market={flow}
          mine={mine}
          book={book.status === 'ready' ? book.data : null}
          prints={tape.status === 'ready' ? tape.data : null}
          tapeAsOfMs={tapeAsOf}
        />
      }
      renderCancel={renderCancel}
      zone={zone}
      setting={setting}
      onSetting={onSetting}
      onPick={onPick}
      onClose={onClose}
      instant={instant}
      oneClick={oneClick}
      badge={<TestMark test={test} />}
    />
  );
}

/** My resting venue limit orders on this market, and where each stands on the venue's own book. */
function VenueQueue({
  market,
  mine,
  book,
  prints,
  tapeAsOfMs,
}: {
  market: FlowMarket;
  mine: readonly VenueRow[];
  book: OrderBook | null;
  prints: readonly TapePrint[] | null;
  tapeAsOfMs: number | null;
}) {
  const { t } = flowCopy.useCopy();
  const owner = useChartOwnerCounts();
  const fillWindow = ownerValue(owner, 'queueFillWindowSeconds');
  const resting = mine.filter((row) => row.order.type === 'limit');
  return (
    <section className="of-section" aria-label={t('My queue')} data-testid="of-queue">
      <h3 className="of-title">{t('My queue')}</h3>
      {resting.length === 0 ? (
        <p className="of-note">{t('My queue none')}</p>
      ) : (
        <ul className="of-queue">
          {resting.map((row) => (
            <VenueQueueRow
              key={row.id}
              market={market}
              row={row}
              book={book}
              prints={prints}
              tapeAsOfMs={tapeAsOfMs}
              fillWindow={fillWindow}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function VenueQueueRow({
  market,
  row,
  book,
  prints,
  tapeAsOfMs,
  fillWindow,
}: {
  market: FlowMarket;
  row: VenueRow;
  book: OrderBook | null;
  prints: readonly TapePrint[] | null;
  tapeAsOfMs: number | null;
  fillWindow: ReturnType<typeof ownerValue<'queueFillWindowSeconds'>>;
}) {
  const { t } = flowCopy.useCopy();
  const amountPlaces = placesOf(market.lotSize);
  const size = (value: string) => fmtAmount(value, { places: amountPlaces });
  const head = t('My queue order', {
    side: row.side === 'buy' ? t('My queue side buy') : t('My queue side sell'),
    amount: size(row.remaining),
    asset: market.base,
    price: fmtPrice(row.price, market.tickSize),
  });
  if (!book || !prints || tapeAsOfMs === null || (!fillWindow.ok && fillWindow.why === 'loading'))
    return (
      <li className="of-queue-row" data-testid="of-queue-row" data-order-id={row.id} data-state="loading">
        <span className="of-queue-head">{head}</span>
        <span className="of-note">{t('My queue loading')}</span>
      </li>
    );
  const windowSeconds = fillWindow.ok ? fillWindow.value : null;
  const sinceMs = windowSeconds === null ? tapeAsOfMs : tapeAsOfMs - windowSeconds * 1000;
  const q = venueQueueEstimate({
    side: row.side,
    price: row.price,
    remaining: row.remaining,
    book,
    prints,
    tapeAsOfMs,
    windowSeconds,
    printsComplete: printsReach(prints, DOM_TAPE_LIMIT, sinceMs),
  });
  if (q.kind === 'not_in_book')
    return (
      <li className="of-queue-row" data-testid="of-queue-row" data-order-id={row.id} data-state="not-in-book">
        <span className="of-queue-head">{head}</span>
        <span className="of-note" role="status">
          {t('My queue venue past book')}
        </span>
      </li>
    );
  const chance = q.chance.kind === 'estimate' ? q.chance : null;
  const ahead = q.sizeAheadAtMost === '0' ? null : q.sizeAheadAtMost;
  return (
    <li
      className="of-queue-row"
      data-testid="of-queue-row"
      data-state="ready"
      data-order-id={row.id}
      data-side={row.side}
      data-price={row.price}
      data-level-total={q.levelTotal}
      data-remaining={q.remaining}
      data-size-ahead={q.sizeAheadAtMost}
      data-as-of={book.datetime}
      data-tape-as-of={new Date(tapeAsOfMs).toISOString()}
      data-source="venue_l2"
      data-chance={chance ? chance.ratio : 'unset'}
      data-window={chance?.windowSeconds ?? ''}
      data-window-start={chance ? new Date(chance.windowStartMs).toISOString() : ''}
      data-traded={chance?.tradedThrough ?? ''}
      data-to-fill={chance?.sizeToFill ?? ''}
      data-complete={chance ? String(chance.complete) : ''}
    >
      <span className="of-queue-head">{head}</span>
      <span data-testid="of-queue-ahead">
        {ahead === null ? t('My queue venue first') : t('My queue venue ahead', { size: size(ahead), asset: market.base })}
      </span>
      <span data-testid="of-queue-chance">
        {chance ? t('My queue chance', { pct: fmtPct(chance.ratio, { signed: false }) }) : t('My queue chance unset')}
      </span>
      <span className="of-note" data-testid="of-queue-basis">
        {chance
          ? t('My queue venue basis', {
              traded: size(chance.tradedThrough),
              asset: market.base,
              seconds: chance.windowSeconds,
              toFill: size(chance.sizeToFill),
            })
          : !fillWindow.ok && fillWindow.why === 'unavailable'
            ? t('My queue venue window unread')
            : t('My queue venue basis unset')}
        {chance && !chance.complete ? <> {t('My queue venue partial')}</> : null} {t('My queue venue source')}
      </span>
    </li>
  );
}
