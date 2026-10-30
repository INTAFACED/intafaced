import { useRef, useState } from 'react';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import { useDataEnv } from '../../../data/hooks';
import { useSession } from '../../../features/session/session';
import { isTerminalOrder, type Order } from '../../../features/trade/trade-api';
import { usePreferences } from '../../../shared/preferences';
import { deskCopy } from './copy';
import { useDeskApi } from './data';
import { Button, fmtAmount, fmtPct, fmtPrice, refusalCopy, Skeleton, StateBlock, StatusTag, type Loadable } from './deps';
import type { DeskMarket } from './market';
import { fillFeeRate, fillRebate, fillRole, fillZeroFee } from './fill-detail';
import { groupFillsByOrder } from './fill-groups';
import { parseAmount } from '../../../shared/money';
import { dayTime } from './time';
import { placesOf, quotePlaces } from './text';
import { canEdit } from './EditOrder';
import { canEditStop, exitKindKey } from './order-kind';
import { orderTag } from './tif';
import { OrderChanges } from './OrderChanges';

/** Why a fill whose order chose the platform token took the fee in what it received (svc-trade fee-ifc.ts). */
const FEE_FALLBACK: Record<
  string,
  'Fee fallback insufficient' | 'Fee fallback rebate' | 'Fee fallback dust' | 'Fee fallback no price' | 'Fee fallback refused'
> = {
  'trade.fee_ifc_insufficient': 'Fee fallback insufficient',
  'trade.fee_ifc_rebate_fill': 'Fee fallback rebate',
  'trade.fee_ifc_dust': 'Fee fallback dust',
  'trade.fee_ifc_index_unset': 'Fee fallback no price',
  'trade.fee_ifc_refused': 'Fee fallback refused',
};

/**
 * The order and trade tables shared by the desk's bottom strip and the Activity screen (Orders and Trades tabs), so the
 * two never drift apart: same columns, same cancel button, same formatting.
 */

/** How to show a market's prices and amounts; unknown markets fall back to the value's own digits. */
export interface Precision {
  tickOf: (symbol: string) => string | undefined;
  lotOf: (symbol: string) => number;
  /** The market's full rules, for the one thing that needs them (changing an order). */
  marketOf: (symbol: string) => DeskMarket | undefined;
}

export function precisionOf(markets: readonly DeskMarket[], fallback?: DeskMarket): Precision {
  // "BTC/USDT" and "BTC-USDT" name the same market.
  const same = (a: string, b: string) => a.replace('-', '/') === b.replace('-', '/');
  const find = (symbol: string) => markets.find((m) => same(m.symbol, symbol)) ?? fallback;
  return {
    marketOf: find,
    tickOf: (symbol) => find(symbol)?.tickSize,
    lotOf: (symbol) => {
      const lot = find(symbol)?.lotSize;
      return lot === undefined ? 8 : placesOf(lot);
    },
  };
}

export const byNewest = <T extends { timestamp: number }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => b.timestamp - a.timestamp);

export function Side({ side }: { side: 'buy' | 'sell' }) {
  const { t } = deskCopy.useCopy();
  return (
    <span className="dk-side" data-side={side}>
      {side === 'buy' ? t('Side buy') : t('Side sell')}
    </span>
  );
}

/** "Post only", "IOC" or "FOK" beside the order kind; a plain limit or market order carries no tag. */
export function OrderTag({ order }: { order: Pick<Order, 'timeInForce' | 'postOnly'> }) {
  const { t } = deskCopy.useCopy();
  const tag = orderTag(order);
  if (tag === null) return null;
  return <span className="dk-tag">{tag === 'PO' ? t('Tag post only') : tag}</span>;
}

/** The linked take-profit and stop-loss of an OCO, or of the exit a bracket placed, under the order kind. Nothing on a plain order. */
export function ExitLegs({ order, tick }: { order: Pick<Order, 'exit'>; tick: string | undefined }) {
  const { t } = deskCopy.useCopy();
  const exit = order.exit;
  if (!exit) return null;
  const takeProfit = fmtPrice(exit.takeProfit, tick);
  const stopLoss = fmtPrice(exit.stopLoss, tick);
  return (
    <span className="dk-tag dk-exit-legs if-num">
      {exit.stopLossLimit
        ? t('Exit legs limit', { takeProfit, stopLoss, limit: fmtPrice(exit.stopLossLimit, tick) })
        : t('Exit legs', { takeProfit, stopLoss })}
    </span>
  );
}

