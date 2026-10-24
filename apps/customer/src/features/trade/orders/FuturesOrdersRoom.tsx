import { useEffect, useMemo, useRef, useState } from 'react';
import { Amount, Badge, Button, ChoiceGroup, Price, Table, type TableColumn } from '@intafaced/ui';
import { navigate } from '../../../app/location';
import { fmtAmount, fmtPrice } from '../../../data/format';
import { useDataEnv } from '../../../data/hooks';
import type { ApiResult } from '../../../shared/api';
import { usePreferences } from '../../../shared/preferences';
import { EmptyState, Failure, Loading, Page } from '../../../shared/ui';
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
import { useSession } from '../../session/session';
import { futuresOrdersCopy, type FuturesOrdersT } from './futures-orders-copy';
import { ordersCopy } from './orders-copy';
import './orders.css';

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
export function ProductSwitch({ product }: { product: 'spot' | 'futures' }) {
  const { t } = futuresOrdersCopy.useCopy();
  return (
    <ChoiceGroup
      items={['spot', 'futures']}
      value={product}
      label={t('productLabel')}
      labels={{ spot: t('productSpot'), futures: t('productFutures') }}
      onChange={(next) => navigate(next === 'futures' ? '/trade/orders?product=futures' : '/trade/orders', true)}
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
      const seen = new Set(execState.rows.map((row) => row.id));
      setExecState({
        status: 'ready',
        rows: [...execState.rows, ...result.data.executions.filter((row) => !seen.has(row.id))],
        next: result.data.next,
      });
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
      <Page eyebrow={orders('eyebrow')} title={t('title')} description={t('lead')}>
        <EmptyState
          title={orders('signedOutTitle')}
          action={
            <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(`/trade/orders${search}`)}`}>
              {orders('signIn')}
            </a>
          }
        >
          {orders('signedOutBody')}
        </EmptyState>
      </Page>
    );

  const time = (iso: string | undefined) => (iso ? dayTime(Date.parse(iso), timeZone) : '');
  const side = (s: 'buy' | 'sell') => (
    <Badge variant="outline" tone={s === 'buy' ? 'up' : 'down'}>
      {s === 'buy' ? t('buy') : t('sell')}
    </Badge>
  );
  const detailsHref = (orderId: string) => `/trade/orders/${encodeURIComponent(orderId)}?product=futures`;

  const orderColumns: TableColumn<FuturesOrder>[] = [
    { id: 'placed', header: t('colPlaced'), value: (o) => time(o.createdAt) },
    { id: 'contract', header: t('colContract'), value: (o) => o.symbol ?? o.marketId },
    {
      id: 'side',
      header: t('colSide'),
      cell: (o) => (
        <span className="flex items-center gap-1">
          {side(o.side)}
          {o.reduceOnly ? <Badge>{t('reduceOnly')}</Badge> : null}
        </span>
      ),
    },
    { id: 'type', header: t('colType'), value: (o) => (o.type === 'limit' ? t('limit') : t('market')) },
    { id: 'price', header: t('colPrice'), numeric: true, cell: (o) => <Price value={fmtPrice(o.limitPrice, undefined)} /> },
    { id: 'size', header: t('colSize'), numeric: true, cell: (o) => <Amount value={fmtAmount(o.qty, { places: 8 })} /> },
    { id: 'filled', header: t('colFilled'), numeric: true, cell: (o) => <Amount value={fmtAmount(o.filledQty, { places: 8 })} /> },
    { id: 'held', header: t('colHeld'), numeric: true, cell: (o) => <Amount value={fmtAmount(o.holdAmount, { places: 4 })} /> },
    { id: 'from', header: t('colFrom'), cell: (o) => <FuturesOrderOrigin origin={o.origin} label={o.orderLabel} /> },
    { id: 'status', header: t('colStatus'), cell: (o) => <FuturesOrderStatus order={o} /> },
    {
      id: 'action',
      header: t('colAction'),
      cell: (o) => (
        <span className="flex items-center gap-2">
          <a className="text-link" href={detailsHref(o.orderId)}>
            {t('details')}
          </a>
          {cancellable(o) ? (
            <Button variant="secondary" size={28} loading={cancelling === o.orderId} onClick={() => void cancel(o)}>
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
  const execColumns: TableColumn<FuturesExecution>[] = [
    { id: 'time', header: t('colTime'), value: (e) => time(e.at) },
    { id: 'contract', header: t('colContract'), value: (e) => e.symbol },
    {
      id: 'kind',
      header: t('colKind'),
      cell: (e) => <Badge tone={e.kind === 'liquidation' || e.kind === 'adl' ? 'down' : 'neutral'}>{kindWord[e.kind]}</Badge>,
    },
    { id: 'side', header: t('colSide'), cell: (e) => side(e.side) },
    { id: 'size', header: t('colSize'), numeric: true, cell: (e) => <Amount value={fmtAmount(e.qty, { places: 8 })} /> },
    { id: 'price', header: t('colPrice'), numeric: true, cell: (e) => <Price value={fmtPrice(e.price, undefined)} /> },
    {
      id: 'fee',
      header: t('colFee'),
      numeric: true,
      value: (e) =>
        e.fee === null
          ? t('feeNone')
          : e.feeRole
            ? t('feeWithRole', { fee: fmtAmount(e.fee, { places: 6 }), role: e.feeRole === 'maker' ? t('roleMaker') : t('roleTaker') })
            : fmtAmount(e.fee, { places: 6 }),
    },
    {
      id: 'realized',
      header: t('colRealized'),
      numeric: true,
      value: (e) => (e.realizedPnl === null ? t('realizedNone') : fmtAmount(e.realizedPnl, { places: 6 })),
    },
    { id: 'from', header: t('colFrom'), cell: (e) => (e.origin ? <FuturesOrderOrigin origin={e.origin} label={e.orderLabel} /> : null) },
    {
      id: 'order',
      header: t('colOrder'),
      cell: (e) =>
        e.orderId ? (
          <a className="text-link" href={detailsHref(e.orderId)}>
            {t('details')}
          </a>
        ) : null,
    },
  ];

  const filtering = params.symbol !== '' || params.origin !== '' || params.label !== '' || params.kind !== '';
  const state = params.view === 'executions' ? execState : orderState;
  const none = filtering
    ? t('noneFiltered')
    : params.view === 'open'
      ? t('noneOpen')
      : params.view === 'history'
        ? t('noneHistory')
        : t('noneExecutions');
  const labelBad = labelDraft !== '' && !ORDER_LABEL.test(labelDraft);

  return (
    <Page
      eyebrow={orders('eyebrow')}
      title={t('title')}
      description={t('lead')}
      actions={
        <Button variant="secondary" size={40} onClick={() => setRevision((n) => n + 1)}>
          {t('refresh')}
        </Button>
      }
    >
      <div className="orders-room">
        <ProductSwitch product="futures" />
        <ChoiceGroup
          items={VIEWS}
          value={params.view}
          label={t('viewLabel')}
          labels={{ open: t('viewOpen'), history: t('viewHistory'), executions: t('viewExecutions') }}
          onChange={(view) => setParams({ ...params, view: view as View })}
        />
        <form
          className="orders-filters"
          role="search"
          aria-label={t('title')}
          onSubmit={(event) => {
            event.preventDefault();
            if (!labelBad)
              setParams({ ...params, symbol: symbolDraft.trim(), label: params.view === 'executions' ? '' : labelDraft.trim() });
          }}
        >
          <label className="orders-field">
            <span>{t('filterContract')}</span>
            <input value={symbolDraft} onChange={(event) => setSymbolDraft(event.target.value)} />
          </label>
          {params.view === 'executions' ? (
            <label className="orders-field">
              <span>{t('filterKind')}</span>
              <select value={params.kind} onChange={(event) => setParams({ ...params, kind: event.target.value })}>
                <option value="">{t('filterAll')}</option>
                {FUTURES_EXECUTION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kindWord[kind]}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label className="orders-field">
                <span>{t('filterOrigin')}</span>
                <select value={params.origin} onChange={(event) => setParams({ ...params, origin: event.target.value })}>
                  <option value="">{t('filterAll')}</option>
                  {FUTURES_ORDER_ORIGINS.map((origin) => (
                    <option key={origin} value={origin}>
                      {tabs(`Origin ${origin}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="orders-field">
                <span>{t('filterLabel')}</span>
                <input
                  value={labelDraft}
                  maxLength={36}
                  aria-invalid={labelBad}
                  aria-describedby="futures-label-hint"
                  onChange={(event) => setLabelDraft(event.target.value)}
                />
                <small id="futures-label-hint" className="muted">
                  {labelBad ? t('refusedLabel') : t('labelHint')}
                </small>
              </label>
            </>
          )}
          <Button type="submit" variant="secondary" size={40} disabled={labelBad}>
            {t('filterApply')}
          </Button>
          {filtering ? (
            <Button
              variant="secondary"
              size={40}
              onClick={() => setParams({ view: params.view, symbol: '', origin: '', label: '', kind: '' })}
            >
              {t('filterClear')}
            </Button>
          ) : null}
        </form>
        <p className="muted orders-note">
          <a className="text-link" href="/trade/futures">
            {t('deskLink')}
          </a>
        </p>
        {cancelFailure ? (
          <p className="orders-note orders-note--bad" role="alert">
            {t('cancelFailed', { reason: cancelFailure })}
          </p>
        ) : null}
        {state.status === 'loading' ? <Loading label={params.view === 'executions' ? t('loadingExecutions') : t('loadingOrders')} /> : null}
        {state.status === 'failed' ? <Failure result={state.failure} retry={() => setRevision((n) => n + 1)} /> : null}
        {state.status === 'refused' ? (
          <div className="failure" role="alert">
            <h3>{t('refusedTitle')}</h3>
            <p>{state.words}</p>
            <Button
              variant="secondary"
              size={40}
              onClick={() => setParams({ view: params.view, symbol: '', origin: '', label: '', kind: '' })}
            >
              {t('filterClear')}
            </Button>
          </div>
        ) : null}
        {state.status === 'ready' ? (
          state.rows.length === 0 ? (
            <EmptyState title={none} />
          ) : (
            <>
              <p className="muted orders-note" role="status">
                {t('shownCount', { count: String(state.rows.length) })}
              </p>
              <div className="orders-table">
                {params.view === 'executions' ? (
                  <Table
                    label={t('viewExecutions')}
                    density="dense"
                    columns={execColumns}
                    rows={execState.status === 'ready' ? execState.rows : []}
                    getRowId={(e) => e.id}
                  />
                ) : (
                  <Table
                    label={params.view === 'open' ? t('viewOpen') : t('viewHistory')}
                    density="dense"
                    columns={orderColumns}
                    rows={orderState.status === 'ready' ? orderState.rows : []}
                    getRowId={(o) => o.orderId}
                  />
                )}
              </div>
              {olderFailed ? (
                <p className="orders-note" role="alert">
                  {t('olderFailed')}
                </p>
              ) : null}
              {state.next ? (
                <Button variant="secondary" size={40} loading={olderBusy} onClick={() => void older()}>
                  {olderBusy ? t('olderLoading') : t('older')}
                </Button>
              ) : (
                <p className="muted orders-note">{t('end')}</p>
              )}
              <p className="muted orders-note">{t('footer')}</p>
            </>
          )
        ) : null}
      </div>
    </Page>
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
