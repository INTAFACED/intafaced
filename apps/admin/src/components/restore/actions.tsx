'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RESTORE_NO, STEP_LABEL, refusalWords, type RestoreStep } from '@/lib/restore/model';
import '../desk.css';

interface ApiAnswer {
  readonly ok: boolean;
  readonly code?: string | null;
  readonly message?: string;
  readonly unknown?: boolean;
}

async function post(body: Record<string, unknown>): Promise<ApiAnswer> {
  try {
    const res = await fetch('/api/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ApiAnswer;
  } catch {
    // The request may or may not have arrived: the caller re-reads the stored state instead of repeating the action.
    return { ok: false, unknown: true, message: 'The answer was lost. Reload to see what was stored; nothing is repeated automatically.' };
  }
}

const sentence = (a: ApiAnswer): string => refusalWords(a.code ?? null) ?? a.message ?? 'svc-ops refused this.';

function useAction(onDone?: () => void) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    const a = await post(body);
    setBusy(false);
    if (a.ok) {
      setProblem(null);
      onDone?.();
      router.refresh();
    } else setProblem(sentence(a));
  };
  return { busy, problem, run };
}

/** Start a run. The restore number is the business key: sending it again returns the stored run. */
export function StartRun() {
  const [restoreNo, setRestoreNo] = useState('');
  const [cutOff, setCutOff] = useState('');
  const { busy, problem, run } = useAction();
  const ready = RESTORE_NO.test(restoreNo.trim()) && cutOff.trim() !== '' && !Number.isNaN(Date.parse(cutOff));
  return (
    <section className="dk-stack" aria-label="Start a restore run" data-testid="start-run">
      <h3>Start a restore run</h3>
      <p className="dk-muted">
        The cut-off is the one moment every service must agree on. The restore number is the key: sending it again returns the stored run.
      </p>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="rs-no">Restore number</label>
          <input id="rs-no" className="adm-input" autoComplete="off" value={restoreNo} onChange={(e) => setRestoreNo(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="rs-cutoff">Cut-off (UTC, e.g. 2026-10-20T12:00:00Z)</label>
          <input id="rs-cutoff" className="adm-input" autoComplete="off" value={cutOff} onChange={(e) => setCutOff(e.target.value)} />
        </div>
      </div>
      <button
        type="button"
        className="adm-btn"
        disabled={!ready || busy}
        data-testid="start-submit"
        onClick={() => run({ action: 'start', restoreNo: restoreNo.trim(), cutOff: cutOff.trim() })}
      >
        Start run
      </button>
      {problem && (
        <p role="alert" data-testid="start-refused">
          {problem}
        </p>
      )}
    </section>
  );
}

/** The next step. Only the step svc-ops says is next is offered, and it checks the order again. */
export function StepButton({ restoreNo, step }: { restoreNo: string; step: Exclude<RestoreStep, 'finalize'> }) {
  const { busy, problem, run } = useAction();
  return (
    <span>
      <button
        type="button"
        className="adm-btn"
        disabled={busy}
        data-testid={`step-${step}`}
        onClick={() => run({ action: 'step', restoreNo, step })}
      >
        Record: {STEP_LABEL[step]}
      </button>
      {problem && (
        <span role="alert" data-testid="step-refused">
          {' '}
          {problem}
        </span>
      )}
    </span>
  );
}

/** Finalize needs the second founder's approval, bound to this run and cut-off by svc-ops. */
export function FinalizeForm({ restoreNo }: { restoreNo: string }) {
  const [approvalId, setApprovalId] = useState('');
  const [operationId, setOperationId] = useState('');
  const { busy, problem, run } = useAction();
  return (
    <section className="dk-stack" aria-label="Finalize" data-testid="finalize-form">
      <h3>Finalize</h3>
      <p className="dk-muted">A second founder approves this exact run and cut-off first, then you enter their approval here.</p>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="rf-approval">Approval id</label>
          <input
            id="rf-approval"
            className="adm-input"
            autoComplete="off"
            value={approvalId}
            onChange={(e) => setApprovalId(e.target.value)}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="rf-op">Operation id</label>
          <input id="rf-op" className="adm-input" autoComplete="off" value={operationId} onChange={(e) => setOperationId(e.target.value)} />
        </div>
      </div>
      <button
        type="button"
        className="adm-btn"
        disabled={approvalId.trim() === '' || operationId.trim() === '' || busy}
        data-testid="finalize-submit"
        onClick={() => run({ action: 'finalize', restoreNo, approvalId: approvalId.trim(), operationId: operationId.trim() })}
      >
        Finalize restore
      </button>
      {problem && (
        <p role="alert" data-testid="finalize-refused">
          {problem}
        </p>
      )}
    </section>
  );
}
