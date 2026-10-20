import { useState } from 'react';
import { supportAwaitingMineSchema } from '@intafaced/contracts/support-awaiting';
import { contractProcedure, readContract } from '../../shared/contract-call';
import { useResource } from '../../shared/resource';
import { Button } from '../../shared/ui';
import { useApi, useSession } from '../session/session';
import { helpCopy as copy } from './help-copy';
import { supportRequestHref } from '../more/support-desk';

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
      <section className="help__card help__measure" aria-label={t('actionRequiredTitle')} data-testid="action-required-unread">
        <p className="muted">{t('actionRequiredUnread')}</p>
        <Button variant="secondary" onClick={waiting.reload}>
          {t('retry')}
        </Button>
      </section>
    );
  const { count, longestWaiting } = read.data;
  if (count === 0 || !longestWaiting) return null;
  return (
    <section className="help__card help__measure" role="status" aria-label={t('actionRequiredTitle')} data-testid="action-required">
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
      <a className="button button--primary" href={supportRequestHref(longestWaiting.ticketId)}>
        {t('actionRequiredOpen')}
      </a>
    </section>
  );
}

/**
 * The request button. Signed in it opens the support desk. Signed out it shows the sign-in prompt in place, so the search
 * text on this page is kept; there is no mailto draft standing in for a form. Guest submission is a separate slice.
 */
export function RequestEntry() {
  const { t } = copy.useCopy();
  const { session } = useSession();
  const [asking, setAsking] = useState(false);
  if (session)
    return (
      <a className="button button--secondary" href="/support">
        {t('requestOpenDesk')}
      </a>
    );
  return (
    <>
      <Button variant="secondary" aria-expanded={asking} aria-controls="help-request-signin" onClick={() => setAsking(true)}>
        {t('requestStart')}
      </Button>
      {asking && (
        <section id="help-request-signin" className="help__card help__measure" role="status" data-testid="request-sign-in">
          <h2>{t('requestSignInTitle')}</h2>
          <p className="muted">{t('requestSignInBody')}</p>
          <a className="button button--primary" href={`/login?redirect=${encodeURIComponent('/support')}`}>
            {t('requestSignIn')}
          </a>
          <Button variant="secondary" onClick={() => setAsking(false)}>
            {t('requestSignInClose')}
          </Button>
        </section>
      )}
    </>
  );
}
