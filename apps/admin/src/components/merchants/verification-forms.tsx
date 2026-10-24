'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { StateBlock } from '@/components/merchants/ui';
import { openKybDocument, reviewKybDocument, type KybReply } from '@/lib/merchants/kyb-review-client';
import { KYB_REASON_MAX, KYB_REASON_MIN } from '@/lib/merchants/kyb-review-model';

type Problem = Extract<KybReply<unknown>, { ok: false }>;

const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Opens the file in a new tab from its bytes. Each open is recorded by svc-pay with the founder who opened it. */
export function OpenDocument({ applicationId, documentId, name }: { applicationId: string; documentId: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  async function open() {
    setBusy(true);
    setProblem(null);
    const reply = await openKybDocument({ applicationId, documentId });
    setBusy(false);
    if (!reply.ok) return setProblem(reply);
    const bytes = Uint8Array.from(atob(reply.data.bytesBase64), (c) => c.charCodeAt(0));
    const type = reply.data.contentType.toLowerCase();
    // A blob URL runs with this console's origin, so only kinds that cannot carry script open in a tab; any other kind
    // the owner accepts (HTML, SVG…) is saved as a download and never rendered here.
    const inline = INLINE_TYPES.has(type);
    const url = URL.createObjectURL(new Blob([bytes], { type: inline ? type : 'application/octet-stream' }));
    if (inline) window.open(url, '_blank', 'noopener');
    else {
      const link = document.createElement('a');
      link.href = url;
      link.download = `${reply.data.key}-${reply.data.sha256.slice(0, 12)}`;
      link.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return (
    <>
      <button type="button" className="mp-btn" disabled={busy} onClick={() => void open()} aria-label={`Open the file for ${name}`}>
        {busy ? 'Opening…' : 'Open file'}
      </button>
      {problem ? (
        <StateBlock kind="error" title={problem.title}>
          {problem.body} {problem.next}
        </StateBlock>
      ) : null}
    </>
  );
}

/** One verdict on a waiting file. Invalid needs the reason the merchant will read. */
export function DocumentVerdict({ applicationId, documentId, name }: { applicationId: string; documentId: string; name: string }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const trimmed = reason.trim();
  const rejectWhy =
    trimmed.length < KYB_REASON_MIN
      ? 'Write the reason the merchant will read first.'
      : trimmed.length > KYB_REASON_MAX
        ? `The reason is too long (at most ${KYB_REASON_MAX} characters).`
        : null;
  async function give(verdict: 'accepted' | 'rejected') {
    setBusy(true);
    setProblem(null);
    const reply = await reviewKybDocument({ applicationId, documentId, verdict, ...(verdict === 'rejected' ? { reason: trimmed } : {}) });
    setBusy(false);
    if (reply.ok) router.refresh();
    else setProblem(reply);
  }
  const reasonId = `kyb-reason-${documentId}`;
  return (
    <div className="mp-form">
      <button
        type="button"
        className="mp-btn mp-btn--primary"
        disabled={busy}
        onClick={() => void give('accepted')}
        aria-label={`Mark ${name} Verified`}
      >
        Verified
      </button>
      <div className="mp-field">
        <label htmlFor={reasonId}>Reason, if Invalid (the merchant reads it)</label>
        <textarea
          id={reasonId}
          className="mp-input"
          rows={2}
          maxLength={KYB_REASON_MAX + 1}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <span title={rejectWhy ?? undefined}>
        <button
          type="button"
          className="mp-btn"
          disabled={busy || rejectWhy !== null}
          onClick={() => void give('rejected')}
          aria-label={`Mark ${name} Invalid`}
        >
          Invalid
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
