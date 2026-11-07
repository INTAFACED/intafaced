'use client';

import { useEffect, useState } from 'react';
import type { KycReviewCase } from '@intafaced/contracts/identity-kyc-cases';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { postReviewStep, RefusalLine } from '@/components/kyc-review-queue';
import type { KycReviewRefusal } from '@/lib/kyc-review/model';
import './desk.css';

type Answer<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly refusal: KycReviewRefusal };

async function fetchCase(caseId: string): Promise<Answer<KycReviewCase>> {
  try {
    const res = await fetch(`/api/identity-ops/kyc?caseId=${encodeURIComponent(caseId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const body = (await res.json().catch(() => null)) as Answer<KycReviewCase> | null;
    if (body && (body.ok === true || body.ok === false)) return body;
  } catch {
    // falls through to the unknown answer below
  }
  return { ok: false, refusal: { code: null, title: 'Identity did not answer', body: 'Reload the case.' } };
}

function who(id: string | null, me: string): string {
  if (id === null) return 'Nobody';
  return id === me ? 'You' : 'Another reviewer';
}

/**
 * One verification case for review (I-kyc-compliance-01 and -02, J-identity-20 #2): the record, the owner's reason codes,
 * the case history and the internal notes, read from identity as the signed-in reviewer. A reviewer adds notes, and asks
 * for a decision with a listed reason code, which a second person approves before it runs. Identity stores the decision
 * once: the same request run again returns the stored result, and a different code on a decided case is refused.
 */
export function KycCaseReview({ caseId, me }: { caseId: string; me: string }) {
  const [view, setView] = useState<Answer<KycReviewCase> | null>(null);
  const [note, setNote] = useState('');
  const [noteReply, setNoteReply] = useState<KycReviewRefusal | 'added' | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [appealReply, setAppealReply] = useState<KycReviewRefusal | 'upheld' | 'overturned' | null>(null);

  async function load() {
    setView(await fetchCase(caseId));
  }
  useEffect(() => {
    void load();
    // A case id is a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  async function addNote() {
    setBusy(true);
    const reply = await postReviewStep<{ id: string }>({ op: 'note', caseId, body: note });
    setNoteReply(reply.ok ? 'added' : reply.refusal);
    if (reply.ok) setNote('');
    setBusy(false);
    await load();
  }

  async function decideAppeal(decision: 'upheld' | 'overturned') {
    setBusy(true);
    const reply = await postReviewStep<{ decision: string }>({ op: 'appeal', caseId, decision });
    setAppealReply(reply.ok ? decision : reply.refusal);
    setBusy(false);
    await load();
  }

  if (view === null) return <p data-testid="kyc-case-review-loading">Reading the case from identity…</p>;
  if (!view.ok) return <RefusalLine refusal={view.refusal} testId="kyc-case-review-refusal" />;
  const c = view.data;
  const reasonCode = code || c.reasonCodes[0]?.code || '';
  const action: ControlAction = {
    heading: 'Reject this request',
    submitLabel: 'Ask a second person to approve: reject with this reason',
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'identity.kyc_case.reject', recordId: c.case.recordId, reasonCode }),
    danger: true,
  };
  return (
    <section className="dk-stack" data-testid="kyc-case-review" data-case={caseId} data-state={c.case.state}>
      <h2>Review</h2>
      <dl className="dk-facts" data-testid="kyc-case-record">
        <dt>Request</dt>
        <dd>
          <code>{c.case.recordId}</code>
        </dd>
        <dt>Level asked for</dt>
        <dd>{c.case.tier}</dd>
        <dt>Country</dt>
        <dd>{c.case.jurisdiction}</dd>
        <dt>Request status</dt>
        <dd data-testid="kyc-case-record-status">{c.recordStatus}</dd>
        <dt>Case state</dt>
        <dd data-testid="kyc-case-state">{c.case.state}</dd>
        <dt>Reviewer</dt>
        <dd data-testid="kyc-case-assignee">{who(c.assignedTo, me)}</dd>
        <dt>Reason</dt>
        <dd data-testid="kyc-case-reason">
          {c.case.reason ? `${c.case.reason.code}${c.case.reason.text ? `: ${c.case.reason.text}` : ''}` : 'None'}
        </dd>
      </dl>

      <h3>Reason codes (the owner&apos;s list)</h3>
      {c.reasonCodes.length === 0 ? (
        <p data-testid="kyc-case-reason-codes-unset">
          The owner has not published reject reasons, so identity refuses every reject (kyc.reason_codes_unset).
        </p>
      ) : (
        <ul data-testid="kyc-case-reason-codes">
          {c.reasonCodes.map((r) => (
            <li key={r.code} data-code={r.code}>
              <code>{r.code}</code>: {r.reason}
            </li>
          ))}
        </ul>
      )}

      <h3>History</h3>
      <ol data-testid="kyc-case-history">
        {c.case.history.map((h) => (
          <li key={h.version} data-state={h.state}>
            Step {h.version}: {h.state} at <time dateTime={h.at}>{h.at}</time>
          </li>
        ))}
      </ol>

      <h3>Appeals</h3>
      {c.final ? <p data-testid="kyc-case-final">This rejection is final: its appeal is decided and it takes no more appeals.</p> : null}
      {c.appeals.length === 0 ? (
        <p data-testid="kyc-case-appeals-empty">No appeal on this case.</p>
      ) : (
        <ul data-testid="kyc-case-appeals">
          {c.appeals.map((a) => (
            <li key={a.id} data-testid="kyc-case-appeal" data-decision={a.decision ?? 'open'}>
              <span>{a.body}</span>{' '}
              <span className="dk-muted">
                (appealed <time dateTime={a.submittedAt}>{a.submittedAt}</time>;{' '}
                {a.decision === null ? 'waiting for a decision' : `${a.decision} ${a.decidedAt ?? ''}`})
              </span>
            </li>
          ))}
        </ul>
      )}
      {c.appeals.length > 0 ? (
        <div className="dk-row" role="group" aria-label="Appeal decision">
          <button type="button" className="adm-btn" disabled={busy} onClick={() => void decideAppeal('upheld')}>
            Uphold the rejection
          </button>
          <button type="button" className="adm-btn" disabled={busy} onClick={() => void decideAppeal('overturned')}>
            Overturn: send back to the queue
          </button>
        </div>
      ) : null}
      {appealReply === 'upheld' ? <p data-testid="kyc-case-appeal-decided">Appeal decided: the rejection is upheld and final.</p> : null}
      {appealReply === 'overturned' ? <p data-testid="kyc-case-appeal-decided">Appeal decided: the request is back on the queue.</p> : null}
      {appealReply && typeof appealReply === 'object' ? <RefusalLine refusal={appealReply} testId="kyc-case-appeal-refusal" /> : null}

      <h3>Internal notes</h3>
      <p className="dk-muted">Notes are for reviewers only. The customer never sees them.</p>
      {c.notes.length === 0 ? (
        <p data-testid="kyc-case-notes-empty">No notes yet.</p>
      ) : (
        <ul data-testid="kyc-case-notes">
          {c.notes.map((n) => (
            <li key={n.id} data-testid="kyc-case-note">
              <span>{n.body}</span>{' '}
              <span className="dk-muted">
                ({who(n.authorId, me)}, <time dateTime={n.at}>{n.at}</time>)
              </span>
            </li>
          ))}
        </ul>
      )}
      <label className="dk-stack">
        <span>Add a note</span>
        <textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} aria-label="Add a note" />
      </label>
      <button type="button" className="adm-btn" disabled={busy || note.trim().length === 0} onClick={() => void addNote()}>
        Add note
      </button>
      {noteReply === 'added' ? <p data-testid="kyc-case-note-added">Note added.</p> : null}
      {noteReply && typeof noteReply === 'object' ? <RefusalLine refusal={noteReply} /> : null}

      <h3>Decision</h3>
      {c.reasonCodes.length > 0 ? (
        <label className="dk-stack">
          <span>Reason code</span>
          <select aria-label="Reason code" value={reasonCode} onChange={(e) => setCode(e.target.value)}>
            {c.reasonCodes.map((r) => (
              <option key={r.code} value={r.code}>
                {r.code}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <ControlDesk
        key={`${c.case.recordId}:${reasonCode}`}
        endpoint="/api/identity-ops/kyc/decide"
        userId={me}
        blockedReason={null}
        formHold={c.reasonCodes.length === 0 ? 'The owner has not published reject reasons, so no reject can be asked for.' : null}
        action={action}
        consequence={`Identity rejects request ${c.case.recordId} with reason ${reasonCode}, and the customer is told the reason and what to do. A different person approves this request and this reason first; identity refuses if either of you is the customer. Running the same approved request again returns the stored result.`}
        blockedButtonLabel="Decision unavailable"
        onChanged={() => void load()}
      />
    </section>
  );
}
