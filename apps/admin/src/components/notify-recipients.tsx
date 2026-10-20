'use client';

import { useCallback, useRef, useState } from 'react';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatWhen } from '@/lib/as-of';
import { shortId } from '@/lib/desk/desk-model';
import { codeWords } from '@/lib/desk/words';
import { fetchRecipients, postRelease } from '@/lib/notify/recipients-browser';
import {
  RECIPIENT_STATES,
  RELEASE_REASON_MAX,
  RELEASE_REASON_MIN,
  checkReleaseReason,
  type RecipientRow,
  type RecipientState,
  type RecipientsRead,
  type RecipientsView,
  type ReleaseReply,
} from '@/lib/notify/recipients-model';

/**
 * NOTIFY RECIPIENT HEALTH.
 *
 * Addresses by state: quarantined (svc-notify stopped sending after repeated terminal failures), unconfirmed (never passed
 * verification) and active. A quarantined address can be released with a written reason; the service audits it and replays the
 * same release as a no-op. A channel with no sender is named by the vendor it needs, never shown as healthy. A blank owner
 * threshold means svc-notify never quarantines, and the panel says so.
 */

const TAB_LABEL: Record<RecipientState, string> = { quarantined: 'Quarantined', unconfirmed: 'Unconfirmed', active: 'Active' };
const TAB_EMPTY: Record<RecipientState, string> = {
  quarantined: 'No quarantined addresses. svc-notify is sending to every confirmed address it has.',
  unconfirmed: 'No unconfirmed addresses. Everyone who registered an address has confirmed it.',
  active: 'No active addresses recorded yet.',
};

export interface NotConnected {
  readonly [channel: string]: string | undefined;
}

function Failed({ part }: { part: Extract<RecipientsView, { kind: 'failed' }> }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status" data-testid="recipients-failed">
      <strong>Recipient health unavailable</strong>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
    </div>
  );
}

function ReleaseForm({ row, onDone }: { row: RecipientRow; onDone: (reply: ReleaseReply) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reply, setReply] = useState<ReleaseReply | null>(null);
  const submit = async () => {
    const check = checkReleaseReason(reason);
    if (!check.ok) {
      setProblem(check.message);
      return;
    }
    setProblem(null);
    setBusy(true);
    const result = await postRelease(row, check.reason);
    setBusy(false);
    setReply(result);
    // A definite success, or an outcome nobody can be sure of, both change what the list should say: read it again.
    if (result.ok || result.changed === 'unknown') onDone(result);
  };
  const id = `release-${row.userId}-${row.channel}`;
  return (
    <div className="dk-stack" data-testid="release-form">
      <label htmlFor={id}>
        Why is this address safe to send to again? ({RELEASE_REASON_MIN}–{RELEASE_REASON_MAX} characters, kept in the audit record)
      </label>
      <textarea
        id={id}
        value={reason}
        maxLength={RELEASE_REASON_MAX}
        rows={2}
        onChange={(e) => setReason(e.target.value)}
        disabled={busy}
      />
      {problem && (
        <p className="dk-why" role="alert">
          {problem}
        </p>
      )}
      {reply && !reply.ok && (
        <div className="adm-callout" data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'} role="alert" data-testid="release-refused">
          <strong>{reply.title}</strong>
          <p>{reply.body}</p>
          <p className="dk-muted">{reply.next}</p>
        </div>
      )}
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Releasing…' : 'Release this address'}
        </button>
      </div>
    </div>
  );
}

