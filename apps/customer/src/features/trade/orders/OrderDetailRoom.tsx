import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import { Button } from '@intafaced/ui';
import { dec } from '../../../data/decimal';
import { fmtAmount, fmtPct, fmtPrice } from '../../../data/format';
import { useDataEnv } from '../../../data/hooks';
import { refusalCopy } from '../../../data/refusals';
import type { ApiResult } from '../../../shared/api';
import { usePreferences } from '../../../shared/preferences';
import { EmptyState, Failure, Loading, Page } from '../../../shared/ui';
import { deskCopy } from '../../../screens/trade/desk/copy';
import { useDeskMarkets } from '../../../screens/trade/desk/data';
import { fillFeeRate, fillRole } from '../../../screens/trade/desk/fill-detail';
import { changeLine } from '../../../screens/trade/desk/order-changes';
import { baseOf, orderStatus, precisionOf, quoteOf, type Precision } from '../../../screens/trade/desk/OrderTables';
import { quotePlaces } from '../../../screens/trade/desk/text';
import { dayTime } from '../../../screens/trade/desk/time';
import { useSession } from '../../session/session';
import { createTradeApi, isTerminalOrder, ORDER_TRADES_LIMIT, type Order, type OrderChange } from '../trade-api';
import { orderReason } from './order-reason';
import { fillsAverage, orderTrigger, type Slippage } from './order-trigger';
import { ordersCopy, type OrdersT } from './orders-copy';
import './orders.css';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Read<T> = { status: 'loading' } | { status: 'failed'; failure: Refusal } | { status: 'ready'; data: T };
type Cancelled = { tone: 'good'; text: string } | { tone: 'bad'; text: string };

const isZero = (value: string): boolean => /^0*(\.0*)?$/.test(value);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-testid="orders-row" className="orders-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The rank discount as the person reads it: "None" at zero, a percentage otherwise, "Not stated" when the wire has none. */
function discountText(rate: string | undefined, t: OrdersT): string {
  if (rate === undefined) return t('notStated');
  return isZero(rate) ? t('discountNone') : fmtPct(rate, { signed: false });
}

function Reason({ order, t }: { order: Order; t: OrdersT }) {
  const reason = orderReason(order);
  if (reason.kind === 'none') return null;
  const text =
    reason.kind === 'not-recorded' ? t('reasonNotRecorded') : reason.kind === 'known' ? t(reason.key) : refusalCopy(reason.code).title;
  return <Row label={t('reason')}>{text}</Row>;
}

/** The slippage line: against the person ("worse") or for them ("better"), without the sign; none or not known in words. */
function slippageText(s: Slippage | 'not-filled' | 'unknown', price: (value: string) => string, quote: string, t: OrdersT): string {
  if (s === 'not-filled') return t('slippageNotFilled');
  if (s === 'unknown') return t('notStated');
  if (isZero(s.amount)) return t('slippageNone');
  const better = s.amount.startsWith('-');
  const words = {
    amount: price(s.amount.replace(/^-/, '')),
    quote,
    pct: fmtPct(s.rate.replace(/^-/, ''), { signed: false }),
  };
  return better ? t('slippageBetter', words) : t('slippageWorse', words);
}

/** A stop order's trigger: its stop price, whether it fired, when and at what price, and how far its fills landed. */
function Trigger({
  order,
  average,
  tick,
  quote,
  t,
}: {
  order: Order;
  average: string | null;
  tick: string | undefined;
  quote: string;
  t: OrdersT;
}) {
  const { timeZone } = usePreferences();
  const state = orderTrigger(order, isTerminalOrder(order), average);
  if (state.kind === 'not-stop') return null;
  const price = (value: string) => fmtPrice(value, tick);
  let fired: ReactNode;
  let slippage: ReactNode = null;
  if (state.kind === 'not-stated') fired = t('notStated');
  else if (state.kind === 'waiting') fired = t('triggerWaiting', { price: price(state.stopPrice), quote });
  else if (state.kind === 'not-recorded') fired = t('triggerNotRecorded');
  else {
    const reference = state.by === 'mark' ? t('referenceMark') : state.by === 'index' ? t('referenceIndex') : t('referenceLast');
    fired = t('triggerFired', { time: dayTime(Date.parse(state.at), timeZone), reference, price: price(state.referencePrice), quote });
    const text = slippageText(state.slippage, price, quote, t);
    slippage = (
      <Row label={t('slippage')}>
        <span className="if-num">{text}</span>
      </Row>
    );
  }
  return (
    <>
      <Row label={t('stopPrice')}>
        <span className="if-num">
          {price(state.stopPrice)} {quote}
        </span>
      </Row>
      <Row label={t('trigger')}>
        <span className="if-num">{fired}</span>
      </Row>
      {slippage}
    </>
  );
}

