import { useEffect, useRef, useState, type FormEvent } from 'react';
import { mfaResetViewSchema, type MfaResetView } from '@intafaced/contracts/identity';
import { Button, Failure, Field } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session/session';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { mfaResetCopy } from './mfa-reset-copy';

type View = MfaResetView;
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

const WORDED = [
  'identity.mfa_reset_unconfigured',
  'identity.mfa_reset_no_proved_address',
  'identity.mfa_reset_not_enrolled',
  'identity.security_locked',
  'auth.invalid_credentials',
  'auth.code_invalid',
  'auth.code_expired',
  'auth.too_many_attempts',
  'auth.codes_unwired',
  'vendor.email',
] as const;
type Worded = (typeof WORDED)[number];
const worded = (code: string | undefined): code is Worded => (WORDED as readonly string[]).includes(code ?? '');
/** Refusals that only Support can answer: the page points there. */
const TO_SUPPORT = new Set<string>([
  'identity.mfa_reset_unconfigured',
  'identity.mfa_reset_no_proved_address',
  'identity.security_locked',
  'auth.codes_unwired',
  'vendor.email',
]);

/**
 * "I lost my authenticator" on /login (I-signin-sessions-12, J-identity-05 #2): the locked-out reset. The password again,
 * then the mailed code, then the waiting time with who was told. A blank waiting setting refuses and points to Support.
 * Nothing typed here is kept in state after it is sent, in storage or in logs.
 */
export function MfaReset({ identifier, onBack }: { identifier: string; onBack: () => void }) {
  const { t, languageFor } = mfaResetCopy.useCopy();
  const { api } = useSession();
  const { timeZone } = usePreferences();
  const when = (iso: string) => stamp(iso, timeZone);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function send(
    event: FormEvent<HTMLFormElement>,
    procedure: 'mfaReset.start' | 'mfaReset.confirm',
    read: (form: HTMLFormElement) => object,
  ) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const input = read(form);
    form.querySelectorAll<HTMLInputElement>('input[type=password], input[name=mfaResetCode]').forEach((field) => (field.value = ''));
    setBusy(true);
    setRefusal(null);
    const answer = await api.mutate('identity', procedure, input, mfaResetViewSchema);
    if (!mounted.current) return;
    setBusy(false);
    if (answer.ok) setView(answer.data);
    else setRefusal(answer);
  }
  const value = (form: HTMLFormElement, name: string) => {
    const field = form.elements.namedItem(name);
    return field instanceof HTMLInputElement ? field.value.trim() : '';
  };

  const code = refusal?.code;
  return (
    <section className="public-auth-mfa-reset stack" aria-labelledby="mfa-reset-title">
      <h2 id="mfa-reset-title" lang={languageFor('title')}>
        {t('title')}
      </h2>
      {view?.state === 'waiting' ? (
        <div className="stack">
          <p className="notice" role="status" lang={languageFor('waiting')}>
            <strong>{t('waiting', { time: when(view.completesAt) })}</strong>
          </p>
          <p lang={languageFor('told')}>{t('told', { email: view.told.email })}</p>
          {view.told.sms && <p lang={languageFor('noSms')}>{t('noSms')}</p>}
          <p lang={languageFor('notYou')}>{t('notYou')}</p>
          <p lang={languageFor('after')}>{t('after')}</p>
        </div>
      ) : view?.state === 'code_sent' ? (
        <form
          className="form-stack"
          onSubmit={(event) =>
            void send(event, 'mfaReset.confirm', (form) => ({ resetId: view.resetId, code: value(form, 'mfaResetCode') }))
          }
        >
          <p role="status" lang={languageFor('mailed')}>
            {t('mailed', { email: view.email, time: when(view.codeExpiresAt) })}
          </p>
          <Field label={t('code')} name="mfaResetCode" inputMode="numeric" autoComplete="one-time-code" required disabled={busy} />
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? t('confirming') : t('confirm')}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setRefusal(null);
                setView(null);
              }}
            >
              {t('newCode')}
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="form-stack"
          onSubmit={(event) =>
            void send(event, 'mfaReset.start', (form) => ({
              identifier: value(form, 'mfaResetIdentifier'),
              password: value(form, 'mfaResetPassword'),
            }))
          }
        >
          <p lang={languageFor('intro')}>{t('intro')}</p>
          <Field
            label={t('identifier')}
            name="mfaResetIdentifier"
            autoComplete="username"
            required
            defaultValue={identifier}
            disabled={busy}
          />
          <Field label={t('password')} name="mfaResetPassword" type="password" autoComplete="current-password" required disabled={busy} />
          <Button type="submit" disabled={busy}>
            {busy ? t('sending') : t('send')}
          </Button>
        </form>
      )}
      {refusal &&
        (worded(code) && refusal.reason !== 'uncertain' ? (
          <div data-testid="failure" className="failure" role="alert">
            <p lang={languageFor(code)}>{t(code)}</p>
            {TO_SUPPORT.has(code) && (
              <a className="text-link" href="/help" lang={languageFor('support')}>
                {t('support')}
              </a>
            )}
          </div>
        ) : (
          <Failure result={refusal} />
        ))}
      <Button variant="secondary" onClick={onBack}>
        {t('back')}
      </Button>
    </section>
  );
}
