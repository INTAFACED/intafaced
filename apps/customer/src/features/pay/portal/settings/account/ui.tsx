import type { ReactNode } from 'react';
import { StatusTag } from '@intafaced/ui';
import type { Resource } from '../../../../../shared/resource';
import { Gate, PortalFailure } from '../../components';
import { isComingSoon } from '../../refusal';
import { accountCopy } from './copy';
import './account.css';

/**
 * A part of a page that cannot work yet, for a reason outside the page. `what` names the blocker in a few words
 * ("the starter fee", "the document check"). It is never a fake row and never shows a made-up number.
 */
export function Blocker({ what, title, children }: { what: string; title?: string; children: ReactNode }) {
  const { t } = accountCopy.useCopy();
  return (
    <section className="sa-blocker" aria-label={title ?? what}>
      <StatusTag status="pending" label={t('waitingOn', { what })} />
      {title && <h3>{title}</h3>}
      <p>{children}</p>
    </section>
  );
}

/**
 * Loading and refusal for one read. A read the service has not switched on yet becomes a named blocker (`waiting`)
 * instead of an error, so the page still tells the person what is missing and why.
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
  waiting: { what: string; body: string };
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'failed' && isComingSoon(resource.failure)) return <Blocker what={waiting.what}>{waiting.body}</Blocker>;
  if (resource.status === 'failed') return <PortalFailure result={resource.failure} retry={retry} />;
  return (
    <Gate resource={resource} retry={retry} {...(rows ? { rows } : {})}>
      {children}
    </Gate>
  );
}
