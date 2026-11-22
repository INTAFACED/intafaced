import { StatusChip } from '@intafaced/ui/lit/templates';
import type { MoneyStatus } from '@intafaced/ui/lit';
import { type KycCapabilityState } from '@intafaced/contracts/identity-kyc-capabilities';
import { useSession } from '../session';
import { useResource } from '../../shared/resource';
import { ReadFailure, ReadLoading } from '../../shared/read-state';
import { verificationCapabilitiesCopy as copy } from './verification-capabilities-copy';
import { IDENTITY_KYC_CAPABILITIES_GET } from '@intafaced/contracts/identity-kyc-procedures';

// Not requested is no status at all, so it is plain text, never a tag that reads as something under way.
const tagOf: Record<Exclude<KycCapabilityState, 'unrequested'>, MoneyStatus> = {
  pending: 'pending',
  active: 'done',
  inactive: 'failed',
};

/**
 * I-kyc-compliance-07 (J-identity-08 #6): what the person's verification lets them do, on /verification. Each
 * capability shows its state and the lowest level that includes it; one compliance switched off says so with the
 * owner's reason.
 * With no level-to-capability mapping published, it says an approval turns none on. `recordsKey` is the page's own
 * status read, so a request or a decision reads the capabilities again.
 */
export function VerificationCapabilities({ recordsKey }: { recordsKey: string }) {
  const { api, userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.call(IDENTITY_KYC_CAPABILITIES_GET, undefined, { signal }),
    `verification-capabilities:${userId}:${recordsKey}`,
  );
  const body = () => {
    if (resource.status === 'loading') return <ReadLoading />;
    if (resource.status === 'failed')
      return (
        <>
          <h3>
            <Copy k="failedTitle" />
          </h3>
          <ReadFailure result={resource.failure} retry={reload} />
        </>
      );
    const { mapped, capabilities } = resource.data;
    return (
      <>
        <p className="lt-hint">
          <Copy k={mapped ? 'intro' : 'unmapped'} />
        </p>
        <ul data-testid="verification__capabilities" data-mapped={mapped}>
          {capabilities.map((c) => (
            <li key={c.capability} data-testid="verification__capability" data-capability={c.capability} data-state={c.state}>
              <div>
                <span>
                  <Copy k={c.capability} />
                </span>
                {c.state === 'unrequested' ? (
                  <span className="lt-hint">
                    <Copy k="unrequested" />
                  </span>
                ) : (
                  <StatusChip status={tagOf[c.state]} label={t(c.state)} />
                )}
              </div>
              <p className="lt-hint">{c.grantedAt ? <Copy k="grantedAt" params={{ level: t(c.grantedAt) }} /> : <Copy k="notGranted" />}</p>
              {c.state === 'inactive' && (
                <div data-testid="verification__capability-reason" data-reason={c.reasonCode ?? ''}>
                  {c.reasonText && (
                    <p>
                      <Copy k="reason" params={{ text: c.reasonText }} />
                    </p>
                  )}
                  <p className="lt-hint">
                    <Copy k="inactiveHelp" />
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      </>
    );
  };
  return (
    <section aria-labelledby="verification-capabilities-title">
      <h2 id="verification-capabilities-title">
        <Copy k="title" />
      </h2>
      {body()}
    </section>
  );
}
