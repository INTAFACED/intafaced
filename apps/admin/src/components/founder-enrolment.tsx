'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { submitProps } from '@/lib/crm-form-state';
import { qrModules, qrPath } from '@/lib/qr';
import { Callout } from './crm-callout';
import './founder-enrolment.css';

/*
 * One-time founder enrolment. Every secret here (password, authenticator secret, recovery codes) lives in React state only:
 * never in localStorage, sessionStorage, the URL or a log. The account ID is not known to this page until the last step.
 */

export type EnrolStep = 'checking' | 'unreachable' | 'closed' | 'details' | 'authenticator' | 'recovery' | 'passkey' | 'done';
export type EnrolContext = 'register' | 'start' | 'confirm' | 'passkey' | 'finish' | 'abandon' | 'status';

/** A refusal or a lost connection. `code` is this server's code; `upstreamCode` is identity's own `auth.*` code. */
export class EnrolFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly upstreamCode?: string,
  ) {
    super(code);
  }
}

/** Plain-English copy per refusal. Raw codes are never shown. */
export function enrolmentErrorMessage(failure: { code: string; upstreamCode?: string | undefined }, context: EnrolContext): string {
  switch (failure.upstreamCode) {
    case 'auth.invite_used':
      return "This invite has already been used. If that wasn't you, tell Nitro now.";
    case 'auth.invite_invalid':
      return "That invite code isn't recognised. Check it and try again.";
    case 'auth.invite_expired':
      return 'This invite has expired. Ask Nitro for a new one.';
    case 'auth.founder_enrolment_closed':
      return 'Enrolment is closed. The founder accounts are already set up.';
    case 'auth.handle_taken':
      return 'That handle is already taken. Choose another.';
    case 'auth.email_taken':
      return 'An account with that email already exists. Use a different email, or tell Nitro.';
    case 'auth.mfa_invalid':
      return context === 'passkey'
        ? "That code didn't work. Wait for the next code to appear in your app (the one you just used can't be used twice), then enter it."
        : "That code didn't match. Check your authenticator app and try again. Codes change every 30 seconds.";
    case 'auth.too_many_attempts':
      return 'Too many attempts. Wait a few minutes, then try again.';
    case 'auth.mfa_required':
      return context === 'passkey'
        ? 'Enter a fresh code from your authenticator app to add a passkey.'
        : 'Your authenticator is already set up. Carry on to the next step.';
    case 'auth.passkey_preview_unavailable':
      return "Passkeys can't be tested in the local preview. Skip this step.";
    case 'auth.mfa_already_enrolled':
      return 'An authenticator is already set up on this account. Tell Nitro before going further.';
    case 'auth.password_policy':
      return "That password isn't accepted. Use a longer, random one from your password manager.";
    case 'auth.webauthn_invalid':
      return "The passkey couldn't be verified. Try again, or skip this step.";
  }
  switch (failure.code) {
    case 'network':
      return "Couldn't reach the server. Check your connection and try again.";
    case 'admin.enrolment_off':
      return 'Enrolment is closed.';
    case 'admin.rate_limited':
      return 'Too many attempts from this connection. Wait a few minutes, then try again.';
    case 'admin.enrol_input':
    case 'admin.json_required':
      return 'Check the details you entered and try again.';
    case 'admin.enrolment_expired':
      return 'Your enrolment time has run out. Ask Nitro for a new invite.';
    case 'admin.enrolment_required':
    case 'admin.session_origin':
    case 'admin.session_csrf':
    case 'admin.authority_refused':
      return 'Your enrolment session has ended. Your invite was used, so tell Nitro and ask what to do next.';
    case 'admin.enrolment_totp_required':
      return 'Confirm your authenticator first.';
    case 'admin.upstream_unavailable':
      return "Couldn't reach the server. Try again in a moment.";
    case 'admin.session_unconfigured':
      return 'The founder workspace is awaiting deployment configuration.';
    default:
      return 'Something went wrong. Try again, and tell Nitro if it keeps happening.';
  }
}

