import { Button, Field } from '@intafaced/ui/lit';
import type { StepUpBegin } from '../../account';
import { useStepUpConfirm, type StepUpWords } from '../StepUpConfirm';
import { withdrawStepUpCopy } from '../withdraw-step-up-copy';
import { Loading } from './parts';

/**
 * `StepUpConfirm` drawn from the Volt kit: the same words, controls, names and test ids, and the same `useStepUpConfirm`.
 *
 * "Confirm it's you" inside a review (J-bank-04 #4): a fresh 6-digit authenticator code or a passkey buys one
 * single-use approval for exactly the request under review (`stepUp.begin` names its fields), which goes to `onApproved`
 * and is sent with that one request. A wrong code never ends the session and nothing is sent until the approval exists.
 * A person with no authenticator app and no passkey cannot give one: the request then goes without it (null), and the
 * bank alone decides whether it needs one, refusing with nothing sent if it does.
 */
export function StepUpInline({
  request,
  words,
  disabled,
  onApproved,
}: {
  request: () => StepUpBegin;
  words: StepUpWords;
  disabled: boolean;
  onApproved: (stepUpApprovalId: string | null) => void;
}) {
  const { t } = withdrawStepUpCopy.useCopy();
  const { factors: status, code, setCode, busy, problem, confirm, withCode } = useStepUpConfirm({ request, words, disabled, onApproved });
  if (status.status === 'loading') return <Loading label={t('checking')} />;
  // Unreadable factors still offer the confirmation: a refusal from it says what is missing.
  const none = status.status === 'ready' && !status.data.authenticator.on && status.data.passkeys.count === 0;
  return (
    <section aria-label={t('title')} data-testid="step-up-confirm">
      <h3>{t('title')}</h3>
      {none ? (
        <>
          <p className="lt-hint">{words.noFactor}</p>
          <Button tone="primary" disabled={disabled} onClick={() => onApproved(null)}>
            {words.sendWithout}
          </Button>
        </>
      ) : (
        <>
          <p className="lt-hint">{words.why}</p>
          <form onSubmit={withCode} noValidate>
            <Field
              label={words.code}
              hint={words.codeHint}
              name="step-up-code"
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
              value={code}
              disabled={busy !== null || disabled}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <Button tone="primary" type="submit" disabled={busy !== null || disabled || code.length < 6}>
              {busy === 'code' ? t('checking') : t('confirm')}
            </Button>
          </form>
          <Button tone="secondary" disabled={busy !== null || disabled} onClick={() => void confirm({ passkey: true }, 'passkey')}>
            {busy === 'passkey' ? t('passkeyWaiting') : t('passkey')}
          </Button>
        </>
      )}
      {problem && (
        <p data-testid="failure" className="lt-refusal-body" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