/** One fill, opened for its detail: price, amount, total, role, fee, fee asset, fee rate and the order's rank discount. */
function Fill({ fill, order, precision, t }: { fill: Trade; order: Order; precision: Precision; t: OrdersT }) {
  const { timeZone } = usePreferences();
  const quote = quoteOf(fill.symbol);
  const amount = fmtAmount(fill.amount, { places: precision.lotOf(fill.symbol) });
  const price = fmtPrice(fill.price, precision.tickOf(fill.symbol));
  const role = fillRole(fill);
  const rate = fillFeeRate(fill);
  return (
    <li>
      <details data-testid="orders-fill" className="orders-fill">
        <summary>
          <span className="if-num">{dayTime(fill.timestamp, timeZone)}</span>{' '}
          <span className="if-num">{t('fillSummary', { amount: `${amount} ${baseOf(fill.symbol)}`, price: `${price} ${quote}` })}</span>
        </summary>
        <dl data-testid="orders-list" className="orders-list">
          <Row label={t('fillTime')}>
            <span className="if-num">{dayTime(fill.timestamp, timeZone)}</span>
          </Row>
          <Row label={t('price')}>
            <span className="if-num">
              {price} {quote}
            </span>
          </Row>
          <Row label={t('amount')}>
            <span className="if-num">
              {amount} {baseOf(fill.symbol)}
            </span>
          </Row>
          <Row label={t('total')}>
            <span className="if-num">
              {fmtAmount(fill.cost, { places: quotePlaces(quote), fixed: true })} {quote}
            </span>
          </Row>
          <Row label={t('fillRole')}>{role === 'maker' ? t('roleMaker') : role === 'taker' ? t('roleTaker') : t('roleUnknown')}</Row>
          <Row label={t('fillFee')}>
            <span className="if-num">{fill.fee ? fmtAmount(fill.fee.cost, { places: 8 }) : t('notStated')}</span>
          </Row>
          <Row label={t('fillFeeAsset')}>{fill.fee ? fill.fee.currency : t('notStated')}</Row>
          <Row label={t('fillFeeRate')}>
            <span className="if-num">{rate === null ? t('notStated') : fmtPct(rate, { signed: false })}</span>
          </Row>
          <Row label={t('discount')}>{discountText(order.feeDiscount, t)}</Row>
        </dl>
      </details>
    </li>
  );
}

function Changes({ read, tick, t }: { read: Read<OrderChange[]>; tick: string | undefined; t: OrdersT }) {
  const { timeZone } = usePreferences();
  if (read.status === 'loading') return <Loading label={t('changesLoading')} />;
  if (read.status === 'failed') return <p role="alert">{t('changesFailed')}</p>;
  if (read.data.length === 0) return <p>{t('changesNone')}</p>;
  const rows = read.data.flatMap((change) => {
    const line = changeLine(change);
    return line ? [{ change, line }] : [];
  });
  return (
    <>
      <ol data-testid="orders-changes" className="orders-changes">
        {rows.map(({ change, line }, index) => (
          <li key={`${line.at}:${index}`}>
            <span className="if-num">{Number.isNaN(Date.parse(line.at)) ? '—' : dayTime(Date.parse(line.at), timeZone)}</span>{' '}
            {line.key === 'Order changes amend'
              ? t('changeAmend', { amount: fmtAmount(line.amount, { places: 8 }), price: fmtPrice(line.price, tick) })
              : line.key === 'Order changes replaced by'
                ? t('changeReplacedBy')
                : t('changeReplaces')}
            {change.relatedOrderId ? (
              <>
                {' '}
                <a className="text-link" href={`/trade/orders/${encodeURIComponent(change.relatedOrderId)}`}>
                  {t('changeOpen')}
                </a>
              </>
            ) : null}
          </li>
        ))}
      </ol>
      {rows.length < read.data.length ? <p>{t('changesUnreadable')}</p> : null}
    </>
  );
}

