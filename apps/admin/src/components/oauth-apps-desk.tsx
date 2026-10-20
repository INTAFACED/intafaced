'use client';

import { useCallback, useRef, useState } from 'react';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchOAuthQueue, postReview, type OAuthQueueDeskView, type ReviewReply } from '@/lib/oauth-ops/browser';
import {
  OAUTH_REVIEW_STATUSES,
  REASON_MAX,
  REASON_MIN,
  reviewGate,
  type OAuthDecision,
  type OAuthQueueApp,
  type OAuthReviewStatus,
} from '@/lib/oauth-ops/model';
import './desk.css';

/**
 * OAUTH APP APPROVAL.
 *
 * Third-party apps registered through `/developers/apps`. An app that is not approved reaches only its developer's own
 * account; approving it opens it to every customer who chooses to allow it. Suspending ends every live token of the app.
 * Everything shown is svc-identity's own answer with the time it was read; the logo is printed as an address and never
 * loaded here, so an outside developer cannot make this console fetch from a server they run.
 */

const STATUS_LABEL: Readonly<Record<OAuthReviewStatus, string>> = {
  pending: 'Waiting for a decision',
  approved: 'Approved',
  suspended: 'Suspended',
};

const STATUS_EMPTY: Readonly<Record<OAuthReviewStatus, string>> = {
  pending: 'No app is waiting for a decision.',
  approved: 'No app is approved.',
  suspended: 'No app is suspended.',
};

function chipTone(status: OAuthReviewStatus): string {
  return status === 'approved' ? 'live' : status === 'suspended' ? 'danger' : 'warn';
}

