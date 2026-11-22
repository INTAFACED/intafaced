import { accountStatusSchema } from '@intafaced/contracts/identity-account-status';
import { useSession } from '../session';
import { useResource } from '../../shared/resource';
import { Failure, Loading } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';
import { accountStatusCopy as copy } from './account-status-copy';
import { AccountAppeals } from './AccountAppeals';
import { RestrictionList } from './RestrictionList';

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
    // A staff close with a grace date (J-identity-14 #1): closed, but open to withdraw until the date.
    const graceUntil = status.state === 'closed' ? (status.restrictions.find((r) => r.kind === 'closed')?.graceUntil ?? null) : null;
    return (
      <div className="stack">
        <p data-testid="account-status__state" data-state={status.state} data-grace-until={graceUntil ?? undefined}>
          {graceUntil ? (
            <Copy k="closing" params={{ time: stamp(graceUntil, timeZone) }} />
          ) : (
            <Copy k={status.state === 'active' && status.restrictions.length > 0 ? 'activeWithRecords' : status.state} />
          )}
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
            <RestrictionList restrictions={status.restrictions} />
          </>
        )}
        <AccountAppeals restrictions={status.restrictions} />
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
