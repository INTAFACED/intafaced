'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { founderMutationHeaders } from '@/lib/founder-browser';
import {
  RESTORE_NO,
  RESTORE_SERVICES,
  SERVICE_LABEL,
  STEP_LABEL,
  refusalWords,
  type RestoreServiceName,
  type RestoreStep,
} from '@/lib/restore/model';
import '../desk.css';

interface ApiAnswer {
  readonly ok: boolean;
  readonly code?: string | null;
  readonly message?: string;
  readonly unknown?: boolean;
}

async function post(body: Record<string, unknown>): Promise<ApiAnswer> {
  let headers: Record<string, string>;
  try {
    // The console's CSRF header with the content type; without it the gate refuses admin.session_csrf and nothing is sent.
    headers = await founderMutationHeaders();
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Your founder session could not be confirmed. Nothing was sent.',
    };
  }
  try {
    const res = await fetch('/api/restore', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
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

/** Finalize is a two-founder request bound to this run and its cut-off; svc-ops checks the joint watermark again when it runs. */
export function FinalizeDesk({ restoreNo, cutOff, userId }: { restoreNo: string; cutOff: string; userId: string }) {
  const router = useRouter();
  const action: ControlAction = {
    heading: `Finalize run ${restoreNo}`,
    submitLabel: 'Ask a second founder to approve finalizing this restore',
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'ops.restore.finalize', restoreNo, cutOff }),
  };
  return (
    <section className="dk-stack" aria-label="Finalize" data-testid="finalize-form">
      <h3>Finalize</h3>
      <ControlDesk
        endpoint="/api/restore/approvals"
        userId={userId}
        blockedReason={null}
        action={action}
        consequence="svc-ops checks again that every service matches its stamp and wrote nothing after the cut-off, and refuses if one does not. Only then is the run recorded as restored. Two different founders must agree; svc-ops needs the treasury permission (admin:treasury) and a verified second factor on your session."
        blockedButtonLabel="Finalize unavailable"
        onChanged={() => router.refresh()}
      />
    </section>
  );
}

/**
 * Record the watermark an operator read for one service. The stamp is what the joint check compares that service's live position
 * with, so it is a two-founder request: a different founder approves the exact service, kind and watermark.
 */
export function RecordStamp({ userId }: { userId: string }) {
  const router = useRouter();
  const [service, setService] = useState<RestoreServiceName>(RESTORE_SERVICES[0]);
  const [stampKind, setStampKind] = useState('');
  const [watermark, setWatermark] = useState('');
  const kind = stampKind.trim().toLowerCase();
  const mark = watermark.trim();
  const problem = kind === '' || mark === '' ? 'Enter what the position counts and the watermark you read.' : null;
  const action: ControlAction = {
    heading: 'Record a stamp',
    submitLabel: 'Ask a second founder to approve this stamp',
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'ops.restore.record', service, stampKind: kind, watermark: mark }),
  };
  return (
    <section className="dk-stack" aria-label="Record a stamp" data-testid="record-stamp">
      <h3>Record a stamp</h3>
      <p className="dk-muted">
        Read the service&apos;s position in the joint table of a run, or from the service itself, and record it here. A later stamp for the
        same service takes its place in the check; the earlier one stays listed.
      </p>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="rs-service">Service</label>
          <select
            id="rs-service"
            className="adm-input"
            value={service}
            onChange={(e) => setService(RESTORE_SERVICES.find((s) => s === e.target.value) ?? RESTORE_SERVICES[0])}
          >
            {RESTORE_SERVICES.map((s) => (
              <option key={s} value={s}>
                {SERVICE_LABEL[s] ?? s}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="rs-kind">What the position counts (e.g. ledger_tx.seq)</label>
          <input id="rs-kind" className="adm-input" autoComplete="off" value={stampKind} onChange={(e) => setStampKind(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="rs-watermark">Watermark read</label>
          <input
            id="rs-watermark"
            className="adm-input"
            autoComplete="off"
            value={watermark}
            onChange={(e) => setWatermark(e.target.value)}
          />
        </div>
      </div>
      <ControlDesk
        endpoint="/api/restore/approvals"
        userId={userId}
        blockedReason={null}
        formHold={problem}
        action={action}
        consequence="The stamp is stored once and listed with who recorded and approved it. Nothing is restored and no money moves. Two different founders must agree; svc-ops needs the treasury permission (admin:treasury) and a verified second factor on your session, and refuses while no joint-restore archive is configured."
        blockedButtonLabel="Recording unavailable"
        onChanged={() => router.refresh()}
      />
    </section>
  );
}
