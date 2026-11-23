import { Button, Field } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useWithdrawStepUp } from '../use-withdraw-step-up';
import { withdrawStepUpCopy } from '../withdraw-step-up-copy';

/**
 * "Confirm it's you" for anything that needs `trade:withdraw`, drawn from the kit: the same words, controls and names
 * as `WithdrawStepUp`, and the same `useWithdrawStepUp`, so the token goes to `run` for exactly one call and is dropped.
 */
export function StepUpSheet({
  why,
  run,
  onDone,
  onCancel,
}: {
  why?: string;
  run: (token: string) => Promise<ApiResult<unknown>>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = withdrawStepUpCopy.useCopy();
  const { code, setCode, busy, problem, withPasskey, withCode } = useWithdrawStepUp({ run, onDone });
  return (
    <Sheet
      open
      title={t('title')}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <p className="lt-hint">{why ?? t('why')}</p>
      <Button tone="secondary" disabled={busy !== null} onClick={withPasskey}>
        {busy === 'passkey' ? t('passkeyWaiting') : t('passkey')}
      </Button>
      <p className="lt-hint">{t('or')}</p>
      <form onSubmit={withCode} noValidate>
        <Field
          label={t('code')}
          hint={t('codeHint')}
          name="withdraw-stepup-code"
          autoComplete="one-time-code"
          maxLength={11}
          value={code}
          disabled={busy !== null}
          onChange={(event) => setCode(event.target.value)}
        />
        <Button type="submit" tone="primary" disabled={busy !== null || code.length < 6}>
          {busy === 'code' ? t('checking') : t('confirm')}
        </Button>
      </form>
      {problem && (
        <p data-testid="failure" role="alert">
          {problem}
        </p>
      )}
      <Button tone="quiet" disabled={busy !== null} onClick={onCancel}>
        {t('cancel')}
      </Button>
    </Sheet>
  );
}
