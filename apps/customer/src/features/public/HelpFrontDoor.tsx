import { useId, useState } from 'react';
import { supportAwaitingMineSchema } from '@intafaced/contracts/support-awaiting';
import { contractProcedure, readContract } from '../../shared/contract-call';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui/lit';
import { useApi, useSession } from '../session';
import { helpCopy as copy } from './help-copy';
import { supportNewHref, supportRequestHref } from '../more';

const awaitingMine = contractProcedure('support', 'awaitingMine', { output: supportAwaitingMineSchema });

/**
 * For a signed-in visitor: the "Action required" banner when a request of theirs waits on their reply. It is one read of
 * the caller's own requests (a count and the one that has waited longest), not a second record. Nothing waiting draws
 * nothing; a read that failed says so instead of reading as "nothing waiting".
 */
export function ActionRequired() {
  const { userId } = useSession();
  return userId ? <WaitingBanner userId={userId} /> : null;
}

function WaitingBanner({ userId }: { userId: string }) {
  const { t } = copy.useCopy();
  const api = useApi();
  const waiting = useResource((signal) => readContract(api, awaitingMine, undefined, { signal }), `help-awaiting:${userId}`);
  const read = waiting.resource;
  if (read.status === 'loading') return null;
  if (read.status === 'failed')
    return (
      <section className="lt-stack" aria-label={t('actionRequiredTitle')} data-testid="action-required-unread">
        <p className="lt-hint">{t('actionRequiredUnread')}</p>
        <Button tone="secondary" onClick={waiting.reload}>
          {t('retry')}
        </Button>
      </section>
    );
  const { count, longestWaiting } = read.data;
  if (count === 0 || !longestWaiting) return null;
  return (
    <section className="lt-stack" role="status" aria-label={t('actionRequiredTitle')} data-testid="action-required">
      <h2>{t('actionRequiredTitle')}</h2>
      <p>
        {count === 1 ? (
          t('actionRequiredOne')
        ) : (
          <>
            <span lang="zxx">{count}</span> {t('actionRequiredMany')}
          </>
        )}
      </p>
      <a className="lt-button lt-button-primary" href={supportRequestHref(longestWaiting.ticketId)}>
        {t('actionRequiredOpen')}
      </a>
    </section>
  );
}

/** The support desk, opened on its help search with the visitor's words when there are any. */
export function supportDeskHref(query: string): string {
  const q = query.trim();
  return q ? `/support?${new URLSearchParams({ q })}` : '/support';
}

/**
 * Where a request started from the help centre goes. After a search that found nothing it is the request form with the
 * search words as its subject draft (SP-kb-03); otherwise the support desk, on its help search with the words.
 */
export function requestDestination(query: string, found: boolean): string {
  return query.trim() && !found ? supportNewHref(query) : supportDeskHref(query);
}

/**
 * The request button. Signed in it opens its destination. Signed out it shows the sign-in prompt in place, so the search
 * text on this page is kept, and the sign-in comes back to that destination; there is no mailto draft standing in for a
 * form. Guest submission is a separate slice. `contact` is the "Contact support" control under a search with no answer.
 */
export function RequestEntry({ query = '', found = true, contact = false }: { query?: string; found?: boolean; contact?: boolean }) {
  const { t } = copy.useCopy();
  const { session } = useSession();
  const [asking, setAsking] = useState(false);
  const prompt = useId();
  // The words typed in the help search go along, through sign-in too, so nobody types them twice.
  const destination = requestDestination(query, found);
  const toForm = Boolean(query.trim()) && !found;
  const label = t(contact || (session && toForm) ? 'contactSupport' : session ? 'requestOpenDesk' : 'requestStart');
  if (session)
    return (
      <a className="lt-button lt-button-secondary" href={destination}>
        {label}
      </a>
    );
  return (
    <>
      <Button tone="secondary" aria-expanded={asking} aria-controls={prompt} onClick={() => setAsking(true)}>
        {label}
      </Button>
      {asking && (
        <section id={prompt} className="lt-stack" role="status" data-testid="request-sign-in">
          <h2>{t('requestSignInTitle')}</h2>
          <p className="lt-hint">{t('requestSignInBody')}</p>
          <div className="lt-actions">
            <a className="lt-button lt-button-primary" href={`/login?redirect=${encodeURIComponent(destination)}`}>
              {t('requestSignIn')}
            </a>
            <Button tone="secondary" onClick={() => setAsking(false)}>
              {t('requestSignInClose')}
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
