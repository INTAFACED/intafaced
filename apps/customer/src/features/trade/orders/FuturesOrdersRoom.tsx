import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Segmented, Tag } from '@intafaced/ui/lit';
import { Table, type Column } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import { fmtAmount, fmtPrice } from '../../../data/format';
import { useDataEnv } from '../../../data/hooks';
import type { ApiResult } from '../../../shared/api';
import { usePreferences } from '../../../shared/preferences';
import { FailureNote } from '../../../shared/failure-note';
import { dayTime } from '../../../screens/trade/desk/time';
import {
  FUTURES_EXECUTION_KINDS,
  FUTURES_ORDER_ORIGINS,
  ORDER_LABEL,
  type FuturesExecution,
  type FuturesOrder,
} from '../../../screens/trade/futures/api';
import { useFuturesApi } from '../../../screens/trade/futures/data';
import { cancellable, FuturesOrderOrigin, FuturesOrderStatus } from '../../../screens/trade/futures/OrderStatus';
import { futuresRefusal } from '../../../screens/trade/futures/refusals';
import { tabsCopy } from '../../../screens/trade/futures/tabs-copy';
import { useSession } from '../../session';
import { futuresOrdersCopy, type FuturesOrdersT } from './futures-orders-copy';
import { appendPage } from './history-query';
import { ordersCopy } from './orders-copy';
import { venueOrdersCopy } from './venue-orders-copy';
import { OrdersRoomFrame, Pick, SignedOut, WaitingRows } from './orders-parts';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type View = 'open' | 'history' | 'executions';
const VIEWS: readonly View[] = ['open', 'history', 'executions'];
const PAGE = 50;

/** The room's filters, as the address holds them (`/trade/orders?product=futures&view=history&origin=stop`). */
export interface FuturesParams {
  readonly view: View;
  readonly symbol: string;
  readonly origin: string;
  readonly label: string;
  readonly kind: string;
}

export function readFuturesParams(search: string): FuturesParams {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  return {
    view: VIEWS.includes(view as View) ? (view as View) : 'open',
    symbol: params.get('symbol') ?? '',
    origin: params.get('origin') ?? '',
    label: params.get('label') ?? '',
    kind: params.get('kind') ?? '',
  };
}

export function writeFuturesParams(params: FuturesParams): string {
  const out = new URLSearchParams({ product: 'futures' });
  if (params.view !== 'open') out.set('view', params.view);
  for (const key of ['symbol', 'origin', 'label', 'kind'] as const) if (params[key] !== '') out.set(key, params[key]);
  return `?${out.toString()}`;
}

/** Spot or futures orders: the two halves of the orders room, each with its own address. */
export function ProductSwitch({ product }: { product: 'spot' | 'futures' | 'venue' }) {
  const { t } = futuresOrdersCopy.useCopy();
  const venue = venueOrdersCopy.useCopy().t;
  return (
    <Segmented
      options={[
        { value: 'spot', label: t('productSpot') },
        { value: 'futures', label: t('productFutures') },
        { value: 'venue', label: venue('productVenue') },
      ]}
      value={product}
      label={t('productLabel')}
      onChange={(next) => navigate(next === 'spot' ? '/trade/orders' : `/trade/orders?product=${next}`, true)}
    />
  );
}

type State<T> =
  | { status: 'loading' }
  | { status: 'refused'; words: string }
  | { status: 'failed'; failure: Refusal }
  | { status: 'ready'; rows: T[]; next: string | null };

/** The service's typed refusals of a filter, said in the room's own words. */
function refusedWords(code: string | undefined, t: FuturesOrdersT): string | null {
  if (code === 'trade.invalid_filter') return t('refusedFilter');
  if (code === 'trade.order_label_invalid') return t('refusedLabel');
  if (code === 'trade.invalid_cursor') return t('refusedCursor');
  return null;
}

