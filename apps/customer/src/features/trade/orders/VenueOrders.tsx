import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { navigate } from '../../../app/location';
import { compare, dec, ratio, str, sub, times, toFixedString } from '../../../data/decimal';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { Button, DataTable, EmptyState, Failure, Loading, Page } from '../../../shared/ui';
import { useSession } from '../../session/session';
import { zoneName } from '../../../screens/trade/desk/time';
import { useVenueMode } from '../use-venue-mode';
import type { VenueFill, VenueHistoryPage, VenueHistoryQuery, VenueOrder, VenueOrderRecord } from '../venue-api';
import { AsOfLine, TestMark, VenueFrame, WalletBar, useOwner, useVenueApi, word } from '../venue/VenueKit';
import { venueCopy } from '../venue/venue-copy';
import { ProductSwitch } from './FuturesOrdersRoom';
import { venueOrdersCopy } from './venue-orders-copy';
import './orders.css';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type V = ReturnType<typeof venueCopy.useCopy>['t'];

/** A venue client order id (`0x` and 32 hex): the address `/trade/orders/<id>` of a venue order, never an engine order id. */
export const VENUE_ORDER_ID = /^0x[0-9a-f]{32}$/i;

/** The venue history's filters, as the address holds them (`/trade/orders?product=venue&side=sell&status=filled`). */
export interface VenueHistoryParams {
  readonly side: string;
  readonly status: string;
  /** Local calendar days, `YYYY-MM-DD`. */
  readonly from: string;
  readonly to: string;
  readonly size: string;
}

export function readVenueParams(search: string): VenueHistoryParams {
  const p = new URLSearchParams(search);
  return {
    side: p.get('side') ?? '',
    status: p.get('status') ?? '',
    from: p.get('from') ?? '',
    to: p.get('to') ?? '',
    size: p.get('size') ?? '',
  };
}

function writeVenueParams(params: VenueHistoryParams): string {
  const out = new URLSearchParams({ product: 'venue' });
  for (const key of ['side', 'status', 'from', 'to', 'size'] as const) if (params[key] !== '') out.set(key, params[key]);
  return `?${out.toString()}`;
}

/**
 * The service's query for the address's filters: a day is the person's own calendar day (from its start to the start of
 * the day after). A day that isn't a date is sent as written, so the service refuses it in its own words.
 */
export function historyQuery(params: VenueHistoryParams, before: string | null): VenueHistoryQuery {
  const dayStart = (day: string, plus: number) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!m) return day;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plus).toISOString();
  };
  const q: Record<string, string> = {};
  if (params.side) q.side = params.side;
  if (params.status) q.status = params.status;
  if (params.from) q.from = dayStart(params.from, 0);
  if (params.to) q.to = dayStart(params.to, 1);
  if (params.size) q.limit = params.size;
  if (before) q.before = before;
  return q;
}

function useDayTime(): (iso: string) => string {
  const { timeZone } = usePreferences();
  return (iso: string) => {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: zoneName(timeZone),
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  };
}

