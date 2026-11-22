import { findRoom, roomDescription, roomTitle } from '../../app/navigation';
import { BreakingChangesNotice } from '../developers';
import { useSession } from '../session';
import { NoticeDetail, NoticeFeed } from './NoticeFeed';
import { PARTICIPATION_ROOMS } from './public-pages';
import { pagesCopy } from './public-pages-copy';
import '../../shared/public-pages.css';

/** /notice, /announcement and their detail pages: the published notice feed, read live. */
export function NoticePage({ detail = false, id = null }: { detail?: boolean; id?: string | null }) {
  const copy = pagesCopy.useCopy();
  const { session } = useSession();
  return (
    <div className="pub-page">
      <header className="pub-heading">
        <h1>{copy.t('noticeTitle')}</h1>
      </header>
      {detail ? <NoticeDetail id={id} /> : <NoticeFeed />}
      {detail ? null : <BreakingChangesNotice />}
      {detail && (
        <a className="text-link" href="/notice">
          <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> {copy.t('noticeBack')}
        </a>
      )}
      <section className="pub-card">
        <h2>{copy.t('noticeAccountTitle')}</h2>
        <p>{copy.t('noticeAccountBody')}</p>
        <a className="text-link" href={session ? '/notifications' : '/login?redirect=%2Fnotifications'}>
          {copy.t(session ? 'noticeInbox' : 'noticeSignIn')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
        </a>
      </section>
      <section className="pub-card">
        <h2>{copy.t('noticeStuckTitle')}</h2>
        <p>{copy.t('noticeStuckBody')}</p>
        <a className="text-link" href="/help">
          {copy.t('noticeHelp')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
        </a>
      </section>
    </div>
  );
}

/**
 * Campaigns and activities, for the signed-in /campaigns room. No campaign service exists, so no campaign, task or prize is
 * shown. What a person can take part in today comes from rooms that do exist. The public /lab page is its own screen.
 */
export function CampaignsOverview({ heading = true }: { heading?: boolean }) {
  const copy = pagesCopy.useCopy();
  const { session } = useSession();
  return (
    <div className={heading ? 'pub-page' : 'pub-page pub-page--inline'}>
      {heading && (
        <header className="pub-heading">
          <h1>{copy.t('campTitle')}</h1>
        </header>
      )}
      <section className="pub-notice" role="status">
        <h2>{copy.t('campNoneTitle')}</h2>
        <p>{copy.t('campNoneBody')}</p>
      </section>
      <section className="pub-card" aria-labelledby="camp-today">
        <h2 id="camp-today">{copy.t('campTodayTitle')}</h2>
        <ul className="pub-list">
          {PARTICIPATION_ROOMS.map(({ path, note }) => {
            const room = findRoom(path);
            return (
              <li key={path}>
                <span>
                  <strong>{room ? roomTitle(room) : path}</strong>
                  <span className="muted">{copy.t(note)}</span>
                  {room && <small className="muted">{roomDescription(room)}</small>}
                </span>
                <a className="text-link" href={session ? path : `/login?redirect=${encodeURIComponent(path)}`}>
                  {copy.t(session ? 'campOpen' : 'campSignIn')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
                </a>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
