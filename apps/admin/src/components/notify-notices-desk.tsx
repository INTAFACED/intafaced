'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { ApprovalActions, noticeTarget, type Submit } from '@/components/notify-approval-actions';
import { postNotifyChange } from '@/lib/notify/incidents-browser';
import { approvalFor, type IncidentDeskReply, type PublishApproval } from '@/lib/notify/incidents-model';
import { fetchNoticesDesk } from '@/lib/notify/notices-browser';
import {
  categoriesText,
  checkAnnouncementDraft,
  parseCategories,
  type Announcement,
  type Audience,
  type AudienceOption,
  type NoticeCategories,
  type NoticesDeskView,
  CATEGORIES_REASON_MAX,
} from '@/lib/notify/notices-model';

/**
 * ANNOUNCEMENT DESK (SP-status-03).
 *
 * Write an announcement filed under one of the founders' categories (or none), ask for the approval its publish spends,
 * approve another founder's request, publish. A published announcement is on the public notice board once, with its kind
 * and category, or, written for P2P merchants, read signed in by active P2P merchants alone and on no public read. The category list is an owner value: blank means the kinds alone, and svc-notify then refuses any
 * category. Incidents and maintenance have their own desks.
 */

function Outcome({ reply }: { reply: IncidentDeskReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="notices-desk-outcome">
        <strong>Done: {reply.what}</strong>
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="notices-desk-outcome"
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

function CategoriesForm({ categories, busy, onSubmit }: { categories: NoticeCategories; busy: boolean; onSubmit: Submit }) {
  const [text, setText] = useState(categoriesText(categories.list));
  const [reason, setReason] = useState('');
  const parsed = parseCategories(text);
  return (
    <section className="dk-stack" aria-labelledby="notice-categories" data-testid="notice-categories">
      <h2 id="notice-categories">Categories</h2>
      {categories.list === null ? (
        <p className="dk-muted" data-testid="notice-categories-unset">
          Not set. Announcements carry their kind alone, and svc-notify refuses any category until you set a list.
        </p>
      ) : (
        <ul data-testid="notice-categories-list">
          {categories.list.map((c) => (
            <li key={c.id}>
              {c.name} <span className="dk-muted">({c.id})</span>
            </li>
          ))}
        </ul>
      )}
      <div className="adm-field">
        <label htmlFor="notice-categories-text">One per line, as id: Name (blank clears the list)</label>
        <textarea
          id="notice-categories-text"
          className="adm-input"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
      </div>
      {!parsed.ok && <p className="dk-why">{parsed.why}</p>}
      <div className="adm-field">
        <label htmlFor="notice-categories-reason">Reason for the change</label>
        <input
          id="notice-categories-reason"
          className="adm-input"
          value={reason}
          maxLength={CATEGORIES_REASON_MAX}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          onClick={() => onSubmit({ op: 'categories', categories: text, expectedRevision: categories.revision, reason })}
          disabled={busy || !parsed.ok || reason.trim() === ''}
        >
          Save categories
        </button>
      </div>
    </section>
  );
}

const AUDIENCE_LABEL: Record<Audience, string> = {
  everyone: 'Everyone (the public notice board)',
  'p2p-merchants': 'P2P merchants only (signed in)',
};

function DraftForm({
  categories,
  audiences,
  basis,
  busy,
  onSubmit,
}: {
  categories: NoticeCategories | null;
  /** Null when svc-notify's list could not be read: everyone is still offered, no member audience is. */
  audiences: readonly AudienceOption[] | null;
  basis: string | null;
  busy: boolean;
  onSubmit: Submit;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('');
  const [audience, setAudience] = useState<Audience>('everyone');
  const check = checkAnnouncementDraft({ title, body, category: category === '' ? null : category, audience });
  const merchants = audiences?.find((a) => a.id === 'p2p-merchants') ?? null;
  // A choice the desk no longer offers (the list was read again and P2P merchants went unavailable) is never sent.
  const audienceOk = audience === 'everyone' || merchants?.available === true;
  const listed = categories?.list ?? [];
  return (
    <section className="dk-stack" aria-labelledby="notice-draft" data-testid="notice-draft">
      <h2 id="notice-draft">Write an announcement</h2>
      <div className="adm-field">
        <label htmlFor="notice-title">Title</label>
        <input
          id="notice-title"
          className="adm-input"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="notice-body">Message</label>
        <textarea
          id="notice-body"
          className="adm-input"
          rows={4}
          value={body}
          maxLength={8000}
          onChange={(e) => setBody(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="notice-category">Category</label>
        <select id="notice-category" className="adm-input" value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy}>
          <option value="">None (the kind alone)</option>
          {listed.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {categories !== null && categories.list === null && (
          <p className="dk-muted">No categories are set, so an announcement carries its kind alone.</p>
        )}
      </div>
      <div className="adm-field">
        <label htmlFor="notice-audience">Who it is for</label>
        <select
          id="notice-audience"
          className="adm-input"
          value={audience}
          onChange={(e) => setAudience(e.target.value as Audience)}
          disabled={busy}
          data-testid="notice-audience"
        >
          <option value="everyone">{AUDIENCE_LABEL.everyone}</option>
          <option value="p2p-merchants" disabled={!merchants?.available}>
            {AUDIENCE_LABEL['p2p-merchants']}
          </option>
        </select>
        {merchants === null ? (
          <p className="dk-muted" data-testid="notice-audience-why">
            The audience list could not be read, so only everyone can be chosen.
          </p>
        ) : !merchants.available ? (
          <p className="dk-muted" data-testid="notice-audience-why">
            P2P merchants cannot be chosen: svc-notify has no P2P_URL, so it cannot tell who is a merchant.
          </p>
        ) : (
          audience === 'p2p-merchants' && (
            <p className="dk-muted">Active P2P merchants read it signed in. It is on no public read and mailed to no status subscriber.</p>
          )
        )}
      </div>
      {!check.ok && (title !== '' || body !== '') && <p className="dk-why">{check.why}</p>}
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          onClick={() => onSubmit({ op: 'draft', basis, title, body, category: category === '' ? null : category, audience })}
          disabled={busy || !check.ok || !audienceOk}
        >
          Save draft
        </button>
        <span className="dk-muted">Nothing is public until a second founder approves and it is published.</span>
      </div>
    </section>
  );
}

function AnnouncementCard({
  notice,
  approval,
  me,
  busy,
  onSubmit,
}: {
  notice: Announcement;
  approval: PublishApproval | null;
  me: string;
  busy: boolean;
  onSubmit: Submit;
}) {
  return (
    <article className="dk-stack" data-testid="notice-card" data-notice-id={notice.id} data-status={notice.status}>
      <h3>
        {notice.title}{' '}
        <Chip tone={notice.status === 'published' ? 'live' : 'neutral'}>{notice.status === 'published' ? 'Published' : 'Draft'}</Chip>
      </h3>
      <p>{notice.body}</p>
      <p className="dk-muted" data-testid="notice-filing">
        Kind: {notice.kind}. Category: {notice.category ? notice.category.name : 'none'}. For:{' '}
        {notice.audience === 'everyone' ? 'everyone' : 'P2P merchants only'}.
        {notice.publishedAt ? ` Published ${formatWhen(notice.publishedAt)}.` : ''}
        {notice.authorId === me ? ' Written by you.' : ''}
      </p>
      {notice.status === 'draft' && (
        <ApprovalActions target={noticeTarget(notice.id, 'notice-approval')} approval={approval} me={me} busy={busy} onSubmit={onSubmit} />
      )}
    </article>
  );
}

export function NotifyNoticesDesk({ initial }: { initial: NoticesDeskView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<IncidentDeskReply | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Approvals this founder approved on this visit: identity lists a decided approval to its requester only.
  const [decided, setDecided] = useState<readonly PublishApproval[]>([]);
  // Each form clears only after its own change lands. The category form also reloads after a stale-revision refusal, so
  // the next try names the revision it now shows; the draft form keeps what was typed through a categories change.
  const [categoriesKey, setCategoriesKey] = useState(0);
  const [draftKey, setDraftKey] = useState(0);

  const reread = useCallback(async (): Promise<boolean> => {
    const next = await fetchNoticesDesk();
    setLoadFailed(next === null);
    if (next) setView(next);
    return next !== null;
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setReply(null);
    if (await reread()) {
      setCategoriesKey((k) => k + 1);
      setDraftKey((k) => k + 1);
    }
    setBusy(false);
  }, [reread]);

  const submit = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      const result = await postNotifyChange('/api/notify-notices', body);
      setReply(result);
      if (result.ok && result.approval) {
        const approval = result.approval;
        setDecided((list) => [...list.filter((a) => a.approvalId !== approval.approvalId), approval]);
      }
      const fresh = await reread();
      if (fresh && body.op === 'categories' && (result.ok || result.code === 'status.page_revision_stale')) setCategoriesKey((k) => k + 1);
      if (fresh && body.op === 'draft' && result.ok) setDraftKey((k) => k + 1);
      setBusy(false);
    },
    [reread],
  );

  const onSubmit: Submit = (b) => void submit(b);
  const listed = view.approvals.kind === 'ok' ? view.approvals.data : [];
  const approvals = [
    ...listed,
    ...decided.filter(
      (a) => !listed.some((l) => l.approvalId === a.approvalId || (l.targetId === a.targetId && l.createdAt > a.createdAt)),
    ),
  ];
  const announcements = view.announcements.kind === 'ok' ? view.announcements.data : [];
  const categories = view.categories.kind === 'ok' ? view.categories.data : null;
  const audiences = view.audiences.kind === 'ok' ? view.audiences.data : null;
  return (
    <div className="dk-stack" data-testid="notices-desk">
      <header className="adm-pagehead">
        <h1>Announcements</h1>
        <p className="dk-muted">
          Announcements on the public notice board. Incidents and maintenance have their own desks:{' '}
          <Link href="/notify/incidents">Incident desk</Link> · <Link href="/notify/maintenance">Maintenance</Link> ·{' '}
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
      {view.approvals.kind === 'failed' && <Failed title="Approvals could not be read" message={view.approvals.message} />}
      <div className="dk-stack">
        {view.categories.kind === 'failed' ? (
          <Failed title="The category list could not be read" message={view.categories.message} />
        ) : (
          <CategoriesForm key={categoriesKey} categories={view.categories.data} busy={busy} onSubmit={onSubmit} />
        )}
        <DraftForm
          key={draftKey}
          categories={categories}
          audiences={audiences}
          basis={announcements[0]?.id ?? null}
          busy={busy}
          onSubmit={onSubmit}
        />
        <section className="dk-stack" aria-labelledby="notices-list">
          <h2 id="notices-list">Announcements</h2>
          {view.announcements.kind === 'failed' ? (
            <Failed title="Announcements could not be read" message={view.announcements.message} />
          ) : announcements.length === 0 ? (
            <p className="dk-muted" data-testid="notices-none">
              No announcements, drafted or published.
            </p>
          ) : (
            announcements.map((n) => (
              <AnnouncementCard
                key={n.id}
                notice={n}
                approval={approvalFor(n.id, approvals)}
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
