'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { OUTCOME_LABEL, newStepKey, refusalWords, type DisputeOutcome, type DisputeState } from '@/lib/card-disputes/model';
import '../desk.css';

interface Answer {
  readonly ok: boolean;
  readonly code?: string | null;
  readonly message?: string;
  readonly unknown?: boolean;
}

async function post(body: Record<string, unknown>): Promise<Answer> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Your founder session could not be confirmed.' };
  }
  try {
    const res = await fetch('/api/bank-ops/disputes', { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
    return (await res.json()) as Answer;
  } catch {
    return {
      ok: false,
      unknown: true,
      message: 'The answer was lost. Read the case to see what was stored; nothing is repeated automatically.',
    };
  }
}

const sentence = (a: Answer): string => refusalWords(a.code ?? null) ?? a.message ?? 'svc-bank refused this.';

/** The steps open to a case in its state. Each form keeps its step key until the step is stored, so a lost reply is safe to repeat. */
export function DisputeActions({ disputeId, state, credited }: { disputeId: string; state: DisputeState; credited: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [evidenceKey, setEvidenceKey] = useState(() => newStepKey());
  const [representment, setRepresentment] = useState('');
  const [repKey] = useState(() => newStepKey());
  const [arbKey] = useState(() => newStepKey());
  const [outcome, setOutcome] = useState<DisputeOutcome | ''>('');
  const [answer, setAnswer] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  async function run(body: Record<string, unknown>, done: string, after?: () => void) {
    setBusy(true);
    const a = await post({ ...body, disputeId });
    setBusy(false);
    if (a.ok) {
      setAnswer({ tone: 'ok', text: done });
      after?.();
      router.refresh();
    } else setAnswer({ tone: 'warn', text: sentence(a) });
  }

  return (
    <section className="dk-stack" aria-label="Work the case" data-testid="dispute-actions">
      <h3>Work the case</h3>
      <div className="adm-field">
        <label htmlFor="dispute-evidence">Evidence</label>
        <textarea id="dispute-evidence" className="adm-input" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        <button
          type="button"
          className="adm-btn"
          disabled={busy || evidence.trim() === ''}
          onClick={() =>
            void run(
              { action: 'evidence', stepKey: evidenceKey, description: evidence.trim() },
              'The evidence is stored with its time.',
              () => {
                setEvidence('');
                setEvidenceKey(newStepKey());
              },
            )
          }
        >
          Add evidence
        </button>
      </div>
      {state === 'opened' && (
        <div className="adm-field">
          <label htmlFor="dispute-representment">Representment</label>
          <textarea
            id="dispute-representment"
            className="adm-input"
            value={representment}
            onChange={(e) => setRepresentment(e.target.value)}
          />
          <button
            type="button"
            className="adm-btn"
            disabled={busy || representment.trim() === ''}
            onClick={() =>
              void run({ action: 'representment', stepKey: repKey, description: representment.trim() }, 'The representment is submitted.')
            }
          >
            Submit representment
          </button>
        </div>
      )}
      {state === 'representment' && (
        <button
          type="button"
          className="adm-btn"
          disabled={busy}
          onClick={() => void run({ action: 'arbitration', stepKey: arbKey }, 'The case is in arbitration.')}
        >
          Escalate to arbitration
        </button>
      )}
      {!credited && (
        <div className="dk-row">
          <button
            type="button"
            className="adm-btn"
            disabled={busy}
            onClick={() => void run({ action: 'credit' }, 'The partner gave its provisional credit; its reference is on the case.')}
          >
            Grant provisional credit
          </button>
          <span className="dk-muted">The card partner credits its cardholder under its own terms; nothing posts to the ledger.</span>
        </div>
      )}
      <div className="adm-field">
        <label htmlFor="dispute-outcome">Decision</label>
        <select
          id="dispute-outcome"
          className="adm-input"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as DisputeOutcome | '')}
        >
          <option value="">Choose</option>
          <option value="cardholder">{OUTCOME_LABEL.cardholder}</option>
          <option value="merchant">{OUTCOME_LABEL.merchant}</option>
        </select>
        <button
          type="button"
          className="adm-btn"
          disabled={busy || outcome === ''}
          onClick={() =>
            void run({ action: 'decide', outcome }, 'Decided and closed. Who bears the fraud loss is recorded under the partner’s terms.')
          }
        >
          Decide and close
        </button>
      </div>
      {answer && (
        <div className="adm-callout" data-tone={answer.tone} role="status" data-testid="dispute-answer">
          {answer.text}
        </div>
      )}
    </section>
  );
}
