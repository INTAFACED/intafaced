'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { crmDate } from '@/lib/crm-browser';
import { submitProps } from '@/lib/crm-form-state';
import { qrModules, qrPath } from '@/lib/qr';
import { Callout } from './crm-callout';
import './founder-security.css';

/*
 * The founder Security page. Every secret here (passwords, the new authenticator secret, recovery codes, codes typed as a proof)
 * lives in React state only, never in localStorage, sessionStorage or the URL, and is cleared as soon as it has been used.
 */

export interface SecurityPasskey {
  id: string;
  name?: string;
  createdAt?: string;
}
export interface SecurityOverview {
  totpEnrolled: boolean;
  totpEnrolledAt: string | null;
  recoveryCodesRemaining: number;
  passkeys: SecurityPasskey[];
  passkeysAvailable: boolean;
  passwordChangedAt: string | null;
}

export type SecurityContext = 'load' | 'password' | 'proof' | 'confirm' | 'passkey' | 'remove';

/** A refusal or a lost connection. `code` is this server's code; `upstreamCode` is identity's own `auth.*` code. */
export class SecurityFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly upstreamCode?: string,
    public readonly status?: number,
  ) {
    super(code);
  }
}

/** Plain-English copy per refusal. Raw codes are never shown. */
export function securityErrorMessage(
  failure: { code: string; upstreamCode?: string | undefined; status?: number | undefined },
  context: SecurityContext,
): string {
  switch (failure.upstreamCode) {
    case 'auth.too_many_attempts':
      return 'Too many attempts. Wait a few minutes, then try again.';
    case 'auth.password_unchanged':
      return 'Choose a different password from your current one.';
    case 'auth.password_policy':
      return 'Use at least 12 characters for the new password.';
    case 'auth.mfa_required':
      return 'This needs a sign-in with your authenticator code or a passkey. Sign out, sign in that way, then try again.';
    case 'auth.invalid_credentials':
      return context === 'password' ? 'Your current password is wrong.' : "That code or passkey wasn't accepted. Check it and try again.";
    case 'auth.mfa_invalid':
      return "That code wasn't accepted. Wait for the next code in your app and try again.";
  }
  switch (failure.code) {
    case 'network':
    case 'admin.upstream_unavailable':
      return "Couldn't reach the server. Check your connection and try again.";
    case 'admin.session_unconfigured':
      return 'The founder workspace is awaiting deployment configuration.';
    case 'admin.session_required':
    case 'admin.session_csrf':
    case 'admin.session_origin':
      return 'Your session has ended. Sign in again.';
    case 'admin.founder_required':
      return "This account isn't a founder account any more.";
    case 'admin.proof_input':
      return 'Enter the 6-digit code from your authenticator app, or a recovery code like ABCDE-12345.';
    case 'admin.security_input':
    case 'admin.json_required':
      return 'Check what you entered and try again.';
  }
  if (context === 'load') return "Couldn't load your security settings. Try again.";
  if (context === 'remove') return "This passkey couldn't be removed. It may be your only way to sign in without a code.";
  if (context === 'password' || context === 'proof' || context === 'confirm')
    return failure.status === 400 || failure.status === 401 || failure.status === 403
      ? "That wasn't accepted. Check the details and try again."
      : 'Something went wrong. Try again.';
  return 'Something went wrong. Try again.';
}

/** What went wrong in the browser's own passkey prompt, in plain words. */
export function passkeyBrowserMessage(error: unknown): string | null {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError')
    return 'The passkey prompt was cancelled or timed out. Try again when you are ready.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  if (name === 'NotSupportedError' || name === 'SecurityError') return "This browser can't use a passkey here.";
  return null;
}

const CODE = /^(\d{6}|[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5})$/;
const PASSWORD_HELP = 'Use at least 12 characters.';

export function groupSecret(secret: string): string {
  return (secret.replace(/\s+/g, '').match(/.{1,4}/g) ?? []).join(' ');
}

