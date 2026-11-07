'use client';

import { useEffect, useState } from 'react';
import type { KycLevelSettingsView } from '@intafaced/contracts/identity-kyc-levels';
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { KycReviewRefusal } from '@/lib/kyc-review/model';
import { RefusalLine } from '@/components/kyc-review-queue';
import './desk.css';

type Answer<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly refusal: KycReviewRefusal };
const UNKNOWN: KycReviewRefusal = { code: null, title: 'Identity did not answer', body: 'Reload the page to see what is in force.' };
const LEVELS = ['basic', 'full', 'institutional'] as const;
type Level = (typeof LEVELS)[number];

async function call<T>(init?: RequestInit): Promise<Answer<T>> {
  try {
    const res = await fetch('/api/identity-ops/kyc/levels', { cache: 'no-store', credentials: 'same-origin', ...init });
    const body = (await res.json().catch(() => null)) as Answer<T> | null;
    if (body && (body.ok === true || (body.ok === false && body.refusal))) return body;
  } catch {
    // falls through
  }
  return { ok: false, refusal: UNKNOWN };
}

function minutesText(m: number | null): string {
  if (m === null) return 'No review time stated';
  return m % 60 === 0 ? `${m / 60} h` : `${m} min`;
}

/**
 * Per-level requirements and review times (I-kyc-compliance-05, J-identity-20 #7). Each level shows what is in force and
 * what the owner published. A change for one level is proposed here and waits for a second person; once a different
 * person approves it, identity applies it. "Back to the owner's values" removes an applied change, also with a second person.
 */
export function KycLevelSettingsEditor({ me }: { me: string }) {
  const [view, setView] = useState<Answer<KycLevelSettingsView> | null>(null);
  const [level, setLevel] = useState<Level>('institutional');
  const [requirements, setRequirements] = useState('');
  const [minutes, setMinutes] = useState('');
  const [restore, setRestore] = useState(false);
  const [reply, setReply] = useState<KycReviewRefusal | string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setView(await call<KycLevelSettingsView>());
  }
  useEffect(() => {
    void load();
  }, []);

  async function post(step: Record<string, unknown>, done: string) {
    setBusy(true);
    let headers: Record<string, string>;
    try {
      headers = await founderMutationHeaders();
    } catch {
      setReply(UNKNOWN);
      setBusy(false);
      return;
    }
    const r = await call<{ state: string }>({ method: 'POST', headers, body: JSON.stringify(step) });
    setReply(r.ok ? done : r.refusal);
    setBusy(false);
    await load();
  }

  const keys = requirements
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const mins = minutes.trim() === '' ? null : Number(minutes.trim());
  return (
    <section className="dk-stack" data-testid="kyc-level-settings">
      <h1>Requirements and review times by level</h1>
      <p className="dk-muted">
        A change waits for a second person and takes effect only when a different person approves it. The customer&apos;s ladder and the
        queue&apos;s overdue lines read what is in force.
      </p>
      {view === null ? (
        <p>Reading from identity…</p>
      ) : !view.ok ? (
        <RefusalLine refusal={view.refusal} testId="kyc-level-settings-refusal" />
      ) : (
        <>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Level</th>
                <th>Requirements in force</th>
                <th>Review time in force</th>
                <th>Owner&apos;s published</th>
              </tr>
            </thead>
            <tbody>
              {view.data.levels.map((l) => (
                <tr
                  key={l.level}
                  data-testid="kyc-level-row"
                  data-level={l.level}
                  data-review-minutes={l.reviewMinutes ?? ''}
                  data-edited={String(l.edited)}
                >
                  <td>{l.level}</td>
                  <td>{l.requirements === null ? 'None published' : l.requirements.join(', ')}</td>
                  <td>{minutesText(l.reviewMinutes)}</td>
                  <td>
                    {l.published.requirements === null ? 'None published' : l.published.requirements.join(', ')};{' '}
                    {minutesText(l.published.reviewMinutes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Waiting for a second person</h2>
          {view.data.waiting.length === 0 ? (
            <p data-testid="kyc-level-waiting-empty">No change waits.</p>
          ) : (
            <ul>
              {view.data.waiting.map((c) => (
                <li key={c.id} data-testid="kyc-level-change" data-change={c.id} data-level={c.level}>
                  <span>
                    {c.level}:{' '}
                    {c.restore
                      ? "back to the owner's published values"
                      : `requirements ${c.requirements === null ? 'none published' : c.requirements.join(', ')}; review time ${minutesText(c.reviewMinutes)}`}
                    . Proposed by {c.proposedBy === me ? 'you' : 'another person'}.
                  </span>{' '}
                  {c.proposedBy === me ? (
                    <button
                      type="button"
                      className="adm-btn"
                      disabled={busy}
                      onClick={() => void post({ op: 'withdraw', changeId: c.id }, 'Change withdrawn.')}
                    >
                      Withdraw
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="adm-btn"
                    disabled={busy}
                    onClick={() => void post({ op: 'approve', changeId: c.id }, 'Change approved and in force.')}
                  >
                    Approve this change
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h2>Propose a change</h2>
          <div className="dk-stack" data-testid="kyc-level-propose">
            <label className="dk-stack">
              <span>Level</span>
              <select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="dk-row">
              <input
                type="checkbox"
                checked={restore}
                onChange={(e) => setRestore(e.target.checked)}
                aria-label="Back to the owner's values"
              />
              <span>Back to the owner&apos;s published values</span>
            </label>
            {!restore ? (
              <>
                <label className="dk-stack">
                  <span>Requirements (comma separated; empty: none published)</span>
                  <input aria-label="Requirements" value={requirements} onChange={(e) => setRequirements(e.target.value)} />
                </label>
                <label className="dk-stack">
                  <span>Review time in minutes (empty: none stated)</span>
                  <input
                    aria-label="Review time in minutes"
                    inputMode="numeric"
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                  />
                </label>
              </>
            ) : null}
            <button
              type="button"
              className="adm-btn"
              disabled={busy || (!restore && mins !== null && !(Number.isInteger(mins) && mins >= 1))}
              onClick={() =>
                void post(
                  {
                    op: 'propose',
                    level,
                    restore,
                    requirements: restore || keys.length === 0 ? null : keys,
                    reviewMinutes: restore ? null : mins,
                  },
                  'Change proposed. It waits for a second person.',
                )
              }
            >
              Propose this change
            </button>
          </div>
        </>
      )}
      {typeof reply === 'string' ? <p data-testid="kyc-level-reply">{reply}</p> : null}
      {reply && typeof reply === 'object' ? <RefusalLine refusal={reply} testId="kyc-level-refusal" /> : null}
    </section>
  );
}
