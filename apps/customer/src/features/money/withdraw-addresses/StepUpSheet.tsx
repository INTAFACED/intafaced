import { Button, Field } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useWithdrawStepUp } from '../step-up';

/**
 * The address rooms' "Confirm it's you" (`trade:withdraw`), drawn with the kit: the same words, order, input name and
 * states as `WithdrawStepUp`, whose logic `useWithdrawStepUp` holds. A passkey or a code buys one short token, spent on
 * `run` once; a refusal of the action stays in the sheet in the service's words, and success closes it.
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
  const s = useWithdrawStepUp({ run, onDone });
  const { t } = s;
  return (
    <Sheet
      open
      title={t('title')}
      onClose={() => {
        if (!s.busy) onCancel();
      }}
    >
      <p>{why ?? t('why')}</p>
      <Button tone="secondary" disabled={s.busy !== null} onClick={s.passkey}>
        {s.busy === 'passkey' ? t('passkeyWaiting') : t('passkey')}
      </Button>
      <p>{t('or')}</p>
      <form onSubmit={s.submitCode} noValidate>
        <Field
          label={t('code')}
          hint={t('codeHint')}
          name="withdraw-stepup-code"
          autoComplete="one-time-code"
          maxLength={11}
          value={s.code}
          disabled={s.busy !== null}
          onChange={(event) => s.setCode(event.target.value)}
        />
        <Button type="submit" tone="primary" disabled={s.busy !== null || s.code.length < 6}>
          {s.busy === 'code' ? t('checking') : t('confirm')}
        </Button>
      </form>
      {s.problem && (
        <p data-testid="failure" role="alert">
          {s.problem}
        </p>
      )}
      <Button tone="quiet" disabled={s.busy !== null} onClick={onCancel}>
        {t('cancel')}
      </Button>
    </Sheet>
  );
}
