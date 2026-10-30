'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { refusalWords } from '@/lib/recon-alerts/model';
import '../desk.css';

interface ApiAnswer {
  readonly ok: boolean;
  readonly code?: string | null;
  readonly message?: string;
  readonly detail?: string;
  readonly unknown?: boolean;
}

async function post(body: Record<string, unknown>): Promise<ApiAnswer> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    // Nothing was sent: the session nonce could not be had.
    return { ok: false, message: error instanceof Error ? error.message : 'Your founder session is unavailable. Sign in again.' };
  }
  try {
    const res = await fetch('/api/ledger-reconciliation/alerts', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return (await res.json()) as ApiAnswer;
  } catch {
    // The request may or may not have arrived: the founder re-reads the stored alert instead of repeating the move.
    return { ok: false, unknown: true, message: 'The answer was lost. Reload to see what was stored; nothing is repeated automatically.' };
  }
}

/**
 * One founder's moves on one alert: acknowledge with a note, snooze until a time, lift the snooze, and resolve as fixed by linking
 * the corrective ledger transactions (OPS-reconciliation-04). Resolve goes on the treasury credential; when this founder cannot
 * send it, or the alert cannot take it, the form stays on screen, disabled, with the reason. The page passes the version the
 * founder is looking at, so the route's key names that version; a refusal shows its exact code and the page re-reads the alert, so a
 * founder who lost a race sees the winner's acknowledgement.
 */
export function AlertActions({
  alertId,
  version,
  state,
  snoozed,
  resolveBlocked,
}: {
  alertId: string;
  version: number;
  state: string;
  snoozed: boolean;
  /** Why resolve cannot be sent from here (the alert's state or cause, or the treasury credential), or null. */
  resolveBlocked: string | null;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [txIds, setTxIds] = useState('');
  const [resolveNote, setResolveNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ code: string | null; text: string; detail: string | null } | null>(null);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    const a = await post({ alertId, version, ...body });
    setBusy(false);
    setProblem(
      a.ok
        ? null
        : { code: a.code ?? null, text: refusalWords(a.code ?? null) ?? a.message ?? 'svc-ops refused this.', detail: a.detail ?? null },
    );
    router.refresh();
  };
  return (
    <section className="dk-stack" aria-label="Alert actions" data-testid="alert-actions">
      {state === 'open' && (
        <div className="dk-row">
          <div className="adm-field">
            <label htmlFor="ra-note">Acknowledgement note</label>
            <input id="ra-note" className="adm-input" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <button
            type="button"
            className="adm-btn"
            disabled={busy}
            data-testid="alert-ack"
            onClick={() => run({ action: 'acknowledge', note })}
          >
            Acknowledge
          </button>
        </div>
      )}
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="ra-until">Snooze notices until (UTC, e.g. 2026-10-30T12:00:00Z)</label>
          <input id="ra-until" className="adm-input" autoComplete="off" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </div>
        <button
          type="button"
          className="adm-btn"
          disabled={busy}
          data-testid="alert-snooze"
          onClick={() => run({ action: 'snooze', endsAt })}
        >
          Snooze
        </button>
        {snoozed && (
          <button
            type="button"
            className="adm-btn"
            disabled={busy}
            data-testid="alert-unsnooze"
            onClick={() => run({ action: 'unsnooze' })}
          >
            Lift snooze
          </button>
        )}
      </div>
      <form
        className="dk-stack"
        aria-label="Resolve as fixed"
        data-testid="alert-resolve"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && resolveBlocked === null) void run({ action: 'resolve', txIds, note: resolveNote });
        }}
      >
        <h3>Resolve as fixed</h3>
        <p className="dk-muted">
          Link the corrective transactions already booked in the ledger. svc-ops checks each one exists before it resolves; it moves no
          money and changes no balance. A repeat failure in this period reopens the alert.
        </p>
        <div className="adm-field">
          <label htmlFor="ra-tx">Corrective transaction ids</label>
          <input
            id="ra-tx"
            className="adm-input"
            autoComplete="off"
            value={txIds}
            disabled={resolveBlocked !== null}
            onChange={(e) => setTxIds(e.target.value)}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="ra-resolve-note">Resolution note (optional)</label>
          <input
            id="ra-resolve-note"
            className="adm-input"
            autoComplete="off"
            value={resolveNote}
            disabled={resolveBlocked !== null}
            onChange={(e) => setResolveNote(e.target.value)}
          />
        </div>
        {resolveBlocked && (
          <p className="dk-muted" data-testid="alert-resolve-why">
            {resolveBlocked}
          </p>
        )}
        <button type="submit" className="adm-btn" disabled={busy || resolveBlocked !== null} data-testid="alert-resolve-submit">
          Resolve with these transactions
        </button>
      </form>
      {problem && (
        <div role="alert" data-testid="alert-refused">
          <p>{problem.text}</p>
          {problem.detail && <p data-testid="alert-refused-detail">svc-ops: {problem.detail}</p>}
          {problem.code && (
            <p className="dk-muted" data-testid="alert-refused-code">
              {problem.code}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
