import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiResult } from '../../shared/api';
import { Button, Dialog, Field } from '../../shared/ui';
import { useSession } from '../session/session';
import { isStepUpCode, mintWithdrawToken, type WithdrawStepUpMethod } from './withdraw-step-up';
import { withdrawStepUpCopy } from './withdraw-step-up-copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Key = Parameters<ReturnType<typeof withdrawStepUpCopy.useCopy>['t']>[0];

/** Identity's step-up refusals in plain words: shared by every "Confirm it's you" in the money rooms. */
export const stepUpRefusalKeys: Record<string, Key> = {
  'auth.mfa_invalid': 'codeBad',
  'auth.mfa_not_enrolled': 'noAuthenticator',
  'auth.webauthn_not_enrolled': 'noPasskey',
  'auth.webauthn_invalid': 'passkeyBad',
  'portal.passkey_stopped': 'passkeyStopped',
  'portal.passkey_unavailable': 'passkeyUnavailable',
  'portal.passkey_failed': 'passkeyFailed',
  'portal.passkey_unreadable': 'passkeyFailed',
  'stepUp.code_malformed': 'codeShort',
  'stepUp.scope_missing': 'failed',
};

/**
 * The shared "Confirm it's you" for anything that needs `trade:withdraw` (the withdrawal address list today; the bank
 * address book and the withdraw page next). The person answers with a passkey, an authenticator code or a recovery
 * code; the short token that buys goes to `run` for exactly one call, as that call's own bearer, and is dropped. The
 * token is never stored, never put in the session and never shown. `run` returns the action's own answer: a refusal of
 * the action stays in the dialog in the service's words so the person can fix it and send again; success closes it.
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
  const { api } = useSession();
  const { t } = withdrawStepUpCopy.useCopy();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'code' | 'passkey' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    return () => controller.abort();
  }, []);
  const gone = () => alive.current?.signal.aborted ?? true;

  const wordsFor = (result: Failed) =>
    result.code && stepUpRefusalKeys[result.code] ? t(stepUpRefusalKeys[result.code]!) : result.message || t('failed');

  async function confirm(method: WithdrawStepUpMethod, how: 'code' | 'passkey') {
    if (busy) return;
    setBusy(how);
    setProblem(null);
    const token = await mintWithdrawToken(api, method, alive.current?.signal);
    if (gone()) return;
    if (!token.ok) {
      setBusy(null);
      setProblem(wordsFor(token));
      return;
    }
    const answer = await run(token.data.accessToken);
    if (gone()) return;
    setBusy(null);
    if (!answer.ok) {
      setProblem(answer.message || t('failed'));
      return;
    }
    setCode('');
    onDone();
  }
  function withCode(event: FormEvent) {
    event.preventDefault();
    // The dialog may sit under a caller's own form; its submit is this dialog's alone.
    event.stopPropagation();
    if (busy) return;
    if (!isStepUpCode(code)) {
      setProblem(t('codeShort'));
      return;
    }
    void confirm({ code }, 'code');
  }
  return (
    <Dialog
      title={t('title')}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <div className="form-stack">
        <p className="muted">{why ?? t('why')}</p>
        <Button variant="secondary" disabled={busy !== null} onClick={() => void confirm({ passkey: true }, 'passkey')}>
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
            onChange={(event) => setCode(event.target.value.trim().slice(0, 11))}
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
