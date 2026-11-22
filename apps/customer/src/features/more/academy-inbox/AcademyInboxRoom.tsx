// volt-room: /academy/rooms/messages
import type { ApiResult } from '../../../shared/api';
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { FailureBox, LoadingLine } from '../../../shared/record/record-parts';
import { copy as moreCopy } from '../copy';
import { academyRefusalText } from '../academy-flows';
import { academyLmsCopy as copy } from '../academy-lms-copy';
import { academyMessagesHref, formatMoment } from '../academy-lms';
import { AcademySections } from '../academy-sections';
import { useCourseInbox } from '../AcademyCourseMessages';

type Failure = Extract<ApiResult<never>, { ok: false }>;

/**
 * `/academy/rooms/messages` on the record-list template, signed in: the reader's conversations with course teams, newest
 * first, each with its unread marker (AC-rooms-04). The read is `useCourseInbox` (AcademyCourseMessages.tsx).
 */
export function AcademyInboxRoom() {
  const { t } = copy.useCopy();
  const more = moreCopy.useCopy();
  const { language } = usePreferences();
  const inbox = useCourseInbox();
  return (
    <RecordListTemplate
      title={more.t('moreroutes.academy')}
      description={more.t('moreroutes.learn.practise.and.join.hosted.sessions')}
      state={{ kind: 'ready' }}
      filters={<AcademySections current="Rooms" />}
      list={
        <>
          <a className="lt-link" href="/academy/rooms">
            {t('discussionAll')}
          </a>
          <section>
            <h2>{t('teamMessagesTitle')}</h2>
            <div data-course-inbox>
              <p className="lt-hint">{t('teamMessagesIntro')}</p>
              {inbox.resource.status === 'loading' && <LoadingLine />}
              {inbox.resource.status === 'failed' && <InboxFailure failure={inbox.resource.failure} retry={inbox.reload} />}
              {inbox.resource.status === 'ready' &&
                (inbox.resource.data.length === 0 ? (
                  <p role="status">{t('teamMessagesNone')}</p>
                ) : (
                  <ul>
                    {inbox.resource.data.map((row) => (
                      <li key={row.id} data-course-inbox-row={row.id} data-unread={String(row.unread)}>
                        <div>
                          <a className="lt-link" href={academyMessagesHref(row.id)} lang="und">
                            {row.courseTitle}
                          </a>
                          <div data-testid="academy-lms-meta" className="lt-actions">
                            <span className="lt-chip" data-status={row.unread ? 'pending' : 'done'}>
                              <span className="lt-chip-mark" aria-hidden="true" />
                              {row.unread ? t('teamMessagesUnread') : t('teamMessagesRead')}
                            </span>
                            <span className="lt-hint">{t('teamMessagesLast', { when: formatMoment(row.lastMessageAt, language) })}</span>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ))}
            </div>
          </section>
        </>
      }
    />
  );
}

/** A failed read in Academy's own words where it has them, else in the app's words (as `AcademyRefusal` says it). */
function InboxFailure({ failure, retry }: { failure: Failure; retry: () => void }) {
  const { t } = copy.useCopy();
  const words = academyRefusalText(failure, t);
  if (words === null) return <FailureBox result={failure} retry={retry} />;
  return (
    <div data-testid="failure" role="status">
      <p>{words}</p>
    </div>
  );
}
