import { accountStatusSchema, type AccountRestriction } from '@intafaced/contracts/identity-account-status';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Failure, Loading } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';
import { accountStatusCopy as copy } from './account-status-copy';
import { verificationCapabilitiesCopy } from './verification-capabilities-copy';
import { AccountAppeals } from './AccountAppeals';

/**
 * I-signin-sessions-22: the account status card on /uc/account. It lists what the person can still do and what they
 * cannot, and each restriction with its reason, its start and how it ends, all from identity's `accountStatus.mine`.
 * An active account blocks nothing. A restriction staff gave no coded reason reads "No reason recorded".
 */
export function AccountStatus() {
  const { api, userId } = useSession();
  const { t, Copy } = copy.useCopy();
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
    return (
      <div className="stack">
        <p data-testid="account-status__state" data-state={status.state}>
          <Copy k={status.state === 'active' && status.restrictions.length > 0 ? 'activeWithRecords' : status.state} />
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

/** Each restriction with its reason, its start, whether it stops anything and how it ends; shared with /verification. */
export function RestrictionList({
  restrictions,
  labelledBy,
}: {
  restrictions: readonly AccountRestriction[];
  /** The id of the heading that names this list, when one does. */
  labelledBy?: string;
}) {
  const { t, Copy } = copy.useCopy();
  // The capability names /verification already uses, so a capability reads the same on both pages.
  const capabilities = verificationCapabilitiesCopy.useCopy();
  const { timeZone } = usePreferences();
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
      case 'none':
        return <Copy k="liftNone" />;
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

  const reason = (r: AccountRestriction) => {
    if (r.owner)
      return (
        <>
          {r.owner.text ?? t('ownerUnlisted')} {r.owner.guidance && <Copy k="ownerNext" params={{ guidance: r.owner.guidance }} />}
        </>
      );
    return r.reasonCode ? <Copy k="reason" params={{ reason: t(`reason_${r.reasonCode}`) }} /> : <Copy k="noReason" />;
  };
  return (
    <ul data-testid="account-status__restrictions" aria-labelledby={labelledBy}>
      {restrictions.map((r) => (
        <li
          key={`${r.kind}:${r.capability ?? ''}`}
          data-kind={r.kind}
          data-capability={r.capability ?? ''}
          data-reason={r.reasonCode ?? r.owner?.code ?? ''}
        >
          <strong>
            {r.capability ? (
              <>
                <capabilities.Copy k={r.capability} /> <Copy k="switchedOff" />
              </>
            ) : (
              t(`kind_${r.kind as Exclude<AccountRestriction['kind'], 'capability_off'>}`)
            )}
          </strong>{' '}
          {reason(r)} {r.since && <Copy k="since" params={{ time: stamp(r.since, timeZone) }} />}{' '}
          {r.kind === 'trading_restricted' && <Copy k="stops_trading_restricted" />}
          {r.kind === 'capability_off' && <Copy k={r.blocks.length > 0 ? 'capabilityStops' : 'capabilityStopsNothing'} />} {lift(r)}
        </li>
      ))}
    </ul>
  );
}
