'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatAsOf } from '@/lib/as-of';
import { parseReasonCodeLines } from '@/lib/protocol-listing/model';
import '../desk.css';

const SOURCE_WORDS = {
  default: 'the built-in default',
  env: 'this deployment’s setting',
  admin: 'an admin edit',
} as const;

interface Props {
  readonly source: keyof typeof SOURCE_WORDS;
  readonly codes: readonly string[];
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

/** The reasons a hide or delist may name, where the list in force comes from, and a box to replace it. Every edit is logged by svc-ops. */
export function ReasonCodeList({ source, codes, updatedAt, updatedBy }: Props) {
  const router = useRouter();
  const [text, setText] = useState(codes.join('\n'));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const read = parseReasonCodeLines(text);
  return (
    <section className="dk-stack" aria-label="Reason codes" data-testid="reason-codes">
      <h3>Reason codes</h3>
      <p className="dk-muted" data-testid="reason-codes-source">
        A hide or delist must name one of these. In force now: {SOURCE_WORDS[source]}
        {updatedBy && updatedAt ? `, changed by ${updatedBy} at ${formatAsOf(updatedAt)}` : ''}. An edit replaces the whole list and is
        logged with who made it.
      </p>
      <form
        className="dk-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!read.ok || busy) return;
          setBusy(true);
          let answer: { ok: boolean; message?: string } = { ok: false };
          try {
            const res = await fetch('/api/protocol-ops/reason-codes', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ codes: read.codes }),
            });
            answer = (await res.json()) as typeof answer;
          } catch {
            answer = { ok: false, message: 'The answer was lost. Reload to see what is stored; nothing is repeated automatically.' };
          }
          setBusy(false);
          if (answer.ok) {
            setProblem(null);
            router.refresh();
          } else setProblem(answer.message ?? 'svc-ops refused this.');
        }}
      >
        <div className="adm-field">
          <label htmlFor="rc-codes">Reason codes, one per line</label>
          <textarea id="rc-codes" className="adm-textarea" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {!read.ok && (
          <p className="dk-muted" data-testid="reason-codes-hold">
            {read.problem}
          </p>
        )}
        <button type="submit" className="adm-btn" disabled={!read.ok || busy} data-testid="reason-codes-save">
          Replace the list
        </button>
        {problem && (
          <p role="alert" className="dk-muted" data-testid="reason-codes-refused">
            {problem}
          </p>
        )}
      </form>
    </section>
  );
}
