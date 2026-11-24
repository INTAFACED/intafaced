import { useMemo, useState, type ReactNode } from 'react';
import { navigate } from '../../../app/location';
import { compare, dec, ratio, str, sub, times, toFixedString } from '../../../data/decimal';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Loading, Page } from '../../../shared/ui';
import { useSession } from '../../session';
import { zoneName } from '../../../screens/trade/desk/time';
import { useVenueMode } from '../use-venue-mode';
import {
  keys,
  type VenueFill,
  type VenueHistoryPage,
  type VenueHistoryQuery,
  type VenueLiquidation,
  type VenueOrder,
  type VenueOrderOrigin,
  type VenueOrderRecord,
} from '../venue-api';
import {
  AsOfLine,
  OutcomeLine,
  TestMark,
  VenueFrame,
  WalletBar,
  heldKeys,
  useOwner,
  useVenueActions,
  useVenueApi,
  word,
  type ActionResult,
} from '../venue/VenueKit';
import { venueCopy } from '../venue/venue-copy';
import { ProductSwitch } from './FuturesOrdersRoom';
import { venueOrdersCopy } from './venue-orders-copy';
import './orders.css';
import { DateInput, Field, Segmented } from '@intafaced/ui/lit';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type VenueOrdersView = 'open' | 'history' | 'executions';
const VENUE_VIEWS: readonly VenueOrdersView[] = ['open', 'history', 'executions'];
const VENUE_ORIGINS: readonly VenueOrderOrigin[] = ['user', 'stop', 'take_profit', 'liquidation', 'adl'];
const ORDER_LABEL = /^[A-Za-z0-9._:-]{1,36}$/;

/** A venue client order id (`0x` and 32 hex): the address `/trade/orders/<id>` of a venue order, never an engine order id. */
export const VENUE_ORDER_ID = /^0x[0-9a-f]{32}$/i;

/** The venue orders room's query params (`/trade/orders?product=venue&view=history&side=sell&status=filled`). */
export interface VenueHistoryParams {
  readonly view: VenueOrdersView;
  readonly side: string;
  readonly status: string;
  readonly origin: string;
  readonly label: string;
  /** Local calendar days, `YYYY-MM-DD`. */
  readonly from: string;
  readonly to: string;
  readonly size: string;
}

export function readVenueParams(search: string): VenueHistoryParams {
  const p = new URLSearchParams(search);
  const rawView = p.get('view');
  return {
    view: VENUE_VIEWS.includes(rawView as VenueOrdersView) ? (rawView as VenueOrdersView) : 'history',
    side: p.get('side') ?? '',
    status: p.get('status') ?? '',
    origin: p.get('origin') ?? '',
    label: p.get('label') ?? '',
    from: p.get('from') ?? '',
    to: p.get('to') ?? '',
    size: p.get('size') ?? '',
  };
}

function writeVenueParams(params: VenueHistoryParams): string {
  const out = new URLSearchParams({ product: 'venue' });
  if (params.view !== 'history') out.set('view', params.view);
  for (const key of ['side', 'status', 'origin', 'label', 'from', 'to', 'size'] as const) if (params[key] !== '') out.set(key, params[key]);
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
  if (params.origin) q.origin = params.origin;
  if (params.label) q.label = params.label;
  if (params.from) q.from = dayStart(params.from, 0);
  if (params.to) q.to = dayStart(params.to, 1);
  if (params.size) q.limit = params.size;
  if (before) q.before = before;
  return q;
}

function orderOrigin(o: Pick<VenueOrder, 'origin' | 'trigger'>): VenueOrderOrigin {
  if (o.origin) return o.origin;
  if (o.trigger) return o.trigger.role === 'take_profit' ? 'take_profit' : 'stop';
  return 'user';
}

