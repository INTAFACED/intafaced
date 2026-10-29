'use client';
import { useState } from 'react';
import type { DeviceAuthorisation } from '@/lib/founder-session';
import { Callout } from './crm-callout';

export type { DeviceAuthorisation };

/** A refusal from the console's own session routes, with identity's typed code when it sent one. */
export class SessionRefusal extends Error {
  constructor(
    message: string,
    readonly upstream?: string,
    readonly deviceAuthorisation?: DeviceAuthorisation,
  ) {
    super(message);
  }
}

const REFUSALS: Record<string, string> = {
  'auth.code_invalid': 'That code is not right. Check the latest email and try again.',
  // Sign-in and the emailed device code both answer this, so it names neither.
  'auth.too_many_attempts': 'Too many wrong attempts. Wait, then start over to sign in again.',
  'auth.code_expired': 'That code has expired. Start over to get a new one.',
  'auth.device_authorisation_pending':
    'This browser is still waiting for approval. Enter the emailed code, or approve it from a founder session on a trusted device.',
  'auth.device_authorisation_used': 'That approval was already used. Start over to sign in again.',
  'auth.device_authorisation_invalid': 'That sign-in request is no longer valid. Start over to sign in again.',
  'auth.account_frozen': 'This account is frozen, so it cannot sign in.',
};

/** Refusals after which this request can never sign in: only Start over helps. */
const TERMINAL = new Set([
  'auth.too_many_attempts',
  'auth.code_expired',
  'auth.device_authorisation_used',
  'auth.device_authorisation_invalid',
  'auth.account_frozen',
]);

function deviceAuthorisationOf(data: unknown): DeviceAuthorisation | undefined {
  const d =
    data && typeof data === 'object' && 'deviceAuthorisation' in data ? (data.deviceAuthorisation as Record<string, unknown>) : null;
  if (
    !d ||
    typeof d.flowId !== 'string' ||
    typeof d.secret !== 'string' ||
    typeof d.expiresAt !== 'string' ||
    typeof d.mailed !== 'boolean'
  )
    return undefined;
  return { flowId: d.flowId, secret: d.secret, expiresAt: d.expiresAt, mailed: d.mailed };
}

export async function postSession(path: string, input: unknown): Promise<unknown> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const data: unknown = await response.json();
  if (!response.ok) {
    const code = data && typeof data === 'object' && 'code' in data ? String(data.code) : '';
    const upstream = data && typeof data === 'object' && 'upstream' in data ? String(data.upstream) : undefined;
    throw new SessionRefusal(
      code.includes('unconfigured')
        ? 'The founder workspace is awaiting deployment configuration.'
        : ((upstream && REFUSALS[upstream]) ?? 'Sign-in was refused. Check your credentials and second factor.'),
      upstream,
      deviceAuthorisationOf(data),
    );
  }
  return data;
}

/**
 * The step after the right password and second factor on a browser identity has not seen: the code mailed to the
 * founder's address approves it, or a founder session on a trusted device does (then Continue). Either way the sign-in
 * finishes on this browser, which identity then trusts.
 */
export function FounderDeviceApproval({
  waiting,
  onSignedIn,
  onStartOver,
}: {
  waiting: DeviceAuthorisation;
  onSignedIn: (session: unknown) => void;
  onStartOver: () => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const flow = { flowId: waiting.flowId, secret: waiting.secret };
  const run = async (approve: boolean) => {
    setBusy(true);
    setError('');
    try {
      // The emailed code approves and signs in at once; Continue picks up an approval made from a trusted session.
      onSignedIn(
        await postSession(
          '/api/session/device',
          approve ? { action: 'approve', ...flow, code: code.trim() } : { action: 'complete', ...flow },
        ),
      );
    } catch (failure) {
      const upstream = failure instanceof SessionRefusal ? failure.upstream : undefined;
      if (upstream && TERMINAL.has(upstream)) setLocked(true);
      setError(failure instanceof Error ? failure.message : 'Approval failed.');
    } finally {
      setCode('');
      setBusy(false);
    }
  };
  return (
    <section className="adm-form" aria-labelledby="founder-device-heading">
      <h2 id="founder-device-heading">Authorise this browser</h2>
      <p>
        {waiting.mailed
          ? 'This browser has not signed in to this account before. We emailed a 6-digit code to the founder address; enter it to approve this browser.'
          : 'This browser has not signed in to this account before. Approve it from a founder session on a trusted device, then press Continue.'}{' '}
        The request ends at {new Date(waiting.expiresAt).toLocaleTimeString()}.
      </p>
      {!locked && waiting.mailed && (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!/^\d{6}$/.test(code.trim())) {
              setError('Enter the 6-digit code from the email.');
              return;
            }
            void run(true);
          }}
        >
          <div className="adm-login-field">
            <label>
              Device code from the email
              <input
                autoComplete="one-time-code"
                inputMode="numeric"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                maxLength={6}
              />
            </label>
          </div>
          <button type="submit" disabled={busy}>
            {busy ? 'Approving…' : 'Approve this browser'}
          </button>
        </form>
      )}
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
      {!locked && (
        <button type="button" disabled={busy} onClick={() => void run(false)}>
          Continue
        </button>
      )}
      <button type="button" disabled={busy} onClick={onStartOver}>
        Start over
      </button>
    </section>
  );
}
