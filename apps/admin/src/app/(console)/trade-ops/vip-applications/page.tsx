import { PageSection } from '@/components/trade-ops/kit';
import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { VipApplications } from '@/components/trade-ops/vip-applications';
import { readVipApplications } from '@/lib/trade-ops/vip-review-calls';

export const dynamic = 'force-dynamic';

/**
 * VIP applications: people who sent a proof of their status elsewhere, waiting for compliance. A decision and a trial
 * grant each need a second founder's approval; opening a proof needs a stated reason and is audited by svc-trade.
 */
export default async function VipApplicationsPage() {
  const { session, config } = await requireFounderPage();
  const read = await readVipApplications({ session, config }, 'pending');
  return (
    <DeskPage
      title="VIP applications"
      description="Decide applications for a VIP fee tier with a second founder; a trial is the one the owner publishes, never chosen here."
      asOf={read.asOf}
      state={read.kind === 'ok' ? 'live' : read.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'unknown' ? read.message : read.code}
    >
      <PageSection title="Applications">
        <VipApplications initial={read} initialFilter="pending" />
      </PageSection>
    </DeskPage>
  );
}
