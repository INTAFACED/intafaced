// volt-room: /trade/orders
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loading, Page } from '../../../shared/ui';
import { useVenueMode } from '../use-venue-mode';
import { Button, EmptyState, DateInput } from '@intafaced/ui/lit';
import { navigate } from '../../../app/location';
import { useDataEnv } from '../../../data/hooks';
import type { ApiResult } from '../../../shared/api';
import { FailureNote } from '../../../shared/failure-note';
import { useDeskMarkets } from '../../../screens/trade/desk/data';
import { OrdersTable, precisionOf } from '../../../screens/trade/desk/OrderTables';
import { useSession } from '../../session';
import { createTradeApi, type Order } from '../trade-api';
import { appendPage, NO_PARAMS, PAGE_SIZES, readParams, toQuery, writeParams, type HistoryParams } from './history-query';
import { ordersCopy } from './orders-copy';
import { ProductSwitch } from './FuturesOrdersRoom';
import { AssistantOrders } from './AssistantOrders';
import { VenueOrdersRoom } from './VenueOrders';
import { OrdersRoomFrame, Pick, SignedOut, WaitingRows } from './orders-parts';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type State =
  | { status: 'loading' }
  | { status: 'refused'; problem: 'filter' | 'from' | 'to' | 'range' | 'cursor' }
  | { status: 'failed'; failure: Refusal }
  | { status: 'ready'; rows: Order[]; more: boolean; repeated: number };

const SIDES = ['buy', 'sell'] as const;
const STATES = ['closed', 'canceled', 'rejected', 'expired'] as const;
const TYPES = ['market', 'limit', 'stop_limit', 'stop'] as const;

/** The service's typed refusals of a filter, which the page says in its own words. */
const FILTER_CODES: Record<string, 'filter' | 'from' | 'to' | 'range' | 'cursor'> = {
  'trade.invalid_filter': 'filter',
  'trade.invalid_since': 'from',
  'trade.invalid_until': 'to',
  'trade.invalid_cursor': 'cursor',
};

/**
 * `/trade/orders`, the one orders page the menus open (Trade > Orders, More > Order history): with venue trading
 * on, the person's venue orders, open and past, with their assistant's; otherwise the spot order history below.
 */
export function OrdersRoom({ path }: { path: string }) {
  const { t } = ordersCopy.useCopy();
  const mode = useVenueMode();
  if (mode.mode === 'checking')
    return (
      <Page eyebrow={t('eyebrow')} title={t('historyTitle')}>
        <Loading label={t('loading')} />
      </Page>
    );
  if (mode.mode === 'on') return <VenueOrdersRoom path={path} assistant={<AssistantOrders t={t} revision={0} />} />;
  return <OrderHistoryRoom path={path} />;
}

/** The spot half's address: `?product=spot` once the plain address may open the venue half. */
function spotAddress(path: string, query: string): string {
  if (new URL(path, location.origin).searchParams.get('product') !== 'spot') return `/trade/orders${query}`;
  return query === '' ? '/trade/orders?product=spot' : `/trade/orders?product=spot&${query.slice(1)}`;
}

/**
 * Order history (`/trade/orders`, `/trade/orders?product=spot`): the orders that have ended, filtered by side, state, type and dates by the service
 * itself, a page at a time. The filters live in the address, so a link keeps them and a mistyped one is refused in words.
 */