/**
 * One order (`/trade/orders/:id`): its state, what filled and what each fill cost, why it ended (or that no reason was
 * recorded), and every change with its time. Another person's order, or an id that is no order, reads "Order not found"
 * with no hint either way. An open order can be cancelled here; the page says what the cancel gave back.
 */
export function OrderDetailRoom({ orderId }: { orderId: string }) {
  const { t } = ordersCopy.useCopy();
  const desk = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const { api, userId } = useSession();
  const tradeApi = useMemo(() => createTradeApi(api), [api]);
  const env = useDataEnv();
  const markets = useDeskMarkets();
  const marketList = markets.status === 'ready' ? markets.data : null;
  const precision = useMemo(() => precisionOf(marketList ?? []), [marketList]);
  const [order, setOrder] = useState<Read<Order>>({ status: 'loading' });
  const [fills, setFills] = useState<Read<Trade[]>>({ status: 'loading' });
  const [changes, setChanges] = useState<Read<OrderChange[]>>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [cancelled, setCancelled] = useState<Cancelled | null>(null);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    const { signal } = controller;
    const settle =
      <T,>(set: (read: Read<T>) => void) =>
      (result: ApiResult<T>) => {
        if (!signal.aborted) set(result.ok ? { status: 'ready', data: result.data } : { status: 'failed', failure: result });
      };
    setOrder({ status: 'loading' });
    setFills({ status: 'loading' });
    setChanges({ status: 'loading' });
    void tradeApi.orderById(orderId, signal).then(settle(setOrder));
    void tradeApi.orderTrades(orderId, signal).then(settle(setFills));
    void tradeApi.changes(orderId, signal).then(settle(setChanges));
    return () => controller.abort();
  }, [orderId, userId, revision]);

  const back = (
    <a className="text-link" href="/trade/orders">
      {t('backToHistory')}
    </a>
  );
  if (!userId)
    return (
      <Page eyebrow={t('eyebrow')} title={t('detailTitle')}>
        <EmptyState
          title={t('signedOutTitle')}
          action={
            <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(`/trade/orders/${orderId}`)}`}>
              {t('signIn')}
            </a>
          }
        >
          {t('signedOutBody')}
        </EmptyState>
      </Page>
    );
  if (order.status === 'loading')
    return (
      <Page eyebrow={t('eyebrow')} title={t('detailTitle')}>
        <Loading label={t('detailLoading')} />
      </Page>
    );
  if (order.status === 'failed')
    return (
      <Page eyebrow={t('eyebrow')} title={t('detailTitle')} actions={back}>
        {order.failure.code === 'trade.order_not_found' || order.failure.status === 404 ? (
          <EmptyState title={t('notFoundTitle')} action={back}>
            {t('notFoundBody')}
          </EmptyState>
        ) : (
          <Failure result={order.failure} retry={() => setRevision((n) => n + 1)} />
        )}
      </Page>
    );

  const o = order.data;
  const tick = precision.tickOf(o.symbol);
  const lot = precision.lotOf(o.symbol);
  const base = baseOf(o.symbol);
  const quote = quoteOf(o.symbol);
  // The wire's average when it states one, else the average of the fills this page read (when they cover the order).
  const average = o.average ?? (fills.status === 'ready' ? fillsAverage(fills.data, o.filled) : null);
  const side = o.side === 'buy' ? t('sideBuy') : t('sideSell');
  async function cancel() {
    if (busyRef.current || order.status !== 'ready') return;
    busyRef.current = true;
    setBusy(true);
    const before = order.data.hold ?? null;
    const filledBefore = order.data.filled;
    env.poller.recordExternalRequest();
    const result = await tradeApi.cancel({ id: order.data.id, symbol: order.data.symbol });
    busyRef.current = false;
    setBusy(false);
    // The hold this page read is what came back only if nothing filled since that read; otherwise it states no number.
    if (result.ok)
      setCancelled(
        before && dec(filledBefore) !== null && dec(result.data.filled) === dec(filledBefore)
          ? { tone: 'good', text: t('cancelDone', { amount: fmtAmount(before.amount, { places: 8 }), asset: before.asset }) }
          : { tone: 'good', text: t('cancelDoneNoHold') },
      );
    else setCancelled({ tone: 'bad', text: result.reason === 'uncertain' ? t('cancelUncertain') : refusalCopy(result.code ?? '').title });
    setRevision((n) => n + 1);
  }
  return (
    <Page
      eyebrow={t('eyebrow')}
      title={t('detailHeading', { side, pair: o.symbol })}
      description={orderStatus(o, desk.t)}
      actions={
        <>
          {back}
          <Button variant="secondary" size={40} onClick={() => setRevision((n) => n + 1)}>
            {t('refresh')}
          </Button>
        </>
      }
    >
      <div className="orders-room">
        {cancelled ? (
          <p className={`orders-note orders-note--${cancelled.tone}`} role={cancelled.tone === 'good' ? 'status' : 'alert'}>
            {cancelled.text}
          </p>
        ) : null}
        <dl data-testid="orders-list" className="orders-list" aria-label={t('detailTitle')}>
          <Row label={t('placed')}>
            <span className="if-num">{dayTime(o.timestamp, timeZone)}</span>
          </Row>
          <Row label={t('type')}>
            {o.type === 'market'
              ? t('typeMarket')
              : o.type === 'stop_limit' || o.type === 'stop'
                ? `${t(o.type === 'stop' ? 'typeStopMarket' : 'typeStopLimit')}${o.stopPrice ? ` @ ${fmtPrice(o.stopPrice, tick)}` : ''}`
                : t('typeLimit')}
          </Row>
          <Trigger order={o} average={average} tick={tick} quote={quote} t={t} />
          <Row label={t('price')}>
            <span className="if-num">
              {o.price === null
                ? t('marketPrice')
                : o.type === 'stop'
                  ? t('protectionPrice', { price: fmtPrice(o.price, tick), quote })
                  : `${fmtPrice(o.price, tick)} ${quote}`}
            </span>
          </Row>
          <Row label={t('amount')}>
            <span className="if-num">
              {fmtAmount(o.amount, { places: lot })} {base}
            </span>
          </Row>
          <Row label={t('filled')}>
            <span className="if-num">
              {fmtAmount(o.filled, { places: lot })} {base}
            </span>
          </Row>
          {o.status === 'open' ? (
            <Row label={t('remaining')}>
              <span className="if-num">
                {fmtAmount(o.remaining, { places: lot })} {base}
              </span>
            </Row>
          ) : null}
          {o.status === 'open' ? (
            <Row label={t('held')}>
              <span className="if-num">{o.hold ? `${fmtAmount(o.hold.amount, { places: 8 })} ${o.hold.asset}` : t('notStated')}</span>
            </Row>
          ) : null}
          {average ? (
            <Row label={t('average')}>
              <span className="if-num">
                {fmtPrice(average, tick)} {quote}
              </span>
            </Row>
          ) : null}
          {o.cost !== null && !isZero(o.cost) ? (
            <Row label={t('total')}>
              <span className="if-num">
                {fmtAmount(o.cost, { places: quotePlaces(quote), fixed: true })} {quote}
              </span>
            </Row>
          ) : null}
          <Row label={t('discount')}>{discountText(o.feeDiscount, t)}</Row>
          <Reason order={o} t={t} />
          {o.tag ? <Row label={t('tag')}>{o.tag}</Row> : null}
          <Row label={t('orderId')}>
            <code>{o.id}</code>
          </Row>
        </dl>
        {isTerminalOrder(o) ? null : (
          <div>
            <Button variant="secondary" size={40} loading={busy} onClick={() => void cancel()}>
              {busy ? t('cancelling') : t('cancel')}
            </Button>
          </div>
        )}
        <section className="orders-section">
          <h2>{t('fillsHeading')}</h2>
          {fills.status === 'loading' ? <Loading label={t('fillsLoading')} /> : null}
          {fills.status === 'failed' ? <p role="alert">{t('fillsFailed')}</p> : null}
          {fills.status === 'ready' ? (
            fills.data.length === 0 ? (
              <p>{t('fillsNone')}</p>
            ) : (
              <>
                <ul className="orders-fills">
                  {fills.data.map((fill) => (
                    <Fill key={fill.id} fill={fill} order={o} precision={precision} t={t} />
                  ))}
                </ul>
                {fills.data.length >= ORDER_TRADES_LIMIT ? (
                  <p className="orders-note">{t('fillsCapped', { count: String(ORDER_TRADES_LIMIT) })}</p>
                ) : null}
              </>
            )
          ) : null}
        </section>
        <section className="orders-section">
          <h2>{t('changesHeading')}</h2>
          <Changes read={changes} tick={tick} t={t} />
        </section>
      </div>
    </Page>
  );
}
