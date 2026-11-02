'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SupportTicket } from '@intafaced/contracts';
import {
  CHECK_RECORD_KINDS,
  CHECK_RECORD_OWNER,
  RECORD_KIND_WORDS,
  isRecordId,
  type Disclosure,
  type SupportVerificationView,
  type VerificationReply,
} from '@/lib/support/verification';
import { fetchVerification, postVerification } from '@/lib/support/verification-browser';
import { formatWhen } from '@/lib/as-of';
import { shortId } from '@/lib/desk/desk-model';
import { Failed } from './support-action-parts';

/**
 * BALANCE AND WITHDRAWAL DESTINATION — behind two checks the customer can confirm (J-support-public-20 #2).
 *
 * The person who wrote in may not be the account holder, so the desk reads neither until two checks are recorded on this
 * request. A check is a record the customer quotes (an order, withdrawal or deposit id) that the service owning it says is
 * theirs: never a box the agent ticks. Every answer is svc-support's, shown as it came: a refused check or read says why
 * and that nothing was recorded or read.
 */

type RecordKind = (typeof CHECK_RECORD_KINDS)[number];

export interface VerificationGateViewProps {
  readonly view: SupportVerificationView | null;
  readonly loading: boolean;
  readonly recordKind: RecordKind;
  readonly recordId: string;
  readonly busy: boolean;
  readonly outcome: VerificationReply | null;
  readonly onField: (patch: { recordKind?: RecordKind; recordId?: string }) => void;
  readonly onRecord: () => void;
  readonly onRead: (what: Disclosure) => void;
}

export function VerificationGateView(p: VerificationGateViewProps) {
  const part = p.view?.checks;
  const current = part?.kind === 'ok' ? part.data : null;
  const idOk = isRecordId(p.recordId);
  return (
    <section className="dk-stack" aria-label="Balance and withdrawal destination" data-testid="ticket-verification">
      <h4>Balance and withdrawal destination</h4>
      <p className="dk-muted">
        Read only after two checks the customer can confirm are recorded on this request. A check is one of the customer’s own records, by
        its id, that the service holding it says is theirs.
      </p>
      {!p.view ? (
        <p className="dk-muted">{p.loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : part?.kind === 'failed' ? (
        <Failed name="Checks" part={part} />
      ) : current ? (
        <>
          <p data-testid="verification-count">
            {current.checks.length} of {current.required} checks recorded
          </p>
          {current.checks.length > 0 && (
            <table className="adm-table" aria-label="Checks recorded">
              <thead>
                <tr>
                  <th scope="col">Record</th>
                  <th scope="col">Id</th>
                  <th scope="col">Recorded by</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {current.checks.map((c) => (
                  <tr key={`${c.recordKind}:${c.recordId}`}>
                    <td>{RECORD_KIND_WORDS[c.recordKind]}</td>
                    <td className="dk-packet">{shortId(c.recordId)}</td>
                    <td className="dk-packet">{shortId(c.recordedBy)}</td>
                    <td>{formatWhen(c.recordedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}

      <div className="adm-field">
        <label htmlFor="sd-check-kind">Record the customer quoted</label>
        <select
          id="sd-check-kind"
          className="adm-input"
          value={p.recordKind}
          disabled={p.busy}
          onChange={(e) => p.onField({ recordKind: e.target.value as RecordKind })}
        >
          {CHECK_RECORD_KINDS.map((k) => (
            <option key={k} value={k}>
              {RECORD_KIND_WORDS[k]} (confirmed by {CHECK_RECORD_OWNER[k]})
            </option>
          ))}
        </select>
      </div>
      <div className="adm-field">
        <label htmlFor="sd-check-id">Its id (full)</label>
        <input
          id="sd-check-id"
          className="adm-input"
          value={p.recordId}
          autoComplete="off"
          spellCheck={false}
          disabled={p.busy}
          onChange={(e) => p.onField({ recordId: e.target.value })}
        />
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" disabled={!idOk || p.busy} onClick={p.onRecord}>
          Record as a check
        </button>
        {!idOk && p.recordId !== '' && <span className="dk-why">An id is the record’s full id, as the customer sees it.</span>}
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" disabled={p.busy} onClick={() => p.onRead('balance')}>
          Read the balance
        </button>
        <button type="button" className="adm-btn" disabled={p.busy} onClick={() => p.onRead('withdrawal_destination')}>
          Read the withdrawal destination
        </button>
      </div>
      <Outcome reply={p.outcome} />
    </section>
  );
}

function Outcome({ reply }: { reply: VerificationReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="verification-outcome">
        <strong>Done</strong>
        <p>{reply.summary}</p>
      </div>
    );
  const r = reply.refusal;
  return (
    <div
      className="adm-callout"
      role="alert"
      data-testid="verification-outcome"
      data-code={r.code ?? undefined}
      data-tone={r.changed === 'unknown' ? 'warn' : 'danger'}
    >
      <strong>{r.title}</strong>
      <p>{r.body}</p>
      <p>{r.next}</p>
    </div>
  );
}

export function TicketVerification({ ticket }: { ticket: Pick<SupportTicket, 'id'> }) {
  const [view, setView] = useState<SupportVerificationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [recordKind, setRecordKind] = useState<RecordKind>('withdrawal');
  const [recordId, setRecordId] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<VerificationReply | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetchVerification(ticket.id, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setView(next);
      setLoading(false);
    });
    return () => controller.abort();
  }, [ticket.id, version]);

  const send = useCallback(async (request: Parameters<typeof postVerification>[0]) => {
    setBusy(true);
    setOutcome(null);
    const reply = await postVerification(request);
    setOutcome(reply);
    setBusy(false);
    setVersion((v) => v + 1);
    if (reply.ok) setRecordId('');
  }, []);

  return (
    <VerificationGateView
      view={view}
      loading={loading}
      recordKind={recordKind}
      recordId={recordId}
      busy={busy}
      outcome={outcome}
      onField={(patch) => {
        if (patch.recordKind) setRecordKind(patch.recordKind);
        if (patch.recordId !== undefined) setRecordId(patch.recordId);
      }}
      onRecord={() => void send({ action: 'check', ticketId: ticket.id, recordKind, recordId })}
      onRead={(what) => void send({ action: 'disclosure', ticketId: ticket.id, what })}
    />
  );
}
