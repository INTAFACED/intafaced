import { useEffect, useId, useReducer, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button, Field } from '../../shared/ui';
import { useSession } from '../session/session';
import { navigate } from '../../app/location';
import { MAX_INPUT_LENGTH, passwordIssue, passwordProblem, singleFlight } from '../../shared/password';
import { passwordCopy } from '../../shared/password-copy';
import { ContactSupport } from './ContactSupport';
import { HandleRecovery } from './HandleRecovery';
import {
  RECOVERY_STEPS,
  clearsCode,
  completedSchema,
  initialRecovery,
  recoveryReducer,
  requestedSchema,
  stepStates,
  validEmail,
  type RecoveryStep,
} from './password-recovery';
import { recoveryCopy } from './password-recovery-copy';
import './public-pages.css';

/** Whether reset mail can leave the server at all (`auth.passwordResetChannel`); the same answer for every visitor. */
const channelSchema = z.object({ emailDelivery: z.enum(['on', 'off']) });

const TITLE = { request: 'step1', reset: 'step2', done: 'step3' } as const;
const BODY = { request: 'step1Body', reset: 'step2Body', done: 'step3Body' } as const;

/**
 * /findPwd. Ask for a code, enter it with a new password, then sign in. The page asks the identity service
 * (`auth.requestPasswordReset`, `auth.completePasswordReset`) and shows exactly what it answers: when reset is
 * switched off on the server the page says so and sends nothing further. Passwords and codes are read from the
 * form when it is sent and cleared; they are never kept in state, storage or logs.
 */
export function PasswordRecovery() {
  const copy = recoveryCopy.useCopy();
  const { t: pw } = passwordCopy.useCopy();
  const { api } = useSession();
  const [state, dispatch] = useReducer(recoveryReducer, initialRecovery);
  const flight = useRef(singleFlight()).current;
  const form = useRef<HTMLFormElement | null>(null);
  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const states = stepStates(state.step);
  const problemId = useId();
  const [mailOff, setMailOff] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api.query('identity', 'auth.passwordResetChannel', undefined, channelSchema, { signal: controller.signal }).then((channel) => {
      if (!controller.signal.aborted && channel.ok) setMailOff(channel.data.emailDelivery === 'off');
    });
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  // Move focus to the first field of whichever step just opened.
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [state.step]);

  function wipe(...names: string[]) {
    for (const name of names) {
      const input = form.current?.elements.namedItem(name);
      if (input instanceof HTMLInputElement) input.value = '';
    }
  }

  async function askCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    if (flight.busy) return;
    if (!validEmail(email)) {
      dispatch({ type: 'askCode', email });
      return;
    }
    await flight.run(async () => {
      dispatch({ type: 'askCode', email });
      const controller = new AbortController();
      abort.current = controller;
      const result = await api.mutate('identity', 'auth.requestPasswordReset', { email }, requestedSchema, { signal: controller.signal });
      if (mounted.current) dispatch({ type: 'codeAnswered', result });
    });
  }

  async function finish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Read once, here. These strings are never put in state.
    const data = new FormData(event.currentTarget);
    const code = String(data.get('code') ?? '').trim();
    const password = String(data.get('new-password') ?? '');
    const confirm = String(data.get('confirm-password') ?? '');
    if (flight.busy) return;
    const issue = !code ? 'codeMissing' : passwordIssue(password, confirm);
    if (issue) {
      dispatch({ type: 'reset', issue });
      if (issue !== 'codeMissing') wipe('confirm-password');
      return;
    }
    const answered = await flight.run(async () => {
      dispatch({ type: 'reset', issue: null });
      const controller = new AbortController();
      abort.current = controller;
      const result = await api.mutate(
        'identity',
        'auth.completePasswordReset',
        { email: state.email, code, newPassword: password },
        completedSchema,
        { signal: controller.signal },
      );
      return result;
    });
    if (!answered || !mounted.current) return;
    wipe('new-password', 'confirm-password');
    if (!answered.ok && clearsCode(passwordProblem(answered))) wipe('code');
    dispatch({ type: 'resetAnswered', result: answered });
  }

  const problem = state.problem;
  const problemText = problem ? (problem === 'invalidEmail' || problem === 'codeMissing' ? copy.t(problem) : pw(problem)) : null;
  return (
    <div className="pub-page">
      <a className="text-link" href="/login">
        ← {copy.t('backToSignIn')}
      </a>
      <header className="pub-heading">
        <h1>{copy.t('title')}</h1>
        <p className="muted">{copy.t('intro')}</p>
      </header>
      {mailOff && (
        <p className="pub-notice" role="status">
          {copy.t('mailOff')}
        </p>
      )}
      <ol className="pub-steps" aria-label={copy.t('stepsLabel')}>
        {RECOVERY_STEPS.map((step, index) => (
          <li key={step} className={`pub-step pub-step--${states[step]}`} aria-current={states[step] === 'current' ? 'step' : undefined}>
            <span className="pub-step__number">{copy.t('stepNumber', { number: index + 1 })}</span>
            <h2>{copy.t(TITLE[step])}</h2>
            <p className="muted">{copy.t(BODY[step])}</p>
            {step === state.step && (
              <StepBody
                step={step}
                formRef={form}
                busy={state.busy}
                email={state.email}
                codeAsked={state.codeAsked}
                onAsk={askCode}
                onFinish={finish}
                describedBy={problemText ? problemId : undefined}
                onRestart={() => dispatch({ type: 'restart' })}
              />
            )}
          </li>
        ))}
      </ol>
      {problemText && (
        <p id={problemId} className="pub-notice" role="alert">
          {problemText}
        </p>
      )}
      <HandleRecovery />
      <ContactSupport context="recovery" />
      <a className="text-link" href="/help">
        {copy.t('help')} →
      </a>
    </div>
  );
}

