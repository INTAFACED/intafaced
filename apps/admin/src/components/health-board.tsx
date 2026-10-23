import Link from 'next/link';
import { Chip } from '@/components/chip';
import { formatAsOf } from '@/lib/as-of';
import { HEALTH_SOURCE_UNAVAILABLE, HEALTH_SOURCE_UNWIRED, type Figure, type HealthRow } from '@/lib/module-health/board';
import './desk.css';

/**
 * The module health board's table. Every module is a row; what fills each cell is said in words beside the figure, a figure
 * a module does not give is "not given" with the reason, and a row with no source or a failed read says so with its code.
 */

function FigureCell({ figure, testid }: { figure: Figure; testid: string }) {
  return (
    <td data-testid={testid}>
      {figure.value === null ? <span className="dk-muted">Not given</span> : <strong>{figure.value}</strong>}
      <br />
      <span className="dk-muted">{figure.note}</span>
    </td>
  );
}

export function HealthBoard({ rows, startedAt }: { rows: readonly HealthRow[]; startedAt: string }) {
  const read = rows.filter((r) => r.state === 'read').length;
  const refused = rows.filter((r) => r.state === 'refused').length;
  const unwired = rows.filter((r) => r.state === 'unwired').length;
  return (
    <div className="dk" data-testid="health-board">
      <div className="adm-pagehead">
        <div>
          <h1>Module health</h1>
          <p>
            Every platform module: how much it did, what failed and the oldest item still waiting, each from that module’s own operator read
            and labelled with what it counts. A module with no source says why and shows no count.
          </p>
        </div>
      </div>
      <div className="dk-row">
        <a className="adm-btn" href="/health">
          Refresh
        </a>
        <span className="dk-asof">Read started {formatAsOf(startedAt)}</span>
        <Chip tone={refused === 0 ? 'live' : 'warn'}>
          {read} read · {refused} refused · {unwired} no source
        </Chip>
      </div>
      <div className="dk-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">Module</th>
              <th scope="col">Volume</th>
              <th scope="col">Failures</th>
              <th scope="col">Oldest waiting</th>
              <th scope="col">Desk</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.module} data-testid={`health-${row.module}`} data-state={row.state}>
                <th scope="row">
                  {row.label}
                  {row.state === 'read' && <div className="dk-asof">As of {formatAsOf(row.asOf)}</div>}
                </th>
                {row.state === 'read' && (
                  <>
                    <FigureCell figure={row.volume} testid="volume" />
                    <FigureCell figure={row.failures} testid="failures" />
                    <FigureCell figure={row.oldest} testid="oldest" />
                  </>
                )}
                {row.state === 'unwired' && (
                  <td colSpan={3}>
                    <strong>No source: </strong>
                    {row.blocker} <span className="dk-muted">Code: {HEALTH_SOURCE_UNWIRED}</span>
                  </td>
                )}
                {row.state === 'refused' && (
                  <td colSpan={3} role="status">
                    <strong>Could not read {row.service}: </strong>
                    {row.message}{' '}
                    <span className="dk-muted">
                      {row.asOf ? `As of ${formatAsOf(row.asOf)}. ` : ''}Code: {HEALTH_SOURCE_UNAVAILABLE}. No count is shown rather than a
                      guess.
                    </span>
                  </td>
                )}
                <td>{row.desk ? <Link href={row.desk.href}>{row.desk.label}</Link> : <span className="dk-muted">No desk yet</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
