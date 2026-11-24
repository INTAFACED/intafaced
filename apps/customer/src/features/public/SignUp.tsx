// volt-room: /register
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, Field, Radio } from '@intafaced/ui/lit';
import { FlowTemplate, SelectField } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../shared/api';
import { FailureNote } from '../../shared/failure-note';
import { singleFlight } from '../../shared/password';
import { useSession } from '../session';
import { navigate } from '../../app/location';
import { publicAuthContext, publicAuthHref } from './auth-context';
import { validAuthSession } from './public-auth-guards';
import { countryOptions, secondsLeft, signUpCode, signUpConfirmedSchema, todayIso, type AccountType, type Channel } from './sign-up';
import { signUpCopy } from './sign-up-copy';
import { subdivisionOptions } from './subdivisions';
import { SocialSignIn } from './SocialSignIn';
import {
  IDENTITY_AUTH_SIGN_UP_PASSWORD_SCREENING,
  IDENTITY_AUTH_SIGN_UP_START,
  IDENTITY_AUTH_SIGN_UP_RESEND,
} from '@intafaced/contracts/identity-auth-procedures';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/** The service's own sentence saying why a region is blocked ("Ontario, Canada is not served at launch."), or none. */
const GENERAL_BLOCK = 'We cannot open accounts for this country right now.';
function blockReason(refusal: Refusal | null): string | undefined {
  const reason = refusal?.message.trim();
  return reason && reason !== GENERAL_BLOCK ? reason : undefined;
}
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
  const [country, setCountry] = useState('');
  const [subdivision, setSubdivision] = useState('');
  const [nationality, setNationality] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [resent, setResent] = useState(false);
  const [screening, setScreening] = useState<'on' | 'unset' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const flight = useRef(singleFlight()).current;
  const form = useRef<HTMLFormElement | null>(null);
  const mounted = useRef(true);
  const problemId = useId();
  const countries = useMemo(() => countryOptions(requestedLocale), [requestedLocale]);
  const provinces = useMemo(() => subdivisionOptions(country), [country]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>('input:not([type=radio])')?.focus();
  }, [pending?.flowId]);
  // Whether the owner's breached-password list is set: when it is not, the page says so beside the password rule.
  useEffect(() => {
    const controller = new AbortController();
    void api.call(IDENTITY_AUTH_SIGN_UP_PASSWORD_SCREENING, undefined, { signal: controller.signal }).then((answer) => {
      if (!controller.signal.aborted && answer.ok) setScreening(answer.data.breachedList);
    });
    return () => controller.abort();
  }, [api]);
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
    const subdivision = field('subdivision');
    // Left unanswered, the question is sent as no answer at all, and the service refuses it: never read as no.
    const usPerson = field('usPerson');
    const input = {
      channel,
      accountType,
      handle: field('handle'),
      ...(channel === 'email' ? { email } : { phone: field('phone') }),
      password: String(data.get('password') ?? ''),
      country: field('country'),
      ...(subdivision ? { subdivision } : {}),
      ...(usPerson === 'yes' ? { usPerson: true } : usPerson === 'no' ? { usPerson: false } : {}),
      ...(nationality ? { nationality } : {}),
      dateOfBirth: field('dateOfBirth'),
      // Signing up from an invitation link names its referrer when the account is made (CM-referral-01, RF-1).
      ...(context.invite ? { inviteToken: context.invite } : {}),
    };
    await flight.run(async () => {
      setBusy(true);
      setRefusal(null);
      const answer = await api.call(IDENTITY_AUTH_SIGN_UP_START, input);
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
      const answer = await api.call(IDENTITY_AUTH_SIGN_UP_RESEND, { flowId: pending.flowId });
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
          : code === 'identity.region_blocked' && blockReason(refusal)
            ? t('regionBlockedBecause', { reason: blockReason(refusal)! })
            : code === 'identity.subdivision_required' && provinces.length === 0
              ? t('subdivisionNoField')
              : code
                ? t(code)
                : null;

  return (
    <FlowTemplate
      title={t('title')}
      description={t('intro')}
      steps={{ labels: [t('step1'), t('step2')], current: pending ? 1 : 0 }}
      state={{ kind: 'ready' }}
      step={
        <div className="lt-stack" data-testid="auth-form">
          <ol className="lt-list lt-stack" aria-label={t('stepsLabel')}>
            <li className="lt-stack" data-step={pending ? 'done' : 'current'} aria-current={pending ? undefined : 'step'}>
              <span className="lt-hint">{t('stepNumber', { number: 1 })}</span>
              <h2>{t('step1')}</h2>
              {!pending && (
                <form ref={form} method="post" className="lt-stack" onSubmit={start}>
                  <fieldset className="lt-stack" disabled={busy}>
                    <legend>{t('accountType')}</legend>
                    {(['individual', 'business'] as const).map((kind) => (
                      <Radio
                        key={kind}
                        name="accountType"
                        value={kind}
                        checked={accountType === kind}
                        onSelect={() => setAccountType(kind)}
                      >
                        {t(kind)} <small className="lt-muted">{t(kind === 'individual' ? 'individualHint' : 'businessHint')}</small>
                      </Radio>
                    ))}
                  </fieldset>
                  <fieldset className="lt-stack" disabled={busy}>
                    <legend>{t('channel')}</legend>
                    {(['email', 'phone'] as const).map((kind) => (
                      <Radio key={kind} name="channel" value={kind} checked={channel === kind} onSelect={() => setChannel(kind)}>
                        {t(kind)}
                      </Radio>
                    ))}
                  </fieldset>
                  {channel === 'email' ? (
                    <Field
                      label={t('emailField')}
                      name="email"
                      type="email"
                      autoComplete="email"
                      maxLength={320}
                      required
                      disabled={busy}
                    />
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
                  {screening === 'unset' && (
                    <p className="lt-note" role="status">
                      {t('screeningUnset')}
                    </p>
                  )}
                  <SelectField
                    label={t('country')}
                    name="country"
                    required
                    disabled={busy}
                    value={country}
                    onChange={(next) => {
                      setCountry(next);
                      setSubdivision('');
                    }}
                    options={[
                      { value: '', label: t('countryPick'), disabled: true },
                      ...countries.map((c) => ({ value: c.code, label: c.name })),
                    ]}
                  />
                  {provinces.length > 0 && (
                    <SelectField
                      key={country}
                      label={t('subdivision')}
                      name="subdivision"
                      disabled={busy}
                      value={subdivision}
                      onChange={setSubdivision}
                      options={[{ value: '', label: t('subdivisionPick') }, ...provinces.map((p) => ({ value: p.code, label: p.name }))]}
                    />
                  )}
                  <fieldset className="lt-stack" disabled={busy}>
                    <legend>{t('usPerson')}</legend>
                    <small className="lt-muted">{t('usPersonHint')}</small>
                    {(['yes', 'no'] as const).map((answer) => (
                      <Radio key={answer} name="usPerson" value={answer}>
                        {t(answer === 'yes' ? 'usPersonYes' : 'usPersonNo')}
                      </Radio>
                    ))}
                  </fieldset>
                  <SelectField
                    label={t('nationality')}
                    name="nationality"
                    disabled={busy}
                    value={nationality}
                    onChange={setNationality}
                    options={[{ value: '', label: t('nationalityPick') }, ...countries.map((c) => ({ value: c.code, label: c.name }))]}
                  />
                  <Field label={t('dateOfBirth')} name="dateOfBirth" type="date" max={todayIso()} required disabled={busy} />
                  <div className="lt-actions">
                    <Button tone="primary" type="submit" disabled={busy || restoring} aria-describedby={problem ? problemId : undefined}>
                      {busy ? t('sending') : t('create')}
                    </Button>
                  </div>
                </form>
              )}
              {!pending && <SocialSignIn />}
            </li>
            <li className="lt-stack" data-step={pending ? 'current' : 'upcoming'} aria-current={pending ? 'step' : undefined}>
              <span className="lt-hint">{t('stepNumber', { number: 2 })}</span>
              <h2>{pending ? t('checkEmail') : t('step2')}</h2>
              {pending && (
                <form ref={form} method="post" className="lt-stack" onSubmit={confirm}>
                  <p role="status" className="lt-muted">
                    {t('checkEmailBody', { email: pending.email })}
                  </p>
                  {resent && <p className="lt-muted">{t('resent')}</p>}
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
                  <div className="lt-actions">
                    <Button tone="primary" type="submit" disabled={busy}>
                      {busy ? t('confirming') : t('confirm')}
                    </Button>
                    <Button tone="secondary" disabled={busy || wait > 0} onClick={() => void resend()}>
                      {t('resend')}
                    </Button>
                    <Button
                      tone="quiet"
                      disabled={busy}
                      onClick={() => {
                        setPending(null);
                        setRefusal(null);
                      }}
                    >
                      {t('differentEmail')}
                    </Button>
                  </div>
                  {wait > 0 && <small className="lt-muted">{t('resendIn', { seconds: wait })}</small>}
                </form>
              )}
            </li>
          </ol>
          {problem ? (
            <div id={problemId} className="lt-refusal" role="alert">
              <p className="lt-refusal-body">{problem}</p>
              {refusal?.code && refusal.code !== 'codeMissing' && (
                <small className="lt-ref" lang="zxx">
                  {refusal.code}
                </small>
              )}
              {/* A channel that cannot send is never swapped for another by itself: the person picks the other one. Email is
                  offered when phone fails; phone is not offered when email fails, since this build connects no text-message
                  provider, but its choice above stays open. */}
              {code === 'vendor.sms' && !pending && (
                <Button
                  tone="secondary"
                  onClick={() => {
                    setChannel('email');
                    setRefusal(null);
                  }}
                >
                  {t('useEmail')}
                </Button>
              )}
              {(code === 'identity.signup_code_used' || code === 'auth.email_taken') && (
                <a className="lt-link" href={publicAuthHref(context, '/login')}>
                  {t('signIn')}
                </a>
              )}
            </div>
          ) : (
            refusal && (
              <div id={problemId}>
                <FailureNote result={refusal} />
              </div>
            )
          )}
          <p className="lt-muted" data-testid="auth-form-links">
            {t('haveAccount')}{' '}
            <a className="lt-link" href={publicAuthHref(context, '/login')}>
              {t('signIn')}
            </a>
          </p>
        </div>
      }
    />
  );
}
