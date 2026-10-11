'use client';
import { useState } from 'react';
import { founderName, useFounderOwners } from './founder-names';

export function FounderSessionBar({ csrf, userId, expiresAt }: { csrf: string; userId: string; expiresAt: string }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const owners = useFounderOwners();
  return (
    <div className="adm-session">
      <span title={userId}>{founderName(owners, userId)}</span>
      <small>Session expires {new Date(expiresAt).toISOString().slice(11, 16)} UTC</small>
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
