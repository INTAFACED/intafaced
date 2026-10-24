'use client';
import { useState } from 'react';
import { Callout } from './crm-callout';

/** A sign-in identity holds until this browser is approved (identity's new-device check, I-signin-sessions-07). */
export interface DeviceAuthorisation {
  flowId: string;
  secret: string;
  expiresAt: string;
  mailed: boolean;
}

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
  'auth.too_many_attempts': 'Too many wrong codes. Start over to sign in again.',
  'auth.code_expired': 'That code has expired. Start over to get a new one.',
  'auth.device_authorisation_pending':
    'This browser is still waiting for approval. Enter the emailed code, or approve it from a founder session on a trusted device.',
  'auth.device_authorisation_used': 'That approval was already used. Start over to sign in again.',
  'auth.device_authorisation_invalid': 'That sign-in request is no longer valid. Start over to sign in again.',
  'auth.account_frozen': 'This account is frozen, so it cannot sign in.',
};

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
      if (approve) await postSession('/api/session/device', { action: 'approve', ...flow, code: code.trim() });
      onSignedIn(await postSession('/api/session/device', { action: 'complete', ...flow }));
    } catch (failure) {
      const upstream = failure instanceof SessionRefusal ? failure.upstream : undefined;
      if (upstream === 'auth.too_many_attempts' || upstream === 'auth.code_expired' || upstream === 'auth.device_authorisation_used')
        setLocked(true);
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
