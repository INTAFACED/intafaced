import Link from 'next/link';
import { MODULE_IDS } from '@intafaced/config/modules';
import { INCIDENT_SEVERITIES_UNSET } from '@intafaced/contracts/ops-incidents';
import { IncidentForm } from '@/components/incident-form';
import { formatAsOf } from '@/lib/as-of';
import { requireFounderPage } from '@/lib/founder-page';
import { loadIncidents } from '@/lib/incidents/server';
import { requireModulePage } from '@/lib/module-page-guard';
import { formatDuration } from '@/lib/ops-desk/model';
import '@/components/desk.css';

export const dynamic = 'force-dynamic';

/**
 * Staff incidents (`/incidents`, OPS-oncall-02): the metrics, the incidents you may see, and declaring one. Read from svc-ops
 * as the signed-in person when the page opens; a private incident you do not take part in is never listed or counted.
 */
export default async function IncidentsPage() {
  requireModulePage('killswitches');
  const founder = await requireFounderPage();
  const { list, metrics } = await loadIncidents(founder);
  return (
    <main className="dk-stack" data-testid="incidents">
      <h1>Incidents</h1>
      <section className="dk-stack" aria-labelledby="h-incident-metrics" data-testid="incident-metrics">
        <h2 id="h-incident-metrics">Metrics</h2>
        {metrics.kind !== 'read' ? (
          <p className="dk-why" role="alert" data-state="unavailable">
            Could not read the incident metrics from svc-ops: {metrics.kind === 'unknown' ? metrics.message : 'it has no incident storage'}.
          </p>
        ) : metrics.data.byStatus.length === 0 ? (
          <p data-state="empty">No incidents yet, so there is nothing to measure. No figure is shown in place of one.</p>
        ) : (
          <dl data-state="read">
            {metrics.data.byStatus.map((s) => (
              <div key={s.status} data-testid={`incident-metric-${s.status}`}>
                <dt>{s.status === 'active' ? 'Active' : 'Resolved'}</dt>
                <dd>{s.count}</dd>
              </div>
            ))}
            <div data-testid="incident-metric-ttr">
              <dt>Mean time to resolve</dt>
              <dd>
                {metrics.data.meanSecondsToResolve === null
                  ? 'none resolved yet'
                  : `${formatDuration(metrics.data.meanSecondsToResolve)} over ${metrics.data.resolvedCount} resolved`}
              </dd>
            </div>
          </dl>
        )}
      </section>
      <section className="dk-stack" aria-labelledby="h-incident-list" data-testid="incident-list">
        <h2 id="h-incident-list">Incidents you can see</h2>
        {list.kind !== 'read' ? (
          <p className="dk-why" role="alert" data-state="unavailable">
            Could not read incidents from svc-ops: {list.kind === 'unknown' ? list.message : 'it has no incident storage'}.
          </p>
        ) : list.data.incidents.length === 0 ? (
          <p data-state="empty">No incident has been declared.</p>
        ) : (
          <table className="dk-table" data-state="read">
            <thead>
              <tr>
                <th>No.</th>
                <th>Title</th>
                <th>Module</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {list.data.incidents.map((i) => (
                <tr key={i.id} data-testid={`incident-row-${i.number}`}>
                  <td>{i.number}</td>
                  <td>
                    <Link href={`/incidents/${i.id}`}>{i.title}</Link>
                    {i.private ? ' (private)' : ''}
                  </td>
                  <td>{i.module ?? '—'}</td>
                  <td>{i.severity}</td>
                  <td>{i.status}</td>
                  <td>{formatAsOf(i.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="dk-stack" aria-labelledby="h-declare">
        <h2 id="h-declare">Declare an incident</h2>
        {list.kind === 'read' && list.data.severities === null ? (
          <p className="dk-muted" data-testid="incident-severities-unset">
            No severities are set, so an incident can only be declared pending. Code: {INCIDENT_SEVERITIES_UNSET}
          </p>
        ) : null}
        <IncidentForm
          action="declare"
          testId="incident-declare"
          submit="Declare the incident"
          onDeclared
          fields={[
            { name: 'title', label: 'Title', kind: 'text' },
            {
              name: 'module',
              label: 'Module affected',
              kind: 'select',
              options: [{ value: '', label: 'None named' }, ...MODULE_IDS.map((m) => ({ value: m, label: m }))],
            },
            {
              name: 'severity',
              label: 'Severity',
              kind: 'select',
              options: [
                { value: '', label: 'Not assessed yet (pending)' },
                ...(list.kind === 'read' && list.data.severities ? list.data.severities : []).map((s) => ({ value: s, label: s })),
              ],
            },
            { name: 'private', label: 'Private: only the people taking part can see it', kind: 'checkbox' },
          ]}
        />
      </section>
    </main>
  );
}
