'use client';
import { useRef, useState } from 'react';
import { browserDraftStorage, keptEnquiryId } from '@/lib/crm-drafts';
import { signInReturnTarget } from '@/lib/crm-return';
import { firstLoginError, loginFieldErrors, type LoginFieldErrors } from '@/lib/crm-login';
import { submitProps } from '@/lib/crm-form-state';
import { Callout } from './crm-callout';
import { signInChallengeSchema } from '@intafaced/contracts/identity-signin-challenge';
import { solveSignInChallenge } from '@/lib/signin-challenge-browser';
import { FounderDeviceApproval, postSession, SessionRefusal, type DeviceAuthorisation } from './founder-device-approval';

/** After signing in: the page the sign-in link asked for (only a /crm path), else the enquiry whose edits this tab kept for the founder who just signed in, else /crm. */
function returnTarget(session: unknown): string {
  const userId =
    session && typeof session === 'object' && 'userId' in session && typeof session.userId === 'string' ? session.userId : null;
  return signInReturnTarget(window.location.search, keptEnquiryId(browserDraftStorage(), userId));
}

function decode(value: string): ArrayBuffer {
  const text = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, (letter) => letter.charCodeAt(0)).buffer;
}
function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function FounderLogin() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  // Tries so far while this browser solves a sign-in check; null when none is running.
  const [challengeTries, setChallengeTries] = useState<number | null>(null);
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<DeviceAuthorisation | null>(null);
  const fields = {
    identifier: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    totpCode: useRef<HTMLInputElement>(null),
  };
  const fieldProps = (name: keyof LoginFieldErrors) => ({
    ref: fields[name],
    'aria-invalid': fieldErrors[name] ? (true as const) : undefined,
    'aria-describedby': fieldErrors[name] ? `login-${name}-error` : undefined,
  });
  const clearFieldError = (name: keyof LoginFieldErrors) =>
    setFieldErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
  const fieldError = (name: keyof LoginFieldErrors) =>
    fieldErrors[name] ? (
      <small id={`login-${name}-error`} className="adm-field-error">
        {fieldErrors[name]}
      </small>
    ) : null;
  if (waiting)
    return (
      <FounderDeviceApproval
        waiting={waiting}
        onSignedIn={(session) => window.location.assign(returnTarget(session))}
        onStartOver={() => setWaiting(null)}
      />
    );
  return (
    <form
      className="adm-form"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        // The browser's own "Please fill out this field" bubbles are off (noValidate); each gap is explained under its field.
        const problems = loginFieldErrors({ identifier, password, totpCode });
        setFieldErrors(problems);
        const first = firstLoginError(problems);
        if (first) {
          setError('');
          fields[first].current?.focus();
          return;
        }
        setBusy(true);
        setError('');
        try {
          const input = { identifier, password, totpCode };
          let session: unknown;
          try {
            session = await postSession('/api/session', input);
          } catch (first) {
            // Too many failed sign-ins came from this console's address: this browser solves identity's check, then the
            // same sign-in goes once more (I-signin-sessions-30).
            if (!(first instanceof SessionRefusal && first.upstream === 'auth.challenge_required')) throw first;
            setChallengeTries(0);
            const challenge = signInChallengeSchema.parse(await postSession('/api/session/challenge', {}));
            const proof = await solveSignInChallenge(challenge, setChallengeTries);
            session = await postSession('/api/session', { ...input, challenge: proof });
          }
          window.location.assign(returnTarget(session));
        } catch (failure) {
          // The right password and code on a browser identity has not seen: approve this browser first.
          if (failure instanceof SessionRefusal && failure.deviceAuthorisation) {
            setWaiting(failure.deviceAuthorisation);
            return;
          }
          setError(failure instanceof Error ? failure.message : 'Sign-in failed.');
        } finally {
          setPassword('');
          setTotpCode('');
          setChallengeTries(null);
          setBusy(false);
        }
      }}
    >
      <div className="adm-login-field">
        <label>
          Email or handle
          <input
            {...fieldProps('identifier')}
            autoComplete="username"
            required
            value={identifier}
            onChange={(event) => {
              setIdentifier(event.target.value);
              clearFieldError('identifier');
            }}
            maxLength={254}
          />
        </label>
        {fieldError('identifier')}
      </div>
      <div className="adm-login-field">
        <label>
          Password
          <input
            {...fieldProps('password')}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              clearFieldError('password');
            }}
            maxLength={1024}
          />
        </label>
        {fieldError('password')}
      </div>
      <div className="adm-login-field">
        <label>
          Authenticator or recovery code
          <input
            {...fieldProps('totpCode')}
            autoComplete="one-time-code"
            required
            value={totpCode}
            onChange={(event) => {
              setTotpCode(event.target.value);
              clearFieldError('totpCode');
            }}
            maxLength={11}
          />
        </label>
        {fieldError('totpCode')}
      </div>
      {challengeTries !== null && (
        <p role="status" aria-live="polite" data-testid="signin-challenge">
          {challengeTries === 0
            ? 'Checking this browser before signing you in.'
            : `Checking this browser before signing you in: ${challengeTries} tries so far.`}
        </p>
      )}
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
      <button type="submit" {...submitProps({ disabled: busy, changed: Boolean(identifier.trim() || password || totpCode.trim()) })}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <button
        type="button"
        disabled={busy || !identifier.trim()}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            if (!navigator.credentials) throw new Error('Passkeys are unavailable in this browser.');
            const raw = (await postSession('/api/session/passkey', { action: 'options', identifier })) as {
              challenge: string;
              allowCredentials?: Array<{ id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }>;
              rpId?: string;
              timeout?: number;
              userVerification?: UserVerificationRequirement;
            };
            if (typeof raw.challenge !== 'string') throw new Error('Passkey challenge unavailable.');
            const credential = (await navigator.credentials.get({
              publicKey: {
                ...raw,
                challenge: decode(raw.challenge),
                allowCredentials: raw.allowCredentials?.map((item) => ({ ...item, id: decode(item.id) })),
              },
            })) as PublicKeyCredential | null;
            if (!credential) throw new Error('Passkey sign-in was cancelled.');
            const response = credential.response as AuthenticatorAssertionResponse;
            const session = await postSession('/api/session/passkey', {
              action: 'authenticate',
              identifier,
              credential: {
                id: credential.id,
                rawId: encode(credential.rawId),
                type: credential.type,
                response: {
                  clientDataJSON: encode(response.clientDataJSON),
                  authenticatorData: encode(response.authenticatorData),
                  signature: encode(response.signature),
                  userHandle: response.userHandle ? encode(response.userHandle) : null,
                },
                clientExtensionResults: credential.getClientExtensionResults(),
              },
            });
            window.location.assign(returnTarget(session));
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Passkey sign-in failed.');
          } finally {
            setBusy(false);
          }
        }}
      >
        Sign in with a passkey
      </button>
    </form>
  );
}