/**
 * The futures half of the orders room (J-derivatives-04 step 1): open orders with cancel, ended orders, and executions,
 * a page at a time, filtered by the service itself by contract, origin and label. An order's state and origin are the
 * desk's own words, so an order reads the same in both places.
 */
export function FuturesOrdersRoom({ path }: { path: string }) {
  const { t } = futuresOrdersCopy.useCopy();
  const tabs = tabsCopy.useCopy().t;
  const orders = ordersCopy.useCopy().t;
  const { userId } = useSession();
  const api = useFuturesApi();
  const env = useDataEnv();
  const { timeZone } = usePreferences();
  const search = new URL(path, location.origin).search;
  const params = useMemo(() => readFuturesParams(search), [search]);
  const [labelDraft, setLabelDraft] = useState(params.label);
  const [symbolDraft, setSymbolDraft] = useState(params.symbol);
  const [orderState, setOrderState] = useState<State<FuturesOrder>>({ status: 'loading' });
  const [execState, setExecState] = useState<State<FuturesExecution>>({ status: 'loading' });
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelFailure, setCancelFailure] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reads = useRef(0);

  useEffect(() => setLabelDraft(params.label), [params.label]);
  useEffect(() => setSymbolDraft(params.symbol), [params.symbol]);

  const key = `${writeFuturesParams(params)}:${revision}:${userId ?? 'out'}`;
  useEffect(() => {
    if (!userId) return;
    const ticket = ++reads.current;
    const controller = new AbortController();
    setOlderFailed(false);
    env.poller.recordExternalRequest();
    if (params.view === 'executions') {
      setExecState({ status: 'loading' });
      void api
        .executions(
          { limit: PAGE, ...(params.symbol ? { symbol: params.symbol } : {}), ...(params.kind ? { kind: params.kind } : {}) },
          controller.signal,
        )
        .then((result) => {
          if (ticket !== reads.current) return;
          if (result.ok) setExecState({ status: 'ready', rows: result.data.executions, next: result.data.next });
          else {
            const words = refusedWords(result.code, t);
            setExecState(words ? { status: 'refused', words } : { status: 'failed', failure: result });
          }
        });
    } else {
      setOrderState({ status: 'loading' });
      void api.orderPage(orderQuery(params), controller.signal).then((result) => {
        if (ticket !== reads.current) return;
        if (result.ok) {
          const last = result.data[result.data.length - 1];
          setOrderState({ status: 'ready', rows: result.data, next: result.data.length === PAGE && last ? last.orderId : null });
        } else {
          const words = refusedWords(result.code, t);
          setOrderState(words ? { status: 'refused', words } : { status: 'failed', failure: result });
        }
      });
    }
    return () => controller.abort();
  }, [key]);

  const setParams = (next: FuturesParams) => navigate(`/trade/orders${writeFuturesParams(next)}`, true);

  async function older() {
    if (olderBusy) return;
    const ticket = reads.current;
    setOlderBusy(true);
    setOlderFailed(false);
    env.poller.recordExternalRequest();
    if (params.view === 'executions') {
      if (execState.status !== 'ready' || !execState.next) return setOlderBusy(false);
      const result = await api.executions({
        limit: PAGE,
        before: execState.next,
        ...(params.symbol ? { symbol: params.symbol } : {}),
        ...(params.kind ? { kind: params.kind } : {}),
      });
      setOlderBusy(false);
      if (ticket !== reads.current) return;
      if (!result.ok) return setOlderFailed(true);
      setExecState({ status: 'ready', rows: appendPage(execState.rows, result.data.executions).rows, next: result.data.next });
      return;
    }
    if (orderState.status !== 'ready' || !orderState.next) return setOlderBusy(false);
    const result = await api.orderPage({ ...orderQuery(params), before: orderState.next });
    setOlderBusy(false);
    if (ticket !== reads.current) return;
    if (!result.ok) return setOlderFailed(true);
    const seen = new Set(orderState.rows.map((row) => row.orderId));
    const last = result.data[result.data.length - 1];
    setOrderState({
      status: 'ready',
      rows: [...orderState.rows, ...result.data.filter((row) => !seen.has(row.orderId))],
      next: result.data.length === PAGE && last ? last.orderId : null,
    });
  }

  async function cancel(order: FuturesOrder) {
    setCancelling(order.orderId);
    setCancelFailure(null);
    // Safe to press twice: the id names the one order, and an order already off the book answers as it stands.
    const result = await api.cancelOrder(order.orderId);
    setCancelling(null);
    if (!result.ok) setCancelFailure(futuresRefusal(result).title);
    setRevision((n) => n + 1);
  }

  if (!userId)
    return (
      <OrdersRoomFrame
        title={t('title')}
        description={t('lead')}
        list={
          <SignedOut
            title={orders('signedOutTitle')}
            body={orders('signedOutBody')}
            signIn={orders('signIn')}
            back={`/trade/orders${search}`}
          />
        }
      />
    );

  const time = (iso: string | undefined) => (iso ? dayTime(Date.parse(iso), timeZone) : '');
  const side = (s: 'buy' | 'sell') => <Tag tone={s === 'buy' ? 'up' : 'down'}>{s === 'buy' ? t('buy') : t('sell')}</Tag>;
  const detailsHref = (orderId: string) => `/trade/orders/${encodeURIComponent(orderId)}?product=futures`;
  const figure = (text: string) => <span className="lt-num">{text}</span>;

  const orderColumns: Column<FuturesOrder>[] = [
    { key: 'placed', label: t('colPlaced'), cell: (o) => time(o.createdAt) },
    { key: 'contract', label: t('colContract'), cell: (o) => o.symbol ?? o.marketId },
    {
      key: 'side',
      label: t('colSide'),
      cell: (o) => (
        <span className="lt-actions">
          {side(o.side)}
          {o.reduceOnly ? <Tag tone="neutral">{t('reduceOnly')}</Tag> : null}
        </span>
      ),
    },
    { key: 'type', label: t('colType'), cell: (o) => (o.type === 'limit' ? t('limit') : t('market')) },
    { key: 'price', label: t('colPrice'), align: 'end', cell: (o) => figure(fmtPrice(o.limitPrice, undefined)) },
    { key: 'size', label: t('colSize'), align: 'end', cell: (o) => figure(fmtAmount(o.qty, { places: 8 })) },
    { key: 'filled', label: t('colFilled'), align: 'end', cell: (o) => figure(fmtAmount(o.filledQty, { places: 8 })) },
    { key: 'held', label: t('colHeld'), align: 'end', cell: (o) => figure(fmtAmount(o.holdAmount, { places: 4 })) },
    { key: 'from', label: t('colFrom'), cell: (o) => <FuturesOrderOrigin origin={o.origin} label={o.orderLabel} /> },
    { key: 'status', label: t('colStatus'), cell: (o) => <FuturesOrderStatus order={o} /> },
    {
      key: 'action',
      label: t('colAction'),
      cell: (o) => (
        <span className="lt-actions">
          <a className="lt-link" href={detailsHref(o.orderId)}>
            {t('details')}
          </a>
          {cancellable(o) ? (
            <Button disabled={cancelling === o.orderId} aria-busy={cancelling === o.orderId || undefined} onClick={() => void cancel(o)}>
              {t('cancel')}
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  const kindWord: Record<string, string> = {
    open: t('kindOpen'),
    close: t('kindClose'),
    liquidation: t('kindLiquidation'),
    adl: t('kindAdl'),
  };
  const execColumns: Column<FuturesExecution>[] = [
    { key: 'time', label: t('colTime'), cell: (e) => time(e.at) },
    { key: 'contract', label: t('colContract'), cell: (e) => e.symbol },
    {
      key: 'kind',
      label: t('colKind'),
      cell: (e) => <Tag tone={e.kind === 'liquidation' || e.kind === 'adl' ? 'down' : 'neutral'}>{kindWord[e.kind]}</Tag>,
    },
    { key: 'side', label: t('colSide'), cell: (e) => side(e.side) },
    { key: 'size', label: t('colSize'), align: 'end', cell: (e) => figure(fmtAmount(e.qty, { places: 8 })) },
    { key: 'price', label: t('colPrice'), align: 'end', cell: (e) => figure(fmtPrice(e.price, undefined)) },
    {
      key: 'fee',
      label: t('colFee'),
      align: 'end',
      cell: (e) =>
        e.fee === null
          ? t('feeNone')
          : e.feeRole
            ? t('feeWithRole', { fee: fmtAmount(e.fee, { places: 6 }), role: e.feeRole === 'maker' ? t('roleMaker') : t('roleTaker') })
            : fmtAmount(e.fee, { places: 6 }),
    },
    {
      key: 'realized',
      label: t('colRealized'),
      align: 'end',
      cell: (e) => (e.realizedPnl === null ? t('realizedNone') : fmtAmount(e.realizedPnl, { places: 6 })),
    },
    { key: 'from', label: t('colFrom'), cell: (e) => (e.origin ? <FuturesOrderOrigin origin={e.origin} label={e.orderLabel} /> : null) },
    {
      key: 'order',
      label: t('colOrder'),
      cell: (e) =>
        e.orderId ? (
          <a className="lt-link" href={detailsHref(e.orderId)}>
            {t('details')}
          </a>
        ) : null,
    },
  ];

  const filtering =
    params.symbol !== '' || (params.view === 'executions' ? params.kind !== '' : params.origin !== '' || params.label !== '');
  const state = params.view === 'executions' ? execState : orderState;
  const none = filtering
    ? t('noneFiltered')
    : params.view === 'open'
      ? t('noneOpen')
      : params.view === 'history'
        ? t('noneHistory')
        : t('noneExecutions');
  const labelBad = labelDraft !== '' && !ORDER_LABEL.test(labelDraft);
  const clear = () => setParams({ view: params.view, symbol: '', origin: '', label: '', kind: '' });
  const originWords = Object.fromEntries(FUTURES_ORDER_ORIGINS.map((origin) => [origin, tabs(`Origin ${origin}`)]));

  return (
    <OrdersRoomFrame
      title={t('title')}
      description={t('lead')}
      action={<Button onClick={() => setRevision((n) => n + 1)}>{t('refresh')}</Button>}
      filters={
        <div className="lt-stack">
          <ProductSwitch product="futures" />
          <Segmented
            options={VIEWS.map((view) => ({
              value: view,
              label: view === 'open' ? t('viewOpen') : view === 'history' ? t('viewHistory') : t('viewExecutions'),
            }))}
            value={params.view}
            label={t('viewLabel')}
            onChange={(view) =>
              // Executions filter by contract and kind; orders by contract, origin and label. A filter the next view can't
              // use is dropped, so nothing hidden narrows the list.
              setParams(view === 'executions' ? { ...params, view, origin: '', label: '' } : { ...params, view, kind: '' })
            }
          />
          <form
            className="lt-toolbar"
            role="search"
            aria-label={t('title')}
            onSubmit={(event) => {
              event.preventDefault();
              if (!labelBad)
                setParams({ ...params, symbol: symbolDraft.trim(), label: params.view === 'executions' ? '' : labelDraft.trim() });
            }}
          >
            <label className="lt-field">
              <span>{t('filterContract')}</span>
              <input value={symbolDraft} onChange={(event) => setSymbolDraft(event.target.value)} />
            </label>
            {params.view === 'executions' ? (
              <Pick
                label={t('filterKind')}
                value={params.kind}
                choices={FUTURES_EXECUTION_KINDS}
                words={kindWord}
                all={t('filterAll')}
                onPick={(kind) => setParams({ ...params, kind })}
              />
            ) : (
              <>
                <Pick
                  label={t('filterOrigin')}
                  value={params.origin}
                  choices={FUTURES_ORDER_ORIGINS}
                  words={originWords}
                  all={t('filterAll')}
                  onPick={(origin) => setParams({ ...params, origin })}
                />
                <label className="lt-field">
                  <span>{t('filterLabel')}</span>
                  <input
                    value={labelDraft}
                    maxLength={36}
                    aria-invalid={labelBad}
                    aria-describedby="futures-label-hint"
                    onChange={(event) => setLabelDraft(event.target.value)}
                  />
                  <small id="futures-label-hint" className="lt-hint" data-part={labelBad ? 'error' : undefined}>
                    {labelBad ? t('refusedLabel') : t('labelHint')}
                  </small>
                </label>
              </>
            )}
            <Button type="submit" disabled={labelBad}>
              {t('filterApply')}
            </Button>
            {filtering ? <Button onClick={clear}>{t('filterClear')}</Button> : null}
          </form>
          <p className="lt-hint">
            <a className="lt-link" href="/trade/futures">
              {t('deskLink')}
            </a>
          </p>
        </div>
      }
      list={
        <>
          {cancelFailure ? (
            <p className="lt-hint" data-part="error" role="alert">
              {t('cancelFailed', { reason: cancelFailure })}
            </p>
          ) : null}
          {state.status === 'loading' ? (
            <WaitingRows label={params.view === 'executions' ? t('loadingExecutions') : t('loadingOrders')} />
          ) : null}
          {state.status === 'failed' ? <FailureNote result={state.failure} retry={() => setRevision((n) => n + 1)} /> : null}
          {state.status === 'refused' ? (
            <div className="lt-refusal" role="alert">
              <p className="lt-refusal-title">{t('refusedTitle')}</p>
              <p className="lt-refusal-body">{state.words}</p>
              <Button onClick={clear}>{t('filterClear')}</Button>
            </div>
          ) : null}
          {state.status === 'ready' ? (
            state.rows.length === 0 ? (
              <EmptyState title={none} />
            ) : (
              <>
                <p className="lt-hint" role="status">
                  {t('shownCount', { count: String(state.rows.length) })}
                </p>
                <div className="lt-table-scroll">
                  {params.view === 'executions' ? (
                    <Table
                      caption={t('viewExecutions')}
                      mode="pro"
                      columns={execColumns}
                      rows={execState.status === 'ready' ? execState.rows : []}
                      rowKey={(e) => e.id}
                    />
                  ) : (
                    <Table
                      caption={params.view === 'open' ? t('viewOpen') : t('viewHistory')}
                      mode="pro"
                      columns={orderColumns}
                      rows={orderState.status === 'ready' ? orderState.rows : []}
                      rowKey={(o) => o.orderId}
                    />
                  )}
                </div>
                {olderFailed ? (
                  <p className="lt-hint" data-part="error" role="alert">
                    {t('olderFailed')}
                  </p>
                ) : null}
                {state.next ? (
                  <Button disabled={olderBusy} aria-busy={olderBusy || undefined} onClick={() => void older()}>
                    {olderBusy ? t('olderLoading') : t('older')}
                  </Button>
                ) : (
                  <p className="lt-hint">{t('end')}</p>
                )}
                <p className="lt-hint">{t('footer')}</p>
              </>
            )
          ) : null}
        </>
      }
    />
  );
}

function orderQuery(params: FuturesParams) {
  return {
    scope: params.view === 'history' ? ('history' as const) : ('open' as const),
    limit: PAGE,
    ...(params.symbol ? { symbol: params.symbol } : {}),
    ...(params.origin ? { origin: params.origin } : {}),
    ...(params.label ? { label: params.label } : {}),
  };
}
