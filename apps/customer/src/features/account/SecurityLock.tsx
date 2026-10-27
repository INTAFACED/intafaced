import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { securityLockCopy as copy } from './security-lock-copy';
import {
  lockStage,
  securityLockChangeSchema,
  securityLockRefusal,
  securityLockSchema,
  unlockStepUp,
  type SecurityLockRefusal,
} from './security-lock';
import { confirmWithStepUp, type StepUpMethod } from './security-step-up';

type Mode = 'view' | 'lock' | 'unlock';

/**
 * The security lock card in Security (W-withdraw-09): the lock's state, turn it on at once, ask to unlock with a fresh
 * 6-digit code or a passkey, and keep it locked while an unlock waits. The end time is identity's, fixed when the unlock
 * was asked for; nothing here can bring it closer.
 */
export function SecurityLock() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [problem, setProblem] = useState<'invalidOtp' | SecurityLockRefusal | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  const form = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'securityLock.read', undefined, securityLockSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `security-lock:${userId}`,
  );

  function open(next: Mode) {
    setNote(null);
    setFailure(null);
    setProblem(null);
    setMode(next);
  }

  function settle(answer: ApiResult<unknown>): answer is Extract<ApiResult<unknown>, { ok: false }> {
    if (answer.ok) return false;
    const refusal = securityLockRefusal(answer);
    if (refusal) setProblem(refusal);
    else setFailure(answer);
    return true;
  }

  /** Turns the lock on, or keeps it on and withdraws a waiting unlock. No confirmation of who you are: it only stops things. */
  async function lock(keep: boolean) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setProblem(null);
    setNote(null);
    try {
      const answer = await api.mutate('identity', 'securityLock.set', {}, securityLockChangeSchema);
      if (!mounted.current || settle(answer)) return;
      setMode('view');
      setNote(t(keep ? 'keptNote' : answer.data.changed ? 'lockedNote' : 'alreadyLocked'));
      reload();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function askUnlock(method: 'code' | 'passkey', element: HTMLFormElement) {
    const otp = String(new FormData(element).get('otp') ?? '').trim();
    if (method === 'code' && !/^\d{6}$/.test(otp)) return setProblem('invalidOtp');
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setProblem(null);
    setNote(null);
    try {
      const requestId = crypto.randomUUID();
      const how: StepUpMethod = method === 'code' ? { totpCode: otp } : { passkey: true };
      const approval = await confirmWithStepUp(api, unlockStepUp(requestId), how);
      const answer = approval.ok
        ? await api.mutate(
            'identity',
            'securityLock.requestUnlock',
            { clientRequestId: requestId, stepUpApprovalId: approval.data.stepUpApprovalId },
            securityLockChangeSchema,
          )
        : approval;
      if (!mounted.current || settle(answer)) return;
      setMode('view');
      setNote(answer.data.unlocksAt ? t('askedNote', { time: stamp(answer.data.unlocksAt, timeZone) }) : t('endedNote'));
      reload();
    } finally {
      const field = element.elements.namedItem('otp');
      if (field instanceof HTMLInputElement) field.value = '';
      if (mounted.current) setBusy(false);
    }
  }

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') {
    return (
      <section data-testid="security__lock" className="security__lock security__card" aria-label={t('title')} lang={languageFor('title')}>
        <h2>{t('title')}</h2>
        <p>{t('body')}</p>
        <Failure result={resource.failure} retry={reload} />
      </section>
    );
  }
  const state = resource.data;
  if (!state) return null;
  const stage = lockStage(state);
  return (
    <section data-testid="security__lock" className="security__lock security__card" aria-label={t('title')} lang={languageFor('title')}>
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      <p className="muted">{t('scope')}</p>
      <p data-testid="security__lock-state" className="security__lock-state" role="status">
        <strong>
          {stage === 'open'
            ? t('open')
            : stage === 'unlocking'
              ? t('unlocking', { time: stamp(state.unlocksAt!, timeZone), asked: stamp(state.unlockRequestedAt!, timeZone) })
              : state.setBy === 'support'
                ? t('lockedBySupport', { time: stamp(state.lockedAt!, timeZone) })
                : t('locked', { time: stamp(state.lockedAt!, timeZone) })}
        </strong>
      </p>
      {stage !== 'open' && <p className="muted">{t('waitNote')}</p>}
      {note && (
        <p data-testid="notice" className="notice" role="status">
          {note}
        </p>
      )}
      {failure && <Failure result={failure} />}
      {problem && mode === 'view' && (
        <p className="error-text" role="alert">
          {t(problem)}
        </p>
      )}
      {mode === 'view' ? (
        <div className="row">
          {stage === 'open' && (
            <Button variant="secondary" disabled={busy} onClick={() => open('lock')}>
              {t('lock')}
            </Button>
          )}
          {stage === 'locked' && (
            <Button variant="secondary" disabled={busy} onClick={() => open('unlock')}>
              {t('askUnlock')}
            </Button>
          )}
          {stage === 'unlocking' && (
            <Button variant="secondary" disabled={busy} onClick={() => void lock(true)}>
              {busy ? t('working') : t('keepLocked')}
            </Button>
          )}
        </div>
      ) : mode === 'lock' ? (
        <div className="stack">
          <p>{t('lockReview')}</p>
          <div className="row">
            <Button disabled={busy} onClick={() => void lock(false)}>
              {busy ? t('working') : t('lockConfirm')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => open('view')}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          ref={form}
          className="stack"
          noValidate
          aria-label={t('unlockTitle')}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void askUnlock('code', event.currentTarget);
          }}
        >
          <p>{t('unlockBody')}</p>
          <Field
            label={t('otpField')}
            name="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            disabled={busy}
            data-security-sensitive="true"
          />
          {problem && (
            <p className="error-text" role="alert">
              {t(problem)}
            </p>
          )}
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? t('working') : t('unlockCode')}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => form.current && void askUnlock('passkey', form.current)}>
              {t('unlockPasskey')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => open('view')}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