/**
 * An OTO buy names its close (waiting for the fill, or placed, with a link to it); the close links back to its buy.
 * Nothing on any other order.
 */
export function OtoLink({ order, tick, quote }: { order: Pick<Order, 'linked'>; tick: string | undefined; quote: string }) {
  const { t } = deskCopy.useCopy();
  const link = order.linked;
  if (!link) return null;
  if (link.role === 'close')
    return (
      <a
        className="dk-tag dk-oto-link"
        href={`/trade/orders/${encodeURIComponent(link.entryOrderId)}`}
        aria-label={t('Oto entry link label')}
      >
        {t('Oto close of')}
      </a>
    );
  const price = fmtPrice(link.closePrice, tick);
  if (link.closeOrderId === null) return <span className="dk-tag dk-oto-link if-num">{t('Oto close waiting', { price, quote })}</span>;
  return (
    <a
      className="dk-tag dk-oto-link if-num"
      href={`/trade/orders/${encodeURIComponent(link.closeOrderId)}`}
      aria-label={t('Oto close link label')}
    >
      {t('Oto close placed', { price, quote })}
    </a>
  );
}

export function orderStatus(order: Order, t: ReturnType<typeof deskCopy.useCopy>['t']) {
  if (order.status === 'open') {
    const partly = order.filled !== '0' && order.remaining !== '0';
    return <StatusTag status="working" label={partly ? t('Order status partly') : t('Order status open')} />;
  }
  if (order.status === 'closed') return <StatusTag status="filled" label={t('Order status closed')} />;
  // A resting order pulled because the person's own new order met it (the engine's self-trade rule) says so.
  if (order.status === 'canceled' && order.rejectCode === 'self_trade_prevention')
    return <StatusTag status="cancelled" label={t('Order status self trade')} />;
  if (order.status === 'canceled') return <StatusTag status="cancelled" label={t('Order status canceled')} />;
  if (order.status === 'expired') return <StatusTag status="cancelled" label={t('Order status expired')} />;
  return <StatusTag status="failed" label={t('Order status rejected')} />;
}

export function LoadState<T>({
  load,
  thing,
  children,
}: {
  load: Loadable<T>;
  thing: 'orders' | 'trades' | 'assets';
  children: (data: T) => React.ReactNode;
}) {
  const { t } = deskCopy.useCopy();
  const { userId } = useSession();
  if (load.status === 'loading' || load.status === 'empty')
    return (
      <div className="dk-bt-skeleton" role="status" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={32} className="bg-field" />
        ))}
      </div>
    );
  if (load.status === 'error')
    return (
      <StateBlock
        kind="error"
        title={
          thing === 'orders' ? t('Couldn’t load orders') : thing === 'trades' ? t('Couldn’t load trade history') : t('Couldn’t load assets')
        }
        onRetry={load.retry}
        retryLabel={t('Try again')}
      />
    );
  if (load.status === 'refused') {
    if (!userId)
      return (
        <StateBlock
          kind="empty"
          title={t('Log in to see your orders')}
          action={{ label: t('Log in'), href: `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}` }}
        />
      );
    const words = refusalCopy(load.code);
    return <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  }
  return <>{children(load.data)}</>;
}

