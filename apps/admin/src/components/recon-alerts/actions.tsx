'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { refusalWords } from '@/lib/recon-alerts/model';
import '../desk.css';

interface ApiAnswer {
  readonly ok: boolean;
  readonly code?: string | null;
  readonly message?: string;
  readonly unknown?: boolean;
}

async function post(body: Record<string, unknown>): Promise<ApiAnswer> {
  try {
    const res = await fetch('/api/ledger-reconciliation/alerts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ApiAnswer;
  } catch {
    // The request may or may not have arrived: the founder re-reads the stored alert instead of repeating the move.
    return { ok: false, unknown: true, message: 'The answer was lost. Reload to see what was stored; nothing is repeated automatically.' };
  }
}

/**
 * One founder's moves on one alert: acknowledge with a note, snooze until a time, lift the snooze. The page passes the version the
 * founder is looking at, so the route's key names that version; a refusal shows its exact code and the page re-reads the alert, so a
 * founder who lost a race sees the winner's acknowledgement.
 */
export function AlertActions({ alertId, version, state, snoozed }: { alertId: string; version: number; state: string; snoozed: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ code: string | null; text: string } | null>(null);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    const a = await post({ alertId, version, ...body });
    setBusy(false);
    setProblem(a.ok ? null : { code: a.code ?? null, text: refusalWords(a.code ?? null) ?? a.message ?? 'svc-ops refused this.' });
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
      {problem && (
        <div role="alert" data-testid="alert-refused">
          <p>{problem.text}</p>
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
