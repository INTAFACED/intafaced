import { formatAsOf, formatWhen } from '@/lib/as-of';
import type { OpsVenueEconomics } from '@intafaced/contracts';
import { CATEGORY_LABEL } from '@/lib/venue-economics/model';
import '../desk.css';

/**
 * The month's report as svc-ops answered it. A line nobody entered says "Not entered", never zero, and while any line is missing
 * the cost sums are labelled partial and there is no net. Fee revenue is the ledger's own figure for the month, per asset; net is
 * shown only when svc-ops worked it out, and otherwise says what it is waiting on. The warehouse read below it is as it stands and
 * is not cut by month.
 */

function FeeRevenue({ fees }: { fees: OpsVenueEconomics['feeRevenue'] }) {
  if (!fees) return null;
  if (fees.status === 'unavailable') {
    return (
      <div className="adm-callout" data-tone="warn" role="status" data-testid="fees-unavailable">
        <strong>Fee revenue not available</strong>
        <p>{fees.message}</p>
        <p className="dk-muted">Code: {fees.code}. It is not read as zero.</p>
      </div>
    );
  }
  if (fees.assets.length === 0) {
    return (
      <p className="dk-muted" data-testid="fees-empty">
        The ledger booked no fee movement this month. That is the ledger’s answer, not a missing read.
      </p>
    );
  }
  return (
    <div className="dk-table-wrap" role="region" aria-label="Fee revenue" tabIndex={0}>
      <table className="adm-table" data-testid="fees-table">
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col">Collected</th>
            <th scope="col">Returned</th>
            <th scope="col">Kept</th>
          </tr>
        </thead>
        <tbody>
          {fees.assets.map((a) => (
            <tr key={a.assetId}>
              <td>{a.assetId}</td>
              <td>{a.collected}</td>
              <td>{a.returned}</td>
              <td>{a.net}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dk-muted">From the ledger’s fee accounts for this month. Returned is corrections and distributions.</p>
    </div>
  );
}

function Net({ net, feesCode }: { net: OpsVenueEconomics['net']; feesCode: string | null }) {
  if (net.status === 'ok') {
    return (
      <div className="dk-table-wrap" role="region" aria-label="Net by asset" tabIndex={0}>
        <table className="adm-table" data-testid="net-table">
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Fee revenue kept</th>
              <th scope="col">Costs</th>
              <th scope="col">Net</th>
            </tr>
          </thead>
          <tbody>
            {net.byAsset.map((row) => (
              <tr key={row.asset}>
                <td>{row.asset}</td>
                <td>{row.revenue}</td>
                <td>{row.costs}</td>
                <td>{row.net}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dk-muted">Each asset on its own: fee revenue less the costs entered in that asset. Units are never mixed.</p>
      </div>
    );
  }
  if (net.reason === 'costs_incomplete') {
    return (
      <p data-testid="net-unavailable">
        Net needs every cost line entered. The fee revenue above is the ledger’s figure; the costs are partial, so no net is given.
      </p>
    );
  }
  if (net.reason === 'revenue_unavailable') {
    return (
      <p data-testid="net-unavailable">
        Net needs the ledger’s fee revenue, which could not be read{feesCode ? ` (${feesCode})` : ''}. No net is given and fees are not read
        as zero.
      </p>
    );
  }
  return (
    <p data-testid="net-unavailable">
      Net is not worked out here. The warehouse’s revenue points carry no currency or month, so subtracting costs from them would mix units.
    </p>
  );
}

function Revenue({ revenue }: { revenue: OpsVenueEconomics['revenue'] }) {
  if (revenue.status === 'unavailable') {
    return (
      <div className="adm-callout" data-tone="warn" role="status" data-testid="revenue-unavailable">
        <strong>Revenue not available</strong>
        <p>{revenue.message}</p>
        <p className="dk-muted">Code: {revenue.code}. The cost side below is still what was entered.</p>
      </div>
    );
  }
  if (revenue.empty || revenue.points.length === 0) {
    return (
      <p className="dk-muted" data-testid="revenue-empty">
        The analytics warehouse has no revenue to report. That is shown as empty, not as zero.
      </p>
    );
  }
  return (
    <div className="dk-table-wrap" role="region" aria-label="Revenue" tabIndex={0}>
      <table className="adm-table" data-testid="revenue-table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Breakdown</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {revenue.points.map((p, i) => (
            <tr key={`${p.metricId}:${p.dim ?? ''}:${i}`}>
              <td>{p.metricId}</td>
              <td>{p.dim ?? '—'}</td>
              <td>{p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dk-muted">Freshness: {revenue.freshness}. These are all the warehouse’s revenue points, not only this month’s.</p>
    </div>
  );
}

export function VenueEconomicsReport({ report, asOf }: { report: OpsVenueEconomics; asOf: string }) {
  return (
    <div className="dk-stack" data-testid="venue-report">
      <p className="dk-asof">
        {report.period}. As of {formatAsOf(asOf)} (when this console read svc-ops).
      </p>
      <section className="dk-stack" aria-label="Fee revenue">
        <h3>Fee revenue</h3>
        <FeeRevenue fees={report.feeRevenue} />
      </section>
      <section className="dk-stack" aria-label="Revenue">
        <h3>Warehouse revenue</h3>
        <Revenue revenue={report.revenue} />
      </section>
      <section className="dk-stack" aria-label="Costs">
        <h3>Costs</h3>
        {report.completeness.status === 'incomplete' && (
          <div className="adm-callout" data-tone="warn" role="status" data-testid="incomplete">
            <strong>Incomplete: no total for {report.period}</strong>
            <p>Not entered: {report.completeness.missing.map((c) => CATEGORY_LABEL[c]).join(', ')}.</p>
            <p className="dk-muted">A line nobody entered is not read as zero.</p>
          </div>
        )}
        <div className="dk-table-wrap" role="region" aria-label="Cost lines" tabIndex={0}>
          <table className="adm-table" data-testid="cost-table">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Amount</th>
                <th scope="col">Source note</th>
                <th scope="col">Entered</th>
                <th scope="col">Versions</th>
              </tr>
            </thead>
            <tbody>
              {report.costs.map((line) =>
                line.status === 'not_entered' ? (
                  <tr key={line.category} data-testid={`cost-${line.category}`}>
                    <td>{CATEGORY_LABEL[line.category]}</td>
                    <td colSpan={4}>Not entered</td>
                  </tr>
                ) : (
                  <tr key={line.category} data-testid={`cost-${line.category}`}>
                    <td>{CATEGORY_LABEL[line.category]}</td>
                    <td>
                      {line.current.amount} {line.current.asset}
                    </td>
                    <td>{line.current.sourceNote}</td>
                    <td>{formatWhen(line.current.enteredAt)}</td>
                    <td>
                      {line.history.length === 1 ? (
                        '1'
                      ) : (
                        <details>
                          <summary>{line.history.length} (latest is used)</summary>
                          <ul>
                            {line.history.map((h) => (
                              <li key={h.key}>
                                v{h.version}: {h.amount} {h.asset}, {formatWhen(h.enteredAt)}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
        <p data-testid="cost-totals">
          {report.costTotals.byAsset.length === 0
            ? 'Entered costs: none.'
            : `${report.costTotals.partial ? 'Entered so far (partial, not the month’s cost)' : 'Total cost'}: ${report.costTotals.byAsset
                .map((t) => `${t.amount} ${t.asset}`)
                .join(' + ')}.`}
        </p>
      </section>
      <section className="dk-stack" aria-label="Net">
        <h3>Net</h3>
        <Net net={report.net} feesCode={report.feeRevenue?.status === 'unavailable' ? report.feeRevenue.code : null} />
      </section>
    </div>
  );
}
