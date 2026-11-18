import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { readAlertEngineHealth } from '@/lib/trade-ops/alert-engine-calls';
import { CHART_METRIC_BLOCKERS } from '@/lib/trade-ops/alert-engine-model';

/**
 * Charts module metrics (C-ops-01 (b), J-charts-desk-18 #3): chart opens, alerts, saved layouts and indicator use. A count
 * is shown only when a service keeps the rows it counts; otherwise its row says what is missing, never zero.
 */
export const dynamic = 'force-dynamic';

export default async function ChartsMetricsPage() {
  const { session, config } = await requireFounderPage();
  const read = await readAlertEngineHealth({ session, config });
  return (
    <DeskPage
      title="Charts metrics"
      description="Use of the charts module. A count is shown only where a service keeps the records; anything else names what is missing."
      asOf={read.asOf}
      state={read.kind === 'ok' ? 'live' : read.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'unknown' ? read.message : read.code}
    >
      <table className="w-full text-sm" aria-label="Charts module metrics">
        <thead>
          <tr className="text-left text-fg-3">
            <th scope="col" className="py-1 pr-4">
              Metric
            </th>
            <th scope="col" className="py-1 pr-4">
              Count
            </th>
            <th scope="col" className="py-1 pr-4">
              Source
            </th>
          </tr>
        </thead>
        <tbody>
          <tr data-metric="alerts" data-served={String(read.kind === 'ok')} className="border-t border-line">
            <th scope="row" className="py-1 pr-4 text-left font-medium">
              Alerts
            </th>
            <td className="py-1 pr-4 tabular-nums" data-field="count" data-open={read.kind === 'ok' ? read.data.alerts.open : undefined}>
              {read.kind === 'ok' ? `${read.data.alerts.open} open, ${read.data.alerts.firedToday} fired today` : 'Not read'}
            </td>
            <td className="py-1 pr-4" data-field="source">
              {read.kind === 'ok' ? 'Notification service: alerts held open and fires since the start of the UTC day' : null}
            </td>
          </tr>
          {CHART_METRIC_BLOCKERS.map((b) => (
            <tr key={b.key} data-metric={b.key} data-served="false" className="border-t border-line">
              <th scope="row" className="py-1 pr-4 text-left font-medium">
                {b.label}
              </th>
              <td className="py-1 pr-4" data-field="count">
                Not served
              </td>
              <td className="py-1 pr-4" data-field="source">
                {b.text} Owner: {b.owner}.
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {read.kind !== 'ok' ? <ReadProblem outcome={read} title="Alert counts not read" /> : null}
    </DeskPage>
  );
}
