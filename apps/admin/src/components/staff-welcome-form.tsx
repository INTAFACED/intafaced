'use client';

import { useState } from 'react';
import { formatWhen } from '@/lib/as-of';

/** The invited person sets their own password. The password goes only to this console's own route, once. */
export function StaffWelcomeForm({ token, email, displayName, expiresAt }: { token: string; email: string; displayName: string; expiresAt: string }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const mismatch = again !== '' && again !== password;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || mismatch || password === '') return;
    setBusy(true);
    setRefusal(null);
    try {
      const res = await fetch('/api/staff-welcome', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
        credentials: 'same-origin',
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; code?: string; upstream?: string } | null;
      if (res.ok && body?.ok === true) {
        setDone(true);
      } else {
        setRefusal(body?.upstream ?? body?.code ?? `HTTP ${res.status}`);
      }
    } catch {
      setRefusal('admin.upstream_unavailable');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div role="status" data-testid="staff-welcome-done">
        <p>
          Your password is set, {displayName}. Your staff account for {email} is active. <a href="/login">Sign in to the console</a>.
        </p>
      </div>
    );
  }
  return (
    <form className="adm-stack" onSubmit={(e) => void submit(e)} data-testid="staff-welcome-form">
      <p>
        This invite is for <strong data-testid="staff-welcome-name">{displayName}</strong> (<span data-testid="staff-welcome-email">{email}</span>). It
        works until {formatWhen(expiresAt)}, once.
      </p>
      <div className="adm-field">
        <label htmlFor="sw-password">Your new password</label>
        <input id="sw-password" className="adm-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="adm-field">
        <label htmlFor="sw-again">The same password again</label>
        <input id="sw-again" className="adm-input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <p className="dk-why">The two passwords are not the same.</p>}
      </div>
      <button type="submit" className="adm-btn" data-tone="primary" disabled={busy || mismatch || password === '' || again === ''}>
        {busy ? 'Setting…' : 'Set my password'}
      </button>
      {refusal && (
        <p role="alert" data-testid="staff-welcome-refusal">
          Your password was not set. Code: {refusal}
        </p>
      )}
    </form>
  );
}
