import { formatAsOf, formatWhen } from '@/lib/as-of';
import type { OpsVenueEconomics } from '@intafaced/contracts';
import { CATEGORY_LABEL } from '@/lib/venue-economics/model';
import '../desk.css';

/**
 * The month's report as svc-ops answered it. A line nobody entered says "Not entered", never zero, and while any line is missing
 * the cost sums are labelled partial and there is no net. Revenue is the warehouse read as it stands; it is not cut by month.
 */

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
  const incomplete = report.completeness.status === 'incomplete';
  return (
    <div className="dk-stack" data-testid="venue-report">
      <p className="dk-asof">
        {report.period}. As of {formatAsOf(asOf)} (when this console read svc-ops).
      </p>
      <section className="dk-stack" aria-label="Revenue">
        <h3>Revenue</h3>
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
        <p data-testid="net-unavailable">
          Net is not worked out here. The warehouse’s revenue points carry no currency or month, so subtracting costs from them would mix
          units.
          {incomplete ? ' It also needs every cost line entered.' : ''}
        </p>
      </section>
    </div>
  );
}
