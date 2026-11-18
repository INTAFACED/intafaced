import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { ChartOwnerValuesPanel } from '@/components/trade-ops/charts-owner-values-panel';
import { readChartOwnerValues } from '@/lib/trade-ops/charts-owner-values-calls';
import { AlertOwnerValuesPanel } from '@/components/trade-ops/alert-owner-values-panel';
import { readAlertOwnerValues } from '@/lib/trade-ops/alert-owner-values-calls';

/**
 * Charts settings (C-ops-04, LD-14; J-charts-desk-18 #5 #6): the owner values the charts module enforces, in svc-trade
 * (counts, data class) and svc-notify (alert quota per plan, trigger log retention). A value that is not set reads "Not set"
 * and the customer action that needs it refuses; nothing here has a default. A data class change needs a second founder.
 */
export const dynamic = 'force-dynamic';

export default async function ChartsSettingsPage() {
  const { session, config } = await requireFounderPage();
  const read = await readChartOwnerValues({ session, config });
  // The alert values live in svc-notify and are read on their own: either read can fail without hiding the other.
  const alerts = await readAlertOwnerValues({ session, config });

  return (
    <DeskPage
      title="Charts settings"
      description="The owner values the charts module enforces. A value that is not set refuses the action that needs it: nothing falls back to a default. A data class change needs a second founder and an audit."
      asOf={read.asOf}
      state={read.kind === 'ok' ? 'live' : read.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'unknown' ? read.message : read.code}
    >
      <div className="flex flex-col gap-8">
        {read.kind === 'ok' ? (
          <ChartOwnerValuesPanel initial={read.data} />
        ) : (
          <ReadProblem outcome={read} title="Charts settings not read" />
        )}
        {alerts.kind === 'ok' ? (
          <AlertOwnerValuesPanel initial={alerts.data} />
        ) : (
          <ReadProblem outcome={alerts} title="Alert settings not read" />
        )}
      </div>
    </DeskPage>
  );
}