export function CancelButton({ order, onDone }: { order: Order; onDone: () => void }) {
  const { t } = deskCopy.useCopy();
  const env = useDataEnv();
  const api = useDeskApi();
  const busyRef = useRef(false);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'uncertain' | 'refused'>('idle');
  const asset = order.symbol.split('/')[0] ?? '';
  async function cancel() {
    if (busyRef.current) return;
    busyRef.current = true;
    setState('busy');
    env.poller.recordExternalRequest();
    // One DELETE per click. Nothing here retries it: on a doubtful answer the person checks Open orders.
    const result = await api.cancel(order);
    busyRef.current = false;
    setState(result.ok ? 'done' : result.reason === 'uncertain' ? 'uncertain' : 'refused');
    onDone();
  }
  if (state === 'done') return <span className="dk-bt-note">{t('Cancel done')}</span>;
  if (state === 'uncertain') return <span className="dk-bt-note dk-bt-note--bad">{t('Cancel uncertain')}</span>;
  return (
    <span className="dk-bt-cancel">
      <Button
        variant="secondary"
        size={28}
        loading={state === 'busy'}
        onClick={() => void cancel()}
        aria-label={t('Cancel order label', {
          side: order.side === 'buy' ? t('Order placed side buy') : t('Order placed side sell'),
          amount: fmtAmount(order.amount, { places: 8 }),
          asset,
        })}
      >
        {state === 'busy' ? t('Cancelling') : t('Cancel order')}
      </Button>
      {state === 'refused' ? <span className="dk-bt-note dk-bt-note--bad">{t('Cancel refused')}</span> : null}
    </span>
  );
}

export const baseOf = (symbol: string): string => symbol.split('/')[0] ?? symbol;
export const quoteOf = (symbol: string): string => symbol.split('/')[1] ?? '';

/** The words for an order's type; a type the screen has no words for shows as the service named it, never blank. */
function typeWordOf(order: Order, t: ReturnType<typeof deskCopy.useCopy>['t'], precision: Precision): string {
  if (order.exit) return t(exitKindKey(order.exit.kind));
  if (order.linked) return t(order.linked.role === 'entry' ? 'Order type oto' : 'Order type oto close');
  if (order.type === 'limit') return t('Order type limit');
  if (order.type === 'market') return t('Order type market');
  if (order.type === 'stop_limit' || order.type === 'stop')
    return `${t(order.type === 'stop' ? 'Order type stopMarket' : 'Order type stopLimit')}${order.stopPrice ? ` @ ${fmtPrice(order.stopPrice, precision.tickOf(order.symbol))}` : ''}`;
  return order.type;
}

