import { KeyValue, Badge, EmptyState } from '@/components/trade-ops/kit';
import type { KeyValueItem } from '@intafaced/ui';
import { requireFounderPage } from '@/lib/founder-page';
import { readOpenOrders } from '@/lib/trade-ops/reads';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { explainHold, findOrder, statusWord } from '@/lib/trade-ops/orders-model';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { BlockerPanel, ReadProblem } from '@/components/trade-ops/blocker-panel';
import { OrderDetailPanels } from '@/components/trade-ops/orders-detail-panels';

/**
 * One order. The only read operators have is the open-orders list, so this page finds the order there. An id that is
 * not in it is said to be outside the open projection (closed orders cannot be looked up), never "not found".
 */
export const dynamic = 'force-dynamic';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const id = decodeURIComponent((await params).id);
  const orders = await readOpenOrders(ctx, 500);
  const order = orders.kind === 'ok' ? findOrder(orders.data, id) : null;
  const state = orders.kind === 'ok' ? 'live' : orders.kind === 'unknown' ? 'unknown' : 'refused';

  return (
    <DeskPage
      title="Order"
      description={id}
      asOf={orders.asOf}
      state={state}
      stateReason={orders.kind === 'ok' ? undefined : orders.kind === 'unknown' ? orders.message : orders.code}
      actions={
        <a className="text-sm underline" href="/trade-ops/orders">
          All orders
        </a>
      }
    >
      {orders.kind !== 'ok' ? (
        <ReadProblem outcome={orders} title="Open orders could not be read" />
      ) : !order ? (
        <div className="flex flex-col gap-3">
          <EmptyState
            variant="refused"
            size="panel"
            title="This order is not in the open projection"
            reason="Operators can read open orders only (the newest 500). A closed, filled or cancelled order cannot be looked up by id, so this id may be closed or may not exist. That is a blocker, not a missing page."
            code={`${BLOCKERS.orders_by_id_cross_user_missing.owner} · ${BLOCKERS.orders_by_id_cross_user_missing.need}`}
          />
          <OrderDetailPanels orderId={id} cancellable={false} />
        </div>
      ) : (
        <Detail order={order} />
      )}
    </DeskPage>
  );
}

function Detail({ order }: { order: NonNullable<ReturnType<typeof findOrder>> }) {
  const s = statusWord(order);
  const items: KeyValueItem[] = [
    { label: 'Order id', value: order.id, mono: true },
    { label: 'Client order id', value: order.clientOrderId, mono: true },
    { label: 'Account (user id)', value: order.userId, mono: true },
    { label: 'Market', value: order.symbol },
    { label: 'Side', value: order.side === 'buy' ? '▲ Buy' : '▼ Sell' },
    { label: 'Type', value: order.type },
    { label: 'Time in force', value: order.timeInForce },
    { label: 'Price', value: order.price },
    { label: 'Amount', value: order.amount },
    { label: 'Filled', value: order.filled },
    { label: 'Remaining', value: order.remaining },
    { label: 'Cost so far', value: order.cost },
    { label: 'Status (service)', value: order.status },
    { label: 'Origin', value: order.seeded ? 'House seed (seeded liquidity)' : 'Customer' },
    { label: 'Created (UTC)', value: order.datetime },
  ];
  const hold = order.held ? explainHold(order.recoveryReason) : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={s.tone} variant={s.key === 'held' ? 'outline' : 'soft'}>
          {s.key === 'held' ? '◆ ' : ''}
          {s.label}
        </Badge>
        <Badge tone={order.seeded ? 'neutral' : 'lime'} variant="outline">
          {order.seeded ? 'House seed' : 'Customer'}
        </Badge>
      </div>
      {hold ? (
        <section aria-label="Execution outcome" className="flex flex-col gap-2 border border-warn p-3">
          <h2 className="text-sm font-medium text-warn">◆ Execution outcome: {hold.heading}</h2>
          <p className="text-sm">{hold.stage}</p>
          <p className="text-sm text-fg-2">{hold.meaning}</p>
          <KeyValue
            density="dense"
            items={[
              { label: 'Recovery reason', value: order.recoveryReason },
              { label: 'Reconciliation key', value: order.reconciliationKey, mono: true },
            ]}
          />
          <BlockerPanel blocker={BLOCKERS.reconcile_route_missing} title="Reconcile cannot be started or read from here" size="inline" />
        </section>
      ) : null}
      <section aria-label="Order fields" className="max-w-2xl border border-line p-3">
        <h2 className="mb-2 text-sm font-medium">Fields the service returns</h2>
        <KeyValue density="dense" items={items} />
        <p className="mt-2 text-xs text-fg-3">These are the fields on the open-orders row. Nothing is added or estimated.</p>
      </section>
      <OrderDetailPanels orderId={order.id} cancellable={order.status === 'open' && !order.held} />
    </div>
  );
}
