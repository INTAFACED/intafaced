'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { newHoldKey, refusalWords } from '@/lib/bank-holds/model';
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
    const res = await fetch('/api/bank-ops/holds', { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
    return (await res.json()) as Answer;
  } catch {
    return {
      ok: false,
      unknown: true,
      message: 'The answer was lost. Read the queue to see what was stored; nothing is repeated automatically.',
    };
  }
}

const sentence = (a: Answer): string => refusalWords(a.code ?? null) ?? a.message ?? 'svc-bank refused this.';

function Result({ answer }: { answer: { tone: 'ok' | 'warn'; text: string } | null }) {
  if (!answer) return null;
  return (
    <div className="adm-callout" data-tone={answer.tone} role="status" data-testid="hold-answer">
      {answer.text}
    </div>
  );
}

/** One action on one held send: a single button or a single text field with a button. */
export function HoldRowActions({ sendId, canRelease, hasProof }: { sendId: string; canRelease: boolean; hasProof: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [reference, setReference] = useState('');
  const [answer, setAnswer] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  async function run(body: Record<string, unknown>, done: string, after?: () => void) {
    setBusy(true);
    const a = await post({ ...body, sendId });
    setBusy(false);
    if (a.ok) {
      setAnswer({ tone: 'ok', text: done });
      after?.();
      router.refresh();
    } else setAnswer({ tone: 'warn', text: sentence(a) });
  }

  return (
    <div className="dk-stack" data-testid="hold-actions">
      <div className="adm-field">
        <label htmlFor={`info-${sendId}`}>Ask the customer for something</label>
        <input id={`info-${sendId}`} className="adm-input" autoComplete="off" value={info} onChange={(e) => setInfo(e.target.value)} />
        <button
          type="button"
          className="adm-btn"
          disabled={busy || info.trim() === ''}
          data-testid="hold-request-info"
          onClick={() =>
            void run({ action: 'requestInfo', infoRequest: info.trim() }, 'The customer is asked and sees your words.', () => setInfo(''))
          }
        >
          Request information
        </button>
      </div>
      <div className="adm-field">
        <label htmlFor={`ref-${sendId}`}>Incoming payment reference</label>
        <input
          id={`ref-${sendId}`}
          className="adm-input"
          autoComplete="off"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <button
          type="button"
          className="adm-btn"
          disabled={busy || reference.trim().length < 6}
          data-testid="hold-link-reference"
          onClick={() =>
            void run({ action: 'linkReference', reference: reference.trim() }, 'The reference is linked and the hold is released.', () =>
              setReference(''),
            )
          }
        >
          Link reference and release
        </button>
      </div>
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          disabled={busy || !canRelease}
          data-testid="hold-release"
          onClick={() => void run({ action: 'release' }, 'Released. The send continues from where it stopped.')}
        >
          Release
        </button>
        {!canRelease && <span className="dk-muted">You placed this hold, so a second operator must release it.</span>}
        {hasProof && (
          <a className="adm-btn" href={`/api/bank-ops/holds?sendId=${encodeURIComponent(sendId)}`} data-testid="hold-proof" download>
            Download the customer’s file
          </a>
        )}
      </div>
      <Result answer={answer} />
    </div>
  );
}

/** Place a hold on a send that has not been debited. The key stays until the hold is stored, so a lost reply can be sent again. */
export function PlaceHold() {
  const router = useRouter();
  const [sendId, setSendId] = useState('');
  const [reason, setReason] = useState('');
  const [info, setInfo] = useState('');
  const [key, setKey] = useState(() => newHoldKey());
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const ready = /^[0-9a-f-]{36}$/i.test(sendId.trim()) && reason.trim() !== '';
  return (
    <section className="dk-stack" aria-label="Place a hold" data-testid="place-hold">
      <h3>Place a hold</h3>
      <p className="dk-muted">
        A hold stops a send that has not been debited. The customer sees only that it is on hold and what you ask of them, never your
        reason.
      </p>
      <div className="adm-field">
        <label htmlFor="ph-send">Send id</label>
        <input id="ph-send" className="adm-input" autoComplete="off" value={sendId} onChange={(e) => setSendId(e.target.value)} />
      </div>
      <div className="adm-field">
        <label htmlFor="ph-reason">Reason (kept for operators)</label>
        <input id="ph-reason" className="adm-input" autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="adm-field">
        <label htmlFor="ph-info">Ask the customer for something (optional)</label>
        <input id="ph-info" className="adm-input" autoComplete="off" value={info} onChange={(e) => setInfo(e.target.value)} />
      </div>
      <button
        type="button"
        className="adm-btn"
        disabled={!ready || busy}
        data-testid="place-hold-submit"
        onClick={async () => {
          setBusy(true);
          const a = await post({
            action: 'hold',
            sendId: sendId.trim(),
            holdKey: key,
            reason: reason.trim(),
            ...(info.trim() ? { infoRequest: info.trim() } : {}),
          });
          setBusy(false);
          if (a.ok) {
            setAnswer({ tone: 'ok', text: 'The hold is stored.' });
            setSendId('');
            setReason('');
            setInfo('');
            setKey(newHoldKey());
            router.refresh();
          } else setAnswer({ tone: 'warn', text: sentence(a) });
        }}
      >
        Place hold
      </button>
      <Result answer={answer} />
    </section>
  );
}
