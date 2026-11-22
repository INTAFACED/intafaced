import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { BreakingChangesNotice } from '../../developers';
import { useSession } from '../../session';
import { pagesCopy } from '../public-pages-copy';
import { NoticeDetail, NoticeFeed } from './NoticeFeed';

/**
 * /notice, /announcement and their detail pages, on the reading template: the published notice feed, read live. The feed
 * and each notice say their own loading, empty and failed lines, so the room itself is always ready.
 */
export function NoticeRoom({ detail = false, id = null }: { detail?: boolean; id?: string | null }) {
  const copy = pagesCopy.useCopy();
  const { session } = useSession();
  return (
    <div data-room="notice">
      <ReadingTemplate
        title={copy.t('noticeTitle')}
        state={{ kind: 'ready' }}
        body={
          <div className="lt-stack">
            {detail ? <NoticeDetail id={id} /> : <NoticeFeed />}
            {detail ? null : <BreakingChangesNotice />}
            {detail && (
              <a className="lt-link" href="/notice">
                <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> {copy.t('noticeBack')}
              </a>
            )}
          </div>
        }
        related={
          <div className="lt-stack">
            <section className="lt-stack">
              <h2>{copy.t('noticeAccountTitle')}</h2>
              <p>{copy.t('noticeAccountBody')}</p>
              <a className="lt-link" href={session ? '/notifications' : '/login?redirect=%2Fnotifications'}>
                {copy.t(session ? 'noticeInbox' : 'noticeSignIn')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
              </a>
            </section>
            <section className="lt-stack">
              <h2>{copy.t('noticeStuckTitle')}</h2>
              <p>{copy.t('noticeStuckBody')}</p>
              <a className="lt-link" href="/help">
                {copy.t('noticeHelp')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
              </a>
            </section>
          </div>
        }
      />
    </div>
  );
}
