'use client';

import { useCallback, useEffect, useState } from 'react';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchView, postEnrolment } from '@/lib/academy/enrolment-browser';
import {
  BYPASS_WORDS,
  COURSES,
  MAIL_NOT_CONNECTED,
  RECIPIENT_WORDS,
  ROW_CODE_WORDS,
  courseTitle,
  type AcademyStaffEnrolmentEvent,
  type EnrolmentReply,
  type EnrolmentView,
  type MailView,
  type ReportsView,
} from '@/lib/academy/enrolment-model';
import type { AcademyBulkEnrol, AcademyCourseInvitation } from '@intafaced/contracts/academy-staff-enrolment';
import { Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * STAFF ENROLMENT (J-academy-15): enrol people in bulk or one at a time, invite an address, tag learners in bulk, write
 * to a course, and export learners by tag. Every change asks for a reason (svc-academy refuses one without it), shows
 * every refusal, and reads again; nothing is retried on its own. This build has no email provider, so every mail step
 * says so with `vendor.email`, and nobody is ever marked sent.
 */

export function EnrolmentNav() {
  return (
    <nav aria-label="Programmes pages" className="dk-row">
      <a href="/academy-ops/programmes/learners">Learners</a>
      <a href="/academy-ops/programmes/enrolment">Enrolment and invitations</a>
      <a href="/academy-ops/programmes/mail">Course email</a>
      <a href="/academy-ops/catalogue/reports">Learner exports</a>
    </nav>
  );
}

function MailNotice({ action }: { action: string }) {
  return (
    <p className="adm-callout" data-tone="warn" data-not-connected="vendor.email" data-testid="mail-not-connected">
      {MAIL_NOT_CONNECTED(action)} <span className="dk-muted">(vendor.email)</span>
    </p>
  );
}

function CourseSelect({ name, label }: { name: string; label: string }) {
  return (
    <label>
      {label}
      <select name={name} aria-label={label} defaultValue="foundations">
        {COURSES.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.title}
          </option>
        ))}
      </select>
    </label>
  );
}

const field = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? '');

function useSend(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<EnrolmentReply | null>(null);
  const send = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setReply(null);
      const answer = await postEnrolment(body);
      setReply(answer);
      await reload();
      setBusy(false);
      return answer;
    },
    [reload],
  );
  return { busy, reply, send };
}

function Bypassed({ event }: { event: AcademyStaffEnrolmentEvent }) {
  return event.bypassed.length === 0 ? (
    <span>nothing</span>
  ) : (
    <span data-bypassed={event.bypassed.join(' ')}>{event.bypassed.map((b) => BYPASS_WORDS[b] ?? b).join('; ')}</span>
  );
}

