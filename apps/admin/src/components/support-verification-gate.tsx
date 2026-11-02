'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SupportTicket } from '@intafaced/contracts';
import {
  CHECK_KIND_WORDS,
  CHECK_OWNER,
  DISCLOSURE_OWNER,
  DISCLOSURE_WORDS,
  DISCLOSURES,
  isCheckValue,
  type Disclosure,
  type SupportVerificationView,
  type VerificationReply,
} from '@/lib/support/verification';
import { fetchVerification, postVerification } from '@/lib/support/verification-browser';
import { formatWhen } from '@/lib/as-of';
import { shortId } from '@/lib/desk/desk-model';
import { Failed } from './support-action-parts';

/**
 * VERIFY THE CUSTOMER — the balance disclosure gate on the ticket (RC-support-public-01, J-support-public-20 #2).
 *
 * The person who wrote in may not be the account holder, so the desk reads no balance, fills or withdrawal destination
 * until two checks match on this request: the email on the customer's account, and the id of one of their own orders,
 * withdrawals or deposits. Each is answered by the service that owns the fact, never ticked by the agent; the typed value
 * is never shown back or kept. Every control is here with its named blocker; every answer is svc-support's, as it came.
 */

const RECORD_KINDS = ['withdrawal_id', 'deposit_id', 'client_order_id'] as const;
type RecordKind = (typeof RECORD_KINDS)[number];

export interface VerificationGateViewProps {
  readonly view: SupportVerificationView | null;
  readonly loading: boolean;
  readonly email: string;
  readonly recordKind: RecordKind;
  readonly recordValue: string;
  readonly busy: boolean;
  readonly outcome: VerificationReply | null;
  readonly onField: (patch: { email?: string; recordKind?: RecordKind; recordValue?: string }) => void;
  readonly onRecordEmail: () => void;
  readonly onRecordId: () => void;
  readonly onRead: (what: Disclosure) => void;
}

