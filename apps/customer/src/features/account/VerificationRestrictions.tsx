import { accountStatusSchema } from '@intafaced/contracts/identity-account-status';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Failure, Loading } from '../../shared/ui';
import { RestrictionList } from './AccountStatus';
import { accountStatusCopy as copy } from './account-status-copy';

/**
 * I-kyc-compliance-17 (J-identity-08 #7): "Restrictions on your account" on /verification. Every restriction from
 * identity's account status, including a KYC capability compliance switched off, with the owner's words and next
 * step, and a link to the full account status. A restriction no service enforces says so; nothing here implies a stop
 * that does not happen.
 */
export function VerificationRestrictions({ recordsKey }: { recordsKey: string }) {
  const { api, userId } = useSession();
  const { Copy } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'accountStatus.mine', undefined, accountStatusSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `verification-restrictions:${userId}:${recordsKey}`,
  );
  const body = () => {
    if (resource.status === 'loading') return <Loading />;
    if (resource.status === 'failed')
      // A sub-account's session reads no status of its own: say where it lives rather than offer a retry that fails.
      return resource.failure.code === 'identity.delegated_refused' ? (
        <p>
          <Copy k="delegated" />
        </p>
      ) : (
        <Failure result={resource.failure} retry={reload} />
      );
    if (!resource.data) return null;
    // A switched-off capability is already in Capabilities above; listing it again here would say it twice.
    const others = resource.data.restrictions.filter((r) => r.kind !== 'capability_off');
    const switchedOff = others.length < resource.data.restrictions.length;
    return (
      <>
        {others.length > 0 ? (
          <RestrictionList restrictions={others} />
        ) : (
          !switchedOff && (
            <p data-testid="verification__restrictions-none">
              <Copy k="noRestrictions" />
            </p>
          )
        )}
        {switchedOff && (
          <p data-testid="verification__restrictions-capabilities">
            <Copy k="capabilitiesAbove" />
          </p>
        )}
      </>
    );
  };
  return (
    <section className="verification__cases" aria-labelledby="verification-restrictions-title" data-testid="verification__restrictions">
      <h2 id="verification-restrictions-title">
        <Copy k="restrictionsOnAccount" />
      </h2>
      {body()}
      <p>
        <a href="/uc/account">
          <Copy k="seeStatus" />
        </a>
      </p>
    </section>
  );
}

/**
 * I-kyc-compliance-07 and -17 (J-identity-08 #7): a request for a level that grants a switched-off capability was
 * refused (`kyc.capability_inactive`). Says so where the person hit it, then lists what compliance switched off on the
 * account that stops a request, in the owner's words and with the next step, read fresh from identity's account status.
 * The level map is not published to this screen, so the list is what is switched off, not a claim about which one.
 */
export function VerificationCapabilityRefused({ recordsKey }: { recordsKey: string }) {
  const { api, userId } = useSession();
  const { Copy } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'accountStatus.mine', undefined, accountStatusSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `verification-capability-refused:${userId}:${recordsKey}`,
  );
  const body = () => {
    if (resource.status === 'loading') return <Loading />;
    if (resource.status === 'failed')
      return resource.failure.code === 'identity.delegated_refused' ? (
        <p>
          <Copy k="delegated" />
        </p>
      ) : (
        <Failure result={resource.failure} retry={reload} />
      );
    const stops = (resource.data?.restrictions ?? []).filter((r) => r.kind === 'capability_off' && r.blocks.length > 0);
    // Lifted or remapped since the refusal: point to where capabilities are read, never an empty list.
    return stops.length > 0 ? (
      <>
        <p id="verification-capability-refused-list">
          <Copy k="capabilityRefusedList" />
        </p>
        <RestrictionList restrictions={stops} labelledBy="verification-capability-refused-list" />
      </>
    ) : (
      <p>
        <Copy k="capabilitiesAbove" />
      </p>
    );
  };
  return (
    <div data-testid="verification__capability-refused" data-code="kyc.capability_inactive">
      <p>
        <Copy k="capabilityRefused" />
      </p>
      {body()}
    </div>
  );
}