/** Open orders (with Cancel) or past orders (with a status tag). `onChanged` runs after a cancel so the lists refresh. */
export function OrdersTable({
  rows,
  withAction,
  precision,
  onChanged,
  desk = false,
  onEdit,
  lastPriceOf,
  selected,
  onSelect,
}: {
  rows: Order[];
  withAction: boolean;
  precision: Precision;
  onChanged: () => void;
  /** The desk's table: Edit beside Cancel on open orders, and Average price and Cost on past orders. Activity keeps its own columns. */
  desk?: boolean;
  /** Open the edit dialog for an order (the desk hosts the dialog above the table: a replacement removes the row). */
  onEdit?: (order: Order) => void;
  /** The last trade price of a pair, where the desk knows it: a stop that has not fired shows it beside its trigger. */
  lastPriceOf?: (symbol: string) => string | null;
  /** Orders ticked for a batch cancel; with `onSelect`, each open order gets a checkbox. */
  selected?: ReadonlySet<string>;
  onSelect?: (id: string, on: boolean) => void;
}) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const detailsTitle = t('Order details open');
  return (
    <>
      <table data-testid="dk-table" className="dk-table">
        <thead>
          <tr>
            {withAction && onSelect ? (
              <th>
                <span className="sr-only">{t('Select order')}</span>
              </th>
            ) : null}
            <th>{t('Time')}</th>
            <th>{t('Pair')}</th>
            <th>{t('Type')}</th>
            <th>{t('Side')}</th>
            <th className="dk-num">{t('Price')}</th>
            <th className="dk-num">{t('Amount')}</th>
            <th className="dk-num">{t('Filled')}</th>
            {withAction ? <th className="dk-num">{t('Held')}</th> : null}
            {withAction || !desk ? null : (
              <>
                <th className="dk-num">{t('Average price')}</th>
                <th className="dk-num">{t('Cost')}</th>
              </>
            )}
            <th>{withAction ? t('Action') : t('Status')}</th>
          </tr>
        </thead>
        <tbody>
          {byNewest(rows).map((order) => (
            <tr key={order.id}>
              {withAction && onSelect ? (
                <td>
                  {isTerminalOrder(order) ? null : (
                    <input
                      type="checkbox"
                      className="dk-select"
                      checked={selected?.has(order.id) ?? false}
                      onChange={(event) => onSelect(order.id, event.currentTarget.checked)}
                      aria-label={t('Select order label', {
                        side: order.side === 'buy' ? t('Order placed side buy') : t('Order placed side sell'),
                        amount: fmtAmount(order.amount, { places: 8 }),
                        asset: baseOf(order.symbol),
                        pair: order.symbol,
                      })}
                    />
                  )}
                </td>
              ) : null}
              <td className="if-num">
                <a
                  data-testid="dk-order-link"
                  className="dk-order-link"
                  href={`/trade/orders/${encodeURIComponent(order.id)}`}
                  title={detailsTitle}
                >
                  {dayTime(order.timestamp, timeZone)}
                </a>
              </td>
              <td>{order.symbol}</td>
              <td>
                {typeWordOf(order, t, precision)}
                <OrderTag order={order} />
                <ExitLegs order={order} tick={precision.tickOf(order.symbol)} />
                <OtoLink order={order} tick={precision.tickOf(order.symbol)} quote={quoteOf(order.symbol)} />
                {withAction && lastPriceOf ? (
                  <PendingStop order={order} tick={precision.tickOf(order.symbol)} last={lastPriceOf(order.symbol)} />
                ) : null}
                {order.tag ? (
                  <span className="dk-tag" title={t('Order tag label', { tag: order.tag })}>
                    {order.tag}
                  </span>
                ) : null}
              </td>
              <td>
                <Side side={order.side} />
              </td>
              <td className="dk-num if-num">
                {order.price === null ? t('Market price word') : fmtPrice(order.price, precision.tickOf(order.symbol))}
              </td>
              <td className="dk-num if-num">{fmtAmount(order.amount, { places: precision.lotOf(order.symbol) })}</td>
              <td className="dk-num if-num">{fmtAmount(order.filled, { places: precision.lotOf(order.symbol) })}</td>
              {withAction ? (
                <td className="dk-num if-num">
                  <Held order={order} lot={precision.lotOf(order.symbol)} unknown={t('Held unknown label')} />
                </td>
              ) : null}
              {withAction || !desk ? null : (
                <>
                  <td className="dk-num if-num">{order.average ? fmtPrice(order.average, precision.tickOf(order.symbol)) : '—'}</td>
                  <td className="dk-num if-num">
                    {order.cost === null ? '—' : fmtAmount(order.cost, { places: quotePlaces(quoteOf(order.symbol)), fixed: true })}{' '}
                    {order.cost === null ? null : <span className="dk-unit">{quoteOf(order.symbol)}</span>}
                  </td>
                </>
              )}
              <td>
                {withAction && !isTerminalOrder(order) ? (
                  <span className="dk-bt-actions">
                    {onEdit && (canEdit(order) || canEditStop(order)) && precision.marketOf(order.symbol) ? (
                      <Button
                        variant="secondary"
                        size={28}
                        onClick={() => onEdit?.(order)}
                        aria-label={t(canEditStop(order) ? 'Edit stop label' : 'Edit order label', {
                          side: order.side === 'buy' ? t('Order placed side buy') : t('Order placed side sell'),
                          amount: fmtAmount(order.amount, { places: 8 }),
                          asset: baseOf(order.symbol),
                        })}
                      >
                        {t('Edit order')}
                      </Button>
                    ) : null}
                    <CancelButton order={order} onDone={onChanged} />
                  </span>
                ) : (
                  orderStatus(order, t)
                )}{' '}
                {desk ? <OrderChanges orderId={order.id} tick={precision.tickOf(order.symbol)} /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** A stop that has not fired, in the open list: its trigger, and the last trade price it waits on. */
function PendingStop({ order, tick, last }: { order: Order; tick: string | undefined; last: string | null }) {
  const { t } = deskCopy.useCopy();
  if ((order.type !== 'stop_limit' && order.type !== 'stop') || !order.stopPrice || order.triggered !== null || isTerminalOrder(order))
    return null;
  return (
    <span className="dk-tag dk-pending if-num">
      {t('Pending trigger', { stop: fmtPrice(order.stopPrice, tick), quote: quoteOf(order.symbol) })}
      {' · '}
      {last ? t('Pending last price', { price: fmtPrice(last, tick) }) : t('Pending last price unknown')}
    </span>
  );
}

/** What an open order still holds, in the asset it holds. A wire that states nothing reads "—", never a computed guess. */
function Held({ order, lot, unknown }: { order: Order; lot: number; unknown: string }) {
  const hold = order.hold;
  if (!hold) return <span title={unknown}>—</span>;
  const quote = hold.asset === quoteOf(order.symbol);
  return (
    <>
      {fmtAmount(hold.amount, quote ? { places: quotePlaces(hold.asset), fixed: true } : { places: lot })}{' '}
      <span className="dk-unit">{hold.asset}</span>
    </>
  );
}

const roleWord = (role: 'maker' | 'taker' | null, t: (key: 'Maker' | 'Taker') => string): string =>
  role === 'maker' ? t('Maker') : role === 'taker' ? t('Taker') : '—';

/**
 * Trade history from fills. `desk` keeps the strip's columns; `activity` leads with a plain sentence per trade
 * ("Bought 0.00015 BTC") and drops the columns that sentence already says. In `activity` an order that filled in parts is
 * one order row (its type, how many fills, the totals) with its fills under it; `orders` gives the type, and an order not
 * in it shows no type rather than a guessed one.
 */
export function FillsTable({
  rows,
  precision,
  layout = 'desk',
  orders,
  current = null,
}: {
  rows: Trade[];
  precision: Precision;
  layout?: 'desk' | 'activity';
  orders?: ReadonlyMap<string, Order>;
  /** The fill a link opened on: marked current and scrolled into view. */
  current?: string | null;
}) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const activity = layout === 'activity';
  const fillRow = (fill: Trade, of: string | null, typeWord: string | null) => {
    // The sentence in Activity never rounds a fill: it shows the amount's own digits (up to 8). The desk keeps the lot's.
    const amount = fmtAmount(fill.amount, { places: activity ? 8 : precision.lotOf(fill.symbol) });
    const quote = quoteOf(fill.symbol);
    const zeroFee = fillZeroFee(fill);
    const rate = fillFeeRate(fill);
    const rebate = fillRebate(fill);
    return (
      <tr
        key={fill.id}
        data-fill={fill.id}
        data-of={of ?? undefined}
        className={of ? 'dk-fill-part' : undefined}
        aria-current={current !== null && fill.id === current ? 'true' : undefined}
        ref={current !== null && fill.id === current ? (row) => row?.scrollIntoView({ block: 'nearest' }) : undefined}
      >
        <td className="if-num">{dayTime(fill.timestamp, timeZone)}</td>
        {activity ? (
          <td>
            <span data-testid="dk-trade-what" className="dk-trade-what" data-side={fill.side}>
              {t(fill.side === 'buy' ? 'Bought {amount} {asset}' : 'Sold {amount} {asset}', { amount, asset: baseOf(fill.symbol) })}
            </span>
            <span className="dk-trade-sub">{typeWord ? `${fill.symbol} · ${typeWord}` : fill.symbol}</span>
          </td>
        ) : (
          <>
            <td>{fill.symbol}</td>
            <td>
              <Side side={fill.side} />
            </td>
          </>
        )}
        <td className="dk-num if-num">{fmtPrice(fill.price, precision.tickOf(fill.symbol))}</td>
        {activity ? null : <td className="dk-num if-num">{amount}</td>}
        <td className="dk-num if-num">
          {fmtAmount(fill.cost, { places: quotePlaces(quote), fixed: true })} <span className="dk-unit">{quote}</span>
        </td>
        {activity ? null : <td>{roleWord(fillRole(fill), t)}</td>}
        <td className="dk-num if-num" data-fee={zeroFee ? 'zero' : undefined}>
          {zeroFee ? t('Zero fee') : fill.fee ? `${fmtAmount(fill.fee.cost, { places: 8 })} ${fill.fee.currency}` : '—'}
          {!activity && !zeroFee && rate ? <span className="dk-unit"> {fmtPct(rate, { signed: false })}</span> : null}
          {fill.feeFallback && fill.fee && FEE_FALLBACK[fill.feeFallback] ? (
            <span className="dk-fee-fallback" data-fee-fallback={fill.feeFallback}>
              {' · '}
              {t(FEE_FALLBACK[fill.feeFallback]!, { asset: fill.fee.currency })}
            </span>
          ) : null}
          {rebate ? (
            <span data-testid="dk-rebate" className="dk-rebate" data-rebate={rebate.cost}>
              {' '}
              {t('Rebate {amount} {asset}', { amount: fmtAmount(rebate.cost, { places: 8 }), asset: rebate.currency })}
              {activity ? null : <span className="dk-unit"> {fmtPct(rebate.rate, { signed: false })}</span>}
            </span>
          ) : null}
        </td>
      </tr>
    );
  };
  return (
    <table data-testid="dk-table" className="dk-table" data-layout={layout}>
      <thead>
        <tr>
          <th>{t('Time')}</th>
          {activity ? (
            <th>{t('Trade')}</th>
          ) : (
            <>
              <th>{t('Pair')}</th>
              <th>{t('Side')}</th>
            </>
          )}
          <th className="dk-num">{t('Price')}</th>
          {activity ? null : <th className="dk-num">{t('Amount')}</th>}
          <th className="dk-num">{t('Total')}</th>
          {activity ? null : <th>{t('Role')}</th>}
          <th className="dk-num">{t('Fee')}</th>
        </tr>
      </thead>
      <tbody>
        {activity
          ? groupFillsByOrder(rows).flatMap((group) => {
              const order = group.order ? orders?.get(group.order) : undefined;
              const typeWord = order ? typeWordOf(order, t, precision) : null;
              const [first] = group.fills;
              if (!first) return [];
              if (group.fills.length === 1) return [fillRow(first, null, typeWord)];
              const quote = quoteOf(first.symbol);
              const head = (
                <tr key={`order:${group.order}`} className="dk-fill-order" data-order={group.order ?? undefined}>
                  <td className="if-num">{dayTime(first.timestamp, timeZone)}</td>
                  <td>
                    <span data-testid="dk-trade-what" className="dk-trade-what" data-side={first.side}>
                      {t(first.side === 'buy' ? 'Bought {amount} {asset}' : 'Sold {amount} {asset}', {
                        amount: fmtAmount(group.amount, { places: 8 }),
                        asset: baseOf(first.symbol),
                      })}
                    </span>
                    <span className="dk-trade-sub">
                      {typeWord
                        ? t('Order of fills', { type: typeWord, count: group.fills.length })
                        : t('Order of fills no type', { count: group.fills.length })}
                      {/* The order filled more than the fills read here: older ones are past the latest page. */}
                      {order && parseAmount(order.filled) > parseAmount(group.amount) ? ` · ${t('Order of fills older')}` : null}
                    </span>
                  </td>
                  <td className="dk-num if-num" title={t('Average price')}>
                    {group.average ? fmtPrice(group.average, precision.tickOf(first.symbol)) : '—'}
                  </td>
                  <td className="dk-num if-num">
                    {fmtAmount(group.cost, { places: quotePlaces(quote), fixed: true })} <span className="dk-unit">{quote}</span>
                  </td>
                  <td className="dk-num if-num" data-fee={fillZeroFee(group) ? 'zero' : undefined}>
                    {fillZeroFee(group)
                      ? t('Zero fee')
                      : group.fee
                        ? `${fmtAmount(group.fee.cost, { places: 8 })} ${group.fee.currency}`
                        : '—'}
                    {group.rebate ? (
                      <span data-testid="dk-rebate" className="dk-rebate">
                        {' '}
                        {t('Rebate {amount} {asset}', {
                          amount: fmtAmount(group.rebate.cost, { places: 8 }),
                          asset: group.rebate.currency,
                        })}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
              return [head, ...group.fills.map((fill) => fillRow(fill, group.order, null))];
            })
          : byNewest(rows).map((fill) => fillRow(fill, null, null))}
      </tbody>
    </table>
  );
}
