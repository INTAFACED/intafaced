'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Chip, type ChipTone } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { ApprovalActions, noticeTarget, type Submit } from '@/components/notify-approval-actions';
import { postNotifyChange } from '@/lib/notify/incidents-browser';
import { approvalFor, type IncidentDeskReply, type PublishApproval } from '@/lib/notify/incidents-model';
import { fetchMaintenanceDesk } from '@/lib/notify/maintenance-browser';
import {
  checkMaintenanceDraft,
  parseOffsets,
  type MaintenanceDeskView,
  type MaintenanceState,
  type MaintenanceTarget,
  type MaintenanceWindow,
} from '@/lib/notify/maintenance-model';

/**
 * MAINTENANCE DESK (SP-status-03).
 *
 * Schedule a maintenance window with the components it touches and reminder offsets, ask for the approval its publish
 * spends, approve another founder's request, publish. Once published svc-notify derives where it stands: scheduled
 * before the start, in progress from it, then the operators mark it verifying and completed (or cancel it first). A
 * completed or cancelled window is final, and svc-notify refuses a reopen. Each reminder goes out once, before the start.
 */

const STATE: Record<MaintenanceState, { label: string; tone: ChipTone }> = {
  scheduled: { label: 'Scheduled', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'warn' },
  verifying: { label: 'Verifying', tone: 'warn' },
  completed: { label: 'Completed', tone: 'live' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const MOVES: readonly { to: MaintenanceTarget; label: string }[] = [
  { to: 'verifying', label: 'Mark verifying' },
  { to: 'completed', label: 'Mark completed' },
  { to: 'cancelled', label: 'Cancel window' },
  { to: 'in_progress', label: 'Reopen' },
];

/** A `datetime-local` value as an instant; blank or unreadable is null. */
const fromLocal = (value: string) => {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

function Outcome({ reply }: { reply: IncidentDeskReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="maintenance-desk-outcome">
        <strong>Done: {reply.what}</strong>
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="maintenance-desk-outcome"
      data-code={reply.code ?? ''}
    >
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}

function Failed({ title, message }: { title: string; message: string }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status">
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  );
}

function ScheduleForm({
  components,
  basis,
  busy,
  onSubmit,
}: {
  components: readonly { id: string; name: string }[];
  basis: string | null;
  busy: boolean;
  onSubmit: Submit;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [offsets, setOffsets] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  const save = () => {
    const reminderOffsets = parseOffsets(offsets);
    if (reminderOffsets === null) return setWhy('Reminder offsets are whole minutes from 1 to 43200, at most 10, separated by commas.');
    const input = {
      title,
      body,
      startsAt: fromLocal(startsAt) ?? '',
      endsAt: fromLocal(endsAt) ?? '',
      components: chosen,
      reminderOffsets,
    };
    const check = checkMaintenanceDraft(input);
    if (!check.ok) return setWhy(check.why);
    setWhy(null);
    onSubmit({ op: 'draft', ...input, basis });
  };
  return (
    <section className="dk-stack" aria-labelledby="maintenance-schedule" data-testid="maintenance-schedule">
      <h2 id="maintenance-schedule">Schedule maintenance</h2>
      <div className="adm-field">
        <label htmlFor="maintenance-title">Title</label>
        <input
          id="maintenance-title"
          className="adm-input"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="maintenance-body">What happens</label>
        <textarea
          id="maintenance-body"
          className="adm-textarea"
          rows={3}
          value={body}
          maxLength={8000}
          onChange={(e) => setBody(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="maintenance-starts">Starts</label>
          <input
            id="maintenance-starts"
            type="datetime-local"
            className="adm-input"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="maintenance-ends">Planned end</label>
          <input
            id="maintenance-ends"
            type="datetime-local"
            className="adm-input"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>
      {components.length === 0 ? (
        <p className="dk-muted">No components are defined on the status page.</p>
      ) : (
        <fieldset className="dk-row">
          <legend>Components it touches</legend>
          {components.map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={chosen.includes(c.id)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))}
                disabled={busy}
              />{' '}
              {c.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className="adm-field">
        <label htmlFor="maintenance-offsets">Reminders, minutes before the start</label>
        <input
          id="maintenance-offsets"
          className="adm-input"
          value={offsets}
          placeholder="none"
          onChange={(e) => setOffsets(e.target.value)}
          disabled={busy}
        />
        <small className="dk-muted">Blank sends no reminder. Each one goes once to the subscribers the window concerns.</small>
      </div>
      {why && (
        <p className="dk-why" role="alert">
          {why}
        </p>
      )}
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={save} disabled={busy}>
          Save draft
        </button>
        <span className="dk-muted">Nothing is public until a second founder approves and it is published.</span>
      </div>
    </section>
  );
}

function reminderLine(r: MaintenanceWindow['reminders'][number]) {
  if (r.sentAt) return `sent ${formatWhen(r.sentAt)}`;
  if (r.skipped) return `not sent: the window was ${r.skipped.replace('_', ' ')} when it came due`;
  return `due ${formatWhen(r.dueAt)}`;
}

function WindowCard({
  window: w,
  approval,
  names,
  me,
  busy,
  onSubmit,
}: {
  window: MaintenanceWindow;
  approval: PublishApproval | null;
  names: ReadonlyMap<string, string>;
  me: string;
  busy: boolean;
  onSubmit: Submit;
}) {
  const [reason, setReason] = useState('');
  const { notice } = w;
  const state = w.state ? STATE[w.state] : { label: 'Draft', tone: 'neutral' as ChipTone };
  return (
    <article className="dk-stack" data-testid="maintenance-window" data-window-id={notice.id} data-state={w.state ?? 'draft'}>
      <h3>
        {notice.title} <Chip tone={state.tone}>{state.label}</Chip>
      </h3>
      <p>{notice.body}</p>
      <p className="dk-muted">
        {formatWhen(notice.startsAt)} to {formatWhen(notice.endsAt)} (planned). Components:{' '}
        {notice.components.length === 0 ? 'none named' : notice.components.map((c) => names.get(c) ?? c).join(', ')}.
        {notice.authorId === me ? ' Written by you.' : ''}
      </p>
      <div data-testid="maintenance-reminders">
        {notice.reminderOffsets.length === 0 ? (
          <p className="dk-muted">No reminders.</p>
        ) : (
          <ul>
            {notice.reminderOffsets.map((offset) => {
              const row = w.reminders.find((r) => r.offsetMinutes === offset);
              return (
                <li key={offset} data-testid="maintenance-reminder" data-offset={offset} data-sent={row?.sentAt ? 'yes' : 'no'}>
                  {offset} minute{offset === 1 ? '' : 's'} before:{' '}
                  {row ? reminderLine(row) : notice.status === 'draft' ? 'after it is published' : 'not yet scheduled'}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {notice.status === 'draft' ? (
        <ApprovalActions
          target={noticeTarget(notice.id, 'maintenance-approval')}
          approval={approval}
          me={me}
          busy={busy}
          onSubmit={onSubmit}
        />
      ) : (
        <div className="dk-stack" data-testid="maintenance-moves">
          {w.moves.length > 0 && (
            <ol>
              {w.moves.map((m) => (
                <li key={m.state}>
                  {STATE[m.state as MaintenanceState]?.label ?? m.state} {formatWhen(m.movedAt)}
                  {m.movedBy === me ? ' by you' : ' by another founder'}: {m.reason}
                </li>
              ))}
            </ol>
          )}
          <div className="adm-field">
            <label htmlFor={`maintenance-reason-${notice.id}`}>Reason for a move</label>
            <input
              id={`maintenance-reason-${notice.id}`}
              className="adm-input"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="dk-row">
            {MOVES.map((m) => (
              <button
                key={m.to}
                type="button"
                className="adm-btn adm-btn--compact"
                onClick={() => onSubmit({ op: 'move', id: notice.id, to: m.to, reason })}
                disabled={busy || reason.trim() === ''}
              >
                {m.label}
              </button>
            ))}
          </div>
          {(w.state === 'completed' || w.state === 'cancelled') && (
            <p className="dk-muted">Final: svc-notify refuses a reopen. If the work is needed again, schedule a new window.</p>
          )}
        </div>
      )}
    </article>
  );
}

export function NotifyMaintenanceDesk({ initial }: { initial: MaintenanceDeskView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<IncidentDeskReply | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Approvals this founder approved on this visit: identity lists a decided approval to its requester only.
  const [decided, setDecided] = useState<readonly PublishApproval[]>([]);
  const [generation, setGeneration] = useState(0);

  const reread = useCallback(async (clear: boolean) => {
    const next = await fetchMaintenanceDesk();
    setLoadFailed(next === null);
    if (next) {
      setView(next);
      if (clear) setGeneration((g) => g + 1);
    }
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setReply(null);
    await reread(true);
    setBusy(false);
  }, [reread]);

  const submit = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      const result = await postNotifyChange('/api/notify-maintenance', body);
      setReply(result);
      if (result.ok && result.approval) {
        const approval = result.approval;
        setDecided((list) => [...list.filter((a) => a.approvalId !== approval.approvalId), approval]);
      }
      await reread(result.ok);
      setBusy(false);
    },
    [reread],
  );

  const onSubmit: Submit = (b) => void submit(b);
  const components = view.components.kind === 'ok' ? view.components.data : [];
  const names = new Map(components.map((c) => [c.id, c.name]));
  const listed = view.approvals.kind === 'ok' ? view.approvals.data : [];
  const approvals = [
    ...listed,
    ...decided.filter(
      (a) => !listed.some((l) => l.approvalId === a.approvalId || (l.targetId === a.targetId && l.createdAt > a.createdAt)),
    ),
  ];
  const windows = view.windows.kind === 'ok' ? view.windows.data : [];
  return (
    <div className="dk-stack" data-testid="maintenance-desk">
      <header className="adm-pagehead">
        <h1>Maintenance</h1>
        <p className="dk-muted">
          Scheduled maintenance on the public status page. <Link href="/notify/incidents">Incident desk</Link> ·{' '}
          <Link href="/notify">Notify health</Link>
        </p>
        <div className="dk-row">
          <button type="button" className="adm-btn" onClick={() => void refresh()} disabled={busy}>
            {busy ? 'Reading…' : 'Read again'}
          </button>
          <span className="dk-asof">As of {formatAsOf(view.asOf)}</span>
        </div>
        {loadFailed && <p className="dk-why">The console could not read the desk again. What is shown is the last read.</p>}
      </header>
      <Outcome reply={reply} />
      {view.components.kind === 'failed' && (
        <Failed title="The status page components could not be read" message={view.components.message} />
      )}
      {view.approvals.kind === 'failed' && <Failed title="Approvals could not be read" message={view.approvals.message} />}
      <div key={generation} className="dk-stack">
        <ScheduleForm components={components} basis={windows[0]?.notice.id ?? null} busy={busy} onSubmit={onSubmit} />
        <section className="dk-stack" aria-labelledby="maintenance-list">
          <h2 id="maintenance-list">Windows</h2>
          {view.windows.kind === 'failed' ? (
            <Failed title="Maintenance windows could not be read" message={view.windows.message} />
          ) : windows.length === 0 ? (
            <p className="dk-muted" data-testid="maintenance-none">
              No maintenance windows, drafted or published.
            </p>
          ) : (
            windows.map((w) => (
              <WindowCard
                key={w.notice.id}
                window={w}
                approval={approvalFor(w.notice.id, approvals)}
                names={names}
                me={view.me}
                busy={busy}
                onSubmit={onSubmit}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}
