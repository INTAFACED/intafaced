import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session';
import { useResource } from '../../shared/resource';
import { ReadFailure, ReadLoading } from '../../shared/read-state';
import { verificationAttemptsCopy as copy } from './verification-attempts-copy';
import { IDENTITY_KYC_ATTEMPTS_READ } from '@intafaced/contracts/identity-kyc-procedures';

/**
 * I-kyc-compliance-10 (J-identity-08 #4): where the person stands against the owner's limit on rejected requests, on
 * the request form. No limit set says so. At the cap it counts down the seconds left and tells the page, which holds
 * the form; the service refuses a request there on its own (`kyc.attempts_exhausted`). `recordsKey` is the page's
 * status read, plus a count of such refusals, so a decision or a refusal reads the standing again. The countdown is not
 * a live region: a screen reader would read it every second.
 */
export function VerificationAttempts({ recordsKey, onLocked }: { recordsKey: string; onLocked: (locked: boolean) => void }) {
  const { api, userId } = useSession();
  const { Copy } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.call(IDENTITY_KYC_ATTEMPTS_READ, undefined, { signal }),
    `verification-attempts:${userId}:${recordsKey}`,
  );
  // A re-read keeps the last known lock, so the form never opens while a lockout is only being read again.
  const lastLockedUntil = useRef<string | null>(null);
  if (resource.status === 'ready') lastLockedUntil.current = resource.data.lockedUntil;
  const lockedUntil = lastLockedUntil.current;
  const [, setTick] = useState(0);
  const seconds = lockedUntil ? Math.ceil((Date.parse(lockedUntil) - Date.now()) / 1000) : 0;
  const locked = seconds > 0;
  useEffect(() => {
    onLocked(locked);
  }, [locked, onLocked]);
  useEffect(() => {
    if (!locked) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [locked]);
  useEffect(() => () => onLocked(false), [onLocked]);
  if (resource.status === 'loading') return <ReadLoading />;
  if (resource.status === 'failed')
    return (
      <div data-testid="verification__attempts" data-state="unread">
        <h3>
          <Copy k="failedTitle" />
        </h3>
        <ReadFailure result={resource.failure} retry={reload} />
      </div>
    );
  const { limit, denialsInWindow } = resource.data;
  return (
    <div data-testid="verification__attempts" data-state={!limit ? 'unset' : locked ? 'locked' : 'open'}>
      <h3>
        <Copy k="title" />
      </h3>
      {!limit ? (
        <p className="lt-hint">
          <Copy k="unset" />
        </p>
      ) : locked ? (
        <>
          <p data-testid="verification__attempts-locked" data-locked-until={lockedUntil}>
            <Copy k="locked" params={{ seconds: String(seconds) }} />
          </p>
          <p className="lt-hint">
            <Copy k="lockedHelp" />
          </p>
        </>
      ) : (
        <p className="lt-hint">
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
