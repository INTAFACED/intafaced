import { useMemo, useRef, useState } from 'react';
import { useVenueMode, type VenueMode } from '../../features/trade/use-venue-mode';
import { FillsTable as VenueFillsTable, OrdersTable as VenueOrdersTable } from '../../features/trade/venue/VenueKit';
import {
  OutcomeLine,
  TestMark,
  VenueFrame,
  WalletBar,
  heldKeys,
  readAllVenueOrders,
  useOwner,
  useVenueAccount,
  useVenueActions,
  useVenueApi,
  word,
  type ActionResult,
} from '../../features/trade/venue/VenueKit';
import { draftId, keys, type VenueOrder } from '../../features/trade/venue-api';
import { venueCopy } from '../../features/trade/venue/venue-copy';
import { deskCopy } from '../trade/desk/copy';
import { useClosedOrders, useDeskMarkets, useFills, useOpenOrders, useRefreshPrivate } from '../trade/desk/data';
import { FillsTable, LoadState, OrdersTable, precisionOf } from '../trade/desk/OrderTables';
import { StateBlock } from '@intafaced/ui/lit';
import { Skeleton, Table } from '@intafaced/ui/lit/templates';
import { displayAmount } from '../../shared/money';
import { useResource } from '../../shared/resource';
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
    <div data-testid="money-trade-tab" className="lt-stack">
      <VenueTrades asset={asset} />
      <LoadState load={fills} thing="trades">
        {(all) => {
          const rows = asset ? all.filter((fill) => symbolHasAsset(fill.symbol, asset)) : all;
          const note =
            all.length >= FILLS_PAGE ? (
              <p data-testid="money-act-note" className="lt-hint">
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
                  title={money.t('No {asset} trades in your latest {count}', { asset, count: FILLS_PAGE })}
                  body={money.t('No {asset} trades latest body')}
                />
              ) : why === 'asset' && asset ? (
                <StateBlock
                  kind="empty"
                  testId="money-state"
                  title={money.t('No {asset} trades', { asset })}
                  body={money.t('No {asset} trades body', { asset })}
                />
              ) : (
                <StateBlock kind="empty" testId="money-state" title={money.t('No trades yet')} body={money.t('No trades yet body')} />
              )}
              {why === 'asset-latest' ? note : null}
            </>
          );
        }}
      </LoadState>
    </div>
  );
}

/**
 * The trades on the person's own venue account (J-cex-spot-06 #8), when trading there is on: one row per venue fill with
 * its price, total and both fees, the venue's and our builder fee, read from the venue itself for the connected wallet.
 */
function VenueTrades({ asset }: { asset: string | null }) {
  const mode = useVenueMode();
  if (mode.mode !== 'on') return null;
  return (
    <VenueFrame mode={mode}>
      <section data-testid="money-venue-trades" className="lt-stack">
        <WalletBar />
        <VenueFills test={mode.status.available ? mode.status.test : false} asset={asset} />
      </section>
    </VenueFrame>
  );
}

const EVERY_FILL = new Date(0).toISOString();

function VenueFills({ test, asset }: { test: boolean; asset: string | null }) {
  const owner = useOwner();
  return owner ? <OwnerVenueFills owner={owner} test={test} asset={asset} /> : null;
}

function OwnerVenueFills({ owner, test, asset }: { owner: string; test: boolean; asset: string | null }) {
  const api = useVenueApi();
  const { resource } = useResource(async (signal) => {
    const [fills, orders] = await Promise.all([api.fills(owner, EVERY_FILL, signal), readAllVenueOrders(api, owner, signal)]);
    if (!fills.ok) return fills;
    return {
      ok: true as const,
      data: {
        fills: fills.data,
        // If order history is unavailable, fills still show without a guessed order type.
        orders: orders.ok ? orders.data.map((entry) => entry.order) : [],
      },
    };
  }, `venue-fills:${owner}`);
  const fills = resource.status === 'ready' ? resource.data.fills : null;
  const orderList = resource.status === 'ready' ? resource.data.orders : null;
  const orderMap = useMemo(() => {
    const map = new Map<string, VenueOrder>();
    for (const order of orderList ?? []) {
      if (order.venueClientOrderId) map.set(order.venueClientOrderId.toLowerCase(), order);
    }
    return map;
  }, [orderList]);
  const shown = fills && asset ? { ...fills, value: fills.value.filter((f) => f.symbol.split('-').includes(asset)) } : fills;
  // Newest first, as the rest of Activity reads.
  const sorted = shown ? { ...shown, value: [...shown.value].sort((a, b) => b.filledAt.localeCompare(a.filledAt)) } : null;
  return <VenueFillsTable fills={sorted} test={test} withTotal orders={orderMap} groupByOrder />;
}

export function OrdersPanel() {
  const mode = useVenueMode();
  if (mode.mode === 'checking') return <Skeleton shape="rows" count={4} />;
  if (mode.mode === 'on') return <VenueOrders mode={mode} />;
  return <CustodialOrdersPanel />;
}

/**
 * Activity's Orders tab on the launch model (when svc-trade's user-venue door is on): lists the person's open
 * venue orders (with Cancel) and order history read straight from the venue for the connected wallet, with a link to
 * the full filterable orders room (`/trade/orders?product=venue`).
 */
function VenueOrders({ mode }: { mode: Extract<VenueMode, { mode: 'on' }> }) {
  return (
    <VenueFrame mode={mode}>
      <section data-testid="money-venue-orders" className="lt-stack">
        <WalletBar />
        <VenueOrdersBody status={mode.status} />
      </section>
    </VenueFrame>
  );
}