/** The field an upstream refusal belongs to, so its message sits next to it. */
export function failureField(upstreamCode: string | undefined): 'invite' | 'handle' | 'email' | null {
  switch (upstreamCode) {
    case 'auth.invite_used':
    case 'auth.invite_invalid':
    case 'auth.invite_expired':
      return 'invite';
    case 'auth.handle_taken':
      return 'handle';
    case 'auth.email_taken':
      return 'email';
    default:
      return null;
  }
}

/** `JBSWY3DPEHPK3PXP` -> `JBSW Y3DP EHPK 3PXP`. */
export function groupSecret(secret: string): string {
  return (secret.replace(/\s+/g, '').match(/.{1,4}/g) ?? []).join(' ');
}

/** The ID without dashes in groups of four, easier to read aloud. */
export function groupAccountId(userId: string): string[] {
  return userId.replace(/-/g, '').match(/.{1,4}/g) ?? [];
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

export interface DetailsValues {
  invite: string;
  email: string;
  handle: string;
  password: string;
  again: string;
}
export type DetailsErrors = Partial<Record<keyof DetailsValues, string>>;

export function detailsErrors(values: DetailsValues): DetailsErrors {
  const errors: DetailsErrors = {};
  if (!values.invite.trim()) errors.invite = 'Enter the invite code Nitro sent you.';
  else if (values.invite.length > 64) errors.invite = 'That invite code is too long.';
  if (!values.email.trim()) errors.email = 'Enter your email.';
  else if (values.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(values.email.trim())) errors.email = 'Enter a valid email address.';
  if (!values.handle.trim()) errors.handle = 'Choose a handle.';
  else if (values.handle.length > 32) errors.handle = 'Handles are at most 32 characters.';
  if (values.password.length < 12) errors.password = 'Use at least 12 characters.';
  else if (values.password.length > 200) errors.password = 'Use at most 200 characters.';
  if (!errors.password && values.again !== values.password) errors.again = "The two passwords don't match.";
  return errors;
}

/** The first field with a problem, in page order. */
export function firstDetailsError(errors: DetailsErrors): keyof DetailsValues | null {
  return (['invite', 'email', 'handle', 'password', 'again'] as const).find((name) => errors[name]) ?? null;
}

/** Calls an enrolment route. Throws EnrolFailure for a refusal or a lost connection. */
export async function enrolCall(path: string, method: 'GET' | 'POST' | 'DELETE', csrf: string | null, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(csrf ? { 'x-intafaced-csrf': csrf } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new EnrolFailure('network');
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const row = (data && typeof data === 'object' ? data : {}) as { code?: unknown; upstreamCode?: unknown };
    throw new EnrolFailure(
      typeof row.code === 'string' ? row.code : 'admin.request_failed',
      typeof row.upstreamCode === 'string' ? row.upstreamCode : undefined,
    );
  }
  return data;
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

interface RegistrationOptions {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: Array<{ id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }>;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
}

/** Browser side of passkey registration: `navigator.credentials.create` (the login uses `.get`). */
export async function createPasskey(csrf: string, code: string | null, onStepUp: () => void = () => undefined): Promise<void> {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) throw new EnrolFailure('passkey_unavailable');
  // A fresh authenticator code buys a five-minute step-up that the server keeps; without a code the server reuses one it still holds.
  const raw = (await enrolCall('/api/enroll/passkey/options', 'POST', csrf, code ? { code } : {})) as RegistrationOptions;
  onStepUp();
  if (!raw || typeof raw.challenge !== 'string' || !raw.user || typeof raw.user.id !== 'string') throw new EnrolFailure('passkey_options');
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...raw,
      challenge: decode(raw.challenge),
      user: { ...raw.user, id: decode(raw.user.id) },
      excludeCredentials: raw.excludeCredentials?.map((item) => ({ ...item, id: decode(item.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new EnrolFailure('passkey_cancelled');
  const response = credential.response as AuthenticatorAttestationResponse;
  await enrolCall('/api/enroll/passkey/verify', 'POST', csrf, {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: encode(response.clientDataJSON),
      attestationObject: encode(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  });
}

/* ---------------------------------------------------------------- views (pure, so they can be rendered in tests) */

export function EnrolmentClosed() {
  return (
    <div>
      <h2 tabIndex={-1}>Enrolment is closed.</h2>
      <p>This page is only open while the two founder accounts are being set up.</p>
      <p>
        <a href="/login">Go to sign in</a>
      </p>
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string | undefined }) {
  return message ? (
    <small id={id} className="adm-field-error" role="alert">
      {message}
    </small>
  ) : null;
}

export function DetailsStep({
  values,
  errors,
  error,
  busy,
  onChange,
  onSubmit,
  refs,
}: {
  values: DetailsValues;
  errors: DetailsErrors;
  error: string;
  busy: boolean;
  onChange: (name: keyof DetailsValues, value: string) => void;
  onSubmit: () => void;
  refs?: Partial<Record<keyof DetailsValues, Ref<HTMLInputElement>>>;
}) {
  const field = (name: keyof DetailsValues) => ({
    ref: refs?.[name],
    'aria-invalid': errors[name] ? (true as const) : undefined,
    'aria-describedby': errors[name] ? `enrol-${name}-error` : undefined,
    value: values[name],
    onChange: (event: { target: { value: string } }) => onChange(name, event.target.value),
  });
  return (
    <div>
      <p className="adm-enrol__step">Step 1 of 4</p>
      <h2 tabIndex={-1}>Create your account</h2>
      <p>Use the invite code Nitro sent you. Make a long, random password in your password manager and save it there now.</p>
      <form
        className="adm-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="adm-login-field">
          <label>
            Invite code
            <input {...field('invite')} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={64} required />
          </label>
          <FieldError id="enrol-invite-error" message={errors.invite} />
        </div>
        <div className="adm-login-field">
          <label>
            Email
            <input {...field('email')} type="email" autoComplete="username" maxLength={254} required />
          </label>
          <FieldError id="enrol-email-error" message={errors.email} />
        </div>
        <div className="adm-login-field">
          <label>
            Handle
            <input {...field('handle')} autoComplete="nickname" autoCapitalize="none" spellCheck={false} maxLength={32} required />
          </label>
          <FieldError id="enrol-handle-error" message={errors.handle} />
        </div>
        <div className="adm-login-field">
          <label>
            New password (at least 12 characters)
            <input {...field('password')} type="password" autoComplete="new-password" maxLength={200} required />
          </label>
          <FieldError id="enrol-password-error" message={errors.password} />
        </div>
        <div className="adm-login-field">
          <label>
            Type the password again
            <input {...field('again')} type="password" autoComplete="new-password" maxLength={200} required />
          </label>
          <FieldError id="enrol-again-error" message={errors.again} />
        </div>
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
        <button type="submit" {...submitProps({ disabled: busy, changed: Boolean(values.invite.trim() && values.password) })}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </div>
  );
}

export function QrCode({ uri }: { uri: string }) {
  const drawn = useMemo(() => {
    try {
      return qrPath(qrModules(uri));
    } catch {
      return null;
    }
  }, [uri]);
  if (!drawn) return <p className="adm-subtle">The QR code could not be drawn. Type the setup key below into your app instead.</p>;
  return (
    <div className="adm-enrol__qr">
      <svg
        viewBox={`0 0 ${drawn.size} ${drawn.size}`}
        role="img"
        aria-label="QR code for your authenticator app"
        shapeRendering="crispEdges"
      >
        <rect width={drawn.size} height={drawn.size} fill="#ffffff" />
        <path d={drawn.d} fill="#0b0c0d" />
      </svg>
    </div>
  );
}

function CopyButton({ label, copied, onCopy }: { label: string; copied: boolean; onCopy: () => void }) {
  return (
    <button type="button" onClick={onCopy}>
      {copied ? 'Copied' : label}
    </button>
  );
}

export function AuthenticatorStep({
  uri,
  secret,
  code,
  error,
  busy,
  loading,
  copied,
  onCode,
  onCopy,
  onConfirm,
  onRetry,
  codeRef,
}: {
  uri: string;
  secret: string;
  code: string;
  error: string;
  busy: boolean;
  loading: boolean;
  copied: boolean;
  onCode: (value: string) => void;
  onCopy: () => void;
  onConfirm: () => void;
  onRetry: () => void;
  codeRef?: Ref<HTMLInputElement>;
}) {
  const ready = Boolean(uri && secret);
  return (
    <div>
      <p className="adm-enrol__step">Step 2 of 4</p>
      <h2 tabIndex={-1}>Set up your authenticator</h2>
      <p>Scan this with an authenticator app on your phone, then type the 6-digit code it shows.</p>
      {loading && <p role="status">Preparing your authenticator…</p>}
      {!loading && !ready && (
        <div className="adm-enrol__stack">
          {error && (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          )}
          <button type="button" onClick={onRetry} disabled={busy}>
            Try again
          </button>
        </div>
      )}
      {ready && (
        <form
          className="adm-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
        >
          <QrCode uri={uri} />
          <div className="adm-login-field">
            <small className="adm-subtle">Can't scan? Type this setup key into your app.</small>
            <div className="adm-enrol__mono">
              <code aria-label="Setup key">{groupSecret(secret)}</code>
              <CopyButton label="Copy" copied={copied} onCopy={onCopy} />
            </div>
          </div>
          <div className="adm-login-field">
            <label>
              6-digit code
              <input
                ref={codeRef}
                value={code}
                onChange={(event) => onCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]*"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'enrol-code-error' : undefined}
                required
              />
            </label>
            <FieldError id="enrol-code-error" message={error} />
          </div>
          <button type="submit" {...submitProps({ disabled: busy, changed: code.length === 6 })}>
            {busy ? 'Checking…' : 'Confirm code'}
          </button>
        </form>
      )}
    </div>
  );
}

export function RecoveryStep({
  codes,
  saved,
  onSaved,
  onDownload,
  onPrint,
  onContinue,
}: {
  codes: readonly string[];
  saved: boolean;
  onSaved: (value: boolean) => void;
  onDownload: () => void;
  onPrint: () => void;
  onContinue: () => void;
}) {
  return (
    <div>
      <p className="adm-enrol__step adm-enrol__no-print">Step 3 of 4</p>
      <h2 tabIndex={-1}>Save your recovery codes</h2>
      <p className="adm-enrol__print-only">INTAFACED founder recovery codes. Each code works once.</p>
      <p className="adm-enrol__no-print">
        If you lose your phone, one of these codes lets you sign in. Each works once. They are shown only now, so save them away from your
        phone: a password manager or a printed sheet in a safe place.
      </p>
      <ol className="adm-enrol__codes" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="adm-enrol__stack adm-enrol__no-print">
        <div className="adm-enrol__actions">
          <button type="button" onClick={onDownload}>
            Download .txt
          </button>
          <button type="button" onClick={onPrint}>
            Print
          </button>
        </div>
        <label className="adm-enrol__check">
          <input type="checkbox" checked={saved} onChange={(event) => onSaved(event.target.checked)} />
          <span>I have saved these somewhere other than my phone</span>
        </label>
        <button type="button" disabled={!saved} data-primary={saved ? 'true' : 'false'} onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}

export function PasskeyStep({
  supported,
  code,
  needsCode,
  error,
  busy,
  onCode,
  onAdd,
  onSkip,
  codeRef,
}: {
  supported: boolean;
  code: string;
  /** False while the server still holds a step-up from a moment ago, so a retry needs no new code. */
  needsCode: boolean;
  error: string;
  busy: boolean;
  onCode: (value: string) => void;
  onAdd: () => void;
  onSkip: () => void;
  codeRef?: Ref<HTMLInputElement>;
}) {
  const ready = supported && (!needsCode || code.length === 6);
  return (
    <div>
      <p className="adm-enrol__step">Step 4 of 4</p>
      <h2 tabIndex={-1}>Add a passkey (optional)</h2>
      <p>A passkey lets this computer sign you in with Touch ID or similar, and is your backup if you lose your phone.</p>
      {!supported && <p className="adm-subtle">This browser can't create a passkey here. You can skip this step.</p>}
      <form
        className="adm-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) onAdd();
        }}
      >
        {supported && needsCode && (
          <div className="adm-login-field">
            <label>
              Fresh 6-digit code from your authenticator app
              <input
                ref={codeRef}
                value={code}
                onChange={(event) => onCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]*"
                aria-describedby="enrol-passkey-code-hint"
              />
            </label>
            <small id="enrol-passkey-code-hint" className="adm-subtle">
              Wait for the next code to appear in your app. The code you used a moment ago can't be used twice.
            </small>
          </div>
        )}
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
        <div className="adm-enrol__actions">
          <button type="submit" {...submitProps({ disabled: busy || !ready, changed: ready })}>
            {busy ? 'Waiting…' : 'Add a passkey on this computer'}
          </button>
          <button type="button" disabled={busy} onClick={onSkip}>
            Skip
          </button>
        </div>
      </form>
    </div>
  );
}

export function DoneStep({ userId, copied, onCopy }: { userId: string; copied: boolean; onCopy: () => void }) {
  const groups = groupAccountId(userId);
  const last = groups.length - 1;
  return (
    <div>
      <h2 tabIndex={-1}>You're enrolled</h2>
      <p>Your account ID is:</p>
      <div className="adm-enrol__stack">
        <div className="adm-enrol__mono" aria-label="Account ID">
          <code>
            {groups.map((group, index) => (
              <span key={index}>
                {index === 0 || index === last ? <b>{group}</b> : group}
                {index < last ? ' ' : ''}
              </span>
            ))}
          </code>
          <CopyButton label="Copy ID" copied={copied} onCopy={onCopy} />
        </div>
        <p>Send this ID to Nitro, then confirm it on a call: read out the first 4 and last 4 characters (the highlighted ones).</p>
        <p className="adm-subtle">Copy gives the ID with its dashes, which is the form Nitro needs.</p>
        <p>
          You are signed out. Once both founders are switched on, <a href="/login">sign in here</a> with your password and a code.
        </p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------- the page */

function Section({ children }: { children: ReactNode }) {
  return <div className="adm-enrol__section">{children}</div>;
}

export function FounderEnrolment() {
  const [step, setStep] = useState<EnrolStep>('checking');
  const [csrf, setCsrf] = useState<string | null>(null);
  const [values, setValues] = useState<DetailsValues>({ invite: '', email: '', handle: '', password: '', again: '' });
  const [errors, setErrors] = useState<DetailsErrors>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [userId, setUserId] = useState('');
  const [copied, setCopied] = useState<'secret' | 'id' | null>(null);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const refs = {
    invite: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    handle: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    again: useRef<HTMLInputElement>(null),
  };
  const codeRef = useRef<HTMLInputElement>(null);
  const passkeyCodeRef = useRef<HTMLInputElement>(null);
  const [passkeyCode, setPasskeyCode] = useState('');
  // The server holds a five-minute step-up after the first options call, so a cancelled prompt can be retried without a new code.
  const [stepUpHeld, setStepUpHeld] = useState(false);

  async function checkStatus() {
    setStep('checking');
    setError('');
    try {
      const status = (await enrolCall('/api/enroll/status', 'GET', null)) as { open?: unknown };
      setStep(status.open === true ? 'details' : 'closed');
    } catch (failure) {
      if (failure instanceof EnrolFailure && failure.code === 'admin.enrolment_off') return setStep('closed');
      setError(enrolmentErrorMessage(failure instanceof EnrolFailure ? failure : { code: 'x' }, 'status'));
      setStep('unreachable');
    }
  }
  useEffect(() => {
    void checkStatus();
  }, []);

  // Move focus to each step's heading, so a screen reader announces where it is.
  useEffect(() => {
    root.current?.querySelector('h2')?.focus();
  }, [step]);

  // The secret and recovery codes live only in this page. Warn before a reload or close loses them.
  const holding = step === 'authenticator' || step === 'recovery' || step === 'passkey';
  useEffect(() => {
    if (!holding) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [holding]);

  const fail = (failure: unknown, context: EnrolContext) =>
    enrolmentErrorMessage(failure instanceof EnrolFailure ? failure : { code: 'x' }, context);

  async function loadAuthenticator(token: string) {
    setLoading(true);
    setError('');
    try {
      const data = (await enrolCall('/api/enroll/authenticator/start', 'POST', token, {})) as {
        secret: string;
        uri: string;
        recoveryCodes: string[];
      };
      setSecret(data.secret);
      setUri(data.uri);
      setRecoveryCodes(data.recoveryCodes);
    } catch (failure) {
      setError(fail(failure, 'start'));
    } finally {
      setLoading(false);
    }
  }

  async function register() {
    const problems = detailsErrors(values);
    setErrors(problems);
    const first = firstDetailsError(problems);
    if (first) {
      setError('');
      refs[first].current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = (await enrolCall('/api/enroll/register', 'POST', null, {
        invite: values.invite.trim(),
        handle: values.handle.trim(),
        email: values.email.trim(),
        password: values.password,
      })) as { csrf: string };
      // The password is not needed again: drop it from memory before moving on.
      setValues((current) => ({ ...current, password: '', again: '' }));
      setCsrf(data.csrf);
      setStep('authenticator');
      void loadAuthenticator(data.csrf);
    } catch (failure) {
      const upstream = failure instanceof EnrolFailure ? failure.upstreamCode : undefined;
      const message = fail(failure, 'register');
      const field = failureField(upstream);
      if (field) {
        setErrors({ [field]: message });
        refs[field].current?.focus();
      } else setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!csrf || code.length !== 6) return;
    setBusy(true);
    setError('');
    try {
      await enrolCall('/api/enroll/authenticator/confirm', 'POST', csrf, { code, secret });
      // The secret has done its job: only the recovery codes are kept.
      setSecret('');
      setUri('');
      setCode('');
      setStep('recovery');
    } catch (failure) {
      setError(fail(failure, 'confirm'));
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!csrf) return;
    setBusy(true);
    setError('');
    try {
      const data = (await enrolCall('/api/enroll/finish', 'POST', csrf, {})) as { userId: string };
      setUserId(data.userId);
      setRecoveryCodes([]);
      setCsrf(null);
      setStep('done');
    } catch (failure) {
      setError(fail(failure, 'finish'));
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    if (!csrf) return;
    setBusy(true);
    setError('');
    try {
      await createPasskey(csrf, stepUpHeld && !passkeyCode ? null : passkeyCode, () => {
        setStepUpHeld(true);
        setPasskeyCode('');
      });
      setBusy(false);
      await finish();
    } catch (failure) {
      setBusy(false);
      // A code that was refused, or a step-up that has lapsed, means a new code is needed.
      if (
        failure instanceof EnrolFailure &&
        ['auth.mfa_invalid', 'auth.mfa_required', 'auth.too_many_attempts'].includes(failure.upstreamCode ?? '')
      )
        setStepUpHeld(false);
      setPasskeyCode('');
      if (failure instanceof DOMException && failure.name === 'NotAllowedError') setError('Passkey setup was cancelled.');
      else if (failure instanceof EnrolFailure && failure.code === 'passkey_cancelled') setError('Passkey setup was cancelled.');
      else if (failure instanceof EnrolFailure && failure.code.startsWith('passkey_'))
        setError("This browser couldn't create a passkey. You can skip this step.");
      else setError(fail(failure, 'passkey'));
    }
  }

  async function abandon() {
    setBusy(true);
    try {
      if (csrf) await enrolCall('/api/enroll', 'DELETE', csrf);
    } catch {
      // The cookie lapses on its own within 30 minutes either way.
    }
    setBusy(false);
    setCsrf(null);
    setSecret('');
    setUri('');
    setRecoveryCodes([]);
    setLeaving(false);
    setError('');
    setValues({ invite: '', email: '', handle: '', password: '', again: '' });
    setStep('closed');
  }

  async function copy(text: string, which: 'secret' | 'id') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Couldn't copy. Select the text and copy it by hand.");
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([recoveryCodesText(recoveryCodes)], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'intafaced-recovery-codes.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const midway = step === 'authenticator' || step === 'recovery' || step === 'passkey';
  return (
    <div ref={root}>
      {step === 'checking' && (
        <Section>
          <h2 tabIndex={-1}>Checking…</h2>
          <p role="status">Checking whether enrolment is open.</p>
        </Section>
      )}
      {step === 'unreachable' && (
        <Section>
          <h2 tabIndex={-1}>Couldn't check</h2>
          <div className="adm-enrol__stack">
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
            <button type="button" onClick={() => void checkStatus()}>
              Try again
            </button>
          </div>
        </Section>
      )}
      {step === 'closed' && <EnrolmentClosed />}
      {step === 'details' && (
        <DetailsStep
          values={values}
          errors={errors}
          error={error}
          busy={busy}
          refs={refs}
          onChange={(name, value) => {
            setValues((current) => ({ ...current, [name]: value }));
            setErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
          }}
          onSubmit={() => void register()}
        />
      )}
      {step === 'authenticator' && (
        <AuthenticatorStep
          uri={uri}
          secret={secret}
          code={code}
          error={error}
          busy={busy}
          loading={loading}
          copied={copied === 'secret'}
          codeRef={codeRef}
          onCode={(value) => {
            setCode(value);
            setError('');
          }}
          onCopy={() => void copy(secret, 'secret')}
          onConfirm={() => void confirm()}
          onRetry={() => csrf && void loadAuthenticator(csrf)}
        />
      )}
      {step === 'recovery' && (
        <RecoveryStep
          codes={recoveryCodes}
          saved={saved}
          onSaved={setSaved}
          onDownload={download}
          onPrint={() => window.print()}
          onContinue={() => {
            setError('');
            setStep('passkey');
          }}
        />
      )}
      {step === 'passkey' && (
        <>
          <PasskeyStep
            supported={typeof window !== 'undefined' && Boolean(window.PublicKeyCredential)}
            code={passkeyCode}
            needsCode={!stepUpHeld}
            codeRef={passkeyCodeRef}
            onCode={(value) => {
              setPasskeyCode(value);
              setError('');
            }}
            error={error}
            busy={busy}
            onAdd={() => void addPasskey()}
            onSkip={() => void finish()}
          />
        </>
      )}
      {step === 'done' && <DoneStep userId={userId} copied={copied === 'id'} onCopy={() => void copy(userId, 'id')} />}
      {midway && (
        <div className="adm-enrol__stack adm-enrol__no-print">
          {leaving ? (
            <Callout
              tone="warn"
              role="alert"
              actions={
                <>
                  <button type="button" disabled={busy} onClick={() => void abandon()}>
                    Yes, cancel enrolment
                  </button>
                  <button type="button" disabled={busy} onClick={() => setLeaving(false)}>
                    Keep going
                  </button>
                </>
              }
            >
              Your invite has already been used. If you cancel now, ask Nitro what to do next.
            </Callout>
          ) : (
            <button type="button" className="adm-enrol__quiet" onClick={() => setLeaving(true)}>
              Cancel enrolment
            </button>
          )}
        </div>
      )}
    </div>
  );
}
