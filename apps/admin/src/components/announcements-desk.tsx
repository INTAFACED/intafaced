'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_DIALOG_MAX,
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_LINK,
  ANNOUNCEMENT_LINK_LABEL_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  announcementPhase,
  announcementWindowProblem,
  type Announcement,
  type AnnouncementAction,
  type AnnouncementKind,
  type AnnouncementPhase,
} from '@intafaced/contracts/ops-console-announcements';
import { Chip } from '@/components/chip';
import { formatAsOf } from '@/lib/as-of';
import { fetchAnnouncements, postConsoleChange, type ConsoleChangeReply } from '@/lib/console-announcements/browser';
import { KIND_LABEL, type AnnouncementsView } from '@/lib/console-announcements/model';
import { formatInZone, zonedInputToIso } from '@/lib/time-zone';
import './desk.css';

/**
 * ANNOUNCEMENT BANNER (OPS-admin-access-08, admin-access-035).
 *
 * A message to every founder on every console page while its window is open: a kind, a title, a message, and a link or a
 * longer text behind "Read more". Save it as a draft and publish it later, or publish at once. Only one shows at a time:
 * svc-ops refuses to publish a window that overlaps another published one. The window is typed in the founder's own time
 * zone (Profile and preferences). This is the console's own banner; customers' announcements are on Notify.
 */

const PHASE_LABEL: Readonly<Record<AnnouncementPhase, string>> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  active: 'Showing now',
  ended: 'Ended',
  withdrawn: 'Withdrawn',
};
const PHASE_TONE: Readonly<Record<AnnouncementPhase, 'live' | 'info' | 'neutral' | 'warn'>> = {
  draft: 'neutral',
  scheduled: 'info',
  active: 'live',
  ended: 'neutral',
  withdrawn: 'neutral',
};

type Submit = (body: Record<string, unknown>) => void;

