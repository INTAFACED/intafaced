import { Button, Field } from '@intafaced/ui/lit';
import type { StepUpBegin } from '../../account';
import { useStepUpConfirm } from '../step-up';

/**
 * "Confirm it's you" before an older month's statement (J-bank-23), drawn with the kit: `StepUpConfirm`'s logic
 * (`useStepUpConfirm`) with the same words, order and ids. A fresh 6-digit code or a passkey buys one single-use
 * approval for exactly this export; a person with no factor sends without one and the bank alone decides.
 */
export function BooksStepUp({
  request,
  words,
  disabled,
  onApproved,
}: {
  request: () => StepUpBegin;
  words: { why: string; code: string; codeHint: string; codeShort: string; noFactor: string; sendWithout: string };
  disabled: boolean;
  onApproved: (stepUpApprovalId: string | null) => void;
}) {
  const s = useStepUpConfirm({ request, codeShort: words.codeShort, disabled, onApproved });
  const { t } = s;
  if (s.checking) return <p role="status">{t('checking')}…</p>;
  return (
    <section aria-label={t('title')} data-testid="step-up-confirm">
      <h3>{t('title')}</h3>
      {s.noFactor ? (
        <>
          <p>{words.noFactor}</p>
          <Button tone="primary" disabled={disabled} onClick={() => onApproved(null)}>
            {words.sendWithout}
          </Button>
        </>
      ) : (
        <>
          <p>{words.why}</p>
          <form onSubmit={s.submitCode} noValidate>
            <Field
              label={words.code}
              hint={words.codeHint}
              name="step-up-code"
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
              value={s.code}
              disabled={s.busy !== null || disabled}
              onChange={(event) => s.setCode(event.target.value)}
            />
            <Button tone="primary" type="submit" disabled={s.busy !== null || disabled || s.code.length < 6}>
              {s.busy === 'code' ? t('checking') : t('confirm')}
            </Button>
          </form>
          <Button tone="secondary" disabled={s.busy !== null || disabled} onClick={s.passkey}>
            {s.busy === 'passkey' ? t('passkeyWaiting') : t('passkey')}
          </Button>
        </>
      )}
      {s.problem && (
        <p data-testid="failure" role="alert">
          {s.problem}
        </p>
      )}
    </section>
  );
}
