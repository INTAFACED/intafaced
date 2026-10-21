import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { VenueEconomicsReport } from '@/components/venue-economics/report';
import { ExportCostsCsv } from '@/components/venue-economics/export-csv';
import { VenueCostEntry } from '@/components/venue-economics/entry-form';
import { currentPeriod, periodFromQuery } from '@/lib/venue-economics/model';
import { readVenueEconomics } from '@/lib/venue-economics/read';
import '@/components/desk.css';

/**
 * Venue unit economics for one month: fee revenue from the analytics warehouse beside the seven cost lines operators enter
 * (liquidity, insurance and default capital, custody, data, support, compliance, infrastructure), from svc-ops. A line nobody
 * entered is "Not entered", never zero, and there is no total while any line is missing. `?period=2026-10` picks the month.
 */
export const dynamic = 'force-dynamic';

export default async function VenueEconomicsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  const period = periodFromQuery((await searchParams).period) ?? currentPeriod(new Date());
  const read = await readVenueEconomics(founder, period);
  return (
    <main className="dk-stack" data-testid="venue-economics">
      <p>
        <Link href="/more-ops">More modules</Link>
      </p>
      <h2>Venue unit economics</h2>
      <p className="dk-muted">
        What the venue earns against what it costs to run, one month at a time. Revenue comes from the analytics warehouse; costs are
        entered by operators with a second founder’s approval.
      </p>
      <form method="get" className="dk-row" data-testid="period-form">
        <div className="adm-field">
          <label htmlFor="vc-period">Month</label>
          <input id="vc-period" name="period" type="month" className="adm-input" defaultValue={period} />
        </div>
        <button type="submit" className="adm-btn">
          Show
        </button>
      </form>
      {read.part.kind === 'ok' ? (
        <>
          <VenueEconomicsReport report={read.part.data} asOf={read.asOf} />
          <ExportCostsCsv period={period} asOf={read.asOf} lines={read.part.data.costs} />
        </>
      ) : (
        <div
          className="adm-callout"
          data-tone={read.part.forbidden || read.part.notBuilt ? 'warn' : 'danger'}
          role="status"
          data-testid="read-failed"
        >
          <strong>The report could not be read</strong>
          <p>{read.part.message}</p>
          {read.part.code && <p className="dk-muted">Code: {read.part.code}</p>}
          <p className="dk-muted">Nothing is shown here rather than a guess.</p>
        </div>
      )}
      <VenueCostEntry key={period} period={period} userId={founder.session.userId} />
    </main>
  );
}
