import { EmptyState, PageSection } from '@/components/trade-ops/kit';
import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { readAlertEngineHealth } from '@/lib/trade-ops/alert-engine-calls';
import { DELIVERY_STATUSES, utcSecond } from '@/lib/trade-ops/alert-engine-model';

/**
 * Alert engine and delivery health (C-ops-01 (c), J-charts-desk-18 #4): the evaluation sweep's lag and last pass, firings
 * today, and alert deliveries today per channel with their failures, all counted by svc-notify from its own rows.
 */
export const dynamic = 'force-dynamic';

export default async function AlertEnginePage() {
  const { session, config } = await requireFounderPage();
  const read = await readAlertEngineHealth({ session, config });
  return (
    <DeskPage
      title="Alert engine"
      description="How late alert evaluation runs, what fired today, and how each channel delivered those alerts, counted by the notification service."
      asOf={read.asOf}
      state={read.kind === 'ok' ? 'live' : read.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'unknown' ? read.message : read.code}
    >
      {read.kind !== 'ok' ? (
        <ReadProblem outcome={read} title="Alert engine not read" />
      ) : (
        <div className="flex flex-col gap-6">
          <section aria-label="Evaluation" className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">Evaluation</h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
              <dt>Evaluation lag</dt>
              <dd data-field="lag" data-seconds={read.data.sweep.lagSeconds ?? undefined} data-late={String(read.data.sweep.late)}>
                {read.data.sweep.lagSeconds === null
                  ? 'No evaluation pass has completed since the service started'
                  : `${read.data.sweep.lagSeconds} s since the last pass${read.data.sweep.late ? ' (late)' : ''}`}
              </dd>
              <dt>Sweep interval</dt>
              <dd data-field="interval">{read.data.sweep.intervalMs / 1000} s</dd>
              <dt>Last pass</dt>
              <dd data-field="last-pass">
                {read.data.sweep.lastFinishedAt === null
                  ? '—'
                  : `${utcSecond(read.data.sweep.lastFinishedAt)}, took ${read.data.sweep.lastDurationMs} ms`}
              </dd>
              <dt>Last pass outcome</dt>
              <dd data-field="last-outcome">
                {read.data.sweep.last === null
                  ? '—'
                  : `${read.data.sweep.last.markets} markets, ${read.data.sweep.last.fired} fired, ${read.data.sweep.last.held} held, ${read.data.sweep.last.refused} refused`}
              </dd>
              {read.data.sweep.lastFailure ? (
                <>
                  <dt>Last failure</dt>
                  <dd data-field="last-failure">
                    {utcSecond(read.data.sweep.lastFailure.at)}: {read.data.sweep.lastFailure.message}
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
          <section aria-label="Firings today" className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">Firings today</h2>
            <p className="text-sm" data-field="firings" data-count={read.data.firings.total}>
              {read.data.firings.total} fired since {utcSecond(read.data.since)}
              {Object.keys(read.data.firings.byKind).length > 0
                ? `: ${Object.entries(read.data.firings.byKind)
                    .map(([kind, n]) => `${n} ${kind}`)
                    .join(', ')}`
                : ''}
            </p>
          </section>
          <PageSection title="Deliveries today by channel">
            {read.data.deliveries.length === 0 ? (
              <EmptyState variant="empty" size="inline" title="No alert was delivered on any channel today" />
            ) : (
              <table className="w-full text-sm" aria-label="Alert deliveries by channel">
                <thead>
                  <tr className="text-left text-fg-3">
                    <th scope="col" className="py-1 pr-4">
                      Channel
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      Deliveries
                    </th>
                    {DELIVERY_STATUSES.map((s) => (
                      <th key={s} scope="col" className="py-1 pr-4">
                        {s}
                      </th>
                    ))}
                    <th scope="col" className="py-1 pr-4">
                      Failures
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {read.data.deliveries.map((d) => (
                    <tr key={d.channel} data-channel={d.channel} className="border-t border-line">
                      <th scope="row" className="py-1 pr-4 text-left font-medium">
                        {d.channel}
                      </th>
                      <td className="py-1 pr-4 tabular-nums" data-field="total">
                        {d.total}
                      </td>
                      {DELIVERY_STATUSES.map((s) => (
                        <td key={s} className="py-1 pr-4 tabular-nums" data-field={s}>
                          {d.byStatus[s]}
                        </td>
                      ))}
                      <td className="py-1 pr-4 tabular-nums" data-field="failures">
                        {d.failures}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </PageSection>
        </div>
      )}
    </DeskPage>
  );
}
