import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Button, ReviewDialog as Dialog } from '@intafaced/ui';
import { uiCopy } from '../../../../shared/ui-copy';
import { requestPasskeyAssertion } from '../../../session/webauthn';
import { useSession } from '../../../session/session';
import { Field } from '../../ui-kit';
import { useNow } from '../hooks';
import type { MoneyKind } from './money-step';
import { mintPayStepUp, payStepUp, type FactorProof } from './step-up-store';
import { stepUpCopy } from './step-up-copy';
import { stepUpRefusalText } from './step-up-words';

/**
 * Where the "Confirm it's you" question is asked. The portal mounts one host; it tells the store who is signed in to
 * which business (a different person or business drops any confirmation held) and draws the question when a refund
 * or a payout action asks for one (`payStepUp.ensure`). See `step-up-store.ts` for what is held and for how long.
 */
export function StepUpHost({ userId, merchantId }: { userId: string | null; merchantId: string | null }) {
  useEffect(() => {
    payStepUp.bind({ userId, merchantId });
    return () => payStepUp.unbind();
  }, [userId, merchantId]);
  const { ask } = useSyncExternalStore(payStepUp.subscribe, payStepUp.getSnapshot, payStepUp.getSnapshot);
  if (!ask || !merchantId) return null;
  return <ConfirmItsYou key={ask.id} kind={ask.kind} expired={ask.expired} merchantId={merchantId} />;
}

function ConfirmItsYou({ kind, expired, merchantId }: { kind: MoneyKind; expired: boolean; merchantId: string }) {
  const { api } = useSession();
  const { t } = stepUpCopy.useCopy();
  const { t: ui } = uiCopy.useCopy();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'code' | 'passkey' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // One controller per mount (a development double-mount makes a fresh one), aborted when the question goes away.
  const alive = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    return () => controller.abort();
  }, []);
  const signal = () => alive.current?.signal;
  const gone = () => alive.current?.signal.aborted ?? true;

  async function confirm(proof: FactorProof, how: 'code' | 'passkey') {
    setBusy(how);
    setProblem(null);
    const result = await mintPayStepUp(api, { merchantId, kind, proof }, signal());
    if (gone()) return;
    setBusy(null);
    if (!result.ok) {
      setProblem(stepUpRefusalText(result));
      return;
    }
    // Held in memory by the store; the reply is not kept anywhere else.
    if (!payStepUp.remember(kind, result.data)) {
      setProblem(t('suFailed'));
      return;
    }
    setCode('');
    payStepUp.confirmed();
  }
  async function withPasskey() {
    if (busy) return;
    setBusy('passkey');
    setProblem(null);
    const assertion = await requestPasskeyAssertion(api, signal());
    if (gone()) return;
    if (!assertion.ok) {
      setBusy(null);
      setProblem(stepUpRefusalText(assertion));
      return;
    }
    await confirm({ webauthn: assertion.data }, 'passkey');
  }
  function withCode(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{6}$/.test(code)) {
      setProblem(t('suCodeShort'));
      return;
    }
    void confirm({ totpCode: code }, 'code');
  }
  return (
    <Dialog
      closeLabel={ui('closeDialog')}
      title={t('suTitle')}
      onClose={() => {
        if (!busy) payStepUp.declined();
      }}
    >
      <div data-testid="form-stack" className="form-stack pp-stepup">
        <p className="muted">{kind === 'refund' ? t('suWhyRefund') : t('suWhyPayout')}</p>
        {expired && (
          <p className="pp-callout" role="status">
            {t('suExpired')}
          </p>
        )}
        <Button variant="secondary" disabled={busy !== null} onClick={() => void withPasskey()}>
          {busy === 'passkey' ? t('suPasskeyWaiting') : t('suPasskey')}
        </Button>
        <p className="muted pp-note">{t('suOr')}</p>
        <form data-testid="form-stack" className="form-stack" onSubmit={withCode} noValidate>
          <Field
            label={t('suCode')}
            name="stepup-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            disabled={busy !== null}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <Button type="submit" variant="primary" disabled={busy !== null || code.length !== 6}>
            {busy === 'code' ? t('suChecking') : t('suConfirm')}
          </Button>
        </form>
        {problem && (
          <p className="pp-callout pp-callout--warn" role="alert">
            {problem}
          </p>
        )}
        <Button variant="ghost" disabled={busy !== null} onClick={() => payStepUp.declined()}>
          {t('suCancel')}
        </Button>
      </div>
    </Dialog>
  );
}

/** "Confirmed for the next N minutes." while a confirmation for this kind is held, and nothing otherwise. */
export function StepUpNote({ kind }: { kind: MoneyKind }) {
  const { t } = stepUpCopy.useCopy();
  useSyncExternalStore(payStepUp.subscribe, payStepUp.getSnapshot, payStepUp.getSnapshot);
  useNow(15_000);
  const minutes = payStepUp.minutesLeft(kind);
  if (minutes === null) return null;
  return (
    <p className="muted pp-note" role="status">
      {minutes === 1 ? t('suNoteOne') : t('suNoteMany', { n: minutes })}
    </p>
  );
}
