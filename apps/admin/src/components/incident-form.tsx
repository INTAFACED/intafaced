'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { postConsoleChange, type ConsoleChangeReply } from '@/lib/console-announcements/browser';
import './desk.css';

export interface IncidentField {
  readonly name: string;
  readonly label: string;
  readonly kind: 'text' | 'textarea' | 'select' | 'checkbox';
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

/** A fresh business key for one change; kept until the change is known to be done, so a retry is the same request. */
const newKey = (action: string) => `console:incident:${action}:${crypto.randomUUID()}`;

/**
 * One incident change (declare, note, invite, task, resolve) through the console's incident route. The request key stays the
 * same until svc-ops answers that the change was made or refused, so pressing again after a lost reply sends the same request
 * and svc-ops reads it back instead of applying it twice. After every answer the page reads again.
 */
export function IncidentForm({
  action,
  fields,
  fixed = {},
  submit,
  testId,
  onDeclared,
}: {
  action: 'declare' | 'note' | 'invite' | 'task' | 'resolve';
  fields: readonly IncidentField[];
  fixed?: Readonly<Record<string, string>>;
  submit: string;
  testId: string;
  /** Declare only: open the new incident's page. */
  onDeclared?: boolean;
}) {
  const router = useRouter();
  const [key, setKey] = useState(() => newKey(action));
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [reply, setReply] = useState<ConsoleChangeReply | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    const body: Record<string, unknown> = { action, requestKey: key, ...fixed };
    for (const f of fields) {
      const v = values[f.name];
      if (f.kind === 'checkbox') body[f.name] = v === true;
      else if (typeof v === 'string' && v.trim() !== '') body[f.name] = v.trim();
    }
    const r = await postConsoleChange('/api/incidents', body);
    setReply(r);
    setBusy(false);
    if (r.ok || r.changed === 'no') setKey(newKey(action));
    if (r.ok) setValues({});
    const id = r.ok ? (r.answer.detail as { incident?: { id?: string } } | undefined)?.incident?.id : undefined;
    if (onDeclared && typeof id === 'string') router.push(`/incidents/${id}`);
    else router.refresh();
  }

  return (
    <form
      className="dk-stack"
      data-testid={testId}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {fields.map((f) => (
        <label key={f.name} className="dk-stack">
          {f.kind !== 'checkbox' && <span>{f.label}</span>}
          {f.kind === 'text' && (
            <input
              className="adm-input"
              name={f.name}
              aria-label={f.label}
              value={String(values[f.name] ?? '')}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          )}
          {f.kind === 'textarea' && (
            <textarea
              className="adm-input"
              name={f.name}
              aria-label={f.label}
              value={String(values[f.name] ?? '')}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          )}
          {f.kind === 'select' && (
            <select
              className="adm-input"
              name={f.name}
              aria-label={f.label}
              value={String(values[f.name] ?? '')}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            >
              {(f.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {f.kind === 'checkbox' && (
            <span>
              <input
                type="checkbox"
                name={f.name}
                aria-label={f.label}
                checked={values[f.name] === true}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })}
              />{' '}
              {f.label}
            </span>
          )}
        </label>
      ))}
      <div className="dk-row">
        <button type="submit" className="adm-btn" disabled={busy}>
          {submit}
        </button>
      </div>
      {reply && (
        <p
          className="dk-why"
          role={reply.ok ? 'status' : 'alert'}
          data-testid="incident-outcome"
          data-code={reply.ok ? 'ok' : (reply.code ?? '')}
          data-changed={reply.ok ? 'yes' : reply.changed}
        >
          {reply.ok ? 'Done. The page shows what svc-ops stored.' : `${reply.title}. ${reply.body} ${reply.next}`}
          {!reply.ok && reply.code ? ` (${reply.code})` : ''}
        </p>
      )}
    </form>
  );
}
