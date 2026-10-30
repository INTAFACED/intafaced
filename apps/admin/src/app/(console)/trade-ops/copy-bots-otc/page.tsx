import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { CopyBotsOtcRoom } from '@/components/trade-ops/copy-bots-otc';
import { lookupCustomer, readOpsMetrics, readQuoteDesk } from '@/lib/trade-ops/copy-bots-otc-calls';

export const dynamic = 'force-dynamic';

/**
 * Copy, bots and OTC (CB-ops-05, CB-ops-04): the module's numbers, one customer's follows, bots and quotes, and the
 * quote desk with its settlement exceptions, from svc-trade's operator reads. Read only. `?customer=<email or account
 * id>` looks a customer up (svc-trade audits it); `?tab=quotes` opens the quote desk. Each read keeps its own state.
 */
export default async function CopyBotsOtcPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const params = await searchParams;
  const tab = params.tab === 'quotes' ? 'quotes' : 'lookup';
  const customer = typeof params.customer === 'string' ? params.customer.trim().slice(0, 320) : '';
  const [metrics, lookup, desk] = await Promise.all([
    readOpsMetrics(ctx),
    tab === 'lookup' && customer ? lookupCustomer(ctx, customer) : null,
    tab === 'quotes' ? readQuoteDesk(ctx) : null,
  ]);
  return (
    <DeskPage
      title="Copy, bots and OTC"
      description="Module numbers, one customer’s follows, bots and quotes, and the quote desk. Read only; every lookup is audited."
      asOf={metrics.asOf}
      state={metrics.kind === 'ok' ? 'live' : metrics.kind}
      stateReason={metrics.kind === 'ok' ? undefined : metrics.kind === 'refused' ? metrics.code : metrics.message}
    >
      <CopyBotsOtcRoom tab={tab} customer={customer} metrics={metrics} lookup={lookup} desk={desk} />
    </DeskPage>
  );
}
