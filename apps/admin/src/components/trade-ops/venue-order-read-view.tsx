import type { VenueOrderRead } from '@/lib/trade-ops/order-read';
import { venueStatusLabel } from '@/lib/trade-ops/order-read';

const SENT: Record<VenueOrderRead['sent'], string> = {
  accepted: 'The venue took the order',
  refused: 'The venue refused the order: it never held it',
  unknown: 'No definite answer from the venue: the send is not known',
};

/**
 * One customer's routed order as the venue reports it (J-cex-spot-18 #1, #2), read by the customer's own address: its
 * state in the words the customer's own order page uses, what filled, the reject reason in the venue's words, and every
 * fill. INTAFACED holds none of it; nothing is added or estimated.
 */
export function VenueOrderReadView({ read }: { read: VenueOrderRead }) {
  const o = read.order;
  const rows: Array<{ label: string; value: string; testId?: string; mono?: boolean }> = [
    { label: 'Status', value: o ? venueStatusLabel(o.status) : 'Not on the venue', testId: 'venue-read-status' },
    { label: 'Status (venue)', value: o ? o.status : 'none', mono: true },
    { label: 'Our send', value: SENT[read.sent] },
    ...(o
      ? [
          { label: 'Market', value: o.symbol },
          { label: 'Side', value: o.side },
          { label: 'Type', value: `${o.type} · ${o.timeInForce}` },
          { label: 'Price', value: o.price, mono: true },
          { label: 'Amount', value: o.amount, mono: true },
          { label: 'Filled', value: o.filled, testId: 'venue-read-filled', mono: true },
          { label: 'Remaining', value: o.remaining, mono: true },
          { label: 'Average price', value: o.averagePrice ?? 'Not known', mono: true },
        ]
      : []),
    {
      label: 'Reject reason',
      value: read.reject ? `${read.reject.code}: ${read.reject.detail}` : 'None recorded',
      testId: 'venue-read-reject',
      mono: read.reject !== null,
    },
    { label: 'Customer (user id)', value: read.accountId, mono: true },
    { label: "Customer's venue address", value: read.owner, testId: 'venue-read-owner', mono: true },
    ...(read.subAccount ? [{ label: 'Venue sub-account', value: read.subAccount, mono: true }] : []),
    { label: 'Venue', value: read.venueId, mono: true },
    { label: 'Recorded by us (UTC)', value: read.recordedAt, mono: true },
    { label: 'Venue read as of (UTC)', value: read.asOf, mono: true },
  ];
  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="Routed order read"
        className="max-w-2xl border border-line p-3"
        data-venue-order-read=""
        data-order-id={read.venueClientOrderId}
        data-account-id={read.accountId}
        data-owner={read.owner}
        data-status={o?.status ?? ''}
        data-filled={o?.filled ?? ''}
      >
        <h2 className="mb-2 text-sm font-medium">The routed order, read from the venue by the customer&apos;s address</h2>
        <dl className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-x-4 gap-y-1 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-fg-3">{row.label}</dt>
              <dd className={row.mono ? 'if-num break-all' : undefined} data-testid={row.testId}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-fg-3">
          This read is written to the audit with your name, the customer and the time, and the customer sees it in their own access list.
        </p>
      </section>
      <section aria-label="Venue fills" className="flex flex-col gap-2 border border-line p-3">
        <h2 className="text-sm font-medium">Fills, as the venue reports them</h2>
        {read.fills.length === 0 ? (
          <p className="text-sm text-fg-2">Nothing has filled.</p>
        ) : (
          <table aria-label="Venue fills of this order" className="w-full text-sm">
            <thead>
              <tr className="text-start text-fg-3">
                <th className="text-start font-normal">Fill id</th>
                <th className="text-end font-normal">Price</th>
                <th className="text-end font-normal">Amount</th>
                <th className="text-start font-normal">Role</th>
                <th className="text-end font-normal">Venue fee</th>
                <th className="text-end font-normal">Builder fee</th>
                <th className="text-start font-normal">Time (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {read.fills.map((fill) => (
                <tr key={fill.fillId} data-testid="venue-read-fill" data-fill-id={fill.fillId}>
                  <td className="if-num break-all">{fill.fillId}</td>
                  <td className="if-num text-end">{fill.price}</td>
                  <td className="if-num text-end">{fill.amount}</td>
                  <td>{fill.role}</td>
                  <td className="if-num text-end">{`${fill.venueFee} ${fill.feeAsset}`}</td>
                  <td className="if-num text-end">{`${fill.builderFee} ${fill.feeAsset}`}</td>
                  <td className="if-num">{fill.filledAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
