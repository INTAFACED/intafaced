import type { ApiResult } from '../../shared/api';
import { Button, Dialog, Field } from '../../shared/ui';
import { useWithdrawStepUp } from './use-withdraw-step-up';
import { withdrawStepUpCopy } from './withdraw-step-up-copy';

/**
 * The shared "Confirm it's you" for anything that needs `trade:withdraw` (the withdrawal address list today; the bank
 * address book and the withdraw page next). The person answers with a passkey, an authenticator code or a recovery
 * code; `useWithdrawStepUp` hands the token it buys to `run` for exactly one call. A refusal of the action stays in the
 * dialog in the service's words so the person can fix it and send again; success closes it. The settings rooms draw
 * the same confirmation from the kit (`bank-settings/StepUpSheet`).
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
  const { t } = withdrawStepUpCopy.useCopy();
  const { code, setCode, busy, problem, withPasskey, withCode } = useWithdrawStepUp({ run, onDone });
  return (
    <Dialog
      title={t('title')}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <div className="form-stack">
        <p className="muted">{why ?? t('why')}</p>
        <Button variant="secondary" disabled={busy !== null} onClick={withPasskey}>
          {busy === 'passkey' ? t('passkeyWaiting') : t('passkey')}
        </Button>
        <p className="muted">{t('or')}</p>
        <form className="form-stack" onSubmit={withCode} noValidate>
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
          <Button type="submit" variant="primary" disabled={busy !== null || code.length < 6}>
            {busy === 'code' ? t('checking') : t('confirm')}
          </Button>
        </form>
        {problem && (
          <p data-testid="failure" className="failure" role="alert">
            {problem}
          </p>
        )}
        <Button variant="ghost" disabled={busy !== null} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </Dialog>
  );
}
