import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@intafaced/ui';
import { navigate } from '../../../app/location';
import { useDataEnv } from '../../../data/hooks';
import type { ApiResult } from '../../../shared/api';
import { EmptyState, Failure, Loading, Page } from '../../../shared/ui';
import { useDeskMarkets } from '../../../screens/trade/desk/data';
import { OrdersTable, precisionOf } from '../../../screens/trade/desk/OrderTables';
import { useSession } from '../../session/session';
import { createTradeApi, type Order } from '../trade-api';
import { appendPage, NO_PARAMS, PAGE_SIZES, readParams, toQuery, writeParams, type HistoryParams } from './history-query';
import { ordersCopy, type OrdersT } from './orders-copy';
import './orders.css';

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

function Pick({
  label,
  value,
  choices,
  words,
  onPick,
  t,
}: {
  label: string;
  value: string;
  choices: readonly string[];
  words: Record<string, string>;
  onPick: (value: string) => void;
  t: OrdersT;
}) {
  // A value the address holds that is not a choice stays visible as it is, so the refusal below names something real.
  const unknown = value !== '' && !choices.includes(value);
  return (
    <label className="orders-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onPick(event.target.value)}>
        <option value="">{t('filterAll')}</option>
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {words[choice]}
          </option>
        ))}
        {unknown ? <option value={value}>{t('filterUnknown', { value })}</option> : null}
      </select>
    </label>
  );
}

/**
 * Order history (`/trade/orders`): the orders that have ended, filtered by side, state, type and dates by the service
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
    navigate(`/trade/orders${writeParams(next)}`, true);
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
      <Page eyebrow={t('eyebrow')} title={t('historyTitle')} description={t('historyLead')}>
        <EmptyState
          title={t('signedOutTitle')}
          action={
            <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(`/trade/orders${search}`)}`}>
              {t('signIn')}
            </a>
          }
        >
          {t('signedOutBody')}
        </EmptyState>
      </Page>
    );

  const filtering = writeParams({ ...params, size: NO_PARAMS.size }) !== '';
  const refusedWords = {
    filter: t('refusedFilter'),
    from: t('refusedFrom'),
    to: t('refusedTo'),
    range: t('refusedRange'),
    cursor: t('refusedCursor'),
  } as const;
  return (
    <Page
      eyebrow={t('eyebrow')}
      title={t('historyTitle')}
      description={t('historyLead')}
      actions={
        <Button variant="secondary" size={40} onClick={() => setRevision((n) => n + 1)}>
          {t('refresh')}
        </Button>
      }
    >
      <div className="orders-room">
        <form className="orders-filters" role="search" aria-label={t('historyTitle')} onSubmit={(event) => event.preventDefault()}>
          <Pick
            label={t('filterSide')}
            value={params.side}
            choices={SIDES}
            words={{ buy: t('sideBuy'), sell: t('sideSell') }}
            onPick={(side) => setParams({ ...params, side })}
            t={t}
          />
          <Pick
            label={t('filterState')}
            value={params.status}
            choices={STATES}
            words={{ closed: t('stateFilled'), canceled: t('stateCancelled'), rejected: t('stateRejected'), expired: t('stateExpired') }}
            onPick={(status) => setParams({ ...params, status })}
            t={t}
          />
          <Pick
            label={t('filterType')}
            value={params.type}
            choices={TYPES}
            words={{ market: t('typeMarket'), limit: t('typeLimit'), stop_limit: t('typeStopLimit'), stop: t('typeStopMarket') }}
            onPick={(type) => setParams({ ...params, type })}
            t={t}
          />
          <label className="orders-field">
            <span>{t('filterFrom')}</span>
            <input type="date" value={params.from} onChange={(event) => setParams({ ...params, from: event.target.value })} />
          </label>
          <label className="orders-field">
            <span>{t('filterTo')}</span>
            <input type="date" value={params.to} onChange={(event) => setParams({ ...params, to: event.target.value })} />
          </label>
          <label className="orders-field">
            <span>{t('filterSize')}</span>
            <select value={String(params.size)} onChange={(event) => setParams({ ...params, size: Number(event.target.value) })}>
              {PAGE_SIZES.map((size) => (
                <option key={size} value={String(size)}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          {filtering ? (
            <Button variant="secondary" size={40} onClick={() => setParams({ ...NO_PARAMS, size: params.size })}>
              {t('filterClear')}
            </Button>
          ) : null}
        </form>
        <p className="muted orders-note">
          {t('openOrders')}{' '}
          <a className="text-link" href="/exchange">
            {t('tradingDesk')}
          </a>
        </p>
        {state.status === 'loading' ? <Loading label={t('loading')} /> : null}
        {state.status === 'failed' ? <Failure result={state.failure} retry={() => setRevision((n) => n + 1)} /> : null}
        {state.status === 'refused' ? (
          <div data-testid="failure" className="failure" role="alert">
            <h3>{t('refusedTitle')}</h3>
            <p>{refusedWords[state.problem]}</p>
            <Button variant="secondary" size={40} onClick={() => setParams({ ...NO_PARAMS, size: params.size })}>
              {t('filterClear')}
            </Button>
          </div>
        ) : null}
        {state.status === 'ready' ? (
          state.rows.length === 0 ? (
            <EmptyState title={filtering ? t('none') : t('noneAtAll')} />
          ) : (
            <>
              <p className="muted orders-note" role="status">
                {t('shownCount', { count: String(state.rows.length) })}
              </p>
              <div data-testid="orders-table" className="orders-table">
                <OrdersTable rows={state.rows} withAction={false} desk precision={precision} onChanged={() => undefined} />
              </div>
              {state.repeated > 0 ? <p className="orders-note">{t('repeated')}</p> : null}
              {olderFailed ? (
                <p className="orders-note" role="alert">
                  {t('olderFailed')}
                </p>
              ) : null}
              {state.more ? (
                <Button variant="secondary" size={40} loading={olderBusy} onClick={() => void older()}>
                  {olderBusy ? t('olderLoading') : t('older')}
                </Button>
              ) : (
                <p className="muted orders-note">{t('end')}</p>
              )}
            </>
          )
        ) : null}
      </div>
    </Page>
  );
}
