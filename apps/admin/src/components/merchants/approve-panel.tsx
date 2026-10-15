'use client';

import { useState } from 'react';
import { postRegistry, type ApprovalView, type RefusalView } from '@/lib/merchants/registry-client';
import { acceptChange, REGISTRY_INFO, REGISTRY_KINDS, summariseChange, type RegistryKind } from '@/lib/merchants/registry-model';
import { RefusalBlock } from './registry-form';
import { StateBlock } from './ui';

interface Parsed {
  readonly registry: RegistryKind;
  readonly approvalId: string;
  readonly change: Record<string, unknown>;
}

/** Reads the request the first founder copied. Anything that is not exactly that shape is refused. */
export function parseHandoff(text: string): Parsed | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const registry = REGISTRY_KINDS.find((k) => k === raw.registry);
    if (!registry || typeof raw.approvalId !== 'string' || raw.approvalId.trim() === '') return null;
    const change = acceptChange(registry, raw.change);
    return change ? { registry, approvalId: raw.approvalId.trim(), change } : null;
  } catch {
    return null;
  }
}

/**
 * Step 2 of dual control, on the SECOND founder's screen. They see in words
 * what they are approving. The service checks the approval is for exactly that
 * change; if the hashes differ this says so loudly. Identity refuses an
 * approval from the founder who asked.
 */
export function ApprovePanel() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalView | null>(null);
  const [done, setDone] = useState<{ kind: 'approved' | 'declined' | 'mismatch'; approval?: ApprovalView } | null>(null);
  const parsed = text.trim() === '' ? null : parseHandoff(text);

  async function decide(action: 'approve' | 'reject') {
    if (busy || !parsed) return;
    setBusy(true);
    setRefusal(null);
    const reply =
      action === 'approve'
        ? await postRegistry({ action: 'approve', registry: parsed.registry, change: parsed.change, approvalId: parsed.approvalId })
        : await postRegistry({ action: 'reject', approvalId: parsed.approvalId });
    setBusy(false);
    if (!reply.ok) return setRefusal(reply.refusal);
    if (action === 'reject') return setDone({ kind: 'declined', ...(reply.approval ? { approval: reply.approval } : {}) });
    setDone({
      kind: reply.matchesReviewedChange === false ? 'mismatch' : 'approved',
      ...(reply.approval ? { approval: reply.approval } : {}),
    });
  }

  return (
    <section className="mp-card" aria-labelledby="approve-title">
      <div className="mp-card__head">
        <div>
          <h2 id="approve-title">Approve a change from another founder</h2>
          <p>Second step of dual control. Paste the request the other founder copied, read it, then approve or decline.</p>
        </div>
      </div>
      <div className="mp-card__body">
        <div className="mp-field">
          <label htmlFor="handoff">Request from the other founder</label>
          <textarea
            id="handoff"
            className="mp-input"
            rows={4}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDone(null);
              setRefusal(null);
            }}
            aria-describedby="handoff-hint"
            spellCheck={false}
          />
          <span id="handoff-hint" className="mp-hint">
            Starts with a curly bracket. You cannot approve a change you requested yourself.
          </span>
        </div>
        {text.trim() !== '' && !parsed ? (
          <StateBlock kind="error" title="That is not a request this page understands">
            Copy the whole request again from the other founder's screen. It must include the registry, the change and the approval
            reference.
          </StateBlock>
        ) : null}
        {parsed ? (
          <div className="mp-review">
            <p>
              <strong>
                {REGISTRY_INFO[parsed.registry].title}: {String(parsed.change.displayName ?? parsed.change.assetCode ?? 'entry')}
              </strong>
            </p>
            <dl className="mp-kv mp-kv--summary">
              {summariseChange(parsed.registry, parsed.change).map((row) => (
                <div key={row.key}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            <div className="mp-inline">
              <button type="button" className="mp-btn mp-btn--primary" onClick={() => decide('approve')} disabled={busy}>
                {busy ? 'Working…' : 'Approve this change'}
              </button>
              <button type="button" className="mp-btn" onClick={() => decide('reject')} disabled={busy}>
                Decline
              </button>
            </div>
          </div>
        ) : null}
        <RefusalBlock refusal={refusal} />
        {done?.kind === 'approved' ? (
          <StateBlock kind="info" title="Approved">
            Tell the other founder they can save now. The approval only works for exactly this change and only once.
          </StateBlock>
        ) : null}
        {done?.kind === 'mismatch' ? (
          <StateBlock kind="error" title="Approved, but for a different change">
            The approval on that reference covers a different change than the one shown above. It cannot be used to save this one. Ask the
            other founder to request a new approval.
          </StateBlock>
        ) : null}
        {done?.kind === 'declined' ? (
          <StateBlock kind="info" title="Declined">
            The request is closed. The change was not made.
          </StateBlock>
        ) : null}
      </div>
    </section>
  );
}
