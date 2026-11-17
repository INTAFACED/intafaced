import Link from 'next/link';
import { EmptyState, PageSection } from '@/components/trade-ops/kit';
import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { BoundaryNote, FeedsTable } from '@/components/trade-ops/feeds-table';
import { readFeedMarket } from '@/lib/trade-ops/feeds-calls';
import { DEFAULT_GAP_WINDOW_MINUTES, utcSecond } from '@/lib/trade-ops/feeds-model';

/**
 * One market's feed (J-charts-desk-18 #1 drill-down, #2): its candle stream, the candle gaps in a window, and the feed
 * event journal of drops and reconnects, written by svc-trade's feed watcher. Read only: nothing here changes the feed.
 * The symbol is in the address with its "/" encoded (BTC%2FUSDT); `?window=<minutes>` sets the gap window.
 */
export const dynamic = 'force-dynamic';

function decodeSymbol(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default async function FeedMarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ market: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, config } = await requireFounderPage();
  const symbol = decodeSymbol((await params).market);
  const query = await searchParams;
  const typed = typeof query.window === 'string' ? Number(query.window) : NaN;
  const window = Number.isInteger(typed) && typed > 0 ? typed : DEFAULT_GAP_WINDOW_MINUTES;
  const read = await readFeedMarket({ session, config }, symbol, window);
  return (
    <DeskPage
      title={`${symbol} feed`}
      description="This market's candle stream, its candle gaps, and every drop and reconnect the feed watcher recorded. Read only."
      asOf={read.asOf}
      state={read.kind === 'ok' ? 'live' : read.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'unknown' ? read.message : read.code}
      actions={<Link href="/trade-ops/feeds">All markets</Link>}
    >
      {read.kind !== 'ok' ? (
        <ReadProblem outcome={read} title="Feed not read" />
      ) : (
        <div className="flex flex-col gap-6">
          <PageSection title="Candle stream">
            <div className="flex flex-col gap-3">
              <BoundaryNote boundarySeconds={read.data.boundarySeconds} />
              <FeedsTable rows={[read.data.market]} link={false} />
            </div>
          </PageSection>
          <section aria-label="Candle gaps" className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Candle gaps</h2>
            <form method="get" className="flex items-end gap-2 text-sm">
              <label className="flex flex-col gap-1">
                Window (minutes)
                <input
                  name="window"
                  type="number"
                  min={1}
                  defaultValue={read.data.gapWindowMinutes}
                  className="w-28 rounded border border-line px-2 py-1"
                />
              </label>
              <button type="submit" className="rounded border border-line px-3 py-1">
                Show
              </button>
            </form>
            <p className="text-sm text-fg-3">
              A gap is a run of closed 1-minute candles with no trade, from the window start or the market&apos;s first trade, whichever is
              later. Seeded fills are not candles.
            </p>
            {read.data.gaps.length === 0 ? (
              <EmptyState variant="empty" size="inline" title={`No candle gaps in the last ${read.data.gapWindowMinutes} minutes`} />
            ) : (
              <table className="w-full text-sm" aria-label="Candle gaps list">
                <thead>
                  <tr className="text-left text-fg-3">
                    <th scope="col" className="py-1 pr-4">
                      From
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      To
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      Minutes
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {read.data.gaps.map((gap) => (
                    <tr key={gap.from} data-from={gap.from} data-to={gap.to} className="border-t border-line">
                      <td className="py-1 pr-4 tabular-nums">{utcSecond(gap.from)}</td>
                      <td className="py-1 pr-4 tabular-nums">{utcSecond(gap.to)}</td>
                      <td className="py-1 pr-4 tabular-nums">{gap.minutes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {read.data.gapsTruncated ? <p className="text-sm text-fg-3">Only the newest 200 gaps are shown.</p> : null}
          </section>
          <section aria-label="Feed event journal" className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Feed event journal</h2>
            <p className="text-sm text-fg-3">
              Written by the feed watcher every {read.data.watcher.intervalMs / 1000} s, never by a person: a drop when the stream passes
              the delayed boundary, a reconnect when a tick arrives after a drop. Nobody can edit it.
              {read.data.watcher.writing ? '' : ' The delayed boundary is not set, so nothing is being written.'}
            </p>
            {read.data.journal.length === 0 ? (
              <EmptyState variant="empty" size="inline" title="No drops or reconnects recorded for this market" />
            ) : (
              <table className="w-full text-sm" aria-label="Feed events">
                <thead>
                  <tr className="text-left text-fg-3">
                    <th scope="col" className="py-1 pr-4">
                      Time
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      Event
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      Reason
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      Actor
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {read.data.journal.map((event) => (
                    <tr key={event.id} data-kind={event.kind} data-at={event.at} className="border-t border-line">
                      <td className="py-1 pr-4 tabular-nums" data-field="time">
                        {utcSecond(event.at)}
                      </td>
                      <td className="py-1 pr-4" data-field="event">
                        {event.kind}
                      </td>
                      <td className="py-1 pr-4" data-field="reason">
                        {event.reason}
                      </td>
                      <td className="py-1 pr-4" data-field="actor">
                        {event.actor}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </DeskPage>
  );
}