export function VerificationGateView(p: VerificationGateViewProps) {
  const part = p.view?.checks;
  const current = part?.kind === 'ok' ? part.data : null;
  const emailOk = isCheckValue('email', p.email);
  const idOk = isCheckValue(p.recordKind, p.recordValue);
  // The owner value for attempts is blank, or used up: no check can be taken, and the card says so.
  const checkBlocker = !current
    ? 'The checks could not be read.'
    : current.attemptsAllowed === null
      ? 'The owner has not set how many checks a request may take (SUPPORT_VERIFICATION_ATTEMPTS).'
      : current.attemptsUsed >= current.attemptsAllowed
        ? `This request has used all ${current.attemptsAllowed} check attempts.`
        : null;
  const gateHeld = current !== null && current.matched >= current.required;
  const readBlocker = !current
    ? 'The checks could not be read.'
    : gateHeld
      ? null
      : `Needs the customer’s email and one of their record ids matched (${current.matched} of ${current.required}).`;
  return (
    <section className="dk-stack" aria-label="Verify the customer" data-testid="ticket-verification">
      <h4>Verify the customer</h4>
      <p className="dk-muted">
        The balance, fills and withdrawal destination are read only after two checks match on this request: the email on the customer’s
        account, and the id of one of their own orders, withdrawals or deposits. The service that holds each fact answers it.
      </p>
      {!p.view ? (
        <p className="dk-muted">{p.loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : part?.kind === 'failed' ? (
        <Failed name="Checks" part={part} />
      ) : current ? (
        <>
          <p data-testid="verification-count">
            {current.matched} of {current.required} checks matched
            {current.attemptsAllowed === null ? '' : ` · ${current.attemptsUsed} of ${current.attemptsAllowed} attempts used`}
          </p>
          {current.checks.length > 0 && (
            <table className="adm-table" aria-label="Checks recorded">
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Matched</th>
                  <th scope="col">Recorded by</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {current.checks.map((c, i) => (
                  <tr key={`${c.kind}:${c.checkedAt}:${i}`}>
                    <td>{CHECK_KIND_WORDS[c.kind]}</td>
                    <td>{c.matched ? 'Yes' : 'No'}</td>
                    <td className="dk-packet">{shortId(c.checkedBy)}</td>
                    <td>{formatWhen(c.checkedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}

      <div className="adm-field">
        <label htmlFor="sd-check-email">Email the customer gives (confirmed by {CHECK_OWNER.email})</label>
        <input
          id="sd-check-email"
          className="adm-input"
          type="email"
          value={p.email}
          autoComplete="off"
          spellCheck={false}
          disabled={p.busy}
          onChange={(e) => p.onField({ email: e.target.value })}
        />
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" disabled={!emailOk || p.busy || checkBlocker !== null} onClick={p.onRecordEmail}>
          Check the email
        </button>
      </div>
      <div className="adm-field">
        <label htmlFor="sd-check-kind">One of their own records</label>
        <select
          id="sd-check-kind"
          className="adm-input"
          value={p.recordKind}
          disabled={p.busy}
          onChange={(e) => p.onField({ recordKind: e.target.value as RecordKind })}
        >
          {RECORD_KINDS.map((k) => (
            <option key={k} value={k}>
              {CHECK_KIND_WORDS[k]} (confirmed by {CHECK_OWNER[k]})
            </option>
          ))}
        </select>
      </div>
      <div className="adm-field">
        <label htmlFor="sd-check-id">Its id, as the customer gives it</label>
        <input
          id="sd-check-id"
          className="adm-input"
          value={p.recordValue}
          autoComplete="off"
          spellCheck={false}
          disabled={p.busy}
          onChange={(e) => p.onField({ recordValue: e.target.value })}
        />
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" disabled={!idOk || p.busy || checkBlocker !== null} onClick={p.onRecordId}>
          Check the record id
        </button>
        {!idOk && p.recordValue !== '' && (
          <span className="dk-why">That is not the shape of a {CHECK_KIND_WORDS[p.recordKind].toLowerCase()}.</span>
        )}
      </div>
      {checkBlocker && (
        <p className="dk-why" data-testid="verification-check-blocker">
          {checkBlocker}
        </p>
      )}
      <div className="dk-row">
        {DISCLOSURES.map((what) => (
          <button
            key={what}
            type="button"
            className="adm-btn"
            disabled={p.busy || readBlocker !== null}
            title={readBlocker ?? `Answered by ${DISCLOSURE_OWNER[what]}`}
            onClick={() => p.onRead(what)}
          >
            {DISCLOSURE_WORDS[what]}
          </button>
        ))}
      </div>
      {readBlocker && (
        <p className="dk-why" data-testid="verification-read-blocker">
          {readBlocker}
        </p>
      )}
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
  const [email, setEmail] = useState('');
  const [recordKind, setRecordKind] = useState<RecordKind>('withdrawal_id');
  const [recordValue, setRecordValue] = useState('');
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

  const send = useCallback(async (request: Parameters<typeof postVerification>[0], clear?: () => void) => {
    setBusy(true);
    setOutcome(null);
    const reply = await postVerification(request);
    setOutcome(reply);
    setBusy(false);
    setVersion((v) => v + 1);
    if (reply.ok) clear?.();
  }, []);

  return (
    <VerificationGateView
      view={view}
      loading={loading}
      email={email}
      recordKind={recordKind}
      recordValue={recordValue}
      busy={busy}
      outcome={outcome}
      onField={(patch) => {
        if (patch.email !== undefined) setEmail(patch.email);
        if (patch.recordKind) setRecordKind(patch.recordKind);
        if (patch.recordValue !== undefined) setRecordValue(patch.recordValue);
      }}
      onRecordEmail={() => void send({ action: 'check', ticketId: ticket.id, kind: 'email', value: email.trim() }, () => setEmail(''))}
      onRecordId={() =>
        void send({ action: 'check', ticketId: ticket.id, kind: recordKind, value: recordValue.trim() }, () => setRecordValue(''))
      }
      onRead={(what) => void send({ action: 'disclosure', ticketId: ticket.id, what })}
    />
  );
}
