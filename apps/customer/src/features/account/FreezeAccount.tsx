import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { selfFreezeCopy as copy } from './self-freeze-copy';
import { StepUpConfirm } from '../money/StepUpConfirm';
import {
  FREEZE_REASONS,
  FREEZE_REFUSAL_KEYS,
  LIFT_REFUSAL_KEYS,
  REASON_KEYS,
  freezeDone,
  freezeStatus,
  liftDone,
  liftRequestId,
  liftWaitWords,
  type FreezeReason,
} from './self-freeze';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * Freeze account in Security (slice I-account-lifecycle-08): the person's own freeze. It needs the current password and a reason,
 * signs out every device and key, and moves no money. The page says so before the button and shows "You froze this account"
 * afterwards. The frozen card offers the person's own lift (I-account-lifecycle-09): before the owner's waiting time has passed it
 * refuses with the seconds left; after it, a fresh authenticator code or passkey confirms the lift. A blank waiting time refuses.
 */
export function FreezeAccount() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<FreezeReason>('compromise');
  const [problem, setProblem] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [lifting, setLifting] = useState(false);
  const [liftFailure, setLiftFailure] = useState<Failed | null>(null);
  const [confirming, setConfirming] = useState(false);
  const mounted = useRef(true);
  const form = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const status = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'auth.selfFreezeStatus', undefined, freezeStatus, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `self-freeze:${userId}`,
  );

  async function freeze(password: string) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const answer = await api.mutate('identity', 'auth.selfFreeze', { reason, password }, freezeDone);
      if (!mounted.current) return;
      if (!answer.ok) return setFailure(answer);
      setNote(t('frozenNote'));
      status.reload();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function lift(since: string, stepUpApprovalId: string | null) {
    if (lifting || !userId) return;
    setLifting(true);
    setLiftFailure(null);
    try {
      const answer = await api.mutate(
        'identity',
        'selfFreezeManage.lift',
        { clientRequestId: liftRequestId(userId, since), stepUpApprovalId },
        liftDone,
      );
      if (!mounted.current) return;
      if (!answer.ok) {
        // The step-up is asked for only once the wait has passed: the service refuses too soon before it spends one.
        // Asked again after an approval was sent, the approval was refused: say so beside a fresh confirmation.
        if (answer.code === 'identity.step_up_required') {
          if (stepUpApprovalId) setLiftFailure(answer);
          return setConfirming(true);
        }
        setConfirming(false);
        setLiftFailure(answer);
        // An unclear answer may hide a lift that happened: re-read the freeze rather than offer it again.
        if (!answer.code || !(answer.code in LIFT_REFUSAL_KEYS || answer.code === 'identity.self_freeze_lift_too_soon')) status.reload();
        return;
      }
      setConfirming(false);
      setNote(t('liftedNote'));
      status.reload();
    } finally {
      if (mounted.current) setLifting(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('freeze-password') ?? '');
    if (password.length === 0) return setProblem(true);
    setProblem(false);
    form.current?.reset();
    void freeze(password);
  }

  if (status.resource.status === 'loading') return <Loading />;
  if (status.resource.status === 'failed') return <Failure result={status.resource.failure} retry={status.reload} />;
  if (!status.resource.data) return null;
  const current = status.resource.data;

  if (current.frozen && current.since && current.reason) {
    const since = current.since;
    return (
      <section
        data-testid="security__card"
        className="security__freeze security__card"
        aria-label={t('frozenTitle')}
        lang={languageFor('frozenTitle')}
      >
        <h2>{t('frozenTitle')}</h2>
        {note && (
          <p className="notice" role="status">
            {note}
          </p>
        )}
        <p>{t('frozenBody', { date: stamp(current.since, timeZone), reason: t(REASON_KEYS[current.reason] as 'reasonPersonal') })}</p>
        <h3>{t('liftTitle')}</h3>
        <p>{t('liftBody')}</p>
        {liftFailure && <LiftRefusal failure={liftFailure} />}
        {confirming ? (
          <StepUpConfirm
            request={() => ({
              scope: 'identity.step_up.self_freeze_lift',
              purpose: 'account.selfFreeze.lift',
              target: liftRequestId(userId ?? '', since),
              fields: { clientRequestId: liftRequestId(userId ?? '', since) },
            })}
            words={{
              why: t('liftWhy'),
              code: t('liftCode'),
              codeHint: t('liftCodeHint'),
              codeShort: t('liftCodeShort'),
              noFactor: t('liftNoFactor'),
              sendWithout: t('liftSendWithout'),
            }}
            disabled={lifting}
            onApproved={(approval) => void lift(since, approval)}
          />
        ) : (
          <div className="actions">
            <Button data-testid="freeze__lift" disabled={lifting} onClick={() => void lift(since, null)}>
              {lifting ? t('working') : t('liftAsk')}
            </Button>
          </div>
        )}
      </section>
    );
  }

  const refusal = failure && failure.code ? FREEZE_REFUSAL_KEYS[failure.code] : undefined;
  return (
    <section data-testid="security__card" className="security__freeze security__card" aria-label={t('title')} lang={languageFor('title')}>
      <h2>{t('title')}</h2>
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      <p>{t('body')}</p>
      <p>{t('consequences')}</p>
      {failure &&
        (refusal ? (
          <p className="notice" role="alert">
            {t(refusal as 'refusedPassword')}
          </p>
        ) : (
          <Failure result={failure} />
        ))}
      <form ref={form} method="post" className="stack" onSubmit={submit} noValidate>
        <fieldset disabled={busy}>
          <legend>{t('reasonLabel')}</legend>
          {FREEZE_REASONS.map((value) => (
            <label key={value} className="row">
              <input type="radio" name="freeze-reason" value={value} checked={reason === value} onChange={() => setReason(value)} />{' '}
              {t(REASON_KEYS[value] as 'reasonPersonal')}
            </label>
          ))}
        </fieldset>
        <Field
          label={t('passwordField')}
          name="freeze-password"
          type="password"
          autoComplete="current-password"
          required
          disabled={busy}
          error={problem ? t('passwordNeeded') : undefined}
          data-security-sensitive="true"
        />
        <div className="actions">
          <Button type="submit" variant="danger" disabled={busy}>
            {busy ? t('working') : t('freezeAsk')}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** A lift refusal in the card's own words: the time left when the service sent it, else the typed reason. */
function LiftRefusal({ failure }: { failure: Failed }) {
  const { t } = copy.useCopy();
  let words: string | null = null;
  if (failure.code === 'identity.self_freeze_lift_too_soon') {
    const wait = failure.retryAfterSeconds ? liftWaitWords(failure.retryAfterSeconds) : null;
    words = wait ? t(wait.key, { n: wait.n }) : t('liftTooSoon');
  } else if (failure.code === 'identity.step_up_required') {
    words = t('liftApprovalRefused');
  } else if (failure.code && LIFT_REFUSAL_KEYS[failure.code]) {
    words = t(LIFT_REFUSAL_KEYS[failure.code] as 'liftWaitUnset');
  }
  if (words === null) return <Failure result={failure} />;
  return (
    <p className="notice" role="alert" data-testid="freeze__lift-refusal">
      {words}
    </p>
  );
}
