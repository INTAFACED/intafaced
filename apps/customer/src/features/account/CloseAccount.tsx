import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { closeAccountCopy as copy } from './close-account-copy';
import {
  BLOCKER_KEYS,
  CLOSE_REFUSAL_KEYS,
  closeStepUp,
  closureCheck,
  closureStatus,
  closureView,
  daysLeft,
  isSixDigits,
  type ClosureView,
} from './close-account';
import { confirmWithStepUp, type StepUpMethod } from './security-step-up';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * Close account in Security (slice I-account-lifecycle-10): what is still open, a confirmation with a fresh factor, then the waiting
 * period with a cancel button. The list comes from the service's own checks and an unreadable one is shown as such, never as
 * "nothing open". Closing moves no money. The page states plainly that closure is permanent.
 */
export function CloseAccount() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<'request' | 'cancel' | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [problem, setProblem] = useState(false);
  const [note, setNote] = useState<string | null>(null);
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
        ? api.query('identity', 'accountClosure.status', undefined, closureStatus, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `closure-status:${userId}`,
  );
  const open = status.resource.status === 'ready' && status.resource.data?.closure?.status === 'requested';
  const check = useResource(
    (signal) =>
      userId && status.resource.status === 'ready' && !open
        ? api.query('identity', 'accountClosure.check', undefined, closureCheck, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `closure-check:${userId}:${status.resource.status}:${open}`,
  );

  async function confirmAndRun(intent: 'request' | 'cancel', method: StepUpMethod, closure: ClosureView | null) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      const requestId = intent === 'request' ? crypto.randomUUID() : (closure?.clientRequestId ?? '');
      const approved = await confirmWithStepUp(api, closeStepUp(intent, requestId), method);
      if (!mounted.current) return;
      if (!approved.ok) return setFailure(approved);
      const answer =
        intent === 'request'
          ? await api.mutate(
              'identity',
              'accountClosure.request',
              { stepUpApprovalId: approved.data.stepUpApprovalId, clientRequestId: requestId },
              closureView,
            )
          : await api.mutate('identity', 'accountClosure.cancel', { stepUpApprovalId: approved.data.stepUpApprovalId }, closureView);
      if (!mounted.current) return;
      // The service spends the approval first, so after any refusal the next try starts a new confirmation.
      if (!answer.ok) return setFailure(answer);
      setAsking(null);
      setNote(intent === 'cancel' ? t('cancelled') : null);
      status.reload();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>, intent: 'request' | 'cancel', closure: ClosureView | null) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('close-code') ?? '');
    if (!isSixDigits(code)) return setProblem(true);
    setProblem(false);
    form.current?.reset();
    void confirmAndRun(intent, { totpCode: code.trim() }, closure);
  }

  if (status.resource.status === 'loading') return <Loading />;
  if (status.resource.status === 'failed') return <Failure result={status.resource.failure} retry={status.reload} />;
  if (!status.resource.data) return null;
  const closure = status.resource.data.closure;

  const refusal = failure && failure.code ? CLOSE_REFUSAL_KEYS[failure.code] : undefined;
  const failureView = failure ? (
    refusal ? (
      <p className="notice" role="alert">
        {t(refusal as 'refusedBlocked')}
      </p>
    ) : (
      <Failure result={failure} />
    )
  ) : null;

  const confirmForm = (intent: 'request' | 'cancel') => (
    <form ref={form} method="post" className="stack" onSubmit={(event) => submit(event, intent, closure)} noValidate>
      <h3>{t('confirmTitle')}</h3>
      <p>{t('confirmBody')}</p>
      <Field
        label={t('codeField')}
        name="close-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        required
        disabled={busy}
        error={problem ? t('invalidCode') : undefined}
        data-security-sensitive="true"
      />
      <div className="actions">
        <Button type="submit" variant={intent === 'request' ? 'danger' : 'primary'} disabled={busy}>
          {busy ? t('working') : intent === 'request' ? t('askClose') : t('cancelAsk')}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void confirmAndRun(intent, { passkey: true }, closure)}>
          {t('usePasskey')}
        </Button>
      </div>
    </form>
  );

  if (closure?.status === 'closed') {
    return (
      <section
        data-testid="security__card"
        className="security__close security__card"
        aria-label={t('closedTitle')}
        lang={languageFor('closedTitle')}
      >
        <h2>{t('closedTitle')}</h2>
        <p>{t('closedBody', { date: stamp(closure.finalizedAt ?? closure.effectiveAt, timeZone) })}</p>
      </section>
    );
  }

  return (
    <section data-testid="security__card" className="security__close security__card" aria-label={t('title')} lang={languageFor('title')}>
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      {failureView}
      {open && closure ? (
        <>
          <h3>{t('requestedTitle')}</h3>
          <p>
            {daysLeft(closure.effectiveAt, Date.now()) > 0
              ? t('requestedBody', { date: stamp(closure.effectiveAt, timeZone), days: daysLeft(closure.effectiveAt, Date.now()) })
              : t('requestedToday', { date: stamp(closure.effectiveAt, timeZone) })}
          </p>
          {asking === 'cancel' ? (
            confirmForm('cancel')
          ) : (
            <div className="actions">
              <Button variant="primary" onClick={() => setAsking('cancel')}>
                {t('cancelAsk')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          {closure?.status === 'blocked' && (
            <div data-testid="failure" className="failure" role="status">
              <h3>{t('blockedTitle')}</h3>
              <p>{t('blockedBody')}</p>
            </div>
          )}
          <h3>{t('checkTitle')}</h3>
          {check.resource.status === 'loading' && <p className="muted">{t('checking')}</p>}
          {check.resource.status === 'failed' &&
            (check.resource.failure.code && CLOSE_REFUSAL_KEYS[check.resource.failure.code] ? (
              <p className="notice" role="status">
                {t(CLOSE_REFUSAL_KEYS[check.resource.failure.code] as 'refusedCheck')}
              </p>
            ) : (
              <Failure result={check.resource.failure} retry={check.reload} />
            ))}
          {check.resource.status === 'ready' && check.resource.data && (
            <>
              {check.resource.data.blockers.length === 0 ? (
                <p>{t('allClear')}</p>
              ) : (
                <>
                  <p>{t('stillOpen')}</p>
                  <ul data-testid="security__rows" className="security__rows">
                    {check.resource.data.blockers.map((blocker) => (
                      <li key={blocker.code} data-testid="security__row" className="security__row">
                        {t((BLOCKER_KEYS[blocker.code] ?? 'blockOther') as 'blockOrder', { count: blocker.count })}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {check.resource.data.balances.length > 0 && (
                <>
                  <h3>{t('balancesTitle')}</h3>
                  <ul data-testid="security__rows" className="security__rows">
                    {check.resource.data.balances.map((balance) => (
                      <li key={balance.assetId} data-testid="security__row" className="security__row">
                        {balance.amount} {balance.assetId}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {asking === 'request' && check.resource.data.blockers.length === 0 ? (
                confirmForm('request')
              ) : (
                <div className="actions">
                  <Button variant="danger" disabled={check.resource.data.blockers.length > 0} onClick={() => setAsking('request')}>
                    {t('askClose')}
                  </Button>
                  <Button variant="ghost" onClick={check.reload}>
                    {t('recheck')}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
