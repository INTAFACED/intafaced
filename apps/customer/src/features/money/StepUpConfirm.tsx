import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Field, Loading } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import { useSession } from '../session/session';
import { confirmWithStepUp, type StepUpBegin, type StepUpMethod } from '../account/security-step-up';
import { factorStatus } from '../account/security-checklist';
import { stepUpRefusalKeys } from './WithdrawStepUp';
import { withdrawStepUpCopy } from './withdraw-step-up-copy';

const refusalKeys = { ...stepUpRefusalKeys, 'stepUp.no_passkey': 'noPasskey' } as const;

/**
 * "Confirm it's you" inside a review (J-bank-04 #4): a fresh 6-digit authenticator code or a passkey buys one
 * single-use approval for exactly the request under review (`stepUp.begin` names its fields), which goes to `onApproved`
 * and is sent with that one request. A wrong code never ends the session and nothing is sent until the approval exists.
 * A person with no authenticator app and no passkey cannot give one: the request then goes without it (null), and the
 * bank alone decides whether it needs one, refusing with nothing sent if it does.
 */
export function StepUpConfirm({
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
  const { api, userId } = useSession();
  const { t } = withdrawStepUpCopy.useCopy();
  const factors = useResource((signal) => api.query('identity', 'factorStatus', undefined, factorStatus, { signal }), `factors:${userId}`);
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
      if (approved.code === 'stepUp.code_malformed') return setProblem(words.codeShort);
      const key = approved.code ? refusalKeys[approved.code as keyof typeof refusalKeys] : undefined;
      setProblem(key ? t(key) : approved.message || t('failed'));
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
  const status = factors.resource;
  if (status.status === 'loading') return <Loading label={t('checking')} />;
  // Unreadable factors still offer the confirmation: a refusal from it says what is missing.
  const none = status.status === 'ready' && !status.data.authenticator.on && status.data.passkeys.count === 0;
  return (
    <section className="form-stack" aria-label={t('title')} data-testid="step-up-confirm">
      <h3 className="bd-subhead">{t('title')}</h3>
      {none ? (
        <>
          <p className="muted">{words.noFactor}</p>
          <Button disabled={disabled} onClick={() => onApproved(null)}>
            {words.sendWithout}
          </Button>
        </>
      ) : (
        <>
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
        </>
      )}
      {problem && (
        <p data-testid="failure" className="failure" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
