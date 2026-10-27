import { useEffect, useState } from 'react';
import { kycAttemptsSchema } from '@intafaced/contracts/identity-kyc-attempts';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Failure, Loading } from '../../shared/ui';
import { verificationAttemptsCopy as copy } from './verification-attempts-copy';

/**
 * I-kyc-compliance-10 (J-identity-08 #4): where the person stands against the owner's limit on rejected requests, on
 * the request form. No limit set says so. At the cap it counts down the seconds left and tells the page, which holds
 * the form; the service refuses a request there on its own (`kyc.attempts_exhausted`). `recordsKey` is the page's
 * status read, so a decision reads the standing again.
 */
export function VerificationAttempts({ recordsKey, onLocked }: { recordsKey: string; onLocked: (locked: boolean) => void }) {
  const { api, userId } = useSession();
  const { Copy } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'kyc.attempts.read', undefined, kycAttemptsSchema, { signal }),
    `verification-attempts:${userId}:${recordsKey}`,
  );
  const lockedUntil = resource.status === 'ready' ? resource.data.lockedUntil : null;
  const [now, setNow] = useState(() => Date.now());
  const seconds = lockedUntil ? Math.ceil((Date.parse(lockedUntil) - now) / 1000) : 0;
  const locked = seconds > 0;
  useEffect(() => {
    onLocked(locked);
  }, [locked, onLocked]);
  useEffect(() => {
    if (!lockedUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);
  useEffect(() => () => onLocked(false), [onLocked]);
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed')
    return (
      <div className="verification__attempts" data-testid="verification__attempts" data-state="unread">
        <h3>
          <Copy k="failedTitle" />
        </h3>
        <Failure result={resource.failure} retry={reload} />
      </div>
    );
  const { limit, denialsInWindow } = resource.data;
  return (
    <div
      className="verification__attempts"
      data-testid="verification__attempts"
      data-state={!limit ? 'unset' : locked ? 'locked' : 'open'}
      role={locked ? 'status' : undefined}
    >
      <h3>
        <Copy k="title" />
      </h3>
      {!limit ? (
        <p className="muted">
          <Copy k="unset" />
        </p>
      ) : locked ? (
        <>
          <p data-testid="verification__attempts-locked" data-locked-until={lockedUntil}>
            <Copy k="locked" params={{ seconds: String(seconds) }} />
          </p>
          <p className="muted">
            <Copy k="lockedHelp" />
          </p>
        </>
      ) : (
        <p className="muted">
          <Copy
            k="standing"
            params={{
              count: String(denialsInWindow ?? 0),
              max: String(limit.maxDenials),
              window: String(limit.windowHours),
              lockout: String(limit.lockoutHours),
            }}
          />
        </p>
      )}
    </div>
  );
}
