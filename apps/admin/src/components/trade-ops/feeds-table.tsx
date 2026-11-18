import Link from 'next/link';
import { FEED_STATE_LABEL, feedHref, utcSecond, type FeedRow } from '@/lib/trade-ops/feeds-model';

/**
 * Each market's candle stream: state, age and last tick time (J-charts-desk-18 #1). Server rendered, read only. A value
 * the service did not send is "—"; a market with no tick says so and has no age.
 */
export function FeedsTable({ rows, link = true }: { rows: readonly FeedRow[]; link?: boolean }) {
  return (
    <table className="w-full text-sm" aria-label="Candle streams">
      <thead>
        <tr className="text-left text-fg-3">
          <th scope="col" className="py-1 pr-4">
            Market
          </th>
          <th scope="col" className="py-1 pr-4">
            State
          </th>
          <th scope="col" className="py-1 pr-4">
            Age
          </th>
          <th scope="col" className="py-1 pr-4">
            Last tick
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.symbol} data-symbol={row.symbol} data-state={row.state} className="border-t border-line">
            <th scope="row" className="py-1 pr-4 text-left font-medium">
              {link ? <Link href={feedHref(row.symbol)}>{row.symbol}</Link> : row.symbol}
              {row.test ? <span className="ml-2 text-xs text-fg-3">TEST</span> : null}
            </th>
            <td className="py-1 pr-4" data-field="state">
              {FEED_STATE_LABEL[row.state]}
            </td>
            <td className="py-1 pr-4 tabular-nums" data-field="age" data-seconds={row.ageSeconds ?? undefined}>
              {row.ageSeconds === null ? '—' : `${row.ageSeconds} s`}
            </td>
            <td className="py-1 pr-4 tabular-nums" data-field="last-tick" data-at={row.lastTickAt ?? undefined}>
              {row.lastTickAt === null ? 'No tick yet' : utcSecond(row.lastTickAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One line on what the states are judged against, so a reader never guesses the threshold. */
export function BoundaryNote({ staleAgeSeconds, delayedAgeSeconds }: { staleAgeSeconds: number | null; delayedAgeSeconds: number | null }) {
  const delayed =
    delayedAgeSeconds === null
      ? ' The delayed age is not set, so no stream reads delayed.'
      : ` Older than ${delayedAgeSeconds} s (the owner's delayed age) it reads delayed.`;
  return (
    <p
      className="text-sm text-fg-3"
      data-testid="feed-boundary"
      data-seconds={staleAgeSeconds ?? undefined}
      data-delayed-seconds={delayedAgeSeconds ?? undefined}
    >
      {staleAgeSeconds === null
        ? 'The stale age is not set (Charts settings), so no stream is judged live or stale and no feed event is written.'
        : `A stream whose newest candle tick is older than ${staleAgeSeconds} s (the owner's stale age, Charts settings) reads stale.${delayed}`}
    </p>
  );
}
