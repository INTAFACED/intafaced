'use client';

import { useCallback, useState } from 'react';
import { CLAIM_EVIDENCE_MAX, CLAIM_TEXT_MAX, CLAIM_TOPIC_MAX, type MarketingClaim } from '@intafaced/contracts/ops-marketing-claims';
import { formatAsOf } from '@/lib/as-of';
import { postConsoleChange, type ConsoleChangeReply } from '@/lib/console-announcements/browser';
import { BLOCK_TEXT, type ClaimsView } from '@/lib/marketing-claims/model';
import './desk.css';

/**
 * MARKETING CLAIMS EVIDENCE REGISTER (RC-more-catalogue-24, J-more-catalogue-14 #7), on the launch lens beside the
 * announce controls: before a launch is announced, a founder reads every claim it would carry with its evidence, or the
 * block that keeps it off the page. A founder records a claim; a second founder publishes it, and only with evidence.
 */

async function fetchClaims(): Promise<ClaimsView | null> {
  try {
    const res = await fetch('/api/launch/claims', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = (await res.json()) as { view?: ClaimsView };
    return body.view && typeof body.view.kind === 'string' ? body.view : null;
  } catch {
    return null;
  }
}

function Outcome({ reply }: { reply: ConsoleChangeReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="claims-outcome">
        <strong>Done: {String(reply.answer.what ?? 'saved')}</strong>
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="claims-outcome"
      data-code={reply.code ?? ''}
    >
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}

function ClaimRow({ c, me, busy, onPublish }: { c: MarketingClaim; me: string; busy: boolean; onPublish: (id: string) => void }) {
  return (
    <tr data-claim={c.id}>
      <td lang="und">{c.text}</td>
      <td lang="und">{c.topic}</td>
      <td data-testid="claim-evidence" lang="und">
        {c.evidence ?? '—'}
      </td>
      <td data-testid="claim-state" data-block={c.block ?? ''}>
        {c.block ? BLOCK_TEXT[c.block] : 'Published'}
      </td>
      <td data-testid="claim-author">{c.authorId}</td>
      <td data-testid="claim-approver">{c.approverId ?? '—'}</td>
      <td>
        {c.status === 'draft' && (
          <button type="button" className="adm-btn" disabled={busy} onClick={() => onPublish(c.id)}>
            {c.authorId === me ? 'Publish (a second founder must)' : 'Publish this claim'}
          </button>
        )}
      </td>
    </tr>
  );
}

export function MarketingClaimsRegister({ initial, me }: { initial: ClaimsView; me: string }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ConsoleChangeReply | null>(null);
  const [topic, setTopic] = useState('');
  const [text, setText] = useState('');
  const [evidence, setEvidence] = useState('');

  const submit = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    const result = await postConsoleChange('/api/launch/claims', body);
    setReply(result);
    const next = await fetchClaims();
    if (next) setView(next);
    if (result.ok && body.op === 'record') {
      setTopic('');
      setText('');
      setEvidence('');
    }
    setBusy(false);
  }, []);

  const data = view.kind === 'read' ? view.data : null;
  return (
    <section className="dk-stack" role="region" aria-labelledby="claims-register" data-testid="claims-register">
      <h2 id="claims-register">Marketing claims</h2>
      <p className="dk-muted">
        Every claim a launch or the platform makes, with the evidence it rests on. A claim with no evidence, or not yet published by a
        second founder, is blocked and never shown to customers. Read this before announcing.
      </p>
      <Outcome reply={reply} />
      {view.kind === 'unconfigured' && (
        <div className="adm-callout" data-tone="warn" role="status" data-testid="claims-unconfigured">
          <strong>The claims register has no storage</strong>
          <p>svc-ops has no database configured for it, so no claim can be recorded or published.</p>
        </div>
      )}
      {view.kind === 'unknown' && (
        <div className="adm-callout" data-tone="danger" role="status" data-testid="claims-unknown">
          <strong>The claims register could not be read</strong>
          <p>
            {view.message}
            {view.code ? ` Code: ${view.code}.` : ''}
          </p>
        </div>
      )}
      {data && (
        <>
          <form
            className="dk-stack"
            aria-label="Record a claim"
            onSubmit={(e) => {
              e.preventDefault();
              void submit({ op: 'record', topic, text, evidence });
            }}
          >
            <label>
              Claim about
              <input value={topic} maxLength={CLAIM_TOPIC_MAX} onChange={(e) => setTopic(e.target.value)} required />
            </label>
            <label>
              Claim
              <input value={text} maxLength={CLAIM_TEXT_MAX} onChange={(e) => setText(e.target.value)} required />
            </label>
            <label>
              Evidence (a document reference or an https address; blank keeps the claim blocked)
              <input value={evidence} maxLength={CLAIM_EVIDENCE_MAX} onChange={(e) => setEvidence(e.target.value)} />
            </label>
            <div className="dk-row">
              <button type="submit" className="adm-btn" disabled={busy}>
                Record this claim
              </button>
              <span className="dk-asof">As of {formatAsOf(data.asOf)}</span>
            </div>
          </form>
          {data.items.length === 0 ? (
            <p className="dk-muted" data-testid="claims-none">
              No claim is recorded yet.
            </p>
          ) : (
            <table aria-label="Marketing claims register">
              <thead>
                <tr>
                  <th scope="col">Claim</th>
                  <th scope="col">About</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">State</th>
                  <th scope="col">Recorded by</th>
                  <th scope="col">Published by</th>
                  <th scope="col">
                    <span className="dk-muted">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <ClaimRow key={c.id} c={c} me={me} busy={busy} onPublish={(id) => void submit({ op: 'publish', id })} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
