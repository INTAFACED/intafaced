import type { ReactNode } from 'react';
import type { Resource } from '../../../../../shared/resource';
import { NotLiveCard } from '../../chrome/NotLiveCard';
import { Gate, PortalFailure } from '../../components';
import { isNotLive } from '../../refusal';
import './account.css';

/**
 * A part of a page that cannot work yet, for a reason outside the page. `reason` names what it is waiting for
 * (take it from `reason()` in `chrome/copy.ts`, or word one in `account/copy.ts`); it is required so no card can say
 * "not yet" without saying why. `needs` is the service read it waits for: never shown, listed on the review board.
 * It is never a fake row and never shows a made-up number.
 */
export function Blocker({ reason, title, needs, children }: { reason: string; title?: string; needs?: string; children?: ReactNode }) {
  return (
    <NotLiveCard reason={reason} title={title} needs={needs}>
      {children}
    </NotLiveCard>
  );
}

/**
 * Loading and refusal for one read. A read the service has not switched on yet becomes a card naming what it waits
 * for (`waiting.reason`) instead of an error, so the page still tells the person what is missing and why.
 */
export function ReadGate<T>({
  resource,
  retry,
  waiting,
  rows,
  children,
}: {
  resource: Resource<T>;
  retry: () => void;
  waiting: { reason: string; body: string; needs?: string };
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'failed' && isNotLive(resource.failure))
    return (
      <Blocker reason={waiting.reason} needs={waiting.needs}>
        {waiting.body}
      </Blocker>
    );
  if (resource.status === 'failed') return <PortalFailure result={resource.failure} retry={retry} />;
  return (
    <Gate resource={resource} retry={retry} {...(rows ? { rows } : {})}>
      {children}
    </Gate>
  );
}
