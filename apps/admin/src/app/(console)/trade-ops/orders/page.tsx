import { requireFounderPage } from '@/lib/founder-page';
import { readOpenOrders } from '@/lib/trade-ops/reads';
import { parsePageSize } from '@/lib/trade-ops/orders-model';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { OrdersBoard } from '@/components/trade-ops/orders-board';

/** Orders room: open orders across accounts (GET /api/v1/admin/orders/open, limit always sent). */
export const dynamic = 'force-dynamic';

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const limit = parsePageSize((await searchParams).limit);
  const orders = await readOpenOrders(ctx, limit);
  return (
    <DeskPage
      title="Orders"
      description="Open orders across all accounts. Closed orders cannot be read by operators yet."
      asOf={orders.asOf}
      state={orders.kind === 'ok' ? 'live' : orders.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={orders.kind === 'ok' ? undefined : orders.kind === 'unknown' ? orders.message : orders.code}
    >
      {orders.kind === 'ok' ? (
        <OrdersBoard rows={orders.data} limit={limit} />
      ) : (
        <ReadProblem outcome={orders} title="Open orders could not be read" />
      )}
    </DeskPage>
  );
}
