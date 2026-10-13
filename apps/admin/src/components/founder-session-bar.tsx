'use client';
import { useEffect, useState } from 'react';
import { crmTime } from '@/lib/crm-browser';
import { browserDraftStorage, clearAllDrafts, keptEnquiryId } from '@/lib/crm-drafts';
import { enquiryIdFromSearch, signInHref } from '@/lib/crm-return';
import { founderName, useFounderOwners } from './founder-names';

const WARN_MS = 10 * 60_000;
/** What the bar says about the session clock. `now` is null until the browser has mounted, so server and browser markup match. */
export function sessionStatus(expiresAt: string, now: number | null): { text: string; warning: boolean; expired?: boolean } | null {
  if (now === null) return null;
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return { text: 'Session ended: sign in again', warning: true, expired: true };
  if (left <= WARN_MS) return { text: `Session ends in ${Math.max(1, Math.ceil(left / 60_000))} min — save your work`, warning: true };
  return { text: `Session ends ${crmTime(expiresAt)}`, warning: false };
}

export function FounderSessionBar({ csrf, userId, expiresAt }: { csrf: string; userId: string; expiresAt: string }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const owners = useFounderOwners();
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, []);
  const status = sessionStatus(expiresAt, now);
  return (
    <div className="adm-session">
      <span title={userId}>{founderName(owners, userId)}</span>
      {status && (
        <small className={status.warning ? 'adm-session-note is-warning' : 'adm-session-note'} role={status.warning ? 'status' : undefined}>
          {status.expired ? (
            <a href={signInHref(enquiryIdFromSearch(window.location.search) ?? keptEnquiryId(browserDraftStorage()))}>{status.text}</a>
          ) : (
            status.text
          )}
        </small>
      )}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const response = await fetch('/api/session', { method: 'DELETE', headers: { 'x-intafaced-csrf': csrf } });
            if (!response.ok) {
              setMessage('Sign-out could not be confirmed. Try again.');
              return;
            }
            // Signed out on purpose: nothing typed in this tab is kept for the next person.
            clearAllDrafts(browserDraftStorage());
            window.location.assign('/login');
          } catch {
            setMessage('Connection unavailable. Try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        Sign out
      </button>
      {message && <span role="alert">{message}</span>}
    </div>
  );
}
