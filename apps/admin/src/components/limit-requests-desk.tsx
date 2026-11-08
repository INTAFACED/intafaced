'use client';

import { useCallback, useRef, useState } from 'react';
import type { LimitRequestQueueRow, LimitReviewInput } from '@intafaced/contracts/api-rate-limits';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import type { LimitDeskView } from '@/lib/identity-ops/limits-server';
import './desk.css';

/**
 * API LIMIT REQUESTS (DV-limits-03, J-developer-06 #6).
 *
 * A developer asks for a higher refill on one key, with an optional spike window. A support reviewer grants all of it,
 * part of it, or refuses, with a reason. svc-identity applies a grant to that key at once, records the reviewer from the
 * session, refuses a reviewer's own key, and writes one audit entry per decision. Everything here is its answer.
 */

const STATUS_LABEL: Readonly<Record<LimitRequestQueueRow['status'], string>> = {
  waiting: 'Waiting for review',
  granted: 'Granted',
  granted_in_part: 'Granted in part',
  refused: 'Refused',
};

const UNKNOWN: RefusalView = {
  title: 'The outcome is not known',
  body: 'The console could not tell whether that went through.',
  next: 'Refresh the desk to see where the request stands before deciding again.',
  code: null,
  changed: 'unknown',
};

type Reply = { ok: true } | { ok: false; refusal: RefusalView };

async function postDecision(input: LimitReviewInput): Promise<Reply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return {
      ok: false,
      refusal: {
        title: 'Nothing was sent',
        body: error instanceof Error ? error.message : 'Your founder session could not be confirmed.',
        next: 'Sign in again, then repeat the step.',
        code: null,
        changed: 'no',
      },
    };
  }
  try {
    const res = await fetch('/api/identity-ops/limits', {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; refusal?: RefusalView } | null;
    if (body?.ok === true) return { ok: true };
    if (body?.ok === false && body.refusal && typeof body.refusal.title === 'string') return { ok: false, refusal: body.refusal };
    return { ok: false, refusal: UNKNOWN };
  } catch {
    return { ok: false, refusal: UNKNOWN };
  }
}

