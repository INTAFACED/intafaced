import { EmptyState, PageSection } from '@/components/trade-ops/kit';
import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { BoundaryNote, FeedsTable } from '@/components/trade-ops/feeds-table';
import { readFeeds } from '@/lib/trade-ops/feeds-calls';

/**
 * Market feed desk (C-ops-01 (a), J-charts-desk-18 #1): each spot market's candle stream, its age and last tick, judged
 * against the owner's delayed boundary by svc-trade. A market opens its drill-down: candle gaps and the feed event journal.
 */
export const dynamic = 'force-dynamic';

export default async function FeedsPage() {
  const { session, config } = await requireFounderPage();
  const read = await readFeeds({ session, config });
  return (
    <DeskPage
      title="Market feeds"
      description="Each market's candle stream: the newest candle tick, its age, and whether it is past the owner's delayed boundary. Open a market for its candle gaps and feed event journal."
      asOf={read.asOf}
      state={read.kind === 'ok' ? 'live' : read.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'unknown' ? read.message : read.code}
    >
      {read.kind === 'ok' ? (
        <PageSection title="Candle streams">
          <div className="flex flex-col gap-3">
            <BoundaryNote boundarySeconds={read.data.boundarySeconds} />
            {read.data.markets.length === 0 ? (
              <EmptyState variant="empty" size="panel" title="No spot markets are listed" />
            ) : (
              <FeedsTable rows={read.data.markets} />
            )}
          </div>
        </PageSection>
      ) : (
        <ReadProblem outcome={read} title="Market feeds not read" />
      )}
    </DeskPage>
  );
}
