import { Button, Field } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useWithdrawStepUp } from '../step-up';

/**
 * Withdraw's "Confirm it's you", drawn with the kit's Sheet. Its logic is `useWithdrawStepUp`, the same
 * as the shared `WithdrawStepUp` in the money folder: a passkey or a code buys one short `trade:withdraw` token, spent on
 * `run` once and dropped; a refusal of the action stays in the sheet in the service's words; success closes it.
 */
export function WithdrawStepUp({
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
    // While an answer is awaited, Escape does not close the sheet.
    <div
      onKeyDownCapture={(event) => {
        if (s.busy !== null && event.key === 'Escape') event.preventDefault();
      }}
    >
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
    </div>
  );
}
