import { StatusTag } from '@intafaced/ui';
import { kycCapabilitiesOutputSchema, type KycCapabilityState } from '@intafaced/contracts/identity-kyc-capabilities';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Failure, Loading } from '../../shared/ui';
import { verificationCapabilitiesCopy as copy } from './verification-capabilities-copy';

const tagOf: Record<KycCapabilityState, 'pending' | 'filled' | 'cancelled' | 'working'> = {
  unrequested: 'working',
  pending: 'pending',
  active: 'filled',
  inactive: 'cancelled',
};

/**
 * I-kyc-compliance-07 (J-identity-08 #6): what the person's verification lets them do, on /verification. Each
 * capability shows its state and the lowest level that includes it; one compliance switched off says so with its code.
 * With no level-to-capability mapping published, it says an approval turns none on. `recordsKey` is the page's own
 * status read, so a request or a decision reads the capabilities again.
 */
export function VerificationCapabilities({ recordsKey }: { recordsKey: string }) {
  const { api, userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'kyc.capabilities.get', undefined, kycCapabilitiesOutputSchema, { signal }),
    `verification-capabilities:${userId}:${recordsKey}`,
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
    const { mapped, capabilities } = resource.data;
    return (
      <>
        <p className="muted">
          <Copy k={mapped ? 'intro' : 'unmapped'} />
        </p>
        <ul className="verification__capabilities-list" data-testid="verification__capabilities" data-mapped={mapped}>
          {capabilities.map((c) => (
            <li
              key={c.capability}
              className="verification__capability"
              data-testid="verification__capability"
              data-capability={c.capability}
              data-state={c.state}
            >
              <div className="verification__case-head">
                <span>
                  <Copy k={c.capability} />
                </span>
                <StatusTag status={tagOf[c.state]} label={t(c.state)} />
              </div>
              <p className="muted">{c.grantedAt ? <Copy k="grantedAt" params={{ level: t(c.grantedAt) }} /> : <Copy k="notGranted" />}</p>
              {c.state === 'inactive' && (
                <p data-reason={c.reasonCode ?? ''}>
                  <Copy k="inactiveHelp" />
                </p>
              )}
            </li>
          ))}
        </ul>
      </>
    );
  };
  return (
    <section className="verification__cases" aria-labelledby="verification-capabilities-title">
      <h2 id="verification-capabilities-title">
        <Copy k="title" />
      </h2>
      {body()}
    </section>
  );
}