export function EnrolmentDesk({ initial }: { initial: EnrolmentView }) {
  const [view, setView] = useState(initial);
  const reload = useCallback(async () => {
    const next = await fetchView<EnrolmentView>('view=enrolment');
    if (next) setView(next);
  }, []);
  const bulk = useSend(reload);
  const one = useSend(reload);
  const invite = useSend(reload);
  const tag = useSend(reload);
  const bulkResult = bulk.reply?.ok ? (bulk.reply.data as AcademyBulkEnrol) : null;
  const enrolled = one.reply?.ok ? (one.reply.data as { outcome: string; event: AcademyStaffEnrolmentEvent | null }) : null;
  const invited = invite.reply?.ok ? (invite.reply.data as AcademyCourseInvitation & { replayed: boolean }) : null;

  return (
    <section className="dk-stack" aria-labelledby="h-enrolment" data-testid="enrolment-desk">
      <h2 id="h-enrolment">Enrolment and invitations</h2>
      <EnrolmentNav />
      <p className="dk-muted">Read {formatAsOf(view.asOf)}.</p>

      <section className="dk-stack" aria-labelledby="h-bulk" data-testid="bulk-enrol">
        <h3 id="h-bulk">Enrol people in bulk</h3>
        <p className="dk-muted">
          One email address per line. Each is enrolled, or listed with why not. No mail is sent. The same upload again changes nothing.
        </p>
        <form
          className="dk-stack"
          aria-label="Bulk enrol"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            void bulk.send({
              op: 'bulkEnrol',
              path: field(form, 'path'),
              addresses: field(form, 'addresses'),
              reason: field(form, 'reason'),
            });
          }}
        >
          <CourseSelect name="path" label="Course" />
          <label>
            Addresses
            <textarea name="addresses" rows={8} aria-label="Addresses, one per line" />
          </label>
          <label>
            Reason
            <input name="reason" aria-label="Reason for the bulk enrolment" />
          </label>
          <button type="submit" className="adm-btn" disabled={bulk.busy}>
            Enrol everyone
          </button>
        </form>
        {bulk.reply && !bulk.reply.ok && <Outcome reply={bulk.reply} />}
        {bulkResult && (
          <div className="dk-stack" data-testid="bulk-result" data-replayed={String(bulkResult.replayed)}>
            <p role="status">
              {bulkResult.replayed
                ? 'This upload was already made: these are its stored answers, and nothing was changed.'
                : `${bulkResult.rows.filter((r) => r.outcome === 'enrolled').length} enrolled in ${courseTitle(bulkResult.path)}.`}{' '}
              No mail was sent.
            </p>
            <table className="dk-table">
              <thead>
                <tr>
                  <th scope="col">Address</th>
                  <th scope="col">Answer</th>
                  <th scope="col">Why not</th>
                </tr>
              </thead>
              <tbody>
                {bulkResult.rows.map((row, i) => (
                  <tr key={i} data-address={row.address} data-outcome={row.outcome} data-code={row.code ?? ''}>
                    <td>{row.address}</td>
                    <td>{row.outcome === 'enrolled' ? 'Enrolled' : row.outcome === 'already_enrolled' ? 'Already enrolled' : 'Refused'}</td>
                    <td>{row.code ? `${ROW_CODE_WORDS[row.code] ?? row.code} (${row.code})` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dk-stack" aria-labelledby="h-one" data-testid="staff-enrol">
        <h3 id="h-one">Enrol one learner</h3>
        <p className="dk-muted">
          Staff enrolment goes past a full course, a closed window or a hidden course, and records it with your reason.
        </p>
        <form
          className="dk-row"
          aria-label="Enrol one learner"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            void one.send({ op: 'staffEnrol', path: field(form, 'path'), learner: field(form, 'learner'), reason: field(form, 'reason') });
          }}
        >
          <label>
            Whole email or handle
            <input name="learner" aria-label="Learner email or handle" />
          </label>
          <CourseSelect name="path" label="Course" />
          <label>
            Reason
            <input name="reason" aria-label="Reason for the enrolment" />
          </label>
          <button type="submit" className="adm-btn" disabled={one.busy}>
            Enrol learner
          </button>
        </form>
        {one.reply && !one.reply.ok && <Outcome reply={one.reply} />}
        {enrolled && (
          <p role="status" data-testid="staff-enrol-result" data-outcome={enrolled.outcome}>
            {enrolled.event ? (
              <>
                Enrolled. Went past: <Bypassed event={enrolled.event} />. Reason: {enrolled.event.reason}.
              </>
            ) : (
              'Already enrolled: nothing was changed.'
            )}
          </p>
        )}
        <h4>Staff enrolments</h4>
        {view.events.kind === 'failed' ? (
          <Failed title="Could not read staff enrolments" message={view.events.message} code={view.events.code} />
        ) : view.events.data.length === 0 ? (
          <p className="dk-muted">No staff enrolment yet.</p>
        ) : (
          <table className="dk-table" data-testid="staff-enrolments">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Learner</th>
                <th scope="col">Course</th>
                <th scope="col">How</th>
                <th scope="col">Went past</th>
                <th scope="col">Reason</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {view.events.data.map((e) => (
                <tr key={e.key} data-event={e.key} data-learner={e.userId}>
                  <td>{formatWhen(e.at)}</td>
                  <td>
                    <a href={`/academy-ops/programmes/learners/${e.userId}`}>{e.userId}</a>
                  </td>
                  <td>{courseTitle(e.path)}</td>
                  <td>{e.source === 'bulk' ? 'Bulk upload' : 'One learner'}</td>
                  <td>
                    <Bypassed event={e} />
                  </td>
                  <td>{e.reason}</td>
                  <td>{e.actorId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="dk-stack" aria-labelledby="h-invite" data-testid="invitations">
        <h3 id="h-invite">Invite an address</h3>
        <p className="dk-muted">For a person with no account yet. Only a masked form of the address is kept.</p>
        <form
          className="dk-row"
          aria-label="Invite an address"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            void invite.send({ op: 'invite', path: field(form, 'path'), address: field(form, 'address'), reason: field(form, 'reason') });
          }}
        >
          <label>
            Email address
            <input name="address" aria-label="Address to invite" />
          </label>
          <CourseSelect name="path" label="Course" />
          <label>
            Reason
            <input name="reason" aria-label="Reason for the invitation" />
          </label>
          <button type="submit" className="adm-btn" disabled={invite.busy}>
            Invite
          </button>
        </form>
        {invite.reply && !invite.reply.ok && <Outcome reply={invite.reply} />}
        {invited && (
          <div className="dk-stack" data-testid="invite-result" data-invitation={invited.key}>
            <p role="status">
              {invited.replayed ? 'This address was already invited to this course: nothing was changed.' : 'Invitation stored.'}{' '}
              {invited.addressMask} to {courseTitle(invited.path)}.
            </p>
            <MailNotice action="The invitation mail" />
          </div>
        )}
        {view.invitations.kind === 'failed' ? (
          <Failed title="Could not read invitations" message={view.invitations.message} code={view.invitations.code} />
        ) : view.invitations.data.length === 0 ? (
          <p className="dk-muted">No invitation yet.</p>
        ) : (
          <table className="dk-table" data-testid="invitation-list">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Address</th>
                <th scope="col">Course</th>
                <th scope="col">Reason</th>
                <th scope="col">Mail</th>
              </tr>
            </thead>
            <tbody>
              {view.invitations.data.map((i) => (
                <tr key={i.key} data-invitation={i.key}>
                  <td>{formatWhen(i.at)}</td>
                  <td>{i.addressMask}</td>
                  <td>{courseTitle(i.path)}</td>
                  <td>{i.reason}</td>
                  <td data-not-connected={i.mail}>Needs an email provider</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="dk-stack" aria-labelledby="h-tag" data-testid="bulk-tag">
        <h3 id="h-tag">Tag learners in bulk</h3>
        <form
          className="dk-stack"
          aria-label="Tag learners in bulk"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            void tag.send({ op: 'bulkTag', learners: field(form, 'learners'), tag: field(form, 'tag'), reason: field(form, 'reason') });
          }}
        >
          <label>
            Learners
            <textarea name="learners" rows={5} aria-label="Learners to tag, one email or handle per line" />
          </label>
          <label>
            Tag
            <input name="tag" aria-label="Tag" />
          </label>
          <label>
            Reason
            <input name="reason" aria-label="Reason for the tag" />
          </label>
          <button type="submit" className="adm-btn" disabled={tag.busy}>
            Tag learners
          </button>
        </form>
        {tag.reply && <Outcome reply={tag.reply} />}
        {view.tags.kind === 'ok' && view.tags.data.length > 0 && (
          <p className="dk-muted">
            Tags:{' '}
            {view.tags.data.map((t) => (
              <a key={t.tag} href={`/academy-ops/programmes/learners?tag=${encodeURIComponent(t.tag)}`}>
                {t.tag} ({t.learners}){' '}
              </a>
            ))}
          </p>
        )}
      </section>
    </section>
  );
}

export function MailDesk({ initial }: { initial: MailView }) {
  const [view, setView] = useState(initial);
  const [open, setOpen] = useState<string | null>(initial.detail?.kind === 'ok' ? initial.detail.data.id : null);
  const reload = useCallback(async () => {
    const next = await fetchView<MailView>(`view=mail${open ? `&id=${open}` : ''}`);
    if (next) setView(next);
  }, [open]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const mail = useSend(reload);
  const history = view.history.kind === 'ok' ? view.history.data : [];

  return (
    <section className="dk-stack" aria-labelledby="h-mail" data-testid="mail-desk">
      <h2 id="h-mail">Course email</h2>
      <EnrolmentNav />
      <p className="dk-muted">
        Written to a course’s enrolled learners. Learners who opted out of the course’s email, and learners inactive for longer than the
        owner’s period, are left out. Every send is recorded before it goes out.
      </p>
      <MailNotice action="Sending a course email" />
      <form
        className="dk-stack"
        aria-label="Write to a course"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const path = field(form, 'path');
          // One key per press, from the course's stored history: a retry after a lost reply answers the stored email.
          const n = history.filter((h) => h.path === path).length + 1;
          void mail
            .send({ op: 'sendMail', path, subject: field(form, 'subject'), body: field(form, 'body'), key: `mail:${path}:${n}` })
            .then((a) => {
              if (a.ok && a.data && typeof a.data === 'object' && 'id' in a.data) setOpen(String((a.data as { id: string }).id));
            });
        }}
      >
        <CourseSelect name="path" label="Course" />
        <label>
          Subject
          <input name="subject" aria-label="Subject" />
        </label>
        <label>
          Message
          <textarea name="body" rows={6} aria-label="Message" />
        </label>
        <button type="submit" className="adm-btn" disabled={mail.busy}>
          Send to participants
        </button>
      </form>
      {mail.reply && <Outcome reply={mail.reply} />}
      <h3>History</h3>
      {view.history.kind === 'failed' ? (
        <Failed title="Could not read the history" message={view.history.message} code={view.history.code} />
      ) : history.length === 0 ? (
        <p className="dk-muted">No course email yet.</p>
      ) : (
        <table className="dk-table" data-testid="mail-history">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Course</th>
              <th scope="col">Subject</th>
              <th scope="col">State</th>
              <th scope="col">Not sent</th>
              <th scope="col">Sent</th>
              <th scope="col">Opted out</th>
              <th scope="col">Inactive</th>
              <th scope="col">Recipients</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id} data-email={h.id} data-state={h.state} data-refusal={h.refusal ?? ''}>
                <td>{formatWhen(h.at)}</td>
                <td>{courseTitle(h.path)}</td>
                <td>{h.subject}</td>
                <td>{h.state === 'refused' ? `Refused: needs an email provider (${h.refusal})` : 'Sent'}</td>
                <td>{h.counts.not_sent}</td>
                <td>{h.counts.sent}</td>
                <td>{h.counts.skipped_opted_out}</td>
                <td>{h.counts.skipped_inactive}</td>
                <td>
                  <button type="button" className="adm-btn" onClick={() => setOpen(h.id)}>
                    Show recipients
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.detail?.kind === 'failed' && (
        <Failed title="Could not read the recipients" message={view.detail.message} code={view.detail.code} />
      )}
      {view.detail?.kind === 'ok' && (
        <div className="dk-stack" data-testid="mail-recipients" data-email={view.detail.data.id}>
          <h4>Recipients of “{view.detail.data.subject}”</h4>
          <p className="dk-muted">Inactive means no learning for more than {view.detail.data.inactiveDays} days.</p>
          <table className="dk-table">
            <thead>
              <tr>
                <th scope="col">Learner</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {view.detail.data.recipients.map((r) => (
                <tr key={r.userId} data-learner={r.userId} data-state={r.state}>
                  <td>{r.userId}</td>
                  <td>{RECIPIENT_WORDS[r.state] ?? r.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const TASK_WORDS: Record<string, string> = { queued: 'Queued', running: 'Running', done: 'Finished', failed: 'Failed' };

export function ReportsDesk({ initial }: { initial: ReportsView }) {
  const [view, setView] = useState(initial);
  const reload = useCallback(async () => {
    const next = await fetchView<ReportsView>('view=reports');
    if (next) setView(next);
  }, []);
  const ask = useSend(reload);
  const tasks = view.tasks.kind === 'ok' ? view.tasks.data : [];
  const waiting = tasks.some((t) => t.state === 'queued' || t.state === 'running');
  // While an export runs in the background, the list is read again every two seconds until it finishes.
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => void reload(), 2000);
    return () => clearTimeout(timer);
  }, [waiting, view, reload]);

  return (
    <section className="dk-stack" aria-labelledby="h-reports" data-testid="reports-desk">
      <h2 id="h-reports">Learner exports</h2>
      <EnrolmentNav />
      <p className="dk-muted">
        An export runs in the background. A finished one keeps its finish time and the SHA-256 of its file until the owner’s retention ends.
      </p>
      <form
        className="dk-row"
        aria-label="Request a learner export"
        onSubmit={(e) => {
          e.preventDefault();
          const tag = field(e.currentTarget, 'tag').trim();
          // One key per press of Request, from the stored list: a retry after a lost reply reuses the same task.
          const n = tasks.filter((t) => (t.tag ?? '') === tag).length + 1;
          void ask.send({ op: 'requestExport', tag, key: `report:learners:${tag}:${n}` });
        }}
      >
        <label>
          Learners tagged
          <select name="tag" aria-label="Filter by tag" defaultValue="">
            <option value="">Every learner</option>
            {view.tags.kind === 'ok' &&
              view.tags.data.map((t) => (
                <option key={t.tag} value={t.tag}>
                  {t.tag} ({t.learners})
                </option>
              ))}
          </select>
        </label>
        <button type="submit" className="adm-btn" disabled={ask.busy}>
          Request export
        </button>
      </form>
      {ask.reply && <Outcome reply={ask.reply} />}
      {view.tasks.kind === 'failed' ? (
        <Failed title="Could not read the exports" message={view.tasks.message} code={view.tasks.code} />
      ) : tasks.length === 0 ? (
        <p className="dk-muted">No export yet.</p>
      ) : (
        <table className="dk-table" data-testid="report-tasks">
          <thead>
            <tr>
              <th scope="col">Requested</th>
              <th scope="col">Learners tagged</th>
              <th scope="col">State</th>
              <th scope="col">Rows</th>
              <th scope="col">Finished</th>
              <th scope="col">SHA-256</th>
              <th scope="col">File</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} data-report={t.id} data-key={t.key} data-state={t.state}>
                <td>{formatWhen(t.requestedAt)}</td>
                <td>{t.tag ?? 'every learner'}</td>
                <td>
                  {TASK_WORDS[t.state] ?? t.state}
                  {t.failure ? `: ${t.failure}` : ''}
                </td>
                <td>{t.rows ?? ''}</td>
                <td data-finished={t.finishedAt ?? ''}>{t.finishedAt ? formatWhen(t.finishedAt) : ''}</td>
                <td data-sha256={t.sha256 ?? ''}>
                  <code>{t.sha256 ?? ''}</code>
                </td>
                <td>
                  {t.state === 'done' && !t.expired && <a href={`/api/academy-reports?id=${t.id}`}>Download CSV</a>}
                  {t.expired && 'Expired'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
