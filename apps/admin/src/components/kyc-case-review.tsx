'use client';

import { useEffect, useState } from 'react';
import type { KycCapabilitiesOutput } from '@intafaced/contracts/identity-kyc-capabilities';
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

async function fetchCapabilities(userId: string): Promise<Answer<KycCapabilitiesOutput>> {
  try {
    const res = await fetch(`/api/identity-ops/kyc?capabilitiesFor=${encodeURIComponent(userId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const body = (await res.json().catch(() => null)) as Answer<KycCapabilitiesOutput> | null;
    if (body && (body.ok === true || body.ok === false)) return body;
  } catch {
    // falls through to the unknown answer below
  }
  return { ok: false, refusal: { code: null, title: 'Identity did not answer', body: 'Reload the case.' } };
}

const LEVEL_ORDER = { none: 0, basic: 1, full: 2, institutional: 3 } as const;

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
  const [caps, setCaps] = useState<Answer<KycCapabilitiesOutput> | null>(null);
  const [appealReply, setAppealReply] = useState<KycReviewRefusal | 'upheld' | 'overturned' | null>(null);

  async function load() {
    const next = await fetchCase(caseId);
    setView(next);
    if (next.ok) setCaps(await fetchCapabilities(next.data.userId));
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
  const approve: ControlAction = {
    heading: 'Approve this level',
    submitLabel: 'Ask a second person to approve: approve this level',
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'identity.kyc_case.approve', recordId: c.case.recordId }),
    danger: false,
  };
  const tier = c.case.tier;
  const ownCaps = caps?.ok ? caps.data.capabilities.filter((r) => r.grantedAt === tier) : [];
  const levelCaps = caps?.ok
    ? caps.data.capabilities.filter((r) => r.grantedAt !== null && LEVEL_ORDER[r.grantedAt] <= LEVEL_ORDER[tier])
    : [];
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

      <h3>Capabilities</h3>
      {caps === null ? (
        <p>Reading capabilities…</p>
      ) : !caps.ok ? (
        <RefusalLine refusal={caps.refusal} testId="kyc-case-capabilities-refusal" />
      ) : (
        <div className="dk-stack" data-testid="kyc-case-capabilities" data-mapped={String(caps.data.mapped)}>
          {!caps.data.mapped ? (
            <p data-testid="kyc-case-capabilities-unmapped">
              The owner has not mapped capabilities to levels, so approving this request grants no capability.
            </p>
          ) : ownCaps.length === 0 ? (
            <p data-testid="kyc-case-level-unmapped">
              No capability is mapped to {tier} itself, so approving it grants none of its own
              {levelCaps.length > 0 ? `; it carries what the levels below it grant (${levelCaps.map((r) => r.capability).join(', ')})` : ''}
              .
            </p>
          ) : (
            <p data-testid="kyc-case-level-grants">
              Approving {tier} turns on, in one step: {levelCaps.map((r) => r.capability).join(', ')}.
            </p>
          )}
          <table className="adm-table">
            <thead>
              <tr>
                <th>Capability</th>
                <th>State</th>
                <th>Granted from</th>
              </tr>
            </thead>
            <tbody>
              {caps.data.capabilities.map((r) => (
                <tr key={r.capability} data-testid="kyc-case-capability" data-capability={r.capability} data-state={r.state}>
                  <td>{r.capability}</td>
                  <td>{r.state}</td>
                  <td>{r.grantedAt ?? 'No level'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
      <div data-testid="kyc-case-approve">
        <ControlDesk
          key={`approve:${c.case.recordId}`}
          endpoint="/api/identity-ops/kyc/decide"
          userId={me}
          blockedReason={null}
          formHold={c.recordStatus === 'pending' ? null : `This request is ${c.recordStatus}; only a pending request can be approved.`}
          action={approve}
          consequence={`Identity approves request ${c.case.recordId} for level ${tier} and turns on, in the same step, the capabilities the owner mapped to it and the levels below it. A different person approves this request first; identity refuses if either of you is the customer.`}
          blockedButtonLabel="Approval unavailable"
          onChanged={() => void load()}
        />
      </div>
      <div data-testid="kyc-case-reject">
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
      </div>
    </section>
  );
}