async function readDesk(): Promise<LimitDeskView | null> {
  try {
    const res = await fetch('/api/identity-ops/limits', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = (await res.json()) as LimitDeskView;
    return typeof body?.asOf === 'string' && body.desk ? body : null;
  } catch {
    return null;
  }
}

function ReviewDialog({ row, onClose, onDone }: { row: LimitRequestQueueRow; onClose: () => void; onDone: (note: string) => void }) {
  const [grant, setGrant] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalView | null>(null);
  const sent = useRef(false);
  const amount = Number(grant.trim());
  const amountOk = Number.isInteger(amount) && amount > row.currentPerMinute && amount <= row.askedPerMinute;
  const reasonOk = reason.trim().length >= 4 && reason.trim().length <= 500;

  async function decide(input: LimitReviewInput, note: string) {
    if (sent.current) return;
    sent.current = true;
    setBusy(true);
    const reply = await postDecision(input);
    setBusy(false);
    if (reply.ok) return onDone(note);
    setRefusal(reply.refusal);
    if (reply.refusal.changed === 'no') sent.current = false;
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Review limit request" className="adm-callout dk-stack" data-testid="limit-review">
      <strong>
        {row.keyName} ({row.keyPrefix}): asked {row.askedPerMinute} calls a minute, has {row.currentPerMinute}
      </strong>
      <p className="dk-muted">
        {row.spikeStartsOn && row.spikeEndsOn ? `Spike ${row.spikeStartsOn} to ${row.spikeEndsOn}.` : 'No spike given.'}{' '}
        {row.note ? `Why: ${row.note}` : ''}
      </p>
      <div className="adm-field">
        <label htmlFor={`lr-grant-${row.id}`}>Grant (calls a minute)</label>
        <input
          id={`lr-grant-${row.id}`}
          className="adm-input"
          inputMode="numeric"
          value={grant}
          onChange={(event) => setGrant(event.target.value)}
        />
      </div>
      <div className="adm-field">
        <label htmlFor={`lr-reason-${row.id}`}>Reason</label>
        <textarea
          id={`lr-reason-${row.id}`}
          className="adm-input"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <p className="dk-why">A grant applies to this key at once. Your name is recorded as the reviewer, with one audit entry.</p>
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          disabled={busy || !amountOk || !reasonOk}
          onClick={() =>
            void decide(
              { decision: 'grant', id: row.id, grantedPerMinute: amount, reason: reason.trim() },
              `${row.keyName}: granted ${amount} calls a minute.`,
            )
          }
        >
          {busy ? 'Sending…' : amount === row.askedPerMinute ? 'Grant in full' : 'Grant in part'}
        </button>
        <button
          type="button"
          className="adm-btn"
          data-tone="danger"
          disabled={busy || !reasonOk}
          onClick={() => void decide({ decision: 'refuse', id: row.id, reason: reason.trim() }, `${row.keyName}: refused.`)}
        >
          Refuse
        </button>
        <button type="button" className="adm-btn" onClick={onClose} disabled={busy}>
          Close
        </button>
        {!amountOk && grant !== '' && (
          <span className="dk-muted">
            A grant is more than {row.currentPerMinute} and no more than {row.askedPerMinute}.
          </span>
        )}
      </div>
      {refusal && (
        <div className="adm-callout" role="alert" data-tone={refusal.changed === 'unknown' ? 'warn' : 'danger'}>
          <strong>{refusal.title}</strong>
          <p>{refusal.body}</p>
          <p>{refusal.next}</p>
          {refusal.code && <p className="dk-muted">Code: {refusal.code}</p>}
        </div>
      )}
    </div>
  );
}

export function LimitRequestsDesk({ initial }: { initial: LimitDeskView | null }) {
  const [view, setView] = useState<LimitDeskView | null>(initial);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await readDesk();
    if (mine === sequence.current) {
      setView(next);
      setLoading(false);
    }
  }, []);
  const desk = view && view.desk.kind === 'ok' ? view.desk.data : null;

  return (
    <div className="dk" data-testid="limit-requests-desk">
      <div className="adm-pagehead">
        <div>
          <h1>API limits</h1>
          <p>
            Developers asking for a higher rate limit on one of their keys. Grant all of it, part of it, or refuse. A reviewer never decides
            a request on their own key.
          </p>
        </div>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="dk-asof">{view ? `As of ${formatAsOf(view.asOf)} (when this console read svc-identity)` : 'No read yet'}</span>
      </div>
      {desk && (
        <p className="dk-muted">
          {desk.grantCeilingPerMinute === null
            ? 'The most one key may be granted is not set, so every grant is refused.'
            : `The most one key may be granted: ${desk.grantCeilingPerMinute} calls a minute.`}
        </p>
      )}
      {notice && (
        <div className="adm-callout" role="status" data-tone="ok">
          <strong>Done</strong>
          <p>{notice}</p>
        </div>
      )}
      {!view && <p className="dk-why">svc-identity could not be read. Nothing is shown rather than a guess.</p>}
      {view && view.desk.kind === 'failed' && (
        <div className="adm-callout" data-tone={view.desk.forbidden ? 'warn' : 'danger'} role="status">
          <strong>Limit requests unavailable</strong>
          <p>{view.desk.message}</p>
          {view.desk.code && <p className="dk-muted">Code: {view.desk.code}</p>}
        </div>
      )}
      {desk && (
        <>
          <section aria-labelledby="lr-queue" className="dk-stack">
            <h2 id="lr-queue">Limit requests</h2>
            {desk.requests.length === 0 && <p className="dk-why">No request yet.</p>}
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Asked (a minute)</th>
                  <th scope="col">Has (a minute)</th>
                  <th scope="col">Spike</th>
                  <th scope="col">Asked on</th>
                  <th scope="col">Status</th>
                  <th scope="col">Granted (a minute)</th>
                  <th scope="col">Decide</th>
                </tr>
              </thead>
              <tbody>
                {desk.requests.map((row) => (
                  <tr key={row.id} data-request={row.id} data-status={row.status}>
                    <th scope="row">
                      {row.keyName} <code>{row.keyPrefix}</code>
                    </th>
                    <td>{row.askedPerMinute}</td>
                    <td>{row.currentPerMinute}</td>
                    <td>{row.spikeStartsOn && row.spikeEndsOn ? `${row.spikeStartsOn} to ${row.spikeEndsOn}` : '—'}</td>
                    <td>{formatWhen(row.createdAt)}</td>
                    <td>{STATUS_LABEL[row.status]}</td>
                    <td>{row.grantedPerMinute ?? '—'}</td>
                    <td>
                      {row.status === 'waiting' ? (
                        <button type="button" className="adm-btn" onClick={() => setOpen(row.id)}>
                          Review
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {desk.requests
            .filter((row) => row.id === open && row.status === 'waiting')
            .map((row) => (
              <ReviewDialog
                key={row.id}
                row={row}
                onClose={() => setOpen(null)}
                onDone={(note) => {
                  setOpen(null);
                  setNotice(note);
                  void refresh();
                }}
              />
            ))}
          <section aria-labelledby="lr-audit" className="dk-stack">
            <h2 id="lr-audit">Audit</h2>
            {desk.audit.length === 0 && <p className="dk-why">No decision yet.</p>}
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Key</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Asked</th>
                  <th scope="col">Had</th>
                  <th scope="col">Granted</th>
                  <th scope="col">Reviewer</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {desk.audit.map((entry) => (
                  <tr key={entry.id} data-audit={entry.id}>
                    <th scope="row">{formatWhen(entry.at)}</th>
                    <td>{entry.keyName}</td>
                    <td>{STATUS_LABEL[entry.decision]}</td>
                    <td>{entry.askedPerMinute}</td>
                    <td>{entry.previousPerMinute}</td>
                    <td>{entry.grantedPerMinute ?? '—'}</td>
                    <td>
                      <code>{entry.actorId}</code>
                    </td>
                    <td>{entry.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