function originWord(t: ReturnType<typeof venueOrdersCopy.useCopy>['t'], origin: VenueOrderOrigin): string {
  return t(`origin_${origin}` as 'origin_user');
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

interface VenueRoomContext {
  readonly owner: string;
  readonly test: boolean;
  readonly venueName: string;
  readonly cancelsPerAction: number;
}

/** Venue mode, the wallet and the TEST label around a venue orders page; the body gets the connected owner and venue info. */
function VenueOrdersFrame({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: (ctx: VenueRoomContext) => ReactNode;
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
            <a className="lt-button lt-button-primary" href={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`}>
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
  const venueName = mode.status.available ? mode.status.venue.displayName : '';
  const cancelsPerAction = mode.status.available ? (mode.status.cancelsPerAction ?? 0) : 0;
  return (
    <VenueFrame mode={mode}>
      <Page eyebrow={t('eyebrow')} title={title} actions={actions}>
        <TestMark test={test} />
        <WalletBar />
        <Owned>{(owner) => children({ owner, test, venueName, cancelsPerAction })}</Owned>
      </Page>
    </VenueFrame>
  );
}

function Owned({ children }: { children: (owner: string) => ReactNode }) {
  const { t } = venueOrdersCopy.useCopy();
  const owner = useOwner();
  if (!owner) return <p className="lt-muted">{t('connectFirst')}</p>;
  return <>{children(owner)}</>;
}

type HistoryState =
  | { status: 'loading' }
  | { status: 'refused'; words: string }
  | { status: 'failed'; failure: Refusal }
  | { status: 'ready'; rows: VenueHistoryPage['orders']; next: string | null; asOf: string; venueName?: string; loadingMore: boolean };

/**
 * The venue orders room (`/trade/orders?product=venue`, J-cex-spot-06 #1 #7; J-derivatives-04 #1 #2): open orders,
 * order history and trades & executions on the person's own venue account, naming each order's venue, origin and label,
 * with the same status words as the trading desks. Defaults to Order history when `?view` is absent.
 */
export function VenueOrdersRoom({ path }: { path: string }) {
  const { t } = venueOrdersCopy.useCopy();
  const search = new URL(path, location.origin).search;
  const params = useMemo(() => readVenueParams(search), [search]);
  const title = params.view === 'open' ? t('viewOpen') : params.view === 'executions' ? t('viewExecutions') : t('historyTitle');
  return (
    <VenueOrdersFrame
      title={title}
      actions={
        <a className="lt-link" href="/trade/spot/BTC-USDC">
          {t('deskLink')}
        </a>
      }
    >
      {(ctx) => (
        <div className="lt-stack">
          <ProductSwitch product="venue" />
          <Segmented
            options={[
              { value: 'open', label: t('viewOpen') },
              { value: 'history', label: t('viewHistory') },
              { value: 'executions', label: t('viewExecutions') },
            ]}
            value={params.view}
            label={t('viewLabel')}
            onChange={(view) => navigate(`/trade/orders${writeVenueParams({ ...params, view: view as VenueOrdersView })}`, true)}
          />
          {params.view === 'open' ? (
            <VenueOpenOrders ctx={ctx} />
          ) : params.view === 'executions' ? (
            <VenueExecutions ctx={ctx} />
          ) : (
            <VenueHistory path={path} ctx={ctx} />
          )}
        </div>
      )}
    </VenueOrdersFrame>
  );
}

function VenueOpenOrders({ ctx }: { ctx: VenueRoomContext }) {
  const { owner, test, venueName, cancelsPerAction } = ctx;
  const { t } = venueOrdersCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const api = useVenueApi();
  const { run } = useVenueActions(owner);
  const keysHeld = useMemo(() => heldKeys(owner), [owner]);
  const [round, setRound] = useState(0);
  const [cancelResult, setCancelResult] = useState<ActionResult | null>(null);
  const { resource } = useResource((signal) => api.openOrders(owner, signal), `venue-open-orders:${owner}:${round}`);

  function cancelOrder(o: VenueOrder) {
    const id = o.venueClientOrderId;
    if (!id) return;
    const key = keysHeld.get(id);
    const done = (r: ActionResult) => {
      setCancelResult(r);
      setRound((n) => n + 1);
    };
    if (key) void run({ kind: 'cancel_order', symbol: o.symbol, clientOrderKey: key }).then(done);
    else if (cancelsPerAction >= 1)
      void run(
        { kind: 'cancel_orders', orders: [{ symbol: o.symbol, venueClientOrderId: id }] },
        { actionKey: keys.cancelBatch(owner, `one-${id.slice(2)}`) },
      ).then(done);
  }

  return (
    <section data-testid="venue-open-orders">
      <p className="lt-muted">{t('openLead')}</p>
      <OutcomeLine result={cancelResult} owner={owner} />
      {resource.status === 'loading' ? <Loading label={t('viewOpen')} /> : null}
      {resource.status === 'failed' ? <Failure result={resource.failure} retry={() => setRound((n) => n + 1)} /> : null}
      {resource.status === 'ready' ? (
        resource.data.value.length === 0 ? (
          <p className="lt-muted">{t('noneOpen')}</p>
        ) : (
          <>
            <TestMark test={test} />
            <DataTable
              label={t('viewOpen')}
              headers={[
                v('Venue'),
                v('Market'),
                v('Side'),
                v('Type'),
                v('Price'),
                v('Amount'),
                v('Filled'),
                v('Locked'),
                t('origin'),
                v('Status'),
                '',
              ]}
            >
              {resource.data.value.map((o) => {
                const origin = orderOrigin(o);
                const id = o.venueClientOrderId;
                const canCancel =
                  Boolean(id) &&
                  (o.status === 'open' || o.status === 'partially_filled') &&
                  origin !== 'liquidation' &&
                  Boolean((id && keysHeld.get(id)) || cancelsPerAction >= 1);
                return (
                  <tr key={id ?? o.venueOrderId ?? `${o.symbol}:${o.price}`} data-client-order-id={id ?? ''}>
                    <td data-cell="venue">{venueName || resource.data.venueId}</td>
                    <td>{o.symbol}</td>
                    <td>{word(v, 'side', o.side)}</td>
                    <td>{word(v, 'type', o.type)}</td>
                    <td className="lt-num">{displayAmount(o.price)}</td>
                    <td className="lt-num">{displayAmount(o.amount)}</td>
                    <td className="lt-num">{displayAmount(o.filled)}</td>
                    <td className="lt-num">{`${displayAmount(o.locked)} ${o.lockedAsset}`}</td>
                    <td data-cell="origin" data-origin={origin}>
                      {originWord(t, origin)}
                      {o.label ? (
                        <>
                          {' '}
                          <span data-cell="label">{o.label}</span>
                        </>
                      ) : null}
                    </td>
                    <td data-cell="status">{word(v, 'status', o.status)}</td>
                    <td>
                      <span className="lt-actions">
                        {id ? (
                          <a className="lt-link" data-testid="venue-order-link" href={`/trade/orders/${id}`}>
                            {t('open')}
                          </a>
                        ) : null}
                        {canCancel ? (
                          <Button variant="secondary" onClick={() => cancelOrder(o)}>
                            {v('Cancel')}
                          </Button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
            <AsOfLine asOf={resource.data.asOf} />
          </>
        )
      ) : null}
    </section>
  );
}

function VenueHistory({ path, ctx }: { path: string; ctx: VenueRoomContext }) {
  const { owner, test, venueName } = ctx;
  const { t } = venueOrdersCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const api = useVenueApi();
  const time = useDayTime();
  const search = new URL(path, location.origin).search;
  const params = useMemo(() => readVenueParams(search), [search]);
  // `round` is the Refresh count: a new round, or new filters, reads the first page again and drops the older pages read.
  const [round, setRound] = useState(0);
  const [draft, setDraft] = useState<{ base: string; value: string }>({ base: params.label, value: params.label });
  const labelDraft = draft.base === params.label ? draft.value : params.label;
  const labelBad = labelDraft.trim() !== '' && !ORDER_LABEL.test(labelDraft.trim());
  const key = `venue-history:${owner}:${search}:${round}`;
  const { resource } = useResource((signal) => api.orderHistory(owner, historyQuery(params, null), signal), key);
  const [more, setMore] = useState<{ key: string; state: HistoryState } | null>(null);
  const refused = (failure: Refusal): HistoryState =>
    failure.code === 'trade.invalid_filter' || failure.code === 'trade.order_label_invalid'
      ? { status: 'refused', words: failure.message }
      : failure.code === 'trade.invalid_cursor'
        ? { status: 'refused', words: t('refusedCursor') }
        : { status: 'failed', failure };
  const first: HistoryState =
    resource.status === 'loading'
      ? { status: 'loading' }
      : resource.status === 'failed'
        ? refused(resource.failure)
        : {
            status: 'ready',
            rows: resource.data.orders,
            next: resource.data.next,
            asOf: resource.data.asOf,
            venueName: resource.data.venueName,
            loadingMore: false,
          };
  const state = more && more.key === key && resource.status === 'ready' ? more.state : first;
  const setState = (next: HistoryState) => setMore({ key, state: next });
  const set = (next: Partial<VenueHistoryParams>) => navigate(`/trade/orders${writeVenueParams({ ...params, ...next })}`, true);

  async function older() {
    if (state.status !== 'ready' || !state.next || state.loadingMore) return;
    setState({ ...state, loadingMore: true });
    const result = await api.orderHistory(owner, historyQuery(params, state.next));
    if (!result.ok) {
      setState(refused(result));
      return;
    }
    const seen = new Set(state.rows.map((r) => r.order.venueClientOrderId));
    const added = result.data.orders.filter((r) => !seen.has(r.order.venueClientOrderId));
    setState({
      status: 'ready',
      rows: [...state.rows, ...added],
      next: result.data.next,
      asOf: result.data.asOf,
      venueName: result.data.venueName ?? state.venueName,
      loadingMore: false,
    });
  }

  const select = (label: string, value: string, options: [string, string][], onChange: (value: string) => void) => (
    <label className="lt-field">
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
  const shownVenue = (state.status === 'ready' ? state.venueName : undefined) || venueName;
  return (
    <section data-testid="venue-history">
      <p className="lt-muted">{t('historyLead')}</p>
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
        {select(
          t('origin'),
          params.origin,
          [['', t('allStates')], ...VENUE_ORIGINS.map((o): [string, string] => [o, originWord(t, o)])],
          (origin) => set({ origin }),
        )}
        <label className="lt-field">
          <span>{t('from')}</span>
          <DateInput type="date" aria-label={t('from')} value={params.from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className="lt-field">
          <span>{t('to')}</span>
          <DateInput type="date" aria-label={t('to')} value={params.to} onChange={(e) => set({ to: e.target.value })} />
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
        <Field
          label={t('label')}
          value={labelDraft}
          maxLength={36}
          hint={labelBad ? undefined : t('labelHint')}
          error={labelBad ? t('refusedLabel') : undefined}
          onChange={(e) => setDraft({ base: params.label, value: e.target.value })}
        />
        <Button variant="secondary" disabled={labelBad} onClick={() => !labelBad && set({ label: labelDraft.trim() })}>
          {t('apply')}
        </Button>
      </div>
      {state.status === 'loading' ? <Loading label={t('historyTitle')} /> : null}
      {state.status === 'refused' ? (
        <div role="alert" className="lt-refusal">
          <strong>{t('refusedTitle')}</strong>
          <p>{state.words}</p>
        </div>
      ) : null}
      {state.status === 'failed' ? <Failure result={state.failure} retry={() => setRound((n) => n + 1)} /> : null}
      {state.status === 'ready' ? (
        state.rows.length === 0 ? (
          <p className="lt-muted">{t('none')}</p>
        ) : (
          <>
            <TestMark test={test} />
            <DataTable
              label={t('historyTitle')}
              headers={[
                t('placed'),
                v('Venue'),
                v('Market'),
                v('Side'),
                v('Type'),
                v('Price'),
                v('Amount'),
                v('Filled'),
                t('origin'),
                v('Status'),
                '',
              ]}
            >
              {state.rows.map(({ order: o, placedAt }) => {
                const origin = orderOrigin(o);
                return (
                  <tr key={o.venueClientOrderId ?? o.venueOrderId ?? placedAt} data-client-order-id={o.venueClientOrderId ?? ''}>
                    <td>{time(placedAt)}</td>
                    <td data-cell="venue">{shownVenue}</td>
                    <td>{o.symbol}</td>
                    <td>{word(v, 'side', o.side)}</td>
                    <td>{word(v, 'type', o.type)}</td>
                    <td className="lt-num">{displayAmount(o.price)}</td>
                    <td className="lt-num">{displayAmount(o.amount)}</td>
                    <td className="lt-num">{displayAmount(o.filled)}</td>
                    <td data-cell="origin" data-origin={origin}>
                      {originWord(t, origin)}
                      {o.label ? (
                        <>
                          {' '}
                          <span data-cell="label">{o.label}</span>
                        </>
                      ) : null}
                    </td>
                    <td data-cell="status">{word(v, 'status', o.status)}</td>
                    <td>
                      {o.venueClientOrderId ? (
                        <a className="lt-link" data-testid="venue-order-link" href={`/trade/orders/${o.venueClientOrderId}`}>
                          {t('open')}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
            <p>{t('shownCount', { count: state.rows.length })}</p>
            {state.next ? (
              <Button variant="secondary" disabled={state.loadingMore} onClick={() => void older()}>
                {t('older')}
              </Button>
            ) : (
              <p className="lt-muted">{t('end')}</p>
            )}
            <AsOfLine asOf={state.asOf} />
          </>
        )
      ) : null}
    </section>
  );
}

type ExecutionRow =
  | { kind: 'trade'; at: string; fill: VenueFill }
  | { kind: 'liquidation'; at: string; symbol: string; side: 'buy' | 'sell'; part: VenueLiquidation['parts'][number] };

function VenueExecutions({ ctx }: { ctx: VenueRoomContext }) {
  const { owner, test, venueName } = ctx;
  const { t } = venueOrdersCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const api = useVenueApi();
  const time = useDayTime();
  const [round, setRound] = useState(0);
  const { resource } = useResource(async (signal) => {
    const [fills, liqs] = await Promise.all([api.fills(owner, new Date(0).toISOString(), signal), api.liquidations(owner, signal)]);
    if (!fills.ok) return fills;
    const rows: ExecutionRow[] = fills.data.value.map((fill) => ({ kind: 'trade', at: fill.filledAt, fill }));
    if (liqs.ok) {
      for (const l of liqs.data.value) {
        const side = l.side === 'long' ? 'sell' : 'buy';
        for (const part of l.parts) rows.push({ kind: 'liquidation', at: part.liquidatedAt, symbol: l.symbol, side, part });
      }
    }
    rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { ok: true as const, data: { venueId: fills.data.venueId, asOf: fills.data.asOf, rows } };
  }, `venue-executions:${owner}:${round}`);

  return (
    <section data-testid="venue-executions">
      <p className="lt-muted">{t('executionsLead')}</p>
      {resource.status === 'loading' ? <Loading label={t('viewExecutions')} /> : null}
      {resource.status === 'failed' ? <Failure result={resource.failure} retry={() => setRound((n) => n + 1)} /> : null}
      {resource.status === 'ready' ? (
        resource.data.rows.length === 0 ? (
          <p className="lt-muted">{t('noneExecutions')}</p>
        ) : (
          <>
            <TestMark test={test} />
            <DataTable
              label={t('viewExecutions')}
              headers={[
                v('Time'),
                v('Venue'),
                v('Market'),
                t('kind'),
                v('Side'),
                v('Price'),
                v('Amount'),
                v('Role'),
                v('Venue fee'),
                v('Our builder fee'),
                v('Realised result'),
                t('order'),
              ]}
            >
              {resource.data.rows.map((row) =>
                row.kind === 'trade' ? (
                  <tr key={`fill:${row.fill.fillId}`} data-fill={row.fill.fillId} data-client-order-id={row.fill.venueClientOrderId ?? ''}>
                    <td>{time(row.at)}</td>
                    <td data-cell="venue">{venueName || resource.data.venueId}</td>
                    <td>{row.fill.symbol}</td>
                    <td data-cell="kind">{t('kindTrade')}</td>
                    <td>{word(v, 'side', row.fill.side)}</td>
                    <td className="lt-num" data-cell="price">
                      {displayAmount(row.fill.price)}
                    </td>
                    <td className="lt-num" data-cell="amount">
                      {displayAmount(row.fill.amount)}
                    </td>
                    <td data-cell="role">{word(v, 'role', row.fill.role)}</td>
                    <td className="lt-num" data-cell="venue-fee">{`${row.fill.venueFee} ${row.fill.feeAsset}`}</td>
                    <td className="lt-num" data-cell="builder-fee">{`${row.fill.builderFee} ${row.fill.feeAsset}`}</td>
                    <td className="lt-num" data-cell="realised">
                      {row.fill.realisedPnl === null ? v('Not known') : row.fill.realisedPnl}
                    </td>
                    <td>
                      {row.fill.venueClientOrderId ? (
                        <a className="lt-link" data-testid="venue-order-link" href={`/trade/orders/${row.fill.venueClientOrderId}`}>
                          {t('open')}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ) : (
                  <tr key={`liq:${row.part.partId}`} data-part={row.part.partId}>
                    <td>{time(row.at)}</td>
                    <td data-cell="venue">{venueName || resource.data.venueId}</td>
                    <td>{row.symbol}</td>
                    <td data-cell="kind">{t('kindLiquidation')}</td>
                    <td>{word(v, 'side', row.side)}</td>
                    <td className="lt-num" data-cell="price">
                      {displayAmount(row.part.price)}
                    </td>
                    <td className="lt-num" data-cell="amount">
                      {displayAmount(row.part.size)}
                    </td>
                    <td data-cell="role">{t('kindLiquidation')}</td>
                    <td className="lt-num" data-cell="venue-fee">{`${row.part.fee} ${row.part.feeAsset}`}</td>
                    <td className="lt-num" data-cell="builder-fee">{`0 ${row.part.feeAsset}`}</td>
                    <td className="lt-num" data-cell="realised">
                      {v('Not known')}
                    </td>
                    <td />
                  </tr>
                ),
              )}
            </DataTable>
            <p>{t('executionsCount', { count: resource.data.rows.length })}</p>
            <AsOfLine asOf={resource.data.asOf} />
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
 * One venue order (`/trade/orders/<venue client order id>`, J-cex-spot-06 #2 #4 #5 #6 #9 #10; J-derivatives-04 #2):
 * its venue, origin (you, stop, take profit, liquidation) and any label, its state, its fills with each fill's price,
 * size, role, the venue's fee and our builder fee as separate lines, the fee asset and any rank discount on our fee;
 * why a trigger order fired, its trigger price against its execution price and the slippage between them; and every
 * amendment the venue accepted, with its time. Every figure is the venue's, as it reports it now: an amendment still
 * waiting for the venue's answer leaves the old amount here. An order the venue has no record of on this account
 * (another person's, or none) reads "Order not found", the same either way.
 */
export function VenueOrderDetail({ clientOrderId }: { clientOrderId: string }) {
  const { t } = venueOrdersCopy.useCopy();
  return (
    <VenueOrdersFrame
      title={t('historyTitle')}
      actions={
        <a className="lt-link" href="/trade/orders?product=venue">
          {t('historyTitle')}
        </a>
      }
    >
      {(ctx) => <VenueOrderBody owner={ctx.owner} clientOrderId={clientOrderId.toLowerCase()} test={ctx.test} venueName={ctx.venueName} />}
    </VenueOrdersFrame>
  );
}

function VenueOrderBody({
  owner,
  clientOrderId,
  test,
  venueName,
}: {
  owner: string;
  clientOrderId: string;
  test: boolean;
  venueName: string;
}) {
  const { t } = venueOrdersCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const api = useVenueApi();
  const time = useDayTime();
  const [round, setRound] = useState(0);
  const key = `${owner}:${clientOrderId}:${round}`;
  const order = useResource((signal) => api.orderByClientId(owner, clientOrderId, signal), `venue-order:${key}`).resource;
  // Our record of the order, then the venue's fills since it was placed, kept to this order.
  const record = useResource(async (signal) => {
    const ours = await api.orderRecord(owner, clientOrderId, signal);
    if (!ours.ok) return ours;
    const read = await api.fills(owner, ours.data.placedAt ?? new Date(0).toISOString(), signal);
    const fills: Read<VenueFill[]> = read.ok
      ? { status: 'ready', data: read.data.value.filter((f) => f.venueClientOrderId === clientOrderId) }
      : { status: 'failed', failure: read };
    return { ok: true as const, data: { ours: ours.data, fills } };
  }, `venue-order-record:${key}`).resource;
  // The price unit is the market's own quote asset as the venue lists it: a perpetual's symbol (BTC-PERP) doesn't name it.
  const markets = useResource((signal) => api.markets(signal), `venue-markets:${round}`).resource;
  const retry = () => setRound((n) => n + 1);
  const missing = (
    <EmptyState title={t('notFoundTitle')}>
      <p>{t('notFoundBody')}</p>
    </EmptyState>
  );
  if (order.status === 'loading' || record.status === 'loading') return <Loading label={t('historyTitle')} />;
  if (order.status === 'failed') return <Failure result={order.failure} retry={retry} />;
  if (!order.data.value || (record.status === 'failed' && record.failure.code === 'trade.venue_order_not_found')) return missing;
  if (record.status === 'failed') return <Failure result={record.failure} retry={retry} />;
  const o = order.data.value;
  const { ours, fills } = record.data;
  const market = markets.status === 'ready' ? markets.data.value.find((m) => m.symbol === o.symbol) : undefined;
  const quote = market ? market.quoteAsset : '';
  const base = o.symbol.split('-')[0] ?? '';
  const ended = o.status === 'canceled' || o.status === 'rejected' || o.status === 'expired';
  const origin = o.origin ?? ours.origin ?? orderOrigin(o);
  const originRef = o.originRef ?? ours.originRef ?? null;
  const label = o.label ?? ours.label ?? null;
  const shownVenue = ours.venueName || venueName || order.data.venueId;
  const reason =
    o.cancelReason === 'position_closed'
      ? t('reasonPositionClosed')
      : o.cancelReason === 'linked'
        ? t('reasonLinked')
        : o.cancelReason === 'self_trade'
          ? t('reasonSelfTrade')
          : o.status === 'rejected' && o.trigger?.failure
            ? t('reasonRejected', { failure: o.trigger.failure })
            : t('reasonNotRecorded');
  return (
    <article data-testid="venue-order">
      <h2 data-testid="venue-order-heading">
        {t('detailHeading', { side: word(v, 'side', o.side), symbol: o.symbol })}{' '}
        <span data-cell="status">{word(v, 'status', o.status)}</span> <TestMark test={test} />
      </h2>
      <dl className="orders-list" data-testid="venue-order-facts">
        <Row label={v('Venue')}>{shownVenue}</Row>
        <Row label={t('origin')}>{originWord(t, origin)}</Row>
        {originRef ? (
          <Row label={t('originRef')}>
            {origin === 'liquidation' ? t('originRefLiquidation', { ref: originRef }) : t('originRefOther', { ref: originRef })}
          </Row>
        ) : null}
        <Row label={t('label')}>{label ?? t('labelNone')}</Row>
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
      {fills.status === 'failed' ? <Failure result={fills.failure} retry={retry} /> : null}
      {fills.status === 'ready' ? (
        fills.data.length === 0 ? (
          <p className="lt-muted">{t('noFills')}</p>
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
        <p className="lt-muted">{t('noChanges')}</p>
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

/** The venue's trigger price source in our words; a source we have no words for reads as the venue names it. */
function sourceWord(t: ReturnType<typeof venueOrdersCopy.useCopy>['t'], source: string): string {
  if (source === 'mark') return t('source_mark');
  if (source === 'last') return t('source_last');
  if (source === 'oracle') return t('source_oracle');
  return source;
}

function TriggerRows({ order, quote, time }: { order: VenueOrder; quote: string; time: (iso: string) => string }) {
  const { t } = venueOrdersCopy.useCopy();
  const trigger = order.trigger!;
  const source = sourceWord(t, trigger.source);
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
