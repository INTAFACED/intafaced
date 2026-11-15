import type { OrderRead } from '@/lib/trade-ops/order-read';
import { customerStatusOf, rejectText, statusLabel } from '@/lib/trade-ops/order-read';

/**
 * One order as the service's operator read gives it (J-cex-spot-18 #1, #2): its state in the customer's own words and
 * the service's, what filled, the reject reason as recorded, and every fill. Nothing is added or estimated.
 */
export function OrderReadView({ read }: { read: OrderRead }) {
  const rows: Array<{ label: string; value: string; testId?: string; mono?: boolean }> = [
    { label: 'Status', value: statusLabel(read.status), testId: 'order-read-status' },
    { label: 'Status the customer sees', value: customerStatusOf(read.status) },
    { label: 'Status (service)', value: read.status, mono: true },
    { label: 'Filled', value: read.filled, testId: 'order-read-filled', mono: true },
    { label: 'Amount', value: read.qty, mono: true },
    { label: 'Price', value: read.price ?? 'None (market order)', mono: true },
    { label: 'Side', value: read.side },
    { label: 'Type', value: read.type },
    { label: 'Reject reason', value: rejectText(read.rejectCode), testId: 'order-read-reject', mono: read.rejectCode !== null },
    { label: 'Account (user id)', value: read.accountId, mono: true },
    { label: 'Market id', value: read.marketId, mono: true },
    { label: 'Held', value: `${read.holdAmount} ${read.holdAsset}`, mono: true },
    { label: 'Origin', value: read.seeded ? 'House seed (seeded liquidity)' : 'Customer' },
    { label: 'Created (UTC)', value: read.createdAt, mono: true },
  ];
  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="Order read"
        className="max-w-2xl border border-line p-3"
        data-order-read=""
        data-order-id={read.id}
        data-account-id={read.accountId}
        data-customer-status={customerStatusOf(read.status)}
        data-filled={read.filled}
      >
        <h2 className="mb-2 text-sm font-medium">The order, from the service&apos;s read</h2>
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
        <p className="mt-2 text-xs text-fg-3">This read is written to the audit with your name, the customer and the time.</p>
      </section>
      <section aria-label="Fills" className="flex flex-col gap-2 border border-line p-3">
        <h2 className="text-sm font-medium">Fills</h2>
        {read.fills.length === 0 ? (
          <p className="text-sm text-fg-2">Nothing has filled.</p>
        ) : (
          <table aria-label="Fills of this order" className="w-full text-sm">
            <thead>
              <tr className="text-start text-fg-3">
                <th className="text-start font-normal">Fill id</th>
                <th className="text-end font-normal">Price</th>
                <th className="text-end font-normal">Quantity</th>
                <th className="text-end font-normal">Quote amount</th>
                <th className="text-end font-normal">Fee</th>
              </tr>
            </thead>
            <tbody>
              {read.fills.map((fill) => (
                <tr key={fill.id} data-testid="order-read-fill" data-fill-id={fill.id}>
                  <td className="if-num break-all">{fill.id}</td>
                  <td className="if-num text-end">{fill.price}</td>
                  <td className="if-num text-end">{fill.qty}</td>
                  <td className="if-num text-end">{fill.quoteAmount}</td>
                  <td className="if-num text-end">{fill.feeAmount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