export function RecipientTable({
  read,
  notConnected,
  onChanged,
}: {
  read: RecipientsRead;
  notConnected: NotConnected;
  onChanged: (reply: ReleaseReply) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const { items, state } = read;
  return (
    <div className="dk-stack" data-testid="recipient-list">
      {state === 'quarantined' && (
        <p className="dk-muted" data-testid="recipient-threshold">
          {read.threshold === null
            ? 'The owner has not set how many failures in a row quarantine an address (notify.quarantine_threshold_unset), so svc-notify never quarantines one. This list stays empty until it is set.'
            : `svc-notify quarantines an address after ${read.threshold} terminal failures in a row. Critical notices are still attempted.`}
        </p>
      )}
      {items.length === 0 ? (
        <p className="dk-muted" data-testid="recipients-empty">
          {TAB_EMPTY[state]}
        </p>
      ) : (
        <div className="dk-table-wrap" role="region" aria-label={`${TAB_LABEL[state]} addresses`} tabIndex={0}>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Channel</th>
                <th>Address</th>
                <th>Failures in a row</th>
                <th>Last failure</th>
                {state === 'quarantined' && <th>Quarantined</th>}
                {state === 'quarantined' && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const key = `${r.userId}:${r.channel}`;
                const vendor = notConnected[r.channel];
                return (
                  <tr key={key} data-testid={`recipient-${r.channel}`}>
                    <td className="dk-packet">{shortId(r.userId)}</td>
                    <td>
                      {r.channel}
                      {vendor && <Chip tone="warn">{vendor}</Chip>}
                    </td>
                    <td className="dk-packet">{r.address}</td>
                    <td>{r.consecutiveFailures}</td>
                    <td>
                      {r.lastFailureAt
                        ? `${formatWhen(r.lastFailureAt)}${r.lastFailureCode ? ` · ${codeWords(r.lastFailureCode)}` : ''}`
                        : '—'}
                    </td>
                    {state === 'quarantined' && (
                      <td>
                        {r.quarantinedAt ? formatWhen(r.quarantinedAt) : '—'}
                        {r.quarantineReason && <div className="dk-muted">{codeWords(r.quarantineReason)}</div>}
                      </td>
                    )}
                    {state === 'quarantined' && (
                      <td>
                        {open === key ? (
                          <ReleaseForm
                            row={r}
                            onDone={(reply) => {
                              setOpen(null);
                              onChanged(reply);
                            }}
                          />
                        ) : (
                          <button type="button" className="adm-btn" onClick={() => setOpen(key)}>
                            Release…
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {items.length >= read.limit && <p className="dk-muted">The page is full ({read.limit}), so more addresses exist than are listed.</p>}
      {Object.entries(notConnected).some(([, v]) => v) && (
        <p className="dk-muted">
          A channel tagged with a vendor code has no sender connected on this deployment: addresses on it are recorded but nothing is sent.
        </p>
      )}
    </div>
  );
}

/** What happened to the last release, kept on screen after the list reloads (the row that was released leaves the list). */
export function ReleaseNotice({ reply }: { reply: ReleaseReply }) {
  if (reply.ok)
    return (
      <p className="dk-why" role="status" data-testid="release-done">
        {reply.replayed
          ? 'This address had already been released with this reason. Nothing more was changed.'
          : 'Released. The next notification will try this address again. It now belongs on the Active tab.'}
      </p>
    );
  return (
    <div className="adm-callout" data-tone="warn" role="alert" data-testid="release-unknown">
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
    </div>
  );
}

export function RecipientsPanel({ initial, notConnected }: { initial: RecipientsView | null; notConnected: NotConnected }) {
  const [tab, setTab] = useState<RecipientState>('quarantined');
  const [views, setViews] = useState<Partial<Record<RecipientState, RecipientsView | null>>>({ quarantined: initial });
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<ReleaseReply | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async (state: RecipientState) => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await fetchRecipients(state);
    if (mine === sequence.current) {
      setViews((v) => ({ ...v, [state]: next }));
      setLoading(false);
    }
  }, []);
  const changed = (reply: ReleaseReply) => {
    setNotice(reply);
    // A release moves an address to another tab: drop every cached tab but this one so none shows a stale list.
    setViews((v) => ({ [tab]: v[tab] }));
    void load(tab);
  };
  const choose = (state: RecipientState) => {
    setTab(state);
    if (views[state] === undefined) void load(state);
    setNotice(null);
  };
  const view = views[tab];
  return (
    <div className="dk" data-testid="notify-recipients">
      <h2>Recipient health</h2>
      <p className="dk-muted">
        Addresses svc-notify sends to, by state. Quarantine counts only terminal failures. Releasing lets the next notification try the
        address again; it does not resend anything.
      </p>
      <div className="dk-row" role="tablist" aria-label="Recipient state">
        {RECIPIENT_STATES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={tab === s}
            className="adm-btn"
            data-active={tab === s}
            onClick={() => choose(s)}
          >
            {TAB_LABEL[s]}
          </button>
        ))}
        <button type="button" className="adm-btn" onClick={() => void load(tab)} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {notice && <ReleaseNotice reply={notice} />}
      {view === undefined && <p className="dk-muted">Reading…</p>}
      {view === null && (
        <p className="dk-why" data-testid="recipients-unreadable">
          svc-notify could not be read. Nothing is shown rather than a guess.
        </p>
      )}
      {view && view.kind === 'failed' && <Failed part={view} />}
      {view && view.kind === 'ok' && <RecipientTable read={view.data} notConnected={notConnected} onChanged={changed} />}
    </div>
  );
}
