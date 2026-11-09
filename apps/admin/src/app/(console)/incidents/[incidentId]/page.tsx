import Link from 'next/link';
import { notFound } from 'next/navigation';
import { INCIDENT_NOT_FOUND } from '@intafaced/contracts/ops-incidents';
import { IncidentForm } from '@/components/incident-form';
import { formatAsOf } from '@/lib/as-of';
import { requireFounderPage } from '@/lib/founder-page';
import { loadIncident } from '@/lib/incidents/server';
import { requireModulePage } from '@/lib/module-page-guard';
import '@/components/desk.css';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One incident (`/incidents/:incidentId`, OPS-oncall-02): who takes part, its timeline and tasks, and the changes. A private
 * incident you do not take part in reads as not found, exactly like one that does not exist.
 */
export default async function IncidentPage({ params }: { params: Promise<{ incidentId: string }> }) {
  requireModulePage('killswitches');
  const founder = await requireFounderPage();
  const { incidentId } = await params;
  if (!UUID.test(incidentId)) notFound();
  const read = await loadIncident(founder, incidentId.toLowerCase());
  if (read.kind !== 'read')
    return (
      <main className="dk-stack" data-testid="incident">
        <p>
          <Link href="/incidents">← Incidents</Link>
        </p>
        {read.kind === 'unknown' && read.code === INCIDENT_NOT_FOUND ? (
          <p className="dk-why" role="alert" data-testid="incident-not-found">
            No incident with this id that you can see. Code: {INCIDENT_NOT_FOUND}
          </p>
        ) : (
          <p className="dk-why" role="alert" data-state="unavailable">
            Could not read this incident from svc-ops: {read.kind === 'unknown' ? read.message : 'it has no incident storage'}.
          </p>
        )}
      </main>
    );
  const { incident, participants, timeline, tasks } = read.data;
  const fixed = { incidentId: incident.id };
  return (
    <main className="dk-stack" data-testid="incident" data-incident={incident.id}>
      <p>
        <Link href="/incidents">← Incidents</Link>
      </p>
      <h1>
        Incident {incident.number}: {incident.title}
      </h1>
      <dl className="dk-stack">
        <div>
          <dt>Severity</dt>
          <dd data-testid="incident-severity">{incident.severity}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd data-testid="incident-status">{incident.status}</dd>
        </div>
        <div>
          <dt>Module</dt>
          <dd data-testid="incident-module">{incident.module ?? 'none named'}</dd>
        </div>
        <div>
          <dt>Visibility</dt>
          <dd data-testid="incident-visibility">{incident.private ? 'private: participants only' : 'all staff'}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd data-testid="incident-started" data-at={incident.startedAt}>
            {formatAsOf(incident.startedAt)}
          </dd>
        </div>
        <div>
          <dt>Ended</dt>
          <dd data-testid="incident-ended" data-at={incident.endedAt ?? ''}>
            {incident.endedAt ? formatAsOf(incident.endedAt) : 'not resolved'}
          </dd>
        </div>
      </dl>
      <section aria-labelledby="h-participants" data-testid="incident-participants">
        <h2 id="h-participants">Taking part</h2>
        <ul>
          {participants.map((p) => (
            <li key={p.userId} data-user={p.userId}>
              {p.userId}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="h-timeline" data-testid="incident-timeline">
        <h2 id="h-timeline">Timeline</h2>
        <ol>
          {timeline.map((t) => (
            <li key={t.id} data-kind={t.kind}>
              {formatAsOf(t.at)}: {t.body} ({t.actorId})
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="h-tasks" data-testid="incident-tasks">
        <h2 id="h-tasks">Tasks</h2>
        {tasks.length === 0 ? (
          <p>No tasks.</p>
        ) : (
          <ul>
            {tasks.map((t) => (
              <li key={t.id} data-assignee={t.assigneeId}>
                {t.title}: {t.assigneeId} ({t.status})
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="dk-stack" aria-labelledby="h-changes">
        <h2 id="h-changes">Changes</h2>
        <IncidentForm
          action="note"
          testId="incident-note"
          submit="Add the note"
          fixed={fixed}
          fields={[{ name: 'body', label: 'Note', kind: 'textarea' }]}
        />
        <IncidentForm
          action="invite"
          testId="incident-invite"
          submit="Invite"
          fixed={fixed}
          fields={[{ name: 'userId', label: 'User id to invite', kind: 'text' }]}
        />
        <IncidentForm
          action="task"
          testId="incident-task"
          submit="Add the task"
          fixed={fixed}
          fields={[
            { name: 'title', label: 'Task', kind: 'text' },
            { name: 'assigneeId', label: 'Assignee user id', kind: 'text' },
          ]}
        />
        <IncidentForm action="resolve" testId="incident-resolve" submit="Resolve the incident" fixed={fixed} fields={[]} />
      </section>
    </main>
  );
}