export function recoveryCodesText(codes: readonly string[]): string {
  return [
    'INTAFACED founder recovery codes',
    '',
    'Each code works once. Keep this file somewhere other than your phone, such as a password manager.',
    'Nobody from INTAFACED will ever ask you for these codes.',
    '',
    ...codes,
    '',
  ].join('\n');
}

/** Checks a new password pair before anything is sent. Returns a message per field, or an empty object. */
export function passwordPairErrors(next: string, again: string): { next?: string; again?: string } {
  const errors: { next?: string; again?: string } = {};
  if (next.length < 12 || next.length > 200) errors.next = next.length > 200 ? 'Use 200 characters or fewer.' : PASSWORD_HELP;
  else if (again !== next) errors.again = "The two passwords don't match.";
  return errors;
}

const when = (value: string | null | undefined): string => {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  try {
    return crmDate(value);
  } catch {
    return '';
  }
};

/* ── talking to the server ─────────────────────────────────────────────────────────────────────────────────────── */

async function call(csrf: string, path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-intafaced-csrf': csrf } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new SecurityFailure('network');
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const row = (data && typeof data === 'object' ? data : {}) as { code?: unknown; upstreamCode?: unknown };
    throw new SecurityFailure(
      typeof row.code === 'string' ? row.code : 'unknown',
      typeof row.upstreamCode === 'string' ? row.upstreamCode : undefined,
      response.status,
    );
  }
  return data;
}

