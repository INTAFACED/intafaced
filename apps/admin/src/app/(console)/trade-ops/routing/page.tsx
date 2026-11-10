import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { readVenueRouting } from '@/lib/trade-ops/venue-routing';
import { amountsText, routingPeriod } from '@/lib/trade-ops/venue-routing-model';

/**
 * Routing (J-derivatives-28 #6): our users' routed volume and the builder fees each venue charged on those fills, by
 * venue, for a period, with house exposure "none: routed": we route orders the customer signs and hold no position. Every
 * figure is the venue's own record of our routed orders. A venue that can't be read is a down row, and the totals say
 * they leave it out.
 */
export const dynamic = 'force-dynamic';

export default async function RoutingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('tradeops');
  const { session, config } = await requireFounderPage();
  const period = routingPeriod(await searchParams);
  const report = await readVenueRouting({ session, config }, { from: period.from, to: period.to });
  return (
    <DeskPage
      title="Routing"
      description="Our users' orders routed to each venue: volume and our builder fees as each venue reports them. House exposure: none, routed."
      asOf={report.asOf}
      state={
        report.kind === 'ok' ? (report.data.totalsExclude.length ? 'unknown' : 'live') : report.kind === 'unknown' ? 'unknown' : 'refused'
      }
      stateReason={
        report.kind === 'ok'
          ? report.data.totalsExclude.length
            ? `Not read: ${report.data.totalsExclude.join(', ')}`
            : undefined
          : report.kind === 'unknown'
            ? report.message
            : report.code
      }
    >
      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Period" data-testid="routing-period">
        <label className="flex flex-col text-xs text-fg-2">
          From (UTC)
          <input name="from" defaultValue={period.from} className="border border-line px-2 py-1 text-sm text-fg" />
        </label>
        <label className="flex flex-col text-xs text-fg-2">
          To (UTC)
          <input name="to" defaultValue={period.to} className="border border-line px-2 py-1 text-sm text-fg" />
        </label>
        <button type="submit" className="border border-line px-3 py-1 text-sm text-fg">
          Show period
        </button>
        {period.fellBack ? <p className="text-xs text-warn">That period could not be read, so the last 24 hours are shown.</p> : null}
      </form>
      {report.kind !== 'ok' ? (
        <ReadProblem outcome={report} title="Routing could not be read" />
      ) : report.data.venues.every((v) => v.orders === 0) && report.data.totalsExclude.length === 0 ? (
        <>
          <p data-testid="routing-empty" className="text-sm text-fg-2">
            No routed order filled in this period.
          </p>
          <RoutingTable view={report.data} />
        </>
      ) : (
        <RoutingTable view={report.data} />
      )}
    </DeskPage>
  );
}

function RoutingTable({ view }: { view: import('@/lib/trade-ops/venue-routing-model').VenueRoutingView }) {
  return (
    <div className="flex flex-col gap-2">
      <table data-testid="routing-table" className="w-full text-sm">
        <caption className="text-start text-xs text-fg-2">
          {view.from} to {view.to}
        </caption>
        <thead>
          <tr className="text-start text-xs text-fg-2">
            <th className="text-start">Venue</th>
            <th className="text-start">State</th>
            <th className="text-end">Routed orders filled</th>
            <th className="text-end">Fills</th>
            <th className="text-end">Routed volume</th>
            <th className="text-end">Our builder fees</th>
            <th className="text-start">House exposure</th>
          </tr>
        </thead>
        <tbody>
          {view.venues.map((v) => (
            <tr key={v.venueId} data-venue={v.venueId} data-state={v.state} className="border-t border-line">
              <td data-cell="venue">
                {v.displayName ?? v.venueId}
                {v.test ? <span className="ms-1 text-xs text-warn">TEST</span> : null}
              </td>
              <td data-cell="state">{v.state === 'up' ? 'Read' : `Down: ${v.reason ?? 'no reason given'}`}</td>
              <td data-cell="orders" className="text-end">
                {v.state === 'up' ? v.orders : '—'}
              </td>
              <td data-cell="fills" className="text-end">
                {v.state === 'up' ? v.fills : '—'}
              </td>
              <td data-cell="volume" className="text-end">
                {v.state === 'up' ? amountsText(v.volume) : '—'}
              </td>
              <td data-cell="builder-fees" className="text-end">
                {v.state === 'up' ? amountsText(v.builderFees) : '—'}
              </td>
              <td data-cell="exposure">{v.houseExposure}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr data-row="total" className="border-t border-line font-medium">
            <td colSpan={4}>All venues read{view.totalsExclude.length ? ` (leaves out ${view.totalsExclude.join(', ')})` : ''}</td>
            <td data-cell="volume" className="text-end">
              {amountsText(view.volume)}
            </td>
            <td data-cell="builder-fees" className="text-end">
              {amountsText(view.builderFees)}
            </td>
            <td data-cell="exposure">{view.houseExposure}</td>
          </tr>
        </tfoot>
      </table>
      {view.truncated ? (
        <p className="text-xs text-warn">More routed orders exist than one read takes; older orders' fills may be missing.</p>
      ) : null}
    </div>
  );
}
