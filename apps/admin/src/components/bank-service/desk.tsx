import type { Part } from '@/lib/desk/part';
import type { DirectDebitsReport, RampMetrics } from '@/lib/bank-service/model';
import type { ServiceDesk } from '@/lib/bank-service/read';

/**
 * The finance desk's bank service page (J-bank-28 #3 #4): ramp metrics and direct debit mandates, each as the partner
 * reports it. A part with no partner wired says "no data", never zero; a part that failed says why and shows nothing.
 */

const ORDER_WORDS: Record<string, string> = {
  opened: 'Opened, waiting for the payer',
  approved: 'Approved by the payer',
  paid: 'Paid',
  returned: 'Sent back',
  expired: 'Quote ran out unpaid',
};
const REASON_WORDS: Record<string, string> = {
  'test_partner.dd_mandate_blocked': 'The person blocked this mandate with the partner',
  'bank.partner_insufficient_funds': 'Not enough money at the partner',
  'bank.dd_mandate_blocked': 'The mandate is blocked',
};
const when = (at: string | null) => (at ? new Date(at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'never');

function Failed({ part, testId }: { part: Extract<Part<unknown>, { kind: 'failed' }>; testId: string }) {
  return (
    <div className="adm-callout" data-tone={part.forbidden || part.notBuilt ? 'warn' : 'danger'} role="status" data-testid={testId}>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
      <p className="dk-muted">Nothing is shown here rather than a guess.</p>
    </div>
  );
}

function NoData({ testId, what }: { testId: string; what: string }) {
  return (
    <p className="adm-callout" data-tone="warn" role="status" data-testid={testId}>
      No data: no partner is connected for {what}, so there is nothing to report. This is not zero.
    </p>
  );
}

function Ramps({ m }: { m: RampMetrics }) {
  return (
    <div className="dk-stack" data-testid="ramp-metrics">
      <p className="dk-muted" data-testid="ramp-source">
        As {m.label} reports it, at {when(m.asOf)}.
      </p>
      <dl className="dk-kv" data-testid="ramp-health">
        <div className="dk-kv-row">
          <dt>Partner health</dt>
          <dd data-testid="ramp-health-state">{m.health === 'operational' ? 'Operational' : m.health}</dd>
        </div>
        <div className="dk-kv-row">
          <dt>Last order opened</dt>
          <dd>{when(m.lastOpenedAt)}</dd>
        </div>
        <div className="dk-kv-row">
          <dt>Last payment</dt>
          <dd>{when(m.lastPaidAt)}</dd>
        </div>
      </dl>
      <div className="dk-table-wrap">
        <table data-testid="ramp-orders">
          <caption>Orders by state</caption>
          <thead>
            <tr>
              <th scope="col">State</th>
              <th scope="col">Orders</th>
            </tr>
          </thead>
          <tbody>
            {m.orders.map((o) => (
              <tr key={o.state} data-testid="ramp-order-state" data-state={o.state}>
                <td>{ORDER_WORDS[o.state] ?? o.state}</td>
                <td data-testid="ramp-order-count">{o.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Quote expiries</h4>
      <p data-testid="ramp-quote-expiries" data-count={m.quoteExpiries.count}>
        {m.quoteExpiries.count} {m.quoteExpiries.count === 1 ? 'order' : 'orders'} whose quote ran out before the payer approved.
      </p>
      {m.quoteExpiries.latest.length > 0 && (
        <ul data-testid="ramp-quote-expiry-list">
          {m.quoteExpiries.latest.map((e) => (
            <li key={e.orderId} data-testid="ramp-quote-expiry" data-order={e.orderId}>
              Order {e.orderId}, quote ran out {when(e.expiredAt)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DirectDebits({ d }: { d: DirectDebitsReport }) {
  return (
    <div className="dk-stack" data-testid="dd-report">
      <p className="dk-muted" data-testid="dd-source">
        As {d.label} reports it, at {when(d.asOf)}. Refunds the partner made: {d.refundCount}.
      </p>
      <h4>Failures by reason</h4>
      {d.failuresByReason.length === 0 ? (
        <p data-testid="dd-failures-none">The partner reports no refused collections.</p>
      ) : (
        <ul data-testid="dd-failures-by-reason">
          {d.failuresByReason.map((f) => (
            <li key={f.code} data-testid="dd-failure-reason" data-code={f.code} data-count={f.count}>
              {REASON_WORDS[f.code] ?? 'A reason this console has no words for'} ({f.code}): {f.count}
            </li>
          ))}
        </ul>
      )}
      <h4>Mandates</h4>
      {d.mandates.length === 0 ? (
        <p data-testid="dd-mandates-none">The partner reports no mandates.</p>
      ) : (
        <ul className="dk-stack" data-testid="dd-mandates">
          {d.mandates.map((m) => (
            <li
              key={`${m.userId}|${m.mandateId}`}
              className="dk-stack"
              data-testid="dd-mandate"
              data-mandate={m.mandateId}
              data-state={m.state}
            >
              <dl className="dk-kv">
                <div className="dk-kv-row">
                  <dt>Mandate</dt>
                  <dd>{m.mandateId}</dd>
                </div>
                <div className="dk-kv-row">
                  <dt>Customer</dt>
                  <dd>{m.userId}</dd>
                </div>
                <div className="dk-kv-row">
                  <dt>Creditor</dt>
                  <dd>
                    {m.creditorName ?? 'Not known here'}
                    {m.reference ? `, reference ${m.reference}` : ''}
                  </dd>
                </div>
                <div className="dk-kv-row">
                  <dt>State</dt>
                  <dd data-testid="dd-mandate-state">{m.state === 'blocked' ? `Blocked since ${when(m.blockedAt)}` : 'Active'}</dd>
                </div>
              </dl>
              {m.refunds.length > 0 && (
                <ul data-testid="dd-refunds">
                  {m.refunds.map((r) => (
                    <li key={r.collectionId} data-testid="dd-refund" data-collection={r.collectionId} data-amount={r.amount}>
                      Refunded {r.amount} {r.assetId} for collection {r.collectionId} on {when(r.refundedAt)} (partner move {r.moveId})
                    </li>
                  ))}
                </ul>
              )}
              {m.failures.length > 0 && (
                <ul data-testid="dd-failures">
                  {m.failures.map((f) => (
                    <li key={f.collectionId} data-testid="dd-failure" data-collection={f.collectionId} data-code={f.code}>
                      Collection {f.collectionId} refused: {REASON_WORDS[f.code] ?? f.code} ({f.code}), {when(f.at)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ServiceDeskView({ desk }: { desk: ServiceDesk }) {
  return (
    <div className="dk-stack" data-testid="bank-service-desk">
      <h2>Bank service: ramps and direct debits</h2>
      <p className="dk-muted dk-asof">
        Read {when(desk.asOf)}. Ramps and direct debits are the partner&apos;s; this page shows what it reports.
      </p>
      <h3>Ramp metrics</h3>
      {desk.ramps.kind === 'failed' ? (
        <Failed part={desk.ramps} testId="ramps-failed" />
      ) : desk.ramps.data === null ? (
        <NoData testId="ramps-no-data" what="ramps" />
      ) : (
        <Ramps m={desk.ramps.data} />
      )}
      <h3>Direct debit mandates</h3>
      {desk.directDebits.kind === 'failed' ? (
        <Failed part={desk.directDebits} testId="dd-failed" />
      ) : desk.directDebits.data === null ? (
        <NoData testId="dd-no-data" what="direct debits" />
      ) : (
        <DirectDebits d={desk.directDebits.data} />
      )}
    </div>
  );
}
