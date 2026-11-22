import type { AccountRestriction } from '@intafaced/contracts/identity-account-status';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';
import { accountStatusCopy as copy } from './account-status-copy';
import { verificationCapabilitiesCopy } from './verification-capabilities-copy';

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
