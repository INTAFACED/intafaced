import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Field } from '../../shared/ui';
import { useSession } from '../session/session';
import { confirmWithStepUp, type StepUpBegin, type StepUpMethod } from '../account/security-step-up';
import { withdrawStepUpCopy } from './withdraw-step-up-copy';

type Key = Parameters<typeof withdrawStepUpCopy.t>[0];
const refusalKeys: Record<string, Key> = {
  'auth.mfa_invalid': 'codeBad',
  'auth.mfa_not_enrolled': 'noAuthenticator',
  'auth.webauthn_not_enrolled': 'noPasskey',
  'stepUp.no_passkey': 'noPasskey',
  'auth.webauthn_invalid': 'passkeyBad',
  'portal.passkey_stopped': 'passkeyStopped',
  'portal.passkey_unavailable': 'passkeyUnavailable',
  'portal.passkey_failed': 'passkeyFailed',
  'portal.passkey_unreadable': 'passkeyFailed',
};

/**
 * "Confirm it's you" inside a review (J-bank-04 #4): a fresh 6-digit authenticator code or a passkey buys one
 * single-use approval for exactly the request under review (`stepUp.begin` names its fields), which goes to `onApproved`
 * and is sent with that one request. A wrong code never ends the session and nothing is sent until the approval exists.
 */
export function StepUpConfirm({
  request,
  words,
  disabled,
  onApproved,
}: {
  request: () => StepUpBegin;
  words: { why: string; code: string; codeHint: string; codeShort: string };
  disabled: boolean;
  onApproved: (stepUpApprovalId: string) => void;
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

  async function confirm(method: StepUpMethod, how: 'code' | 'passkey') {
    if (busy || disabled) return;
    setBusy(how);
    setProblem(null);
    const approved = await confirmWithStepUp(api, request(), method, alive.current?.signal);
    if (alive.current?.signal.aborted ?? true) return;
    setBusy(null);
    setCode('');
    if (!approved.ok) {
      const key = approved.code ? refusalKeys[approved.code] : undefined;
      setProblem(key ? t(key) : t('failed'));
      return;
    }
    onApproved(approved.data.stepUpApprovalId);
  }
  function withCode(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!/^\d{6}$/.test(code)) {
      setProblem(words.codeShort);
      return;
    }
    void confirm({ totpCode: code }, 'code');
  }
  return (
    <section className="form-stack" aria-label={t('title')} data-testid="step-up-confirm">
      <h3 className="bd-subhead">{t('title')}</h3>
      <p className="muted">{words.why}</p>
      <form className="form-stack" onSubmit={withCode} noValidate>
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
        <Button type="submit" disabled={busy !== null || disabled || code.length < 6}>
          {busy === 'code' ? t('checking') : t('confirm')}
        </Button>
      </form>
      <Button variant="secondary" disabled={busy !== null || disabled} onClick={() => void confirm({ passkey: true }, 'passkey')}>
        {busy === 'passkey' ? t('passkeyWaiting') : t('passkey')}
      </Button>
      {problem && (
        <p className="failure" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
