import { useMemo, useRef } from 'react';
import '../trade/desk/desk.css';
import { deskCopy } from '../trade/desk/copy';
import { useClosedOrders, useDeskMarkets, useFills, useOpenOrders, useRefreshPrivate } from '../trade/desk/data';
import { FillsTable, LoadState, OrdersTable, precisionOf } from '../trade/desk/OrderTables';
import { StateBlock } from './deps';
import type { Order } from '../../features/trade/trade-api';
import { FILLS_PAGE, symbolHasAsset, tradesEmpty } from './activity-view';
import { moneyCopy } from './copy';

/**
 * Activity's Trades and Orders tabs (UI-SPEC 5.4). They read the same trade-service lists as the desk's bottom strip and
 * draw them with the desk's own tables (`trade/desk/OrderTables.tsx`), so a trade or an order looks the same in both places.
 */

/** Price and amount decimals per market; until the markets answer, a value shows with its own digits. */
function usePrecision() {
  const markets = useDeskMarkets();
  const list = markets.status === 'ready' ? markets.data : null;
  return useMemo(() => precisionOf(list ?? []), [list]);
}

/** The person's open and recent orders by id, so a trade can name its order's type. Until they answer, no type shows. */
function useOrderIndex(): ReadonlyMap<string, Order> {
  const open = useOpenOrders();
  const closed = useClosedOrders(true);
  const list = [...(closed.status === 'ready' ? closed.data : []), ...(open.status === 'ready' ? open.data : [])];
  // Each poll answers a new list; the index (and so the table) changes only when an order, its type or its fill changes.
  const key = list.map((order) => `${order.id}:${order.type}:${order.filled}`).join('|');
  const latest = useRef(list);
  latest.current = list;
  return useMemo(() => new Map(latest.current.map((order) => [order.id, order])), [key]);
}

/** `fill` is the one trade the link opened on: its row is marked current and scrolled to. */
export function TradesPanel({ asset = null, fill = null }: { asset?: string | null; fill?: string | null }) {
  const { t } = deskCopy.useCopy();
  const money = moneyCopy.useCopy();
  const fills = useFills(true);
  const precision = usePrecision();
  const orders = useOrderIndex();
  return (
    <div data-testid="money-trade-tab" className="money-trade-tab">
      <LoadState load={fills} thing="trades">
        {(all) => {
          const rows = asset ? all.filter((fill) => symbolHasAsset(fill.symbol, asset)) : all;
          const note =
            all.length >= FILLS_PAGE ? (
              <p data-testid="money-act-note" className="money-act-note">
                {t('Latest trades note', { count: FILLS_PAGE })}
              </p>
            ) : null;
          if (rows.length > 0)
            return (
              <>
                <FillsTable rows={rows} precision={precision} layout="activity" orders={orders} current={fill} />
                {note}
              </>
            );
          // Only the latest page of fills is read: with a coin filter and a full page, older fills may match, so it says "latest", not "none".
          const why = tradesEmpty(asset, all.length);
          return (
            <>
              {why === 'asset-latest' && asset ? (
                <StateBlock
                  kind="empty"
                  testId="money-state"
                  className="money-state"
                  title={money.t('No {asset} trades in your latest {count}', { asset, count: FILLS_PAGE })}
                  body={money.t('No {asset} trades latest body')}
                />
              ) : why === 'asset' && asset ? (
                <StateBlock
                  kind="empty"
                  testId="money-state"
                  className="money-state"
                  title={money.t('No {asset} trades', { asset })}
                  body={money.t('No {asset} trades body', { asset })}
                />
              ) : (
                <StateBlock
                  kind="empty"
                  testId="money-state"
                  className="money-state"
                  title={money.t('No trades yet')}
                  body={money.t('No trades yet body')}
                />
              )}
              {why === 'asset-latest' ? note : null}
            </>
          );
        }}
      </LoadState>
    </div>
  );
}

export function OrdersPanel() {
  const { t } = deskCopy.useCopy();
  const open = useOpenOrders();
  const closed = useClosedOrders(true);
  const refresh = useRefreshPrivate();
  const precision = usePrecision();
  return (
    <div data-testid="money-trade-tab" className="money-trade-tab">
      <h2 data-testid="money-trade-tab__head" className="money-trade-tab__head">
        {t('Open orders')}
      </h2>
      <LoadState load={open} thing="orders">
        {(rows) =>
          rows.length === 0 ? (
            <StateBlock kind="empty" testId="money-state" className="money-state money-state--compact" title={t('No open orders')} />
          ) : (
            <OrdersTable rows={rows} withAction precision={precision} onChanged={refresh} />
          )
        }
      </LoadState>
      <h2 data-testid="money-trade-tab__head" className="money-trade-tab__head">
        {t('Order history')}
      </h2>
      <LoadState load={closed} thing="orders">
        {(rows) =>
          rows.length === 0 ? (
            <StateBlock kind="empty" testId="money-state" className="money-state money-state--compact" title={t('No order history')} />
          ) : (
            <OrdersTable rows={rows} withAction={false} precision={precision} onChanged={refresh} />
          )
        }
      </LoadState>
    </div>
  );
}
