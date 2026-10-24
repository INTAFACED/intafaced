import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Failure, Field } from '../../shared/ui';
import type { ApiResult, DeviceAuthorisation } from '../../shared/api';
import { singleFlight } from '../../shared/password';
import { sessionSchema, useSession } from '../session/session';
import { navigate } from '../../app/location';
import { publicAuthContext } from './auth-context';
import { validAuthSession } from './public-auth-guards';
import { secondsLeft } from './sign-up';
import { codeSignInCode, loginCodeAcceptedSchema } from './code-sign-in';
import { codeSignInCopy } from './code-sign-in-copy';
import { DeviceApproval } from './DeviceApproval';
import './public-pages.css';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Pending = { flowId: string; name: string; resendAt: number };

/**
 * Sign-in by a mailed code on /login (I-signin-sessions-19, -20). Step 1 sends the email or handle; the service answers
 * the same for every name and mails a code only to an account that exists. Step 2 takes the code, and the authenticator
 * code too when the account asks for its second step. The codes are read from the form when it is sent and never kept
 * in state, storage or logs.
 */
export function CodeSignIn() {
  const { t } = codeSignInCopy.useCopy();
  const { api, commit, restoring } = useSession();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [needsTotp, setNeedsTotp] = useState(false);
  const [resent, setResent] = useState(false);
  const [waitingDevice, setWaitingDevice] = useState<DeviceAuthorisation | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const flight = useRef(singleFlight()).current;
  const mounted = useRef(true);
  const problemId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pending || secondsLeft(pending.resendAt, now) === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [pending, now]);

  async function request(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (flight.busy || restoring) return;
    const name = String(new FormData(event.currentTarget).get('codeIdentifier') ?? '').trim();
    if (!name) return;
    await flight.run(async () => {
      setBusy(true);
      setRefusal(null);
      const answer = await api.mutate('identity', 'auth.loginCodeRequest', { identifier: name }, loginCodeAcceptedSchema);
      if (!mounted.current) return;
      setBusy(false);
      if (!answer.ok) {
        setRefusal(answer);
        return;
      }
      setResent(false);
      setNeedsTotp(false);
      setNow(Date.now());
      setPending({ flowId: answer.data.flowId, name, resendAt: Date.now() + answer.data.resendAfterSeconds * 1000 });
    });
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending || flight.busy) return;
    const form = event.currentTarget;
    const read = (name: string) => {
      const input = form.elements.namedItem(name);
      return input instanceof HTMLInputElement ? input.value.trim() : '';
    };
    const code = read('loginCode');
    const totpCode = read('loginTotp');
    if (!code) {
      setRefusal({ ok: false, reason: 'error', message: t('codeMissing'), code: 'codeMissing' });
      return;
    }
    await flight.run(async () => {
      setBusy(true);
      setRefusal(null);
      const answer = await api.mutate(
        'identity',
        'auth.loginWithCode',
        { flowId: pending.flowId, code, ...(totpCode ? { totpCode } : {}) },
        sessionSchema,
      );
      if (!mounted.current) return;
      setBusy(false);
      if (!answer.ok) {
        // The mailed code stays in the field while only the second step is missing; anything else clears both.
        if (answer.code === 'auth.mfa_required') setNeedsTotp(true);
        else form.querySelectorAll('input').forEach((input) => (input.value = ''));
        // Every factor passed on a browser this account has not trusted yet: the approval step takes over.
        if (answer.code === 'auth.device_authorisation_required' && answer.deviceAuthorisation) {
          setWaitingDevice(answer.deviceAuthorisation);
          return;
        }
        setRefusal(answer);
        return;
      }
      if (!validAuthSession(answer.data)) {
        setRefusal({ ok: false, reason: 'uncertain', message: t('auth.code_invalid') });
        return;
      }
      commit(answer.data);
      afterSignIn();
    });
  }

  /** Signing in from an invitation goes back to it, as the password form does. */
  function afterSignIn() {
    const context = publicAuthContext(location.pathname, location.search);
    navigate(context.invite ? `/invite?token=${encodeURIComponent(context.invite)}` : context.destination, true);
  }

  async function resend() {
    if (!pending || flight.busy) return;
    await flight.run(async () => {
      setBusy(true);
      setRefusal(null);
      const answer = await api.mutate('identity', 'auth.loginCodeResend', { flowId: pending.flowId }, loginCodeAcceptedSchema);
      if (!mounted.current) return;
      setBusy(false);
      if (!answer.ok) {
        setRefusal(answer);
        return;
      }
      setResent(true);
      setNow(Date.now());
      setPending({ ...pending, resendAt: Date.now() + answer.data.resendAfterSeconds * 1000 });
    });
  }

  const wait = pending ? secondsLeft(pending.resendAt, now) : 0;
  const code = refusal ? codeSignInCode(refusal) : undefined;
  const problem =
    refusal?.code === 'codeMissing'
      ? t('codeMissing')
      : code === 'auth.too_many_attempts'
        ? t(code, { minutes: Math.max(1, Math.ceil((refusal?.retryAfterSeconds ?? 60) / 60)) })
        : code === 'identity.resend_too_soon' && wait > 0
          ? t('resendIn', { seconds: wait })
          : code === 'auth.account_frozen' && refusal?.accountState === 'closed'
            ? t('closed')
            : code
              ? t(code)
              : null;

  if (waitingDevice) {
    return (
      <DeviceApproval
        waiting={waitingDevice}
        onSignedIn={afterSignIn}
        onCancel={() => {
          setWaitingDevice(null);
          setPending(null);
        }}
      />
    );
  }
  return (
    <section className="public-auth-code" aria-labelledby={`${problemId}-title`}>
      <h2 id={`${problemId}-title`}>{pending ? t('checkEmail') : t('title')}</h2>
      {pending ? (
        <form method="post" className="form-stack" onSubmit={confirm}>
          <p role="status" className="muted">
            {t('checkEmailBody', { name: pending.name })}
          </p>
          {resent && <p className="muted">{t('resent')}</p>}
          <Field
            label={t('code')}
            name="loginCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
            required
            disabled={busy}
            aria-describedby={problem ? problemId : undefined}
          />
          {needsTotp && (
            <Field label={t('totp')} name="loginTotp" autoComplete="off" hint={t('totpHint')} maxLength={64} required disabled={busy} />
          )}
          <Button type="submit" disabled={busy}>
            {busy ? t('checking') : t('signIn')}
          </Button>
          <Button variant="secondary" disabled={busy || wait > 0} onClick={() => void resend()}>
            {t('resend')}
          </Button>
          {wait > 0 && <small className="muted">{t('resendIn', { seconds: wait })}</small>}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setPending(null);
              setRefusal(null);
              setNeedsTotp(false);
            }}
          >
            {t('differentName')}
          </Button>
        </form>
      ) : (
        <form method="post" className="form-stack" onSubmit={request}>
          <p className="muted">{t('intro')}</p>
          <Field label={t('identifier')} name="codeIdentifier" autoComplete="username" maxLength={320} required disabled={busy} />
          <Button variant="secondary" type="submit" disabled={busy || restoring}>
            {busy ? t('sending') : t('send')}
          </Button>
        </form>
      )}
      {problem ? (
        <div id={problemId} className="pub-notice" role="alert">
          <p>{problem}</p>
          {code === 'auth.account_frozen' && (
            <a className="text-link" href="/help">
              {t('stateHelp')}
            </a>
          )}
          {refusal?.code && refusal.code !== 'codeMissing' && <small lang="zxx">{refusal.code}</small>}
        </div>
      ) : (
        refusal && (
          <div id={problemId}>
            <Failure result={refusal} />
          </div>
        )
      )}
    </section>
  );
}