export function ReviewForm({
  app,
  decision,
  onDone,
}: {
  app: OAuthQueueApp;
  decision: OAuthDecision;
  onDone: (status: OAuthReviewStatus) => void;
}) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ReviewReply | null>(null);
  const sent = useRef(false);
  const gate = reviewGate({ decision, appName: app.name, reason, typed, busy });
  const approve = decision === 'approve';

  async function submit() {
    if (!gate.ok || sent.current) return;
    sent.current = true;
    setBusy(true);
    const next = await postReview({ appId: app.id, decision, reason: reason.trim() });
    setReply(next);
    setBusy(false);
    // A definite refusal can be fixed and sent again; a success or an unknown outcome is read from the queue first.
    if (!next.ok && next.refusal.changed === 'no') sent.current = false;
    if (next.ok) onDone(next.status);
  }

  return (
    <form
      className="dk-stack"
      data-testid={`oauth-review-${decision}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="adm-field">
        <label htmlFor={`oa-reason-${app.id}-${decision}`}>
          Reason ({REASON_MIN} to {REASON_MAX} characters)
        </label>
        <textarea
          id={`oa-reason-${app.id}-${decision}`}
          className="adm-input"
          rows={3}
          maxLength={REASON_MAX}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {approve && (
        <div className="adm-field">
          <label htmlFor={`oa-type-${app.id}`}>Type the app name to confirm: {app.name}</label>
          <input
            id={`oa-type-${app.id}`}
            className="adm-input"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
          />
        </div>
      )}
      <p className="dk-why">
        {approve
          ? 'Approving lets every customer allow this app to act for them with the scopes it declared. Your name is recorded as the reviewer.'
          : 'Suspending ends every live token this app holds and refuses new ones. Your name is recorded as the reviewer.'}
      </p>
      <div className="dk-row">
        <button type="submit" className="adm-btn" data-tone={approve ? undefined : 'danger'} disabled={!gate.ok}>
          {busy ? 'Sending…' : approve ? 'Approve this app' : 'Suspend this app'}
        </button>
        {!gate.ok && !busy && <span className="dk-muted">{gate.why}</span>}
      </div>
      {reply && !reply.ok && (
        <div
          className="adm-callout"
          role="alert"
          data-tone={reply.refusal.changed === 'unknown' ? 'warn' : 'danger'}
          data-testid="oauth-review-refusal"
        >
          <strong>{reply.refusal.title}</strong>
          <p>{reply.refusal.body}</p>
          <p>{reply.refusal.next}</p>
        </div>
      )}
      {reply && reply.ok && (
        <div className="adm-callout" role="status" data-tone="ok" data-testid="oauth-review-done">
          <strong>Done</strong>
          <p>svc-identity now shows this app as {STATUS_LABEL[reply.status].toLowerCase()}.</p>
        </div>
      )}
    </form>
  );
}

export function AppCard({ app, onChanged }: { app: OAuthQueueApp; onChanged: (app: OAuthQueueApp, status: OAuthReviewStatus) => void }) {
  const [open, setOpen] = useState<OAuthDecision | null>(null);
  return (
    <article className="dk-stack" data-testid="oauth-app" aria-label={app.name}>
      <div className="dk-row">
        <h2>{app.name}</h2>
        <span className="adm-chip" data-tone={chipTone(app.status)}>
          {STATUS_LABEL[app.status]}
        </span>
      </div>
      {app.description && <p>{app.description}</p>}
      <dl className="dk-kv">
        <dt>Client id</dt>
        <dd className="dk-packet">{app.clientId}</dd>
        <dt>Developer account</dt>
        <dd className="dk-packet">{app.developerUserId}</dd>
        <dt>Kind</dt>
        <dd>{app.confidential ? 'Confidential: holds a client secret' : 'Public: no client secret'}</dd>
        <dt>Declared scopes</dt>
        <dd className="dk-packet">{app.scopes.join(', ')}</dd>
        <dt>Redirect addresses</dt>
        <dd className="dk-packet">
          {app.redirectUrls.map((url) => (
            <span key={url} style={{ display: 'block' }}>
              {url}
            </span>
          ))}
        </dd>
        <dt>Logo address</dt>
        <dd className="dk-packet">{app.logoUrl ?? 'none'}</dd>
        <dt>Registered</dt>
        <dd>{formatWhen(app.createdAt)}</dd>
        <dt>Secret last rolled</dt>
        <dd>{app.secretRolledAt ? formatWhen(app.secretRolledAt) : 'never'}</dd>
      </dl>
      <div className="dk-row" role="group" aria-label={`Decide on ${app.name}`}>
        {app.status !== 'approved' && (
          <button
            type="button"
            className="adm-btn"
            aria-pressed={open === 'approve'}
            onClick={() => setOpen(open === 'approve' ? null : 'approve')}
          >
            Approve…
          </button>
        )}
        {app.status !== 'suspended' && (
          <button
            type="button"
            className="adm-btn"
            aria-pressed={open === 'suspend'}
            onClick={() => setOpen(open === 'suspend' ? null : 'suspend')}
          >
            Suspend…
          </button>
        )}
      </div>
      {open && <ReviewForm key={open} app={app} decision={open} onDone={(status) => onChanged(app, status)} />}
    </article>
  );
}

export interface OAuthAppsDeskViewProps {
  readonly view: OAuthQueueDeskView | null;
  readonly status: OAuthReviewStatus;
  readonly loading: boolean;
  readonly notice: string | null;
  readonly onRefresh: () => void;
  readonly onChanged: (app: OAuthQueueApp, status: OAuthReviewStatus) => void;
  readonly onStatus: (status: OAuthReviewStatus) => void;
}

export function OAuthAppsDeskView({ view, status, loading, notice, onRefresh, onChanged, onStatus }: OAuthAppsDeskViewProps) {
  const apps = view && view.apps.kind === 'ok' ? view.apps.data : null;
  return (
    <div className="dk" data-testid="oauth-apps-desk">
      <div className="adm-pagehead">
        <div>
          <h1>OAuth apps</h1>
          <p>
            Apps outside developers registered to act for customers. An app that is not approved reaches only its own developer. The person
            who registered an app cannot approve it.
          </p>
        </div>
      </div>
      <div className="dk-row" role="group" aria-label="Show apps that are">
        {OAUTH_REVIEW_STATUSES.map((s) => (
          <button key={s} type="button" className="adm-btn" aria-pressed={status === s} disabled={loading} onClick={() => onStatus(s)}>
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="dk-asof">{view ? `As of ${formatAsOf(view.asOf)} (when this console read svc-identity)` : 'No read yet'}</span>
      </div>
      {notice && (
        <div className="adm-callout" role="status" data-tone="ok" data-testid="oauth-notice">
          <strong>Done</strong>
          <p>{notice}</p>
        </div>
      )}
      {!view && <p className="dk-why">svc-identity could not be read. Nothing is shown rather than a guess.</p>}
      {view && view.apps.kind === 'failed' && (
        <div className="adm-callout" data-tone={view.apps.forbidden ? 'warn' : 'danger'} role="status" data-testid="oauth-failed">
          <strong>OAuth apps unavailable</strong>
          <p>{view.apps.message}</p>
          {view.apps.code && <p className="dk-muted">Code: {view.apps.code}</p>}
        </div>
      )}
      {apps && apps.length === 0 && (
        <p className="dk-why" data-testid="oauth-empty">
          {STATUS_EMPTY[status]}
        </p>
      )}
      {apps && view && apps.length >= view.limit && (
        <p className="dk-why" data-testid="oauth-full-page">
          This page holds the oldest {view.limit} apps. Decide on some and refresh to see the rest.
        </p>
      )}
      {apps?.map((app) => (
        <AppCard key={`${app.id}:${app.status}`} app={app} onChanged={onChanged} />
      ))}
    </div>
  );
}

export function OAuthAppsDesk({ initial }: { initial: OAuthQueueDeskView | null }) {
  const [view, setView] = useState<OAuthQueueDeskView | null>(initial);
  const [status, setStatus] = useState<OAuthReviewStatus>(initial?.status ?? 'pending');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0);
  const read = useCallback(async (which: OAuthReviewStatus) => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await fetchOAuthQueue(which);
    if (mine === sequence.current) {
      setView(next);
      setLoading(false);
    }
  }, []);
  return (
    <OAuthAppsDeskView
      view={view}
      status={status}
      loading={loading}
      notice={notice}
      onRefresh={() => void read(status)}
      onChanged={(app, now) => {
        setNotice(`svc-identity now shows ${app.name} as ${STATUS_LABEL[now].toLowerCase()}.`);
        void read(status);
      }}
      onStatus={(next) => {
        setNotice(null);
        setStatus(next);
        void read(next);
      }}
    />
  );
}