const toBuffer = (value: string): ArrayBuffer => {
  const text = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, (letter) => letter.charCodeAt(0)).buffer;
};
const toText = (value: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

type CredentialDescriptor = { id: string; type: 'public-key'; transports?: AuthenticatorTransport[] };
const descriptors = (list: CredentialDescriptor[] | undefined) => list?.map((item) => ({ ...item, id: toBuffer(item.id) }));

/** Asks the founder's passkey to sign a step-up challenge, and returns the proof to send with the action. */
async function passkeyProof(csrf: string): Promise<{ webauthn: unknown }> {
  if (!navigator.credentials) throw new SecurityFailure('passkeys_unavailable');
  const raw = (await call(csrf, '/api/security/step-up/options', 'POST')) as {
    challenge: string;
    allowCredentials?: CredentialDescriptor[];
  } & Record<string, unknown>;
  if (typeof raw.challenge !== 'string') throw new SecurityFailure('admin.upstream_invalid');
  const credential = (await navigator.credentials.get({
    publicKey: {
      ...raw,
      challenge: toBuffer(raw.challenge),
      allowCredentials: descriptors(raw.allowCredentials),
    } as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null;
  if (!credential) throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    webauthn: {
      id: credential.id,
      rawId: toText(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toText(response.clientDataJSON),
        authenticatorData: toText(response.authenticatorData),
        signature: toText(response.signature),
        userHandle: response.userHandle ? toText(response.userHandle) : null,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    },
  };
}

/** Adds a passkey to this account: a fresh proof for the options, the browser's prompt, then verify. */
async function registerPasskey(csrf: string, proof: unknown): Promise<void> {
  if (!navigator.credentials) throw new SecurityFailure('passkeys_unavailable');
  const raw = (await call(csrf, '/api/security/passkeys/options', 'POST', { proof })) as {
    challenge: string;
    user: { id: string; name: string; displayName: string };
    excludeCredentials?: CredentialDescriptor[];
  } & Record<string, unknown>;
  if (typeof raw.challenge !== 'string' || typeof raw.user?.id !== 'string') throw new SecurityFailure('admin.upstream_invalid');
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...raw,
      challenge: toBuffer(raw.challenge),
      user: { ...raw.user, id: toBuffer(raw.user.id) },
      excludeCredentials: descriptors(raw.excludeCredentials),
    } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!credential) throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
  const response = credential.response as AuthenticatorAttestationResponse;
  await call(csrf, '/api/security/passkeys/verify', 'POST', {
    id: credential.id,
    rawId: toText(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toText(response.clientDataJSON),
      attestationObject: toText(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  });
}

/* ── small shared pieces ───────────────────────────────────────────────────────────────────────────────────────── */

function messageFor(error: unknown, context: SecurityContext): string {
  if (error instanceof SecurityFailure) {
    if (error.code === 'passkeys_unavailable') return 'Passkeys are unavailable in this browser.';
    return securityErrorMessage(error, context);
  }
  return passkeyBrowserMessage(error) ?? 'Something went wrong. Try again.';
}

/** Runs one server action, tracking busy and error state. Never lets a failure escape. */
function useTask(context: SecurityContext) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(
    async <T,>(action: () => Promise<T>, as: SecurityContext = context): Promise<T | undefined> => {
      setBusy(true);
      setError('');
      try {
        return await action();
      } catch (failure) {
        setError(messageFor(failure, as));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [context],
  );
  return { busy, error, setError, run };
}

/** Moves focus to a step's heading when the step changes, so a screen reader announces where it is. */
function useStepFocus(step: string) {
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);
  return heading;
}

function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  return children ? (
    <small id={id} role="alert" className="adm-field-error">
      {children}
    </small>
  ) : null;
}

/** The "prove it is you" fields: a code from the app or a recovery code, or (when there is one) a passkey. */
export function ProofFields({
  id,
  code,
  onCode,
  error,
  canPasskey,
  busy,
  onPasskey,
}: {
  id: string;
  code: string;
  onCode: (value: string) => void;
  error?: string | undefined;
  canPasskey: boolean;
  busy: boolean;
  onPasskey: () => void;
}) {
  return (
    <>
      <div className="adm-login-field">
        <label>
          Code from your authenticator app, or a recovery code
          <input
            id={`${id}-code`}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={11}
            value={code}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-code-error` : undefined}
            onChange={(event) => onCode(event.target.value)}
          />
        </label>
        <FieldError id={`${id}-code-error`}>{error}</FieldError>
      </div>
      {canPasskey && (
        <div>
          <button type="button" className="adm-sec__quiet" disabled={busy} onClick={onPasskey}>
            Use a passkey instead
          </button>
        </div>
      )}
    </>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  error,
  maxLength = 200,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  error?: string | undefined;
  maxLength?: number;
}) {
  return (
    <div className="adm-login-field">
      <label>
        {label}
        <input
          id={id}
          type="password"
          autoComplete={autoComplete}
          maxLength={maxLength}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

function ErrorBox({ children }: { children?: string }) {
  return children ? (
    <Callout tone="danger" role="alert">
      {children}
    </Callout>
  ) : null;
}

/** The QR for an otpauth:// uri, drawn in the page as SVG paths (no image request, no raw HTML). */
export function SecurityQr({ uri }: { uri: string }) {
  let drawn: { size: number; d: string } | null = null;
  try {
    drawn = qrPath(qrModules(uri));
  } catch {
    drawn = null;
  }
  if (!drawn) return <p className="adm-subtle">The QR code could not be drawn. Type the setup key below into your app instead.</p>;
  return (
    <div className="adm-sec__qr">
      <svg
        viewBox={`0 0 ${drawn.size} ${drawn.size}`}
        role="img"
        aria-label="QR code for your new authenticator app"
        shapeRendering="crispEdges"
      >
        <rect width={drawn.size} height={drawn.size} fill="#fff" />
        <path d={drawn.d} fill="#000" />
      </svg>
    </div>
  );
}

/* ── the four cards ────────────────────────────────────────────────────────────────────────────────────────────── */

interface CardProps {
  csrf: string;
  overview: SecurityOverview;
  onChanged: () => void;
}

const canUsePasskey = (overview: SecurityOverview): boolean => overview.passkeysAvailable && overview.passkeys.length > 0;

function PasswordCard({ csrf, overview }: CardProps) {
  const [mode, setMode] = useState<'idle' | 'change' | 'forgot'>('idle');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [fields, setFields] = useState<{ current?: string; next?: string; again?: string; code?: string }>({});
  const { busy, error, setError, run } = useTask('password');
  const heading = useStepFocus(mode);
  const leave = () => {
    setMode('idle');
    setCurrent('');
    setNext('');
    setAgain('');
    setCode('');
    setFields({});
    setError('');
  };
  const finish = async (path: string, body: unknown, as: SecurityContext) => {
    const done = await run(() => call(csrf, path, 'POST', body), as);
    // The server has ended this session. Everything typed is dropped, and the founder signs in with the new password.
    if (done !== undefined) {
      setCurrent('');
      setNext('');
      setAgain('');
      setCode('');
      window.location.assign('/login?changed=1');
    }
  };
  const submitChange = async () => {
    const problems = { ...passwordPairErrors(next, again), ...(current ? {} : { current: 'Enter your current password.' }) };
    setFields(problems);
    if (Object.keys(problems).length) return;
    await finish('/api/security/password', { currentPassword: current, newPassword: next }, 'password');
  };
  const submitForgot = async (proof: unknown) => {
    await finish('/api/security/password/set', { newPassword: next, proof }, 'proof');
  };
  const forgotPasskey = async () => {
    const problems = passwordPairErrors(next, again);
    setFields(problems);
    if (Object.keys(problems).length) return;
    const proof = await run(() => passkeyProof(csrf), 'proof');
    if (proof) await submitForgot(proof);
  };
  const forgotCode = async () => {
    const problems: { next?: string; again?: string; code?: string } = passwordPairErrors(next, again);
    if (!CODE.test(code.trim())) problems.code = 'Enter a 6-digit code or a recovery code like ABCDE-12345.';
    setFields(problems);
    if (Object.keys(problems).length) return;
    await submitForgot({ totpCode: code.trim() });
  };
  return (
    <section className="adm-sec-card" aria-labelledby="sec-password-title">
      <header>
        <h2 id="sec-password-title" tabIndex={-1} ref={heading}>
          Password
        </h2>
        <p className="adm-subtle">
          {overview.passwordChangedAt && when(overview.passwordChangedAt)
            ? `Last changed ${when(overview.passwordChangedAt)}.`
            : 'You sign in with it, together with a code or a passkey.'}
        </p>
      </header>
      {mode === 'idle' && (
        <>
          <div className="adm-sec__actions">
            <button type="button" onClick={() => setMode('change')}>
              Change password
            </button>
          </div>
          <button type="button" className="adm-sec__link" onClick={() => setMode('forgot')}>
            Forgot it? Sign in with your passkey, then set a new one here
          </button>
        </>
      )}
      {mode === 'change' && (
        <form
          className="adm-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitChange();
          }}
        >
          <PasswordField
            id="sec-current"
            label="Current password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
            error={fields.current}
            maxLength={1024}
          />
          <PasswordField
            id="sec-new"
            label="New password"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            error={fields.next}
          />
          <PasswordField
            id="sec-new-again"
            label="New password again"
            value={again}
            onChange={setAgain}
            autoComplete="new-password"
            error={fields.again}
          />
          <p className="adm-subtle">{PASSWORD_HELP} You will be signed out everywhere and sign in again with the new one.</p>
          <ErrorBox>{error}</ErrorBox>
          <div className="adm-sec__actions">
            <button type="submit" {...submitProps({ disabled: busy, changed: Boolean(current && next && again) })}>
              {busy ? 'Changing…' : 'Change password'}
            </button>
            <button type="button" className="adm-sec__quiet" onClick={leave} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {mode === 'forgot' && (
        <form
          className="adm-form adm-sec__forgot"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void forgotCode();
          }}
        >
          <p>
            You are signed in, so you can set a new password without the old one. Confirm it is you with your passkey, or with a code from
            your authenticator app or a recovery code.
          </p>
          <PasswordField
            id="sec-set-new"
            label="New password"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            error={fields.next}
          />
          <PasswordField
            id="sec-set-again"
            label="New password again"
            value={again}
            onChange={setAgain}
            autoComplete="new-password"
            error={fields.again}
          />
          <ProofFields
            id="sec-set"
            code={code}
            onCode={setCode}
            error={fields.code}
            canPasskey={canUsePasskey(overview)}
            busy={busy}
            onPasskey={() => void forgotPasskey()}
          />
          <ErrorBox>{error}</ErrorBox>
          <div className="adm-sec__actions">
            <button type="submit" {...submitProps({ disabled: busy, changed: Boolean(next && again && code.trim()) })}>
              {busy ? 'Setting…' : 'Set new password'}
            </button>
            <button type="button" className="adm-sec__quiet" onClick={leave} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function AuthenticatorCard({ csrf, overview, onChanged }: CardProps) {
  const [step, setStep] = useState<'idle' | 'prove' | 'scan' | 'done'>('idle');
  const [proofCode, setProofCode] = useState('');
  const [proofError, setProofError] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [newCode, setNewCode] = useState('');
  const [newCodeError, setNewCodeError] = useState('');
  const { busy, error, setError, run } = useTask('proof');
  const heading = useStepFocus(step);
  const leave = () => {
    setStep('idle');
    setProofCode('');
    setProofError('');
    setSetup(null);
    setNewCode('');
    setNewCodeError('');
    setError('');
  };
  const begin = async (proof: unknown) => {
    const started = (await run(() => call(csrf, '/api/security/authenticator/replace-begin', 'POST', { proof }))) as
      { secret?: unknown; uri?: unknown } | undefined;
    if (started && typeof started.secret === 'string' && typeof started.uri === 'string') {
      setProofCode('');
      setSetup({ secret: started.secret, uri: started.uri });
      setStep('scan');
    }
  };
  return (
    <section className="adm-sec-card" aria-labelledby="sec-auth-title">
      <header>
        <h2 id="sec-auth-title" tabIndex={-1} ref={heading}>
          Authenticator app
        </h2>
        <p className="adm-subtle">
          {overview.totpEnrolled
            ? when(overview.totpEnrolledAt)
              ? `Set up ${when(overview.totpEnrolledAt)}.`
              : 'Set up.'
            : 'Not set up yet.'}
        </p>
      </header>
      {step === 'idle' && (
        <div className="adm-sec__actions">
          <button type="button" onClick={() => setStep('prove')} disabled={!overview.totpEnrolled}>
            Replace authenticator
          </button>
        </div>
      )}
      {step === 'prove' && (
        <form
          className="adm-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!CODE.test(proofCode.trim())) {
              setProofError('Enter a 6-digit code or a recovery code like ABCDE-12345.');
              return;
            }
            setProofError('');
            void begin({ totpCode: proofCode.trim() });
          }}
        >
          <p>
            First, prove it is you. Lost your phone? Use a recovery code or a passkey. Your current app keeps working until you confirm the
            new one.
          </p>
          <ProofFields
            id="sec-auth"
            code={proofCode}
            onCode={(value) => {
              setProofCode(value);
              setProofError('');
            }}
            error={proofError}
            canPasskey={canUsePasskey(overview)}
            busy={busy}
            onPasskey={() =>
              void (async () => {
                const proof = await run(() => passkeyProof(csrf));
                if (proof) await begin(proof);
              })()
            }
          />
          <ErrorBox>{error}</ErrorBox>
          <div className="adm-sec__actions">
            <button type="submit" {...submitProps({ disabled: busy, changed: Boolean(proofCode.trim()) })}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
            <button type="button" className="adm-sec__quiet" onClick={leave} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {step === 'scan' && setup && (
        <form
          className="adm-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!/^\d{6}$/.test(newCode.trim())) {
              setNewCodeError('Enter the 6-digit code now showing in your new app.');
              return;
            }
            setNewCodeError('');
            void (async () => {
              const done = await run(
                () => call(csrf, '/api/security/authenticator/replace-confirm', 'POST', { code: newCode.trim() }),
                'confirm',
              );
              if (done !== undefined) {
                setSetup(null);
                setNewCode('');
                setStep('done');
                onChanged();
              }
            })();
          }}
        >
          <p>Scan this with your new authenticator app, or type the key in by hand. Then enter the 6-digit code the app shows.</p>
          <SecurityQr uri={setup.uri} />
          <div>
            <small className="adm-subtle">Setup key</small>
            <div className="adm-sec__mono">{groupSecret(setup.secret)}</div>
          </div>
          <div className="adm-login-field">
            <label>
              Code from the new app
              <input
                id="sec-new-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                value={newCode}
                aria-invalid={newCodeError ? true : undefined}
                aria-describedby={newCodeError ? 'sec-new-code-error' : undefined}
                onChange={(event) => {
                  setNewCode(event.target.value);
                  setNewCodeError('');
                }}
              />
            </label>
            <FieldError id="sec-new-code-error">{newCodeError}</FieldError>
          </div>
          <ErrorBox>{error}</ErrorBox>
          <div className="adm-sec__actions">
            <button type="submit" {...submitProps({ disabled: busy, changed: /^\d{6}$/.test(newCode.trim()) })}>
              {busy ? 'Confirming…' : 'Confirm new authenticator'}
            </button>
            <button type="button" className="adm-sec__quiet" onClick={leave} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {step === 'done' && (
        <>
          <Callout tone="neutral" icon="check" role="status">
            Your new authenticator is active. Your recovery codes have not changed.
          </Callout>
          <div className="adm-sec__actions">
            <button type="button" onClick={leave}>
              Done
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function RecoveryCard({ csrf, overview, onChanged }: CardProps) {
  const [step, setStep] = useState<'idle' | 'prove' | 'show'>('idle');
  const [proofCode, setProofCode] = useState('');
  const [proofError, setProofError] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const { busy, error, setError, run } = useTask('proof');
  const heading = useStepFocus(step);
  const left = overview.recoveryCodesRemaining;
  const leave = () => {
    const shown = step === 'show';
    setStep('idle');
    setProofCode('');
    setProofError('');
    setCodes([]);
    setError('');
    if (shown) onChanged();
  };
  const generate = async (proof: unknown) => {
    const made = (await run(() => call(csrf, '/api/security/recovery-codes', 'POST', { proof }))) as
      { recoveryCodes?: unknown } | undefined;
    if (made && Array.isArray(made.recoveryCodes) && made.recoveryCodes.every((code) => typeof code === 'string')) {
      setProofCode('');
      setCodes(made.recoveryCodes as string[]);
      setStep('show');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([recoveryCodesText(codes)], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'intafaced-recovery-codes.txt';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className={`adm-sec-card${step === 'show' ? ' adm-sec__printable' : ''}`} aria-labelledby="sec-recovery-title">
      <header>
        <h2 id="sec-recovery-title" tabIndex={-1} ref={heading}>
          Recovery codes
        </h2>
        <p className="adm-subtle adm-sec__no-print">Each code signs you in once if you lose your phone.</p>
      </header>
      {step === 'idle' && (
        <>
          <div className="adm-sec__count" data-low={left <= 3 ? 'true' : 'false'}>
            {left} left
          </div>
          {left <= 3 && (
            <Callout tone="warn" role="status">
              {left === 0 ? 'You have no recovery codes left. Get new ones now.' : 'You are running low. Get new ones soon.'}
            </Callout>
          )}
          <div className="adm-sec__actions">
            <button type="button" onClick={() => setStep('prove')} disabled={!overview.totpEnrolled}>
              Get new codes
            </button>
          </div>
        </>
      )}
      {step === 'prove' && (
        <form
          className="adm-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!CODE.test(proofCode.trim())) {
              setProofError('Enter a 6-digit code or a recovery code like ABCDE-12345.');
              return;
            }
            setProofError('');
            void generate({ totpCode: proofCode.trim() });
          }}
        >
          <Callout tone="warn">New codes replace all your old ones. The old codes stop working as soon as these are made.</Callout>
          <ProofFields
            id="sec-codes"
            code={proofCode}
            onCode={(value) => {
              setProofCode(value);
              setProofError('');
            }}
            error={proofError}
            canPasskey={canUsePasskey(overview)}
            busy={busy}
            onPasskey={() =>
              void (async () => {
                const proof = await run(() => passkeyProof(csrf));
                if (proof) await generate(proof);
              })()
            }
          />
          <ErrorBox>{error}</ErrorBox>
          <div className="adm-sec__actions">
            <button type="submit" {...submitProps({ disabled: busy, changed: Boolean(proofCode.trim()) })}>
              {busy ? 'Checking…' : 'Make new codes'}
            </button>
            <button type="button" className="adm-sec__quiet" onClick={leave} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {step === 'show' && (
        <>
          <Callout tone="warn" className="adm-sec__no-print" role="status">
            These are shown once. Save them now, somewhere other than your phone. Your old codes no longer work.
          </Callout>
          <p className="adm-sec__print-only">INTAFACED founder recovery codes. Each code works once. Keep this sheet somewhere safe.</p>
          <ol className="adm-sec__codes" aria-label="Your new recovery codes">
            {codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ol>
          <div className="adm-sec__actions adm-sec__no-print">
            <button type="button" onClick={download}>
              Download .txt
            </button>
            <button type="button" onClick={() => window.print()}>
              Print
            </button>
            <button type="button" data-primary="true" onClick={leave}>
              I have saved them
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** A real modal: the page behind is inert, Escape cancels. Removing a sign-in factor needs a fresh proof, asked for in the dialog. */
export function ConfirmRemove({
  open,
  label,
  busy,
  code,
  onCode,
  codeError,
  error,
  canPasskey,
  onPasskey,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  label: string;
  busy: boolean;
  code: string;
  onCode: (value: string) => void;
  codeError?: string | undefined;
  error?: string | undefined;
  canPasskey: boolean;
  onPasskey: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal?.();
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="sec-remove-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="sec-remove-title">Remove this passkey?</h2>
      <p>
        {label} will stop working for sign-in and for confirming sensitive changes. You can add it again later. Make sure you still have
        another way to sign in.
      </p>
      <form
        className="adm-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <ProofFields
          id="sec-remove"
          code={code}
          onCode={onCode}
          error={codeError}
          canPasskey={canPasskey}
          busy={busy}
          onPasskey={onPasskey}
        />
        <ErrorBox>{error}</ErrorBox>
        <div className="adm-sec__actions">
          <button type="submit" className="adm-irreversible" disabled={busy}>
            {busy ? 'Removing…' : 'Remove passkey'}
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            Keep it
          </button>
        </div>
      </form>
    </dialog>
  );
}

function PasskeysCard({ csrf, overview, onChanged }: CardProps) {
  const [removing, setRemoving] = useState<SecurityPasskey | null>(null);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [notice, setNotice] = useState('');
  const add = useTask('passkey');
  const remove = useTask('remove');
  const passkeys = overview.passkeys;
  const nameOf = (passkey: SecurityPasskey, index: number) => passkey.name ?? `Passkey ${index + 1}`;
  const reset = () => {
    setAdding(false);
    setRemoving(null);
    setCode('');
    setCodeError('');
    add.setError('');
    remove.setError('');
  };
  const checkCode = (): boolean => {
    if (CODE.test(code.trim())) {
      setCodeError('');
      return true;
    }
    setCodeError('Enter a 6-digit code or a recovery code like ABCDE-12345.');
    return false;
  };
  const addWith = async (getProof: () => Promise<unknown>) => {
    setNotice('');
    const done = await add.run(async () => {
      await registerPasskey(csrf, await getProof());
      return true as const;
    });
    if (done) {
      reset();
      setNotice('Passkey added.');
      onChanged();
    }
  };
  const removeWith = async (getProof: () => Promise<unknown>) => {
    if (!removing) return;
    const target = removing;
    setNotice('');
    const removed = (await remove.run(async () =>
      call(csrf, `/api/security/passkeys/${encodeURIComponent(target.id)}`, 'DELETE', { proof: await getProof() }),
    )) as { removed?: unknown } | undefined;
    if (removed) {
      reset();
      setNotice(removed.removed === true ? 'Passkey removed.' : 'That passkey was already gone.');
      onChanged();
    }
  };
  return (
    <section className="adm-sec-card" aria-labelledby="sec-passkeys-title">
      <header>
        <h2 id="sec-passkeys-title" tabIndex={-1}>
          Passkeys
        </h2>
        <p className="adm-subtle">A passkey signs you in with your fingerprint, face or device PIN, and it works if you lose your phone.</p>
      </header>
      {!overview.passkeysAvailable ? (
        <Callout tone="warn">Passkeys can&rsquo;t be loaded right now. Try again later.</Callout>
      ) : passkeys.length === 0 ? (
        <p>You have no passkeys. Add one on this device.</p>
      ) : (
        <ul className="adm-sec__list">
          {passkeys.map((passkey, index) => (
            <li key={passkey.id}>
              <span>
                {nameOf(passkey, index)}
                {when(passkey.createdAt) && <small>Added {when(passkey.createdAt)}</small>}
              </span>
              <button
                type="button"
                className="adm-irreversible"
                onClick={() => {
                  reset();
                  setNotice('');
                  setRemoving(passkey);
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <Callout tone="neutral" icon="check" role="status">
          {notice}
        </Callout>
      )}
      {!adding && removing === null && <ErrorBox>{add.error || remove.error}</ErrorBox>}
      {overview.passkeysAvailable && !adding && (
        <div className="adm-sec__actions">
          <button
            type="button"
            onClick={() => {
              reset();
              setNotice('');
              setAdding(true);
            }}
          >
            Add a passkey
          </button>
        </div>
      )}
      {adding && (
        <form
          className="adm-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (checkCode()) void addWith(async () => ({ totpCode: code.trim() }));
          }}
        >
          <p>First, prove it is you. Then your device will ask you to create the passkey.</p>
          <ProofFields
            id="sec-add"
            code={code}
            onCode={(value) => {
              setCode(value);
              setCodeError('');
            }}
            error={codeError}
            canPasskey={canUsePasskey(overview)}
            busy={add.busy}
            onPasskey={() => void addWith(() => passkeyProof(csrf))}
          />
          <ErrorBox>{add.error}</ErrorBox>
          <div className="adm-sec__actions">
            <button type="submit" {...submitProps({ disabled: add.busy, changed: Boolean(code.trim()) })}>
              {add.busy ? 'Waiting for your device…' : 'Add passkey'}
            </button>
            <button type="button" className="adm-sec__quiet" onClick={reset} disabled={add.busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <ConfirmRemove
        open={removing !== null}
        label={
          removing
            ? nameOf(
                removing,
                passkeys.findIndex((item) => item.id === removing.id),
              )
            : 'This passkey'
        }
        busy={remove.busy}
        code={code}
        onCode={(value) => {
          setCode(value);
          setCodeError('');
        }}
        codeError={codeError}
        error={remove.error}
        canPasskey={canUsePasskey(overview)}
        onPasskey={() => void removeWith(() => passkeyProof(csrf))}
        onCancel={reset}
        onSubmit={() => {
          if (checkCode()) void removeWith(async () => ({ totpCode: code.trim() }));
        }}
      />
    </section>
  );
}

/* ── the page ──────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The four cards for an already-loaded overview. */
export function SecurityCards(props: CardProps) {
  return (
    <>
      <PasswordCard {...props} />
      <AuthenticatorCard {...props} />
      <RecoveryCard {...props} />
      <PasskeysCard {...props} />
    </>
  );
}

export function FounderSecurity({ csrf }: { csrf: string }) {
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const data = (await call(csrf, '/api/security', 'GET')) as SecurityOverview;
      setOverview(data);
      setError('');
    } catch (failure) {
      setError(messageFor(failure, 'load'));
    }
  }, [csrf]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="adm-workspace">
      <div className="adm-sec">
        <div>
          <h1>Security</h1>
          <p className="adm-sec__lead">
            How you sign in to this console. Changes here need your authenticator app, a recovery code or a passkey.
          </p>
        </div>
        {error && (
          <Callout
            tone="danger"
            role="alert"
            actions={
              <button type="button" onClick={() => void load()}>
                Try again
              </button>
            }
          >
            {error}
          </Callout>
        )}
        {!overview && !error && (
          <p className="adm-subtle" role="status">
            Loading your security settings…
          </p>
        )}
        {overview && <SecurityCards csrf={csrf} overview={overview} onChanged={() => void load()} />}
      </div>
    </div>
  );
}
