'use client';

import { useCallback, useRef, useState } from 'react';
import { formatAsOf } from '@/lib/as-of';
import type { Part } from '@/lib/desk/part';
import type { StepReply } from '@/lib/desk/approval-types';
import { SERVICE } from '@/lib/system-staff/model';
import '../desk.css';

/** The founder System pages, linked from the founder operations bar's "System" entry. */
const SYSTEM_PAGES = [
  { href: '/system/users', label: 'Staff and founders' },
  { href: '/system/roles', label: 'Roles' },
  { href: '/system/settings', label: 'Platform settings' },
  { href: '/system/profile', label: 'Profile' },
] as const;

export function SystemNav({ current }: { current: string }) {
  return (
    <nav className="dk-row" aria-label="System pages" data-testid="system-nav">
      {SYSTEM_PAGES.map((page) => (
        <a key={page.href} href={page.href} className="adm-btn" aria-current={current === page.href ? 'page' : undefined}>
          {page.label}
        </a>
      ))}
    </nav>
  );
}

/** A part that did not read: the refusal in words, the owning service and the code. Never an empty table. */
export function PartRefusal({ part, what }: { part: Extract<Part<unknown>, { kind: 'failed' }>; what: string }) {
  return (
    <div className="adm-callout" data-tone={part.notBuilt ? 'warn' : 'danger'} role="status" data-testid="staff-refusal">
      <strong>{part.notBuilt ? `${what}: ${SERVICE} has no staff roster yet` : `${what} unavailable`}</strong>
      <p>{part.message}</p>
      <p className="dk-muted">
        Owning service: {SERVICE}.{part.code ? ` Code: ${part.code}` : ''} Nothing is shown rather than a guess.
      </p>
    </div>
  );
}

/** The read bar: refresh and when svc-identity was read. */
export function ReadBar({ asOf, loading, onRefresh }: { asOf: string | null; loading: boolean; onRefresh: () => void }) {
  return (
    <div className="dk-row">
      <button type="button" className="adm-btn" onClick={onRefresh} disabled={loading} data-testid="staff-refresh">
        {loading ? 'Reading…' : 'Refresh'}
      </button>
      <span className="dk-asof" data-testid="staff-asof">
        {loading ? `Reading ${SERVICE}…` : asOf ? `As of ${formatAsOf(asOf)} (when this console read ${SERVICE})` : 'No read yet'}
      </span>
    </div>
  );
}

/** The whole page could not be read again (the console's own route did not answer in a shape it reads). */
export function ReadFailed() {
  return (
    <div className="adm-callout" data-tone="danger" role="status" data-testid="staff-read-failed">
      <strong>{SERVICE} could not be read</strong>
      <p>The console did not get an answer it could read. Nothing is shown rather than a guess.</p>
      <p className="dk-muted">Owning service: {SERVICE}. Press Refresh to read again.</p>
    </div>
  );
}

/** After a step whose reply was lost: the page has read the stored state again, and a re-run reuses the same request id. */
export function RecoveryNote({ asOf }: { asOf: string | null }) {
  return (
    <div className="adm-callout" data-tone="warn" role="status" data-testid="staff-recovery">
      <strong>The last reply was lost, so this page read {SERVICE} again</strong>
      <p>
        What is shown {asOf ? `(as of ${formatAsOf(asOf)}) ` : ''}is what {SERVICE} stores, not what this console guessed. If the change is
        not there, run the same packet again: it carries the same request id, so {SERVICE} answers with what it stored and never makes a
        second change. Do not make a new request for the same change.
      </p>
    </div>
  );
}

/**
 * A page's view, re-read after every step. `onStepReply` notes a reply whose outcome is unknown, so the page shows the
 * recovery note over the re-read state.
 */
export function useReread<T extends { asOf: string }>(initial: T | null, fetcher: () => Promise<T | null>) {
  const [view, setView] = useState<T | null>(initial);
  const [loading, setLoading] = useState(false);
  const [lostReply, setLostReply] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await fetcher();
    if (mine === sequence.current) {
      setView(next);
      setLoading(false);
    }
  }, [fetcher]);
  const onStepReply = useCallback((reply: StepReply) => {
    setLostReply(!reply.ok && reply.refusal.changed === 'unknown');
  }, []);
  return { view, loading, lostReply, reload: () => void reload(), onStepReply };
}
