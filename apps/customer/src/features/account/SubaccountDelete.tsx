import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field } from '../../shared/ui';
import { subAccountDeleteCopy as copy } from './sub-account-delete-copy';
import { BLOCKER_KEYS, DELETE_REFUSAL_KEYS, deleteCheck, deleteResult, deleteStepUp, isSixDigits } from './sub-account-delete';
import { confirmWithStepUp } from './security-step-up';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * Delete one sub-account (slice I-account-lifecycle-03): what the money services still show for this one sub-account, then a
 * confirmation with a fresh factor. An unreadable service is shown as such, never as "nothing open". Deleting moves no money.
 */
export function SubaccountDelete({ subAccountId, onDeleted }: { subAccountId: string; onDeleted: () => void }) {
  const { t } = copy.useCopy();
  const { api, userId } = useSession();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [problem, setProblem] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const check = useResource(
    (signal) =>
      userId && asking
        ? api.query('identity', 'subAccounts.deleteCheck', { subAccountId }, deleteCheck, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `subaccount-delete-check:${userId}:${subAccountId}:${asking}`,
  );

  async function run(code: string) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const requestId = crypto.randomUUID();
      const approved = await confirmWithStepUp(api, deleteStepUp(subAccountId, requestId), { totpCode: code });
      if (!mounted.current) return;
      if (!approved.ok) return setFailure(approved);
      const answer = await api.mutate(
        'identity',
        'subAccounts.delete',
        { subAccountId, stepUpApprovalId: approved.data.stepUpApprovalId, clientRequestId: requestId },
        deleteResult,
      );
      if (!mounted.current) return;
      // The service spends the approval first, so after any refusal the next try starts a new confirmation.
      if (!answer.ok) {
        check.reload();
        return setFailure(answer);
      }
      setAsking(false);
      onDeleted();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('delete-code') ?? '');
    if (!isSixDigits(code)) return setProblem(true);
    setProblem(false);
    event.currentTarget.reset();
    void run(code.trim());
  }

  if (!asking) {
    return (
      <Button variant="ghost" aria-label={`${t('title')} ${subAccountId}`} onClick={() => setAsking(true)}>
        {t('open')}
      </Button>
    );
  }
  const refusal = failure && failure.code ? DELETE_REFUSAL_KEYS[failure.code] : undefined;
  const data = check.resource.status === 'ready' ? check.resource.data : null;
  return (
    <div className="stack" role="group" aria-label={t('title')}>
      <h3>{t('title')}</h3>
      <p>{t('body')}</p>
      {check.resource.status === 'loading' && <p className="muted">{t('checking')}</p>}
      {check.resource.status === 'failed' &&
        (check.resource.failure.code && DELETE_REFUSAL_KEYS[check.resource.failure.code] ? (
          <p className="notice" role="status">
            {t(DELETE_REFUSAL_KEYS[check.resource.failure.code] as 'refusedCheck')}
          </p>
        ) : (
          <Failure result={check.resource.failure} retry={check.reload} />
        ))}
      {data && (
        <>
          {data.blockers.length === 0 ? (
            <p>{t('allClear')}</p>
          ) : (
            <>
              <p>{t('stillOpen')}</p>
              <ul data-testid="security__rows" className="security__rows">
                {data.blockers.map((blocker) => (
                  <li key={blocker.code} data-testid="security__row" className="security__row">
                    {t((BLOCKER_KEYS[blocker.code] ?? 'blockOther') as 'blockOrder', { count: blocker.count })}
                  </li>
                ))}
              </ul>
            </>
          )}
          {data.balances.length > 0 && (
            <>
              <h3>{t('balancesTitle')}</h3>
              <ul data-testid="security__rows" className="security__rows">
                {data.balances.map((balance) => (
                  <li key={balance.assetId} data-testid="security__row" className="security__row">
                    {balance.amount} {balance.assetId}
                  </li>
                ))}
              </ul>
            </>
          )}
          {data.blockers.length === 0 && (
            <form method="post" className="stack" onSubmit={submit} noValidate>
              <h3>{t('confirmTitle')}</h3>
              <p>{t('confirmBody')}</p>
              <Field
                label={t('codeField')}
                name="delete-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                disabled={busy}
                error={problem ? t('invalidCode') : undefined}
                data-security-sensitive="true"
              />
              <Button type="submit" variant="danger" disabled={busy}>
                {busy ? t('working') : t('delete')}
              </Button>
            </form>
          )}
        </>
      )}
      {failure &&
        (refusal ? (
          <p className="notice" role="alert">
            {t(refusal as 'refusedBlocked')}
          </p>
        ) : (
          <Failure result={failure} />
        ))}
      <div className="actions">
        <Button variant="ghost" onClick={check.reload}>
          {t('recheck')}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