function StepBody({
  step,
  formRef,
  busy,
  email,
  codeAsked,
  onAsk,
  onFinish,
  onRestart,
  describedBy,
}: {
  step: RecoveryStep;
  formRef: React.RefObject<HTMLFormElement | null>;
  busy: boolean;
  email: string;
  codeAsked: boolean;
  onAsk: (event: FormEvent<HTMLFormElement>) => void;
  onFinish: (event: FormEvent<HTMLFormElement>) => void;
  onRestart: () => void;
  describedBy: string | undefined;
}) {
  const copy = recoveryCopy.useCopy();
  const { t: pw } = passwordCopy.useCopy();
  if (step === 'done') {
    return (
      <div className="pub-form">
        <p role="status">{copy.t('doneBody')}</p>
        <Button onClick={() => navigate('/login')}>{copy.t('signIn')}</Button>
      </div>
    );
  }
  if (step === 'request') {
    return (
      <form ref={formRef} method="post" className="pub-form" onSubmit={onAsk} noValidate>
        <Field
          label={copy.t('emailField')}
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={email}
          maxLength={320}
          required
          disabled={busy}
          aria-describedby={describedBy}
        />
        <Button type="submit" disabled={busy}>
          {busy ? copy.t('sending') : copy.t('sendCode')}
        </Button>
      </form>
    );
  }
  return (
    <form ref={formRef} method="post" className="pub-form" onSubmit={onFinish} noValidate>
      {codeAsked && (
        <p role="status" className="muted">
          {copy.t('codeOnItsWay')}
        </p>
      )}
      <Field
        label={copy.t('codeField')}
        name="code"
        autoComplete="one-time-code"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={MAX_INPUT_LENGTH}
        required
        disabled={busy}
      />
      <Field
        label={copy.t('newPasswordField')}
        name="new-password"
        type="password"
        autoComplete="new-password"
        hint={pw('hint')}
        maxLength={MAX_INPUT_LENGTH}
        required
        disabled={busy}
        aria-describedby={describedBy}
      />
      <Field
        label={copy.t('confirmField')}
        name="confirm-password"
        type="password"
        autoComplete="new-password"
        maxLength={MAX_INPUT_LENGTH}
        required
        disabled={busy}
      />
      <Button type="submit" disabled={busy}>
        {busy ? copy.t('saving') : copy.t('saveNewPassword')}
      </Button>
      <Button variant="ghost" disabled={busy} onClick={onRestart}>
        {copy.t('askAgain')}
      </Button>
    </form>
  );
}
