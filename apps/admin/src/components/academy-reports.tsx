'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchReports, postReportsChange } from '@/lib/academy/analytics-browser';
import { stateText, type AcademyReportTask, type ReportsDeskReply, type ReportsView } from '@/lib/academy/analytics-model';
import { Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * REPORTS CENTRE (AC-analytics-02, J-academy-16 #3 to #5).
 *
 * A report is a task svc-academy runs on its report sweep: Request writes it (Requested), the sweep starts it (Running)
 * and, on its next pass, stores its file (Finished) or says why it failed. A requested or running task can be aborted and
 * then never has a file. A finished file is a CSV kept for the owner's retention, shown with the time it was made and its
 * SHA-256, and downloaded byte for byte; past the retention it says Expired. Delete takes a task and its file off the
 * list. Each request carries the founder's next request number, so a retry answers the task it made and never makes a
 * second; only pressing Request again does. Every state is the service's own, read again after each change.
 */

function TaskRow({ task, busy, onAbort, onDelete }: { task: AcademyReportTask; busy: boolean; onAbort: () => void; onDelete: () => void }) {
  const file = task.state === 'done' && !task.expired;
  return (
    <tr data-report-task={task.id} data-state={task.expired ? 'expired' : task.state}>
      <td>{task.n}</td>
      <td>{task.tag ? `Learners tagged ${task.tag}` : 'Every learner'}</td>
      <td data-testid="report-state">{stateText(task)}</td>
      <td data-testid="report-requested-at" data-at={task.requestedAt}>
        {formatWhen(task.requestedAt)}
      </td>
      <td data-testid="report-made-at" data-at={task.finishedAt ?? ''}>
        {task.state === 'done' && task.finishedAt ? formatWhen(task.finishedAt) : 'no file'}
      </td>
      <td>{task.state === 'done' && task.sha256 ? <code data-testid="report-sha256">{task.sha256}</code> : (task.failure ?? '')}</td>
      <td data-testid="report-expires-at" data-at={task.expiresAt ?? ''}>
        {task.expiresAt ? (task.expired ? `Expired ${formatWhen(task.expiresAt)}` : `Kept until ${formatWhen(task.expiresAt)}`) : ''}
      </td>
      <td className="dk-row">
        {task.state === 'done' && (
          <a href={`/api/academy-reports?task=${encodeURIComponent(task.id)}`} download aria-disabled={!file}>
            Download report {task.n}
          </a>
        )}
        {(task.state === 'queued' || task.state === 'running') && (
          <button type="button" className="adm-btn" disabled={busy} onClick={onAbort}>
            Abort report {task.n}
          </button>
        )}
        <button type="button" className="adm-btn" disabled={busy} onClick={onDelete}>
          Delete report {task.n}
        </button>
      </td>
    </tr>
  );
}

export function AcademyReports({ initial }: { initial: ReportsView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ReportsDeskReply | null>(null);
  const [tag, setTag] = useState('');

  const reload = useCallback(async () => {
    const next = await fetchReports();
    if (next) setView(next);
  }, []);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postReportsChange(body);
    setReply(answer);
    setBusy(false);
    // Whatever the answer, the list shows the tasks as svc-academy holds them now.
    await reload();
  };

  const part = view?.tasks;
  const data = part?.kind === 'ok' ? part.data : null;
  return (
    <div className="dk" data-testid="academy-reports">
      <div className="adm-pagehead">
        <div>
          <h1>Reports</h1>
          <p>
            <Link href="/academy-ops/catalogue">Back to the catalogue</Link> ·{' '}
            <Link href="/academy-ops/catalogue/analytics">Academy numbers</Link>
          </p>
        </div>
        <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      </div>
      <Outcome reply={reply} />
      {!part && <p className="dk-why">The console could not reach its own server. Nothing is shown rather than a guess.</p>}
      {part?.kind === 'failed' && <Failed title="Could not read the report tasks" message={part.message} code={part.code} />}
      {data && (
        <>
          <section className="dk-stack" aria-labelledby="h-request">
            <h2 id="h-request">Request a report</h2>
            <form
              className="dk-row"
              aria-label="Request a report"
              onSubmit={(e) => {
                e.preventDefault();
                const t = tag.trim();
                void send({ op: 'request', kind: 'learners', tag: t === '' ? null : t, n: data.nextN });
              }}
            >
              <label>
                Report
                <select name="kind" defaultValue="learners" aria-label="Report">
                  <option value="learners">Learners: enrolments, items completed, last active, tags</option>
                </select>
              </label>
              <label>
                Learner tag (blank for every learner)
                <input name="tag" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Learner tag" />
              </label>
              <button type="submit" className="adm-btn" disabled={busy}>
                Request report {data.nextN}
              </button>
            </form>
            <button type="button" className="adm-btn" disabled={busy} onClick={() => void reload()}>
              Read the list again
            </button>
          </section>
          <section className="dk-stack" aria-labelledby="h-tasks">
            <h2 id="h-tasks">Report tasks</h2>
            {data.tasks.length === 0 ? (
              <p className="dk-muted" data-testid="report-tasks-empty">
                No report has been requested yet.
              </p>
            ) : (
              <table className="dk-table" data-testid="report-tasks">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Learners</th>
                    <th>State</th>
                    <th>Requested</th>
                    <th>File made</th>
                    <th>SHA-256</th>
                    <th>Kept</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      busy={busy}
                      onAbort={() => void send({ op: 'abort', taskId: t.id })}
                      onDelete={() => void send({ op: 'delete', taskId: t.id })}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
