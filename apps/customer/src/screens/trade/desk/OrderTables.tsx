import { useRef, useState } from 'react';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import { useDataEnv } from '../../../data/hooks';
import { useSession } from '../../../features/session/session';
import { isTerminalOrder, type Order } from '../../../features/trade/trade-api';
import { usePreferences } from '../../../shared/preferences';
import { deskCopy } from './copy';
import { useDeskApi } from './data';
import { Button, fmtAmount, fmtPrice, refusalCopy, Skeleton, StateBlock, StatusTag, type Loadable } from './deps';
import type { DeskMarket } from './market';
import { dayTime } from './time';
import { placesOf, quotePlaces } from './text';
import { canEdit } from './EditOrder';
import { exitKindKey } from './order-kind';
import { orderTag } from './tif';

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

export function orderStatus(order: Order, t: ReturnType<typeof deskCopy.useCopy>['t']) {
  if (order.status === 'open') {
    const partly = order.filled !== '0' && order.remaining !== '0';
    return <StatusTag status="working" label={partly ? t('Order status partly') : t('Order status open')} />;
  }
  if (order.status === 'closed') return <StatusTag status="filled" label={t('Order status closed')} />;
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

const baseOf = (symbol: string): string => symbol.split('/')[0] ?? symbol;
const quoteOf = (symbol: string): string => symbol.split('/')[1] ?? '';

/** Open orders (with Cancel) or past orders (with a status tag). `onChanged` runs after a cancel so the lists refresh. */
export function OrdersTable({
  rows,
  withAction,
  precision,
  onChanged,
  desk = false,
  onEdit,
}: {
  rows: Order[];
  withAction: boolean;
  precision: Precision;
  onChanged: () => void;
  /** The desk's table: Edit beside Cancel on open orders, and Average price and Cost on past orders. Activity keeps its own columns. */
  desk?: boolean;
  /** Open the edit dialog for an order (the desk hosts the dialog above the table: a replacement removes the row). */
  onEdit?: (order: Order) => void;
}) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <>
      <table className="dk-table">
        <thead>
          <tr>
            <th>{t('Time')}</th>
            <th>{t('Pair')}</th>
            <th>{t('Type')}</th>
            <th>{t('Side')}</th>
            <th className="dk-num">{t('Price')}</th>
            <th className="dk-num">{t('Amount')}</th>
            <th className="dk-num">{t('Filled')}</th>
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
              <td className="if-num">{dayTime(order.timestamp, timeZone)}</td>
              <td>{order.symbol}</td>
              <td>
                {order.exit
                  ? t(exitKindKey(order.exit.kind))
                  : order.type === 'limit'
                    ? t('Order type limit')
                    : order.type === 'market'
                      ? t('Order type market')
                      : order.type === 'stop_limit'
                        ? `${t('Order type stopLimit')}${order.stopPrice ? ` @ ${fmtPrice(order.stopPrice, precision.tickOf(order.symbol))}` : ''}`
                        : order.type}
                <OrderTag order={order} />
                <ExitLegs order={order} tick={precision.tickOf(order.symbol)} />
              </td>
              <td>
                <Side side={order.side} />
              </td>
              <td className="dk-num if-num">
                {order.price === null ? t('Market price word') : fmtPrice(order.price, precision.tickOf(order.symbol))}
              </td>
              <td className="dk-num if-num">{fmtAmount(order.amount, { places: precision.lotOf(order.symbol) })}</td>
              <td className="dk-num if-num">{fmtAmount(order.filled, { places: precision.lotOf(order.symbol) })}</td>
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
                    {onEdit && canEdit(order) && precision.marketOf(order.symbol) ? (
                      <Button
                        variant="secondary"
                        size={28}
                        onClick={() => onEdit?.(order)}
                        aria-label={t('Edit order label', {
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
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * Trade history from fills. `desk` keeps the strip's columns; `activity` leads with a plain sentence per trade
 * ("Bought 0.00015 BTC") and drops the columns that sentence already says.
 */
export function FillsTable({ rows, precision, layout = 'desk' }: { rows: Trade[]; precision: Precision; layout?: 'desk' | 'activity' }) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const activity = layout === 'activity';
  return (
    <table className="dk-table" data-layout={layout}>
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
          <th className="dk-num">{t('Fee')}</th>
        </tr>
      </thead>
      <tbody>
        {byNewest(rows).map((fill) => {
          // The sentence in Activity never rounds a fill: it shows the amount's own digits (up to 8). The desk keeps the lot's.
          const amount = fmtAmount(fill.amount, { places: activity ? 8 : precision.lotOf(fill.symbol) });
          const quote = quoteOf(fill.symbol);
          return (
            <tr key={fill.id}>
              <td className="if-num">{dayTime(fill.timestamp, timeZone)}</td>
              {activity ? (
                <td>
                  <span className="dk-trade-what" data-side={fill.side}>
                    {t(fill.side === 'buy' ? 'Bought {amount} {asset}' : 'Sold {amount} {asset}', { amount, asset: baseOf(fill.symbol) })}
                  </span>
                  <span className="dk-trade-sub">{fill.symbol}</span>
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
              <td className="dk-num if-num">{fill.fee ? `${fmtAmount(fill.fee.cost, { places: 8 })} ${fill.fee.currency}` : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