/** Venue mode, the wallet and the TEST label around a venue orders page; the body gets the connected owner. */
function VenueOrdersFrame({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: (owner: string, test: boolean) => ReactNode;
}) {
  const { t } = venueOrdersCopy.useCopy();
  const mode = useVenueMode();
  const { userId } = useSession();
  if (!userId)
    return (
      <Page eyebrow={t('eyebrow')} title={title}>
        <EmptyState
          title={t('signedOutTitle')}
          action={
            <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`}>
              {t('signIn')}
            </a>
          }
        >
          {t('signedOutBody')}
        </EmptyState>
      </Page>
    );
  if (mode.mode === 'checking')
    return (
      <Page eyebrow={t('eyebrow')} title={title}>
        <Loading label={t('historyTitle')} />
      </Page>
    );
  if (mode.mode === 'off')
    return (
      <Page eyebrow={t('eyebrow')} title={title} actions={actions}>
        <EmptyState title={t('historyTitle')}>{t('venueOff')}</EmptyState>
      </Page>
    );
  const test = mode.status.available ? mode.status.test : false;
  return (
    <VenueFrame mode={mode}>
      <Page eyebrow={t('eyebrow')} title={title} actions={actions}>
        <TestMark test={test} />
        <WalletBar />
        <Owned>{(owner) => children(owner, test)}</Owned>
      </Page>
    </VenueFrame>
  );
}

function Owned({ children }: { children: (owner: string) => ReactNode }) {
  const { t } = venueOrdersCopy.useCopy();
  const owner = useOwner();
  if (!owner) return <p className="muted">{t('connectFirst')}</p>;
  return <>{children(owner)}</>;
}

type HistoryState =
  | { status: 'loading' }
  | { status: 'refused'; words: string }
  | { status: 'failed'; failure: Refusal }
  | { status: 'ready'; rows: VenueHistoryPage['orders']; next: string | null; asOf: string; loadingMore: boolean };

/**
 * The venue order history (`/trade/orders?product=venue`, J-cex-spot-06 #1 #7): every order on the person's own venue
 * account as the venue keeps it, filtered by side, state and the day placed, a page at a time with no order twice. A
 * filter the service can't use is refused in its words. Each row opens the order's own page.
 */
export function VenueOrdersRoom({ path }: { path: string }) {
  const { t } = venueOrdersCopy.useCopy();
  return (
    <VenueOrdersFrame
      title={t('historyTitle')}
      actions={
        <a className="text-link" href="/trade/spot/BTC-USDC">
          {t('deskLink')}
        </a>
      }
    >
      {(owner, test) => <VenueHistory path={path} owner={owner} test={test} />}
    </VenueOrdersFrame>
  );
}

function VenueHistory({ path, owner, test }: { path: string; owner: string; test: boolean }) {
  const { t } = venueOrdersCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const api = useVenueApi();
  const time = useDayTime();
  const search = new URL(path, location.origin).search;
  const params = useMemo(() => readVenueParams(search), [search]);
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const set = (next: Partial<VenueHistoryParams>) => navigate(`/trade/orders${writeVenueParams({ ...params, ...next })}`, true);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void api.orderHistory(owner, historyQuery(params, null), controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok)
        setState({ status: 'ready', rows: result.data.orders, next: result.data.next, asOf: result.data.asOf, loadingMore: false });
      else if (result.code === 'trade.invalid_filter') setState({ status: 'refused', words: result.message });
      else if (result.code === 'trade.invalid_cursor') setState({ status: 'refused', words: t('refusedCursor') });
      else setState({ status: 'failed', failure: result });
    });
    return () => controller.abort();
  }, [api, owner, params, revision]);

  async function older() {
    if (state.status !== 'ready' || !state.next || state.loadingMore) return;
    setState({ ...state, loadingMore: true });
    const result = await api.orderHistory(owner, historyQuery(params, state.next));
    if (!result.ok) {
      setState(
        result.code === 'trade.invalid_cursor' ? { status: 'refused', words: t('refusedCursor') } : { status: 'failed', failure: result },
      );
      return;
    }
    const seen = new Set(state.rows.map((r) => r.order.venueClientOrderId));
    const added = result.data.orders.filter((r) => !seen.has(r.order.venueClientOrderId));
    setState({ status: 'ready', rows: [...state.rows, ...added], next: result.data.next, asOf: result.data.asOf, loadingMore: false });
  }

  const select = (label: string, value: string, options: [string, string][], onChange: (value: string) => void) => (
    <label className="field">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  const states = ['open', 'partially_filled', 'filled', 'canceled', 'rejected'];
  return (
    <section data-testid="venue-history">
      <ProductSwitch product="venue" />
      <p className="muted">{t('historyLead')}</p>
      <div className="orders-filters" role="group" aria-label={t('historyTitle')}>
        {select(
          v('Side'),
          params.side,
          [
            ['', t('allStates')],
            ['buy', v('side_buy')],
            ['sell', v('side_sell')],
          ],
          (side) => set({ side }),
        )}
        {select(
          v('Status'),
          params.status,
          [['', t('allStates')], ...states.map((s): [string, string] => [s, word(v, 'status', s)])],
          (status) => set({ status }),
        )}
        <label className="field">
          <span>{t('from')}</span>
          <input type="date" aria-label={t('from')} value={params.from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('to')}</span>
          <input type="date" aria-label={t('to')} value={params.to} onChange={(e) => set({ to: e.target.value })} />
        </label>
        {select(
          t('perPage'),
          params.size || '20',
          [
            ['20', '20'],
            ['50', '50'],
            ['100', '100'],
          ],
          (size) => set({ size }),
        )}
      </div>
      {state.status === 'loading' ? <Loading label={t('historyTitle')} /> : null}
      {state.status === 'refused' ? (
        <div role="alert" className="failure">
          <strong>{t('refusedTitle')}</strong>
          <p>{state.words}</p>
        </div>
      ) : null}
      {state.status === 'failed' ? <Failure result={state.failure} retry={() => setRevision((n) => n + 1)} /> : null}
      {state.status === 'ready' ? (
        state.rows.length === 0 ? (
          <p className="muted">{t('none')}</p>
        ) : (
          <>
            <TestMark test={test} />
            <DataTable
              label={t('historyTitle')}
              headers={[t('placed'), v('Market'), v('Side'), v('Type'), v('Price'), v('Amount'), v('Filled'), v('Status'), '']}
            >
              {state.rows.map(({ order: o, placedAt }) => (
                <tr key={o.venueClientOrderId ?? o.venueOrderId ?? placedAt} data-client-order-id={o.venueClientOrderId ?? ''}>
                  <td>{time(placedAt)}</td>
                  <td>{o.symbol}</td>
                  <td>{word(v, 'side', o.side)}</td>
                  <td>{word(v, 'type', o.type)}</td>
                  <td className="numeric">{displayAmount(o.price)}</td>
                  <td className="numeric">{displayAmount(o.amount)}</td>
                  <td className="numeric">{displayAmount(o.filled)}</td>
                  <td data-cell="status">{word(v, 'status', o.status)}</td>
                  <td>
                    {o.venueClientOrderId ? (
                      <a className="text-link" data-testid="venue-order-link" href={`/trade/orders/${o.venueClientOrderId}`}>
                        {t('open')}
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </DataTable>
            <p>{t('shownCount', { count: state.rows.length })}</p>
            {state.next ? (
              <Button variant="secondary" disabled={state.loadingMore} onClick={() => void older()}>
                {t('older')}
              </Button>
            ) : (
              <p className="muted">{t('end')}</p>
            )}
            <AsOfLine asOf={state.asOf} />
          </>
        )
      ) : null}
    </section>
  );
}

type Read<T> = { status: 'loading' } | { status: 'failed'; failure: Refusal } | { status: 'ready'; data: T };

/** `a` less `b` as a share of `b`, in percent to two places; null when `b` is zero. */
function percentOf(a: string, b: string): string | null {
  const share = ratio(dec(a)!, dec(b)!);
  return share === null ? null : toFixedString(times(share, dec('100')!), 2);
}

/**
 * One venue order (`/trade/orders/<venue client order id>`, J-cex-spot-06 #2 #4 #5 #6 #9 #10): its state, its fills with
 * each fill's price, size, role, the venue's fee and our builder fee as separate lines, the fee asset and any rank discount
 * on our fee; why a trigger order fired, its trigger price against its execution price and the slippage between them; and
 * every amendment the venue accepted, with its time. Every figure is the venue's, as it reports it now: an amendment still
 * waiting for the venue's answer leaves the old amount here. An order the venue has no record of on this account (another
 * person's, or none) reads "Order not found", the same either way.
 */
export function VenueOrderDetail({ clientOrderId }: { clientOrderId: string }) {
  const { t } = venueOrdersCopy.useCopy();
  return (
    <VenueOrdersFrame
      title={t('historyTitle')}
      actions={
        <a className="text-link" href="/trade/orders?product=venue">
          {t('historyTitle')}
        </a>
      }
    >
      {(owner, test) => <VenueOrderBody owner={owner} clientOrderId={clientOrderId.toLowerCase()} test={test} />}
    </VenueOrdersFrame>
  );
}

function VenueOrderBody({ owner, clientOrderId, test }: { owner: string; clientOrderId: string; test: boolean }) {
  const { t } = venueOrdersCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const api = useVenueApi();
  const time = useDayTime();
  const [order, setOrder] = useState<Read<{ order: VenueOrder | null; asOf: string }>>({ status: 'loading' });
  const [record, setRecord] = useState<Read<VenueOrderRecord> | { status: 'missing' }>({ status: 'loading' });
  const [fills, setFills] = useState<Read<VenueFill[]>>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  // The price unit is the market's own quote asset as the venue lists it: a perpetual's symbol (BTC-PERP) doesn't name it.
  const [markets, setMarkets] = useState<{ symbol: string; quoteAsset: string }[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void api.markets(signal).then((result) => {
      if (!signal.aborted && result.ok) setMarkets(result.data.value);
    });
    void api.orderByClientId(owner, clientOrderId, signal).then((result) => {
      if (!signal.aborted)
        setOrder(
          result.ok
            ? { status: 'ready', data: { order: result.data.value, asOf: result.data.asOf } }
            : { status: 'failed', failure: result },
        );
    });
    void api.orderRecord(owner, clientOrderId, signal).then(async (result) => {
      if (signal.aborted) return;
      if (!result.ok) {
        setRecord(result.code === 'trade.venue_order_not_found' ? { status: 'missing' } : { status: 'failed', failure: result });
        return;
      }
      setRecord({ status: 'ready', data: result.data });
      const since = result.data.placedAt ?? new Date(0).toISOString();
      const read = await api.fills(owner, since, signal);
      if (!signal.aborted)
        setFills(
          read.ok
            ? { status: 'ready', data: read.data.value.filter((f) => f.venueClientOrderId === clientOrderId) }
            : { status: 'failed', failure: read },
        );
    });
    return () => controller.abort();
  }, [api, owner, clientOrderId, revision]);

  const retry = () => setRevision((n) => n + 1);
  const missing = (
    <EmptyState title={t('notFoundTitle')}>
      <p>{t('notFoundBody')}</p>
    </EmptyState>
  );
  if (order.status === 'loading' || record.status === 'loading') return <Loading label={t('historyTitle')} />;
  if (order.status === 'failed') return <Failure result={order.failure} retry={retry} />;
  if (!order.data.order || record.status === 'missing') return missing;
  if (record.status === 'failed') return <Failure result={record.failure} retry={retry} />;
  const o = order.data.order;
  const ours = record.data;
  const market = markets?.find((m) => m.symbol === o.symbol);
  const quote = market ? market.quoteAsset : '';
  const base = o.symbol.split('-')[0] ?? '';
  const ended = o.status === 'canceled' || o.status === 'rejected' || o.status === 'expired';
  const reason =
    o.cancelReason === 'position_closed'
      ? t('reasonPositionClosed')
      : o.cancelReason === 'linked'
        ? t('reasonLinked')
        : t('reasonNotRecorded');
  return (
    <article data-testid="venue-order">
      <h2 data-testid="venue-order-heading">
        {t('detailHeading', { side: word(v, 'side', o.side), symbol: o.symbol })}{' '}
        <span data-cell="status">{word(v, 'status', o.status)}</span> <TestMark test={test} />
      </h2>
      <dl className="orders-list" data-testid="venue-order-facts">
        <Row label={t('orderId')}>{o.venueClientOrderId}</Row>
        {ours.placedAt ? <Row label={t('placed')}>{time(ours.placedAt)}</Row> : null}
        <Row label={v('Type')}>{word(v, 'type', o.type)}</Row>
        <Row label={t('timeInForce')}>{word(v, 'tif', o.timeInForce)}</Row>
        <Row label={v('Price')}>{`${displayAmount(o.price)} ${quote}`}</Row>
        <Row label={v('Amount')}>{`${displayAmount(o.amount)} ${base}`}</Row>
        <Row label={v('Filled')}>{`${displayAmount(o.filled)} ${base}`}</Row>
        <Row label={t('remaining')}>{`${displayAmount(o.remaining)} ${base}`}</Row>
        <Row label={t('average')}>{o.averagePrice ? `${displayAmount(o.averagePrice)} ${quote}` : v('Not known')}</Row>
        <Row label={t('locked')}>{`${displayAmount(o.locked)} ${o.lockedAsset}`}</Row>
        {ended ? <Row label={t('reason')}>{reason}</Row> : null}
        {o.trigger ? <TriggerRows order={o} quote={quote} time={time} /> : null}
      </dl>
      <h3>{t('fills')}</h3>
      {fills.status === 'loading' ? <Loading label={t('fills')} /> : null}
      {fills.status === 'failed' ? <Failure result={fills.failure} retry={retry} /> : null}
      {fills.status === 'ready' ? (
        fills.data.length === 0 ? (
          <p className="muted">{t('noFills')}</p>
        ) : (
          <ul className="orders-fills">
            {fills.data.map((f) => (
              <li key={f.fillId} data-testid="venue-order-fill" data-fill={f.fillId}>
                <details>
                  <summary>
                    {t('fillSummary', {
                      amount: `${displayAmount(f.amount)} ${base}`,
                      price: `${displayAmount(f.price)} ${quote}`,
                      role: word(v, 'role', f.role),
                      time: time(f.filledAt),
                    })}
                  </summary>
                  <dl className="orders-list">
                    <Row label={t('fillPrice')}>{`${displayAmount(f.price)} ${quote}`}</Row>
                    <Row label={t('fillSize')}>{`${displayAmount(f.amount)} ${base}`}</Row>
                    <Row label={t('fillRole')}>{word(v, 'role', f.role)}</Row>
                    <Row label={t('venueFee')}>{`${f.venueFee} ${f.feeAsset}`}</Row>
                    <Row label={t('builderFee')}>{`${f.builderFee} ${f.feeAsset}`}</Row>
                    <Row label={t('feeAsset')}>{f.feeAsset}</Row>
                    <Row label={t('rankDiscount')}>{rankDiscount(t, ours)}</Row>
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        )
      ) : null}
      <h3>{t('changes')}</h3>
      {ours.amendments.length === 0 ? (
        <p className="muted">{t('noChanges')}</p>
      ) : (
        <ol data-testid="venue-order-changes">
          {ours.amendments.map((a) => (
            <li key={a.actionKey}>{t('changedTo', { amount: `${displayAmount(a.amount)} ${base}`, time: time(a.recordedAt) })}</li>
          ))}
        </ol>
      )}
      <AsOfLine asOf={order.data.asOf} />
      <Button variant="secondary" onClick={retry}>
        {t('refresh')}
      </Button>
    </article>
  );
}

function rankDiscount(t: ReturnType<typeof venueOrdersCopy.useCopy>['t'], ours: VenueOrderRecord): string {
  const fee = ours.builderFee;
  if (!fee || fee.discountBps === 0) return t('rankNone');
  if (fee.discountBps === null) return t('rankUnknown');
  return t('rankOff', { pct: toFixedString(dec(String(fee.discountBps))! / 100n, 2) });
}

function TriggerRows({ order, quote, time }: { order: VenueOrder; quote: string; time: (iso: string) => string }) {
  const { t } = venueOrdersCopy.useCopy();
  const trigger = order.trigger!;
  const source = word(t as unknown as V, 'source', trigger.source);
  const price = `${displayAmount(trigger.price)} ${quote}`;
  const why =
    trigger.state === 'failed'
      ? t('triggerFailed', { failure: trigger.failure ?? '' })
      : trigger.state === 'triggered' && trigger.triggeredAt
        ? t('triggerFired', { source, price, time: time(trigger.triggeredAt) })
        : t('triggerWaiting', { source, price });
  let slippage = t('slippageNotYet');
  if (order.averagePrice) {
    const diff = sub(dec(order.averagePrice)!, dec(trigger.price)!);
    // A buy is worse above its trigger price; a sell, below it.
    const worse = order.side === 'buy' ? compare(diff, 0n) > 0 : compare(diff, 0n) < 0;
    const size = diff < 0n ? -diff : diff;
    const amount = `${displayAmount(str(size))} ${quote}`;
    const pct = percentOf(str(size), trigger.price) ?? '0';
    slippage = size === 0n ? t('slippageNone') : worse ? t('slippageWorse', { amount, pct }) : t('slippageBetter', { amount, pct });
  }
  return (
    <>
      <Row label={t('trigger')}>{why}</Row>
      <Row label={t('triggerPrice')}>{price}</Row>
      <Row label={t('executionPrice')}>
        {order.averagePrice ? `${displayAmount(order.averagePrice)} ${quote}` : venueCopy.t('Not known')}
      </Row>
      <Row label={t('slippage')}>{slippage}</Row>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="orders-row" data-testid="venue-order-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
