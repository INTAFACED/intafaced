import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { ChartOwnerValuesPanel } from '@/components/trade-ops/charts-owner-values-panel';
import { readChartOwnerValues } from '@/lib/trade-ops/charts-owner-values-calls';

/**
 * Charts settings (C-ops-04, LD-14): the owner values the charts module enforces. A value that is not set reads "Not set"
 * and the customer action that needs it refuses; nothing here has a default. A data class change needs a second founder.
 */
export const dynamic = 'force-dynamic';

export default async function ChartsSettingsPage() {
  const { session, config } = await requireFounderPage();
  const read = await readChartOwnerValues({ session, config });

  return (
    <DeskPage
      title="Charts settings"
      description="The owner values the charts module enforces. A value that is not set refuses the action that needs it: nothing falls back to a default. A data class change needs a second founder and an audit."
      asOf={read.asOf}
      state={read.kind === 'ok' ? 'live' : read.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'unknown' ? read.message : read.code}
    >
      {read.kind === 'ok' ? <ChartOwnerValuesPanel initial={read.data} /> : <ReadProblem outcome={read} title="Charts settings not read" />}
    </DeskPage>
  );
}
