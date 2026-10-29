import { accountStatusSchema, type AccountRestriction } from '@intafaced/contracts/identity-account-status';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Failure, Loading } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';
import { accountStatusCopy as copy } from './account-status-copy';

/** The codes identity sends from fixed lists; any other code reads as "no reason recorded", never as raw text. */
const REASONS = [
  'fraud',
  'negative_balance',
  'bank_reason',
  'customer_request',
  'other',
  'compromise',
  'temporary',
  'personal',
  'set_by_you',
  'set_by_support',
] as const;
type Reason = (typeof REASONS)[number];
const known = (code: string | null): code is Reason => code !== null && (REASONS as readonly string[]).includes(code);

/**
 * I-signin-sessions-22: the account status card on /uc/account. It lists what the person can still do and what they
 * cannot, and each restriction with its reason, its start and how it ends, all from identity's `accountStatus.mine`.
 * An active account blocks nothing. A restriction staff gave no coded reason reads "No reason recorded".
 */
export function AccountStatus() {
  const { api, userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const { timeZone } = usePreferences();
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'accountStatus.mine', undefined, accountStatusSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `account-status:${userId}`,
  );

  const lift = (r: AccountRestriction) => {
    switch (r.lift.by) {
      case 'staff':
        return (
          <>
            <Copy k="liftStaff" /> <a href="/help">{t('contactSupport')}</a>
          </>
        );
      case 'owner_after_wait':
        return (
          <>
            {r.lift.availableAt ? <Copy k="liftWait" params={{ time: stamp(r.lift.availableAt, timeZone) }} /> : <Copy k="liftWaitUnset" />}{' '}
            <a href="/uc/safe">{t('manageFreeze')}</a>
          </>
        );
      case 'owner_unlock':
        return (
          <>
            {r.lift.endsAt ? (
              <Copy k="liftUnlockAsked" params={{ time: stamp(r.lift.endsAt, timeZone) }} />
            ) : (
              <Copy k="liftUnlockNotAsked" />
            )}{' '}
            <a href="/uc/safe">{t('manageLock')}</a>
          </>
        );
    }
  };

  const body = () => {
    if (resource.status === 'loading') return <Loading />;
    if (resource.status === 'failed')
      return (
        <>
          <h3>
            <Copy k="failedTitle" />
          </h3>
          <Failure result={resource.failure} retry={reload} />
        </>
      );
    const status = resource.data;
    if (!status) return null;
    return (
      <div className="stack">
        <p data-testid="account-status__state" data-state={status.state}>
          <Copy k={status.state} />
        </p>
        <div className="account-status__lists">
          <div>
            <h3>
              <Copy k="canStill" />
            </h3>
            <ul data-testid="account-status__can">
              {status.canStill.length === 0 ? (
                <li>
                  <Copy k="nothing" />
                </li>
              ) : (
                status.canStill.map((action) => <li key={action}>{t(`action_${action}`)}</li>)
              )}
            </ul>
          </div>
          <div>
            <h3>
              <Copy k="cannot" />
            </h3>
            <ul data-testid="account-status__cannot">
              {status.cannot.length === 0 ? (
                <li>
                  <Copy k="nothing" />
                </li>
              ) : (
                status.cannot.map((c) => (
                  <li key={c.action} data-kind={c.kind}>
                    {t(`action_${c.action}`)}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
        {status.restrictions.length > 0 && (
          <>
            <h3>
              <Copy k="restrictionsTitle" />
            </h3>
            <ul data-testid="account-status__restrictions">
              {status.restrictions.map((r) => (
                <li key={r.kind} data-kind={r.kind} data-reason={r.reasonCode ?? ''}>
                  <strong>{t(`kind_${r.kind}`)}</strong>{' '}
                  {known(r.reasonCode) ? <Copy k="reason" params={{ reason: t(`reason_${r.reasonCode}`) }} /> : <Copy k="noReason" />}{' '}
                  {r.since && <Copy k="since" params={{ time: stamp(r.since, timeZone) }} />} {lift(r)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  };

  return (
    <section className="account-status" aria-labelledby="account-status-title" data-testid="account-status">
      <h2 id="account-status-title">
        <Copy k="title" />
      </h2>
      {body()}
    </section>
  );
}
