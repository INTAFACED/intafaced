import { PageSection } from '@intafaced/ui';
import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { HealthRefresh } from '@/components/trade-ops/health-refresh';
import { MarketsTable } from '@/components/trade-ops/markets-table';
import { loadMarkets, ORDER_READ_LIMIT } from '@/lib/trade-ops/markets-load';
import { oldestAsOf } from '@/lib/trade-ops/markets-model';

/**
 * Markets: every market, its rules, record status, lifecycle state and the orders resting on it.
 * Markets, lifecycle and open orders are read separately; a refused lifecycle or order read shows as such in its
 * own cells and notice, and the rest of the table stays.
 */
export const dynamic = 'force-dynamic';

export default async function MarketsPage() {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const { markets, orders, views, lifecycleCapped } = await loadMarkets(ctx);

  const asOf = oldestAsOf([markets.kind === 'ok' ? markets.asOf : null, orders.kind === 'ok' ? orders.asOf : null]);
  const lifecycleReads = views.map((v) => v.lifecycle);
  const lifecycleOk = lifecycleReads.filter((l) => l?.kind === 'ok').length;
  const state =
    markets.kind !== 'ok'
      ? markets.kind
      : orders.kind !== 'ok'
        ? orders.kind
        : lifecycleReads.length > 0 && lifecycleOk === 0
          ? 'refused'
          : 'live';
  const firstLifecycleProblem = lifecycleReads.find((l) => l && l.kind !== 'ok');

  return (
    <DeskPage
      title="Markets"
      description="Status and rules of each market. Open one to halt, restrict, resume or delist it."
      asOf={asOf}
      state={state}
      stateReason={state === 'live' ? undefined : 'Part of the data could not be read; see the notices below.'}
      actions={<HealthRefresh />}
    >
      {markets.kind !== 'ok' ? (
        <ReadProblem outcome={markets} title="Markets could not be read" />
      ) : (
        <>
          {orders.kind !== 'ok' ? (
            <ReadProblem outcome={orders} title="Open orders could not be read: order counts show a dash, not zero" />
          ) : orders.data.length >= ORDER_READ_LIMIT ? (
            <p className="text-xs text-warn">
              Only the first {ORDER_READ_LIMIT} open orders are read, so order counts per market may be lower than the real number.
            </p>
          ) : null}
          {firstLifecycleProblem && lifecycleOk < lifecycleReads.length ? (
            <p className="text-xs text-fg-2" role="status">
              Lifecycle was read for {lifecycleOk} of {views.length} markets
              {firstLifecycleProblem.kind === 'refused'
                ? `; the service said ${firstLifecycleProblem.code}`
                : '; the service did not answer'}
              . Markets without it show Refused or Unknown.
              {lifecycleCapped ? ' More markets exist than are read at once.' : ''}
            </p>
          ) : null}
          <PageSection title={`Markets (${views.length})`}>
            <MarketsTable rows={views} />
          </PageSection>
        </>
      )}
    </DeskPage>
  );
}
