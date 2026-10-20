'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { COMPLIANCE_ENTITY_TYPES } from '@intafaced/contracts';
import { refusalWords } from '@/lib/compliance-cases/model';
import '../desk.css';

interface ApiAnswer {
  readonly ok: boolean;
  readonly code?: string | null;
  readonly message?: string;
  readonly unknown?: boolean;
}

async function post(body: Record<string, unknown>): Promise<ApiAnswer> {
  try {
    const res = await fetch('/api/compliance/cases', {
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

export function FavouriteButton({ inboxId, favourite }: { inboxId: string; favourite: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <span>
      <button
        type="button"
        className="adm-btn"
        aria-pressed={favourite}
        aria-label={favourite ? 'Remove from favourites' : 'Make this the favourite inbox'}
        data-testid="favourite-toggle"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const a = await post({ action: 'favourite', inboxId, favourite: !favourite });
          setBusy(false);
          if (a.ok) {
            setProblem(null);
            router.refresh();
          } else setProblem(sentence(a));
        }}
      >
        {favourite ? '★' : '☆'}
      </button>
      {problem && (
        <span role="alert" className="dk-muted" data-testid="favourite-refused">
          {problem}
        </span>
      )}
    </span>
  );
}

/** Define a queue. The name and version are the business key: sending the same pair again returns the stored queue. */
export function DefineQueue() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1');
  const [entityType, setEntityType] = useState<string>(COMPLIANCE_ENTITY_TYPES[0]);
  const [workflow, setWorkflow] = useState('standard');
  const [members, setMembers] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const ready = name.trim() !== '' && /^[1-9]\d{0,3}$/.test(version) && workflow.trim() !== '';
  return (
    <section className="dk-stack" aria-label="Define a queue" data-testid="define-queue">
      <h3>Define a queue</h3>
      <p className="dk-muted">
        A queue is an inbox with its own subject type and member list. Sending the same name and version again returns the stored queue.
      </p>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="dq-name">Name</label>
          <input id="dq-name" className="adm-input" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="dq-version">Version</label>
          <input id="dq-version" className="adm-input" inputMode="numeric" value={version} onChange={(e) => setVersion(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="dq-entity">Subject type</label>
          <select id="dq-entity" className="adm-input" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            {COMPLIANCE_ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="dq-workflow">Workflow</label>
          <input id="dq-workflow" className="adm-input" autoComplete="off" value={workflow} onChange={(e) => setWorkflow(e.target.value)} />
        </div>
      </div>
      <div className="adm-field">
        <label htmlFor="dq-members">Other members (operator ids, comma separated; you own the queue)</label>
        <input id="dq-members" className="adm-input" autoComplete="off" value={members} onChange={(e) => setMembers(e.target.value)} />
      </div>
      <button
        type="button"
        className="adm-btn"
        disabled={!ready || busy}
        data-testid="define-submit"
        onClick={async () => {
          setBusy(true);
          const a = await post({
            action: 'define',
            name: name.trim(),
            version: Number(version),
            entityType,
            workflow: workflow.trim(),
            members: members
              .split(',')
              .map((m) => m.trim())
              .filter(Boolean),
          });
          setBusy(false);
          if (a.ok) {
            setAnswer({ tone: 'ok', text: `Queue "${name.trim()}" version ${version} is stored.` });
            router.refresh();
          } else setAnswer({ tone: 'warn', text: sentence(a) });
        }}
      >
        Define queue
      </button>
      {answer && (
        <div className="adm-callout" data-tone={answer.tone === 'ok' ? 'ok' : 'warn'} role="status" data-testid="define-answer">
          {answer.text}
        </div>
      )}
    </section>
  );
}