function VenueOrdersBody({ status }: { status: Extract<VenueMode, { mode: 'on' }>['status'] }) {
  const owner = useOwner();
  return owner ? <OwnerVenueOrders owner={owner} status={status} /> : null;
}

function OwnerVenueOrders({ owner, status }: { owner: string; status: Extract<VenueMode, { mode: 'on' }>['status'] }) {
  const { t } = deskCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const api = useVenueApi();
  const account = useVenueAccount(owner);
  const { run } = useVenueActions(owner);
  const keysHeld = useMemo(() => heldKeys(owner), [owner]);
  const [round, setRound] = useState(0);
  const [cancelResult, setCancelResult] = useState<ActionResult | null>(null);
  const { resource: history } = useResource((signal) => readAllVenueOrders(api, owner, signal), `venue-orders-history:${owner}:${round}`);
  const test = status.available ? status.test : false;
  const cancelsPerAction = status.available ? (status.cancelsPerAction ?? 0) : 0;

  async function cancel(order: VenueOrder) {
    const id = order.venueClientOrderId;
    if (!id) return;
    const key = keysHeld.get(id);
    let answer: ActionResult;
    if (key) {
      answer = await run({ kind: 'cancel_order', symbol: order.symbol, clientOrderKey: key });
    } else if (cancelsPerAction >= 1) {
      answer = await run(
        { kind: 'cancel_orders', orders: [{ symbol: order.symbol, venueClientOrderId: id }] },
        { actionKey: keys.cancelBatch(owner, `one-${draftId()}`) },
      );
    } else {
      return;
    }
    setCancelResult(answer);
    account.reload();
    setRound((n) => n + 1);
  }

  const ended = history.status === 'ready' ? history.data.map((entry) => entry.order) : [];
  return (
    <div data-testid="money-trade-tab" className="lt-stack">
      <div className="lt-row">
        <h2 data-testid="money-trade-tab__head" className="lt-heading">
          {t('Open orders')}
        </h2>
        <a className="lt-link" data-testid="money-venue-orders-full" href="/trade/orders?product=venue">
          {t('View all')}
        </a>
      </div>
      <OutcomeLine result={cancelResult} owner={owner} />
      <VenueOrdersTable orders={account.openOrders.data} test={test} onCancel={(o) => void cancel(o)} cancelled={[]} />
      <h2 data-testid="money-trade-tab__head" className="lt-heading">
        {t('Order history')}
      </h2>
      {history.status === 'loading' ? (
        <Skeleton shape="rows" count={4} />
      ) : ended.length === 0 ? (
        <StateBlock kind="empty" testId="money-state" title={t('No order history')} />
      ) : (
        <div data-testid="venue-order-history">
          <TestMark test={test} />
          <Table
            caption={t('Order history')}
            dense
            scroll
            columns={[
              {
                key: 'market',
                label: v('Market'),
                cell: (o: VenueOrder) =>
                  o.venueClientOrderId ? (
                    <a className="lt-link" data-testid="venue-order-link" href={`/trade/orders/${o.venueClientOrderId}`}>
                      {o.symbol}
                    </a>
                  ) : (
                    o.symbol
                  ),
              },
              { key: 'side', label: v('Side'), cell: (o) => word(v, 'side', o.side) },
              { key: 'type', label: v('Type'), cell: (o) => word(v, 'type', o.type) },
              { key: 'price', label: v('Price'), align: 'end', cell: (o) => displayAmount(o.price) },
              { key: 'amount', label: v('Amount'), align: 'end', cell: (o) => displayAmount(o.amount) },
              { key: 'filled', label: v('Filled'), align: 'end', cell: (o) => displayAmount(o.filled) },
              { key: 'status', label: v('Status'), cell: (o) => word(v, 'status', o.status), cellMarks: () => ({ 'data-cell': 'status' }) },
            ]}
            rows={ended}
            rowKey={(o) => o.venueClientOrderId ?? o.venueOrderId ?? `${o.symbol}:${o.price}:${o.amount}`}
            rowMarks={(o) => ({ 'data-client-order-id': o.venueClientOrderId ?? '' })}
          />
        </div>
      )}
    </div>
  );
}

function CustodialOrdersPanel() {
  const { t } = deskCopy.useCopy();
  const open = useOpenOrders();
  const closed = useClosedOrders(true);
  const refresh = useRefreshPrivate();
  const precision = usePrecision();
  return (
    <div data-testid="money-trade-tab" className="lt-stack">
      <h2 data-testid="money-trade-tab__head" className="lt-heading">
        {t('Open orders')}
      </h2>
      <LoadState load={open} thing="orders">
        {(rows) =>
          rows.length === 0 ? (
            <StateBlock kind="empty" testId="money-state" title={t('No open orders')} />
          ) : (
            <OrdersTable rows={rows} withAction precision={precision} onChanged={refresh} />
          )
        }
      </LoadState>
      <h2 data-testid="money-trade-tab__head" className="lt-heading">
        {t('Order history')}
      </h2>
      <LoadState load={closed} thing="orders">
        {(rows) =>
          rows.length === 0 ? (
            <StateBlock kind="empty" testId="money-state" title={t('No order history')} />
          ) : (
            <OrdersTable rows={rows} withAction={false} precision={precision} onChanged={refresh} />
          )
        }
      </LoadState>
    </div>
  );
}