export function OrderHistoryRoom({ path }: { path: string }) {
  const { t } = ordersCopy.useCopy();
  const { api, userId } = useSession();
  const tradeApi = useMemo(() => createTradeApi(api), [api]);
  const env = useDataEnv();
  const markets = useDeskMarkets();
  const marketList = markets.status === 'ready' ? markets.data : null;
  const precision = useMemo(() => precisionOf(marketList ?? []), [marketList]);
  const search = new URL(path, location.origin).search;
  const params = useMemo(() => readParams(search), [search]);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const reads = useRef(0);

  const key = `${writeParams(params)}:${revision}:${userId ?? 'out'}`;
  useEffect(() => {
    if (!userId) return;
    const ticket = ++reads.current;
    const outcome = toQuery(params);
    setOlderFailed(false);
    if (!outcome.ok) {
      setState({ status: 'refused', problem: outcome.problem });
      return;
    }
    setState({ status: 'loading' });
    const controller = new AbortController();
    env.poller.recordExternalRequest();
    void tradeApi.orderHistory(outcome.query, controller.signal).then((result) => {
      if (ticket !== reads.current) return;
      if (result.ok) setState({ status: 'ready', rows: result.data, more: result.data.length === params.size, repeated: 0 });
      else if (result.code && FILTER_CODES[result.code]) setState({ status: 'refused', problem: FILTER_CODES[result.code]! });
      else setState({ status: 'failed', failure: result });
    });
    return () => controller.abort();
  }, [key]);

  function setParams(next: HistoryParams) {
    navigate(spotAddress(path, writeParams(next)), true);
  }

  async function older() {
    if (state.status !== 'ready' || olderBusy) return;
    const last = state.rows[state.rows.length - 1];
    const outcome = toQuery(params, last?.id);
    if (!outcome.ok || !last) return;
    const ticket = reads.current;
    setOlderBusy(true);
    setOlderFailed(false);
    env.poller.recordExternalRequest();
    const result = await tradeApi.orderHistory(outcome.query);
    setOlderBusy(false);
    if (ticket !== reads.current) return;
    if (!result.ok) {
      if (result.code === 'trade.invalid_cursor') setState({ status: 'refused', problem: 'cursor' });
      else setOlderFailed(true);
      return;
    }
    const { rows, repeated } = appendPage(state.rows, result.data);
    setState({ status: 'ready', rows, more: result.data.length === params.size, repeated: state.repeated + repeated });
  }

  if (!userId)
    return (
      <OrdersRoomFrame
        title={t('historyTitle')}
        description={t('historyLead')}
        list={<SignedOut title={t('signedOutTitle')} body={t('signedOutBody')} signIn={t('signIn')} back={`/trade/orders${search}`} />}
      />
    );

  const filtering = writeParams({ ...params, size: NO_PARAMS.size }) !== '';
  const refusedWords = {
    filter: t('refusedFilter'),
    from: t('refusedFrom'),
    to: t('refusedTo'),
    range: t('refusedRange'),
    cursor: t('refusedCursor'),
  } as const;
  const pickWords = { all: t('filterAll'), unknown: (value: string) => t('filterUnknown', { value }) };
  return (
    <OrdersRoomFrame
      title={t('historyTitle')}
      description={t('historyLead')}
      action={<Button onClick={() => setRevision((n) => n + 1)}>{t('refresh')}</Button>}
      filters={
        <div className="lt-stack">
          <ProductSwitch product="spot" />
          <form className="lt-toolbar" role="search" aria-label={t('historyTitle')} onSubmit={(event) => event.preventDefault()}>
            <Pick
              label={t('filterSide')}
              value={params.side}
              choices={SIDES}
              words={{ buy: t('sideBuy'), sell: t('sideSell') }}
              onPick={(side) => setParams({ ...params, side })}
              {...pickWords}
            />
            <Pick
              label={t('filterState')}
              value={params.status}
              choices={STATES}
              words={{ closed: t('stateFilled'), canceled: t('stateCancelled'), rejected: t('stateRejected'), expired: t('stateExpired') }}
              onPick={(status) => setParams({ ...params, status })}
              {...pickWords}
            />
            <Pick
              label={t('filterType')}
              value={params.type}
              choices={TYPES}
              words={{ market: t('typeMarket'), limit: t('typeLimit'), stop_limit: t('typeStopLimit'), stop: t('typeStopMarket') }}
              onPick={(type) => setParams({ ...params, type })}
              {...pickWords}
            />
            <label className="lt-field">
              <span>{t('filterFrom')}</span>
              <DateInput type="date" value={params.from} onChange={(event) => setParams({ ...params, from: event.target.value })} />
            </label>
            <label className="lt-field">
              <span>{t('filterTo')}</span>
              <DateInput type="date" value={params.to} onChange={(event) => setParams({ ...params, to: event.target.value })} />
            </label>
            <label className="lt-field">
              <span>{t('filterSize')}</span>
              <select value={String(params.size)} onChange={(event) => setParams({ ...params, size: Number(event.target.value) })}>
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={String(size)}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            {filtering ? <Button onClick={() => setParams({ ...NO_PARAMS, size: params.size })}>{t('filterClear')}</Button> : null}
          </form>
          <p className="lt-hint">
            {t('openOrders')}{' '}
            <a className="lt-link" href="/exchange">
              {t('tradingDesk')}
            </a>
          </p>
        </div>
      }
      list={
        <>
          {state.status === 'loading' ? <WaitingRows label={t('loading')} /> : null}
          {state.status === 'failed' ? <FailureNote result={state.failure} retry={() => setRevision((n) => n + 1)} /> : null}
          {state.status === 'refused' ? (
            <div data-testid="failure" className="lt-refusal" role="alert">
              <p className="lt-refusal-title">{t('refusedTitle')}</p>
              <p className="lt-refusal-body">{refusedWords[state.problem]}</p>
              <Button onClick={() => setParams({ ...NO_PARAMS, size: params.size })}>{t('filterClear')}</Button>
            </div>
          ) : null}
          {state.status === 'ready' ? (
            state.rows.length === 0 ? (
              <EmptyState title={filtering ? t('none') : t('noneAtAll')} />
            ) : (
              <>
                <p className="lt-hint" role="status">
                  {t('shownCount', { count: String(state.rows.length) })}
                </p>
                <div data-testid="orders-table" className="lt-table-scroll">
                  <OrdersTable rows={state.rows} withAction={false} desk precision={precision} onChanged={() => undefined} />
                </div>
                {state.repeated > 0 ? <p className="lt-hint">{t('repeated')}</p> : null}
                {olderFailed ? (
                  <p className="lt-hint" data-part="error" role="alert">
                    {t('olderFailed')}
                  </p>
                ) : null}
                {state.more ? (
                  <Button disabled={olderBusy} aria-busy={olderBusy || undefined} onClick={() => void older()}>
                    {olderBusy ? t('olderLoading') : t('older')}
                  </Button>
                ) : (
                  <p className="lt-hint">{t('end')}</p>
                )}
              </>
            )
          ) : null}
          <AssistantOrders t={t} revision={revision} />
        </>
      }
    />
  );
}
