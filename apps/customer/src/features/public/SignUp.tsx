import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, Failure, Field } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { singleFlight } from '../../shared/password';
import { useSession } from '../session/session';
import { navigate } from '../../app/location';
import { publicAuthContext, publicAuthHref } from './auth-context';
import { validAuthSession } from './public-auth-guards';
import {
  countryOptions,
  secondsLeft,
  signUpAcceptedSchema,
  signUpCode,
  signUpConfirmedSchema,
  todayIso,
  type AccountType,
  type Channel,
} from './sign-up';
import { signUpCopy } from './sign-up-copy';
import { SocialSignIn } from './SocialSignIn';
import './public-pages.css';
import './sign-up.css';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Pending = { flowId: string; email: string; resendAt: number; accountType: AccountType };

/**
 * /register (I-signin-sessions-18, I-kyc-compliance-06). Step 1 sends the details and the service mails a code; no
 * account and no session exist yet. Step 2 takes the code: the right one opens the account, proves the email and signs
 * in. Every refusal is the service's own, worded here by its code. The password and the code are read from the form
 * when it is sent and never kept in state, storage or logs.
 */
export function SignUp() {
  const { t, requestedLocale } = signUpCopy.useCopy();
  const { api, commit, restoring } = useSession();
  const context = publicAuthContext(location.pathname, location.search);
  const [accountType, setAccountType] = useState<AccountType>('individual');
  const [channel, setChannel] = useState<Channel>('email');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [resent, setResent] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const flight = useRef(singleFlight()).current;
  const form = useRef<HTMLFormElement | null>(null);
  const mounted = useRef(true);
  const problemId = useId();
  const countries = useMemo(() => countryOptions(requestedLocale), [requestedLocale]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>('input:not([type=radio])')?.focus();
  }, [pending?.flowId]);
  // The resend clock: one tick a second while a code step is open and the wait is not over.
  useEffect(() => {
    if (!pending || secondsLeft(pending.resendAt, now) === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [pending, now]);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (flight.busy || restoring) return;
    const data = new FormData(event.currentTarget);
    const field = (name: string) => String(data.get(name) ?? '').trim();
    const email = field('email');
    const nationality = field('nationality');
    const input = {
      channel,
      accountType,
      handle: field('handle'),
      ...(channel === 'email' ? { email } : { phone: field('phone') }),
      password: String(data.get('password') ?? ''),
      country: field('country'),
      ...(nationality ? { nationality } : {}),
      dateOfBirth: field('dateOfBirth'),
      // Signing up from an invitation link names its referrer when the account is made (CM-referral-01, RF-1).
      ...(context.invite ? { inviteToken: context.invite } : {}),
    };
    await flight.run(async () => {
      setBusy(true);
      setRefusal(null);
      const answer = await api.mutate('identity', 'auth.signUpStart', input, signUpAcceptedSchema);
      if (!mounted.current) return;
      setBusy(false);
      const password = form.current?.elements.namedItem('password');
      if (password instanceof HTMLInputElement) password.value = '';
      if (!answer.ok) {
        setRefusal(answer);
        return;
      }
      setResent(false);
      setNow(Date.now());
      setPending({ flowId: answer.data.flowId, email, resendAt: Date.now() + answer.data.resendAfterSeconds * 1000, accountType });
    });
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending || flight.busy) return;
    const input = event.currentTarget.elements.namedItem('code');
    const code = input instanceof HTMLInputElement ? input.value.trim() : '';
    if (!code) {
      setRefusal({ ok: false, reason: 'error', message: t('codeMissing'), code: 'codeMissing' });
      return;
    }
    await flight.run(async () => {
      setBusy(true);
      setRefusal(null);
      const answer = await api.mutate('identity', 'auth.signUpConfirm', { flowId: pending.flowId, code }, signUpConfirmedSchema);
      if (!mounted.current) return;
      setBusy(false);
      if (!answer.ok) {
        if (input instanceof HTMLInputElement) input.value = '';
        setRefusal(answer);
        return;
      }
      const { accountType: chosen, ...session } = answer.data;
      if (!validAuthSession(session)) {
        setRefusal({ ok: false, reason: 'uncertain', message: t('identity.signup_code_used') });
        return;
      }
      commit(session);
      navigate(
        context.invite
          ? `/invite?token=${encodeURIComponent(context.invite)}`
          : chosen === 'business'
            ? '/identbusiness'
            : context.destination,
        true,
      );
    });
  }

  async function resend() {
    if (!pending || flight.busy) return;
    await flight.run(async () => {
      setBusy(true);
      setRefusal(null);
      const answer = await api.mutate('identity', 'auth.signUpResend', { flowId: pending.flowId }, signUpAcceptedSchema);
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
  const code = refusal ? signUpCode(refusal) : undefined;
  const problem =
    refusal?.code === 'codeMissing'
      ? t('codeMissing')
      : code === 'auth.too_many_attempts'
        ? t(code, { minutes: Math.max(1, Math.ceil((refusal?.retryAfterSeconds ?? 60) / 60)) })
        : code === 'identity.resend_too_soon' && wait > 0
          ? t('resendIn', { seconds: wait })
          : code
            ? t(code)
            : null;

  return (
    <div className="pub-page">
      <header className="pub-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('title')}</h1>
        <p className="muted">{t('intro')}</p>
      </header>
      <ol className="pub-steps" aria-label={t('stepsLabel')}>
        <li className={`pub-step pub-step--${pending ? 'done' : 'current'}`} aria-current={pending ? undefined : 'step'}>
          <span className="pub-step__number">{t('stepNumber', { number: 1 })}</span>
          <h2>{t('step1')}</h2>
          {!pending && (
            <form ref={form} method="post" className="pub-form" onSubmit={start}>
              <fieldset className="pub-choice" disabled={busy}>
                <legend>{t('accountType')}</legend>
                {(['individual', 'business'] as const).map((kind) => (
                  <label key={kind}>
                    <input
                      type="radio"
                      name="accountType"
                      value={kind}
                      checked={accountType === kind}
                      onChange={() => setAccountType(kind)}
                    />{' '}
                    {t(kind)} <small className="muted">{t(kind === 'individual' ? 'individualHint' : 'businessHint')}</small>
                  </label>
                ))}
              </fieldset>
              <fieldset className="pub-choice" disabled={busy}>
                <legend>{t('channel')}</legend>
                {(['email', 'phone'] as const).map((kind) => (
                  <label key={kind}>
                    <input type="radio" name="channel" value={kind} checked={channel === kind} onChange={() => setChannel(kind)} />{' '}
                    {t(kind)}
                  </label>
                ))}
              </fieldset>
              {channel === 'email' ? (
                <Field label={t('emailField')} name="email" type="email" autoComplete="email" maxLength={320} required disabled={busy} />
              ) : (
                <Field label={t('phoneField')} name="phone" type="tel" autoComplete="tel" maxLength={20} required disabled={busy} />
              )}
              <Field
                label={t('handle')}
                name="handle"
                autoComplete="username"
                hint={t('handleHint')}
                minLength={3}
                maxLength={32}
                pattern="[a-zA-Z0-9_]+"
                required
                disabled={busy}
              />
              <Field
                label={t('password')}
                name="password"
                type="password"
                autoComplete="new-password"
                hint={t('passwordRule')}
                maxLength={200}
                required
                disabled={busy}
              />
              <label className="field">
                <span>{t('country')}</span>
                <select name="country" required disabled={busy} defaultValue="">
                  <option value="" disabled>
                    {t('countryPick')}
                  </option>
                  {countries.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('nationality')}</span>
                <select name="nationality" disabled={busy} defaultValue="">
                  <option value="">{t('nationalityPick')}</option>
                  {countries.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <Field label={t('dateOfBirth')} name="dateOfBirth" type="date" max={todayIso()} required disabled={busy} />
              <Button type="submit" disabled={busy || restoring} aria-describedby={problem ? problemId : undefined}>
                {busy ? t('sending') : t('create')}
              </Button>
            </form>
          )}
          {!pending && <SocialSignIn />}
        </li>
        <li className={`pub-step pub-step--${pending ? 'current' : 'upcoming'}`} aria-current={pending ? 'step' : undefined}>
          <span className="pub-step__number">{t('stepNumber', { number: 2 })}</span>
          <h2>{pending ? t('checkEmail') : t('step2')}</h2>
          {pending && (
            <form ref={form} method="post" className="pub-form" onSubmit={confirm}>
              <p role="status" className="muted">
                {t('checkEmailBody', { email: pending.email })}
              </p>
              {resent && <p className="muted">{t('resent')}</p>}
              <Field
                label={t('code')}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={12}
                required
                disabled={busy}
                aria-describedby={problem ? problemId : undefined}
              />
              <Button type="submit" disabled={busy}>
                {busy ? t('confirming') : t('confirm')}
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
                }}
              >
                {t('differentEmail')}
              </Button>
            </form>
          )}
        </li>
      </ol>
      {problem ? (
        <div id={problemId} className="pub-notice" role="alert">
          <p>{problem}</p>
          {refusal?.code && refusal.code !== 'codeMissing' && <small lang="zxx">{refusal.code}</small>}
          {(code === 'identity.signup_code_used' || code === 'auth.email_taken') && (
            <a className="text-link" href={publicAuthHref(context, '/login')}>
              {t('signIn')}
            </a>
          )}
        </div>
      ) : (
        refusal && (
          <div id={problemId}>
            <Failure result={refusal} />
          </div>
        )
      )}
      <p className="muted">
        {t('haveAccount')}{' '}
        <a className="text-link" href={publicAuthHref(context, '/login')}>
          {t('signIn')}
        </a>
      </p>
    </div>
  );
}
