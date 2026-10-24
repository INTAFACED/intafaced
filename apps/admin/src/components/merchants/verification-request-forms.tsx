'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { StateBlock } from '@/components/merchants/ui';
import { sendKybRequest, type KybReply } from '@/lib/merchants/kyb-review-client';
import { KYB_CLOSE_NOTE_MAX, KYB_REASON_MIN, KYB_REQUEST_TEXT_MAX, reasonLength } from '@/lib/merchants/kyb-review-model';

type Problem = Extract<KybReply<unknown>, { ok: false }>;

function tooShortOrLong(text: string, max: number, what: string): string | null {
  const n = reasonLength(text.trim());
  if (n < KYB_REASON_MIN) return `Write ${what} first.`;
  if (n > max) return `${what[0]!.toUpperCase()}${what.slice(1)} is too long (at most ${max} characters).`;
  return null;
}

/** Ask the merchant for more, with a due date. The merchant reads the words as written. */
export function NewInformationRequest({ merchantId }: { merchantId: string }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const dueAt = due ? new Date(due) : null;
  const why =
    tooShortOrLong(text, KYB_REQUEST_TEXT_MAX, 'what the merchant should send') ??
    (!dueAt || Number.isNaN(dueAt.getTime()) ? 'Pick the due date and time first.' : null);
  async function send() {
    if (!dueAt) return;
    setBusy(true);
    setProblem(null);
    const reply = await sendKybRequest({ action: 'create', merchantId, text: text.trim(), dueAt: dueAt.toISOString() });
    setBusy(false);
    if (!reply.ok) return setProblem(reply);
    setText('');
    setDue('');
    router.refresh();
  }
  return (
    <div className="mp-form" aria-label="New information request" role="group">
      <div className="mp-field">
        <label htmlFor="kyb-request-text">What the merchant should send (they read it as written)</label>
        <textarea
          id="kyb-request-text"
          className="mp-input"
          rows={3}
          maxLength={KYB_REQUEST_TEXT_MAX + 1}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="mp-field">
        <label htmlFor="kyb-request-due">Due by (your local time)</label>
        <input id="kyb-request-due" className="mp-input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      <span title={why ?? undefined}>
        <button type="button" className="mp-btn mp-btn--primary" disabled={busy || why !== null} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send request'}
        </button>
      </span>
      {problem ? (
        <StateBlock kind="error" title={problem.title}>
          {problem.body} {problem.next}
        </StateBlock>
      ) : null}
    </div>
  );
}

/** Close an open or answered request. The merchant reads the note and who closed it. */
export function CloseInformationRequest({ requestId, label }: { requestId: string; label: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const why = tooShortOrLong(note, KYB_CLOSE_NOTE_MAX, 'the note the merchant will read');
  async function close() {
    setBusy(true);
    setProblem(null);
    const reply = await sendKybRequest({ action: 'close', requestId, note: note.trim() });
    setBusy(false);
    if (reply.ok) router.refresh();
    else setProblem(reply);
  }
  const noteId = `kyb-close-${requestId}`;
  return (
    <div className="mp-form">
      <div className="mp-field">
        <label htmlFor={noteId}>Closing note (the merchant reads it)</label>
        <textarea
          id={noteId}
          className="mp-input"
          rows={2}
          maxLength={KYB_CLOSE_NOTE_MAX + 1}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <span title={why ?? undefined}>
        <button type="button" className="mp-btn" disabled={busy || why !== null} onClick={() => void close()} aria-label={label}>
          {busy ? 'Closing…' : 'Close request'}
        </button>
      </span>
      {problem ? (
        <StateBlock kind="error" title={problem.title}>
          {problem.body} {problem.next}
        </StateBlock>
      ) : null}
    </div>
  );
}
