'use client';
import { useRef, useState } from 'react';
import { submitProps } from '@/lib/crm-form-state';
import { Callout } from './crm-callout';
import './founder-reset.css';

/*
 * Forgotten password, with no email: the founder proves they hold the authenticator app AND an unused recovery code. Nothing
 * typed here is kept anywhere but React state, and the codes and passwords are cleared after every attempt.
 */

export const RESET_REFUSED = "We couldn't reset your password with those details.";
export const RESET_WAIT = 'Too many attempts. Wait a few minutes, then try again.';

export interface ResetValues {
  identifier: string;
  totpCode: string;
  recoveryCode: string;
  newPassword: string;
  again: string;
}
export type ResetFieldErrors = Partial<Record<keyof ResetValues, string>>;
const ORDER: (keyof ResetValues)[] = ['identifier', 'totpCode', 'recoveryCode', 'newPassword', 'again'];

/** Checks that run before anything is sent. They only say what is missing or mistyped, never anything about an account. */
export function resetFieldErrors(values: ResetValues): ResetFieldErrors {
  const errors: ResetFieldErrors = {};
  if (!values.identifier.trim()) errors.identifier = 'Enter your email or handle.';
  if (!/^\d{6}$/.test(values.totpCode.trim())) errors.totpCode = 'Enter the 6-digit code from your authenticator app.';
  if (!/^[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5}$/.test(values.recoveryCode.trim()))
    errors.recoveryCode = 'Enter an unused recovery code, like ABCDE-12345.';
  if (values.newPassword.length < 12) errors.newPassword = 'Use at least 12 characters.';
  else if (values.newPassword.length > 200) errors.newPassword = 'Use 200 characters or fewer.';
  else if (values.again !== values.newPassword) errors.again = "The two passwords don't match.";
  return errors;
}

export const firstResetError = (errors: ResetFieldErrors): keyof ResetValues | null => ORDER.find((field) => errors[field]) ?? null;

/** One message for every refusal, so the page tells nobody whether an account exists. Only the wait message differs. */
export function resetMessage(code: string): string {
  return code === 'admin.reset_rate_limited' || code === 'admin.rate_limited' ? RESET_WAIT : RESET_REFUSED;
}

export function FounderReset() {
  const [values, setValues] = useState<ResetValues>({ identifier: '', totpCode: '', recoveryCode: '', newPassword: '', again: '' });
  const [fieldErrors, setFieldErrors] = useState<ResetFieldErrors>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fields = {
    identifier: useRef<HTMLInputElement>(null),
    totpCode: useRef<HTMLInputElement>(null),
    recoveryCode: useRef<HTMLInputElement>(null),
    newPassword: useRef<HTMLInputElement>(null),
    again: useRef<HTMLInputElement>(null),
  };
  const set = (name: keyof ResetValues, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
  };
  const field = (name: keyof ResetValues) => ({
    ref: fields[name],
    value: values[name],
    onChange: (event: { target: { value: string } }) => set(name, event.target.value),
    'aria-invalid': fieldErrors[name] ? (true as const) : undefined,
    'aria-describedby': fieldErrors[name] ? `reset-${name}-error` : undefined,
  });
  const fieldError = (name: keyof ResetValues) =>
    fieldErrors[name] ? (
      <small id={`reset-${name}-error`} role="alert" className="adm-field-error">
        {fieldErrors[name]}
      </small>
    ) : null;
  return (
    <div className="adm-reset">
      <h1>Forgot your password?</h1>
      <p>There is no reset email. Pick the way that matches what you still have.</p>

      <section aria-labelledby="reset-app-title">
        <h2 id="reset-app-title">I have my authenticator app and a recovery code</h2>
        <p className="adm-subtle">
          This needs both: the current code from your app and one recovery code you have not used. If you have lost both, contact Nitro.
        </p>
        <form
          className="adm-form"
          noValidate
          onSubmit={async (event) => {
            event.preventDefault();
            const problems = resetFieldErrors(values);
            setFieldErrors(problems);
            const first = firstResetError(problems);
            if (first) {
              setError('');
              fields[first].current?.focus();
              return;
            }
            setBusy(true);
            setError('');
            try {
              const response = await fetch('/api/reset', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  identifier: values.identifier.trim(),
                  totpCode: values.totpCode.trim(),
                  recoveryCode: values.recoveryCode.trim(),
                  newPassword: values.newPassword,
                }),
              });
              const data: unknown = await response.json().catch(() => null);
              if (!response.ok) {
                const code = data && typeof data === 'object' && 'code' in data ? String(data.code) : '';
                setError(
                  code.includes('unconfigured')
                    ? 'The founder workspace is awaiting deployment configuration.'
                    : code === 'admin.upstream_unavailable'
                      ? "Couldn't reach the server. Try again in a moment."
                      : resetMessage(code),
                );
                return;
              }
              window.location.assign('/login?changed=1');
            } catch {
              setError("Couldn't reach the server. Check your connection and try again.");
            } finally {
              setValues((current) => ({ ...current, totpCode: '', recoveryCode: '', newPassword: '', again: '' }));
              setBusy(false);
            }
          }}
        >
          <div className="adm-login-field">
            <label>
              Email or handle
              <input {...field('identifier')} autoComplete="username" required maxLength={254} />
            </label>
            {fieldError('identifier')}
          </div>
          <div className="adm-login-field">
            <label>
              Code from your authenticator app
              <input {...field('totpCode')} autoComplete="one-time-code" inputMode="numeric" required maxLength={6} />
            </label>
            {fieldError('totpCode')}
          </div>
          <div className="adm-login-field">
            <label>
              Recovery code
              <input {...field('recoveryCode')} autoComplete="off" autoCapitalize="characters" spellCheck={false} required maxLength={11} />
            </label>
            {fieldError('recoveryCode')}
          </div>
          <div className="adm-login-field">
            <label>
              New password
              <input {...field('newPassword')} type="password" autoComplete="new-password" required maxLength={200} />
            </label>
            {fieldError('newPassword')}
          </div>
          <div className="adm-login-field">
            <label>
              New password again
              <input {...field('again')} type="password" autoComplete="new-password" required maxLength={200} />
            </label>
            {fieldError('again')}
          </div>
          {error && (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          )}
          <button
            type="submit"
            {...submitProps({
              disabled: busy,
              changed: Boolean(
                values.identifier.trim() && values.totpCode.trim() && values.recoveryCode.trim() && values.newPassword && values.again,
              ),
            })}
          >
            {busy ? 'Resetting…' : 'Reset password'}
          </button>
        </form>
      </section>

      <section aria-labelledby="reset-passkey-title">
        <h2 id="reset-passkey-title">I have a passkey</h2>
        <p>
          <a className="adm-link" href="/login">
            Sign in with your passkey
          </a>
          , then open Security and use &ldquo;Forgot it?&rdquo; under Password to set a new one. You will not need the old one.
        </p>
      </section>

      <p>
        <a className="adm-link" href="/login">
          Back to sign in
        </a>
      </p>
    </div>
  );
}
