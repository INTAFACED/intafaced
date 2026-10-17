import { useId } from 'react';
import { Button, Field } from '../../shared/ui';
import { ContactSupport } from './ContactSupport';
import { CODE_LENGTH, RECOVERY_STEPS, controlsDisabled, stepStates, type RecoveryStep } from './password-recovery';
import { recoveryCopy } from './password-recovery-copy';
import './public-pages.css';

const TITLE = { request: 'step1', code: 'step2', password: 'step3' } as const;
const BODY = { request: 'step1Body', code: 'step2Body', password: 'step3Body' } as const;
const ACTION = { request: 'sendCode', code: 'checkCode', password: 'saveNewPassword' } as const;

/**
 * /findPwd. The whole reset journey (request, code, new password), every control disabled with the reason beside it, and the
 * way to reach a person that does not need a sign-in. See password-recovery.ts for what the identity service lacks.
 */
export function PasswordRecovery() {
  const copy = recoveryCopy.useCopy();
  const off = controlsDisabled();
  const states = stepStates('request');
  const reasonId = useId();
  return (
    <div className="pub-page">
      <a className="text-link" href="/login">
        ← {copy.t('backToSignIn')}
      </a>
      <header className="pub-heading">
        <h1>{copy.t('title')}</h1>
        <p className="muted">{copy.t('intro')}</p>
      </header>
      {off && (
        <section className="pub-notice" role="status" aria-labelledby={`${reasonId}-title`}>
          <h2 id={`${reasonId}-title`}>{copy.t('blockedTitle')}</h2>
          <p>{copy.t('blockedBody')}</p>
          <p className="muted">
            <strong>{copy.t('whatNow')}.</strong> {copy.t('whatNowBody')}
          </p>
        </section>
      )}
      <ol className="pub-steps" aria-label={copy.t('stepsLabel')}>
        {RECOVERY_STEPS.map((step, index) => (
          <li key={step} className={`pub-step pub-step--${states[step]}`} aria-current={states[step] === 'current' ? 'step' : undefined}>
            <span className="pub-step__number">{copy.t('stepNumber', { number: index + 1 })}</span>
            <h2>{copy.t(TITLE[step])}</h2>
            <p className="muted">{copy.t(BODY[step])}</p>
            <StepForm step={step} disabled={off} reasonId={`${reasonId}-${step}`} />
          </li>
        ))}
      </ol>
      <ContactSupport context="recovery" />
      <a className="text-link" href="/help">
        {copy.t('help')} →
      </a>
    </div>
  );
}

function StepForm({ step, disabled, reasonId }: { step: RecoveryStep; disabled: boolean; reasonId: string }) {
  const copy = recoveryCopy.useCopy();
  return (
    <form
      className="pub-form"
      onSubmit={(event) => {
        // Never reached while the journey is off; kept so the form is real the moment it is not.
        event.preventDefault();
      }}
    >
      {step === 'request' && (
        <Field
          label={copy.t('accountField')}
          name="account"
          autoComplete="username"
          disabled={disabled}
          aria-describedby={disabled ? reasonId : undefined}
        />
      )}
      {step === 'code' && (
        <Field
          label={copy.t('codeField')}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={CODE_LENGTH}
          disabled={disabled}
        />
      )}
      {step === 'password' && (
        <>
          <Field
            label={copy.t('newPasswordField')}
            name="new-password"
            type="password"
            autoComplete="new-password"
            hint={copy.t('passwordHint')}
            disabled={disabled}
          />
          <Field label={copy.t('confirmField')} name="confirm-password" type="password" autoComplete="new-password" disabled={disabled} />
        </>
      )}
      <Button type="submit" disabled={disabled} aria-describedby={disabled ? reasonId : undefined}>
        {copy.t(ACTION[step])}
      </Button>
      {disabled && (
        <small id={reasonId} className="muted">
          {copy.t('offReason')}
        </small>
      )}
    </form>
  );
}
