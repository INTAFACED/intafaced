import type { Part } from '@/lib/desk/part';
import type { SalaryRails } from '@/lib/bank-rails/model';
import type { RailsDesk } from '@/lib/bank-rails/read';

/**
 * The founders' bank rails desk (J-bank-30 #8): for each currency salary is paid in, the payroll network's own credits
 * minus reversals against what the app showed, reading "matches" or naming the difference. With no network wired it says
 * "no data", never zero; a part that failed says why and shows nothing.
 */
const when = (at: string) => new Date(at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const net = (f: { credits: string; reversals: string }) => `${f.credits} credited, ${f.reversals} reversed`;

function Failed({ part }: { part: Extract<Part<unknown>, { kind: 'failed' }> }) {
  return (
    <div className="adm-callout" data-tone={part.forbidden || part.notBuilt ? 'warn' : 'danger'} role="status" data-testid="rails-failed">
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
      <p className="dk-muted">Nothing is shown here rather than a guess.</p>
    </div>
  );
}

function Salary({ rails }: { rails: SalaryRails }) {
  return (
    <div className="dk-stack" data-testid="salary-rails">
      <p className="dk-muted" data-testid="salary-rails-source">
        As {rails.label} records it, at {when(rails.asOf)}.
      </p>
      {rails.lines.length === 0 ? (
        <p data-testid="salary-rails-none">No salary has been paid in by direct deposit.</p>
      ) : (
        <div className="dk-table-wrap">
          <table data-testid="salary-rails-lines">
            <caption>Network credits minus reversals, against what the app showed</caption>
            <thead>
              <tr>
                <th scope="col">Currency</th>
                <th scope="col">Network</th>
                <th scope="col">App</th>
                <th scope="col">Reconciliation</th>
              </tr>
            </thead>
            <tbody>
              {rails.lines.map((line) => (
                <tr key={line.currency} data-testid="salary-rail" data-currency={line.currency} data-matches={String(line.matches)}>
                  <td>{line.currency}</td>
                  <td data-testid="salary-rail-network">
                    {line.network ? net(line.network) : 'Not known: the network keeps no record here'}
                  </td>
                  <td data-testid="salary-rail-app">{net(line.app)}</td>
                  <td data-testid="salary-rail-verdict">
                    {line.matches === null
                      ? 'Not known'
                      : line.matches
                        ? 'matches'
                        : `differs by ${line.difference} ${line.currency} (network minus app)`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function RailsDeskView({ desk }: { desk: RailsDesk }) {
  return (
    <div className="dk-stack" data-testid="bank-rails-desk">
      <h2>Bank rails</h2>
      <p className="dk-muted dk-asof">Read {when(desk.asOf)}. The money is the partner bank&apos;s; this page compares records.</p>
      <h3>Salary by direct deposit</h3>
      {desk.salary.kind === 'failed' ? (
        <Failed part={desk.salary} />
      ) : desk.salary.data === null ? (
        <p className="adm-callout" data-tone="warn" role="status" data-testid="salary-rails-no-data">
          No data: no payroll network is connected, so there is nothing to reconcile. This is not zero.
        </p>
      ) : (
        <Salary rails={desk.salary.data} />
      )}
    </div>
  );
}
