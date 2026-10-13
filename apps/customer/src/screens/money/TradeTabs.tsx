import { useMemo } from 'react';
import '../trade/desk/desk.css';
import { deskCopy } from '../trade/desk/copy';
import { useClosedOrders, useDeskMarkets, useFills, useOpenOrders, useRefreshPrivate } from '../trade/desk/data';
import { FillsTable, LoadState, OrdersTable, precisionOf } from '../trade/desk/OrderTables';
import { StateBlock } from './deps';
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

/** The fills call returns the latest this many; a full page says so instead of pretending to be everything. */
const FILLS_PAGE = 100;

export function TradesPanel() {
  const { t } = deskCopy.useCopy();
  const money = moneyCopy.useCopy();
  const fills = useFills(true);
  const precision = usePrecision();
  return (
    <div className="money-trade-tab">
      <LoadState load={fills} thing="trades">
        {(rows) =>
          rows.length === 0 ? (
            <StateBlock kind="empty" className="money-state" title={money.t('No trades yet')} body={money.t('No trades yet body')} />
          ) : (
            <>
              <FillsTable rows={rows} precision={precision} layout="activity" />
              {rows.length >= FILLS_PAGE ? <p className="money-act-note">{t('Latest trades note', { count: FILLS_PAGE })}</p> : null}
            </>
          )
        }
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
    <div className="money-trade-tab">
      <h2 className="money-trade-tab__head">{t('Open orders')}</h2>
      <LoadState load={open} thing="orders">
        {(rows) =>
          rows.length === 0 ? (
            <StateBlock kind="empty" className="money-state money-state--compact" title={t('No open orders')} />
          ) : (
            <OrdersTable rows={rows} withAction precision={precision} onChanged={refresh} />
          )
        }
      </LoadState>
      <h2 className="money-trade-tab__head">{t('Order history')}</h2>
      <LoadState load={closed} thing="orders">
        {(rows) =>
          rows.length === 0 ? (
            <StateBlock kind="empty" className="money-state money-state--compact" title={t('No order history')} />
          ) : (
            <OrdersTable rows={rows} withAction={false} precision={precision} onChanged={refresh} />
          )
        }
      </LoadState>
    </div>
  );
}