function Outcome({ reply }: { reply: ConsoleChangeReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="announcements-outcome">
        <strong>Done: {String(reply.answer.what ?? 'saved')}</strong>
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="announcements-outcome"
      data-code={reply.code ?? ''}
    >
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}

function actionOf(type: AnnouncementAction['type'], url: string, label: string, text: string): AnnouncementAction | string {
  if (type === 'none') return { type: 'none' };
  if (type === 'dialog') {
    const t = text.trim();
    return t === '' ? 'Write the text "Read more" opens.' : { type: 'dialog', text: t };
  }
  if (!ANNOUNCEMENT_LINK.test(url.trim())) return 'A link is an https address or a console path such as /ledger.';
  return label.trim() === '' ? 'Give the link a label.' : { type: 'link', url: url.trim(), label: label.trim() };
}

function DraftForm({
  basis,
  timeZone,
  defaultStart,
  defaultEnd,
  busy,
  onSubmit,
}: {
  basis: string | null;
  timeZone: string;
  defaultStart: string;
  defaultEnd: string;
  busy: boolean;
  onSubmit: Submit;
}) {
  // The newest announcement when this form opened. It stays the same until a save lands, so a save sent again after an
  // unknown outcome carries the same key and finds what the first one stored.
  const [frozenBasis] = useState(basis);
  const [kind, setKind] = useState<AnnouncementKind>('information');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [actionType, setActionType] = useState<AnnouncementAction['type']>('none');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const startsAt = zonedInputToIso(start, timeZone);
  const endsAt = zonedInputToIso(end, timeZone);
  const action = actionOf(actionType, url, label, text);
  const why =
    title.trim() === ''
      ? 'Write a title.'
      : typeof action === 'string'
        ? action
        : !startsAt || !endsAt
          ? 'Pick a start and an end.'
          : announcementWindowProblem(startsAt, endsAt, new Date().toISOString(), false);
  const submit = (publish: boolean) => {
    if (why || typeof action === 'string') return;
    onSubmit({ op: 'save', basis: frozenBasis, kind, title, body, action, startsAt, endsAt, publish });
  };
  return (
    <section className="dk-stack" aria-labelledby="announcement-draft" data-testid="announcement-form">
      <h2 id="announcement-draft">Write an announcement</h2>
      <div className="adm-field">
        <label htmlFor="announcement-kind">Kind</label>
        <select
          id="announcement-kind"
          className="adm-input"
          value={kind}
          onChange={(e) => setKind(e.target.value as AnnouncementKind)}
          disabled={busy}
        >
          {ANNOUNCEMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <div className="adm-field">
        <label htmlFor="announcement-title">Title</label>
        <input
          id="announcement-title"
          className="adm-input"
          value={title}
          maxLength={ANNOUNCEMENT_TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="announcement-body">Message</label>
        <textarea
          id="announcement-body"
          className="adm-input"
          rows={2}
          value={body}
          maxLength={ANNOUNCEMENT_BODY_MAX}
          onChange={(e) => setBody(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="announcement-action">With it</label>
        <select
          id="announcement-action"
          className="adm-input"
          value={actionType}
          onChange={(e) => setActionType(e.target.value as AnnouncementAction['type'])}
          disabled={busy}
        >
          <option value="none">Nothing more</option>
          <option value="link">A link</option>
          <option value="dialog">A longer text behind “Read more”</option>
        </select>
      </div>
      {actionType === 'link' && (
        <div className="dk-row">
          <div className="adm-field">
            <label htmlFor="announcement-url">Link (https address or console path)</label>
            <input id="announcement-url" className="adm-input" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
          </div>
          <div className="adm-field">
            <label htmlFor="announcement-label">Link label</label>
            <input
              id="announcement-label"
              className="adm-input"
              value={label}
              maxLength={ANNOUNCEMENT_LINK_LABEL_MAX}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
      )}
      {actionType === 'dialog' && (
        <div className="adm-field">
          <label htmlFor="announcement-dialog">Text behind “Read more”</label>
          <textarea
            id="announcement-dialog"
            className="adm-input"
            rows={4}
            value={text}
            maxLength={ANNOUNCEMENT_DIALOG_MAX}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
        </div>
      )}
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="announcement-start">Shows from ({timeZone})</label>
          <input
            id="announcement-start"
            type="datetime-local"
            className="adm-input"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="announcement-end">Until ({timeZone})</label>
          <input
            id="announcement-end"
            type="datetime-local"
            className="adm-input"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>
      {why && (title !== '' || body !== '') && <p className="dk-why">{why}</p>}
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => submit(false)} disabled={busy || why !== null}>
          Save draft
        </button>
        <button type="button" className="adm-btn" data-tone="primary" onClick={() => submit(true)} disabled={busy || why !== null}>
          Publish
        </button>
        <span className="dk-muted">Only one announcement shows at a time; a published window cannot overlap another.</span>
      </div>
    </section>
  );
}

function AnnouncementRow({
  a,
  asOf,
  me,
  timeZone,
  busy,
  onSubmit,
}: {
  a: Announcement;
  asOf: string;
  me: string;
  timeZone: string;
  busy: boolean;
  onSubmit: Submit;
}) {
  const phase = announcementPhase(a, asOf);
  const publishWhy = a.status === 'published' ? 'Published already.' : a.status === 'withdrawn' ? 'Withdrawn.' : null;
  return (
    <article className="dk-stack" data-testid="announcement-row" data-announcement-id={a.id} data-phase={phase}>
      <h3>
        {KIND_LABEL[a.kind]}: {a.title} <Chip tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Chip>
      </h3>
      {a.body !== '' && <p>{a.body}</p>}
      <p className="dk-muted" data-testid="announcement-window">
        From {formatInZone(a.startsAt, timeZone)} until {formatInZone(a.endsAt, timeZone)}.
        {a.action.type === 'link' ? ` Links to ${a.action.url}.` : a.action.type === 'dialog' ? ' Has a “Read more” text.' : ''}
        {a.createdBy === me ? ' Written by you.' : ''}
      </p>
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          onClick={() => onSubmit({ op: 'publish', id: a.id })}
          disabled={busy || publishWhy !== null}
          title={publishWhy ?? undefined}
        >
          Publish
        </button>
        <button
          type="button"
          className="adm-btn"
          onClick={() => onSubmit({ op: 'withdraw', id: a.id })}
          disabled={busy || a.status === 'withdrawn'}
          title={a.status === 'withdrawn' ? 'Withdrawn already.' : undefined}
        >
          Withdraw
        </button>
        {(publishWhy || a.status === 'withdrawn') && (
          <span className="dk-muted" data-testid="announcement-controls-why">
            {a.status === 'withdrawn' ? 'Withdrawn: it stays down; write a new one to show it again.' : publishWhy}
          </span>
        )}
      </div>
    </article>
  );
}

export function AnnouncementsDesk({
  initial,
  me,
  timeZone,
  defaultStart,
  defaultEnd,
}: {
  initial: AnnouncementsView;
  me: string;
  timeZone: string;
  defaultStart: string;
  defaultEnd: string;
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ConsoleChangeReply | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [formKey, setFormKey] = useState(0);

  const reread = useCallback(async (): Promise<boolean> => {
    const next = await fetchAnnouncements();
    setLoadFailed(next === null);
    if (next) setView(next);
    // The banner lives in the console layout: re-render it with the announcement now showing.
    router.refresh();
    return next !== null;
  }, [router]);

  const submit = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      const result = await postConsoleChange('/api/console-announcements', body);
      setReply(result);
      const fresh = await reread();
      if (fresh && body.op === 'save' && result.ok) setFormKey((k) => k + 1);
      setBusy(false);
    },
    [reread],
  );
  const onSubmit: Submit = (b) => void submit(b);

  const data = view.kind === 'read' ? view.data : null;
  return (
    <div className="dk-stack" data-testid="announcements-desk">
      <header className="adm-pagehead">
        <h1>Announcements</h1>
        <p className="dk-muted">
          A banner for everyone signed in to this console, shown on every page while its window is open. Customers’ announcements are on
          Notify.
        </p>
        <div className="dk-row">
          <button
            type="button"
            className="adm-btn"
            onClick={() => {
              setBusy(true);
              setReply(null);
              void reread().then(() => setBusy(false));
            }}
            disabled={busy}
          >
            {busy ? 'Reading…' : 'Read again'}
          </button>
          {data && <span className="dk-asof">As of {formatAsOf(data.asOf)}</span>}
        </div>
        {loadFailed && <p className="dk-why">The console could not read the desk again. What is shown is the last read.</p>}
      </header>
      <Outcome reply={reply} />
      {view.kind === 'unconfigured' && (
        <div className="adm-callout" data-tone="warn" role="status" data-testid="announcements-unconfigured">
          <strong>Announcements have no storage</strong>
          <p>svc-ops has no database configured for console announcements, so none can be saved and none shows.</p>
        </div>
      )}
      {view.kind === 'unknown' && (
        <div className="adm-callout" data-tone="danger" role="status" data-testid="announcements-unknown">
          <strong>Announcements could not be read</strong>
          <p>
            {view.message}
            {view.code ? ` Code: ${view.code}.` : ''}
          </p>
        </div>
      )}
      {data && (
        <>
          <p data-testid="announcement-showing">{data.active ? `Showing now: ${data.active.title}.` : 'No announcement is showing now.'}</p>
          <DraftForm
            key={formKey}
            basis={data.items[0]?.id ?? null}
            timeZone={timeZone}
            defaultStart={defaultStart}
            defaultEnd={defaultEnd}
            busy={busy}
            onSubmit={onSubmit}
          />
          <section className="dk-stack" aria-labelledby="announcements-list">
            <h2 id="announcements-list">Announcements</h2>
            {data.items.length === 0 ? (
              <p className="dk-muted" data-testid="announcements-none">
                No announcements, drafted or published.
              </p>
            ) : (
              data.items.map((a) => (
                <AnnouncementRow key={a.id} a={a} asOf={data.asOf} me={me} timeZone={timeZone} busy={busy} onSubmit={onSubmit} />
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}
