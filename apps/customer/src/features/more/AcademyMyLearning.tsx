import { type AcademyMyCourse } from '@intafaced/contracts/academy-catalogue';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { useApi, useSession } from '../session';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref, formatDay } from './academy-lms';
import { pathLabel } from './academy-labels';
import { AcademyRefusal } from './academy-refusal';
import { ProgressMeter } from './academy-kit-parts';
import { EmptyNote, Section, Waiting } from './volt-parts';
import { ACADEMY_MY_LEARNING } from '@intafaced/contracts/academy-my-learning-procedures';

const itemHref = (slug: string) => `/academy/${encodeURIComponent(slug)}`;
const SECTIONS = [
  ['in_progress', 'myInProgress', 'myNothingInProgress'],
  ['completed', 'myCompleted', 'myNothingCompleted'],
  ['future_start', 'myFutureStart', 'myNothingFuture'],
] as const;

/** My learning on the Learning tab (AC-catalogue-02), drawn with the kit: the caller's enrolled courses, by state, with real progress. */
export function AcademyMyLearning() {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const mine = useResource((signal) => api.call(ACADEMY_MY_LEARNING, undefined, { signal }), `my-learning:${userId}`);
  return (
    <Section title={t('myLearning')} className="lt-stack">
      {mine.resource.status === 'loading' ? (
        <Waiting />
      ) : mine.resource.status === 'failed' ? (
        <AcademyRefusal failure={mine.resource.failure} retry={mine.reload} />
      ) : (
        <MyLearningView courses={mine.resource.data} />
      )}
    </Section>
  );
}

/** Pure: the sections as data says them. Continue appears only once something in the course was opened or completed. */
export function MyLearningView({ courses }: { courses: readonly AcademyMyCourse[] }) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  if (courses.length === 0) return <EmptyNote title={t('myNoCourses')} />;
  return (
    <div className="lt-stack" data-academy-my-learning="true">
      {SECTIONS.map(([status, title, empty]) => {
        const rows = courses.filter((row) => row.status === status);
        return (
          <section key={status} className="lt-stack" aria-label={t(title)} data-my-learning-section={status}>
            <h3>{t(title)}</h3>
            {rows.length === 0 ? (
              <p className="lt-hint">{t(empty)}</p>
            ) : (
              <ul className="lt-stack">
                {rows.map((row) => (
                  <li key={row.slug} className="lt-stack" data-my-course={row.slug}>
                    <a className="lt-link lt-link-alone" href={academyCourseHref(row.slug)}>
                      {pathLabel(t, row.slug)}
                    </a>
                    <span data-testid="academy-lms-meta" className="lt-actions lt-hint">
                      <span>
                        <Copy k="myProgress" params={{ completed: row.completed, items: row.items }} />
                      </span>
                      <time dateTime={row.startsAt ?? row.enrolledAt}>
                        {row.startsAt ? (
                          <Copy k="myStartsOn" params={{ date: formatDay(row.startsAt, language) }} />
                        ) : (
                          <Copy k="enrolledSince" params={{ date: formatDay(row.enrolledAt, language) }} />
                        )}
                      </time>
                    </span>
                    <ProgressMeter
                      percent={(row.completed / row.items) * 100}
                      label={t('myProgress', { completed: row.completed, items: row.items })}
                    />
                    {row.status !== 'future_start' && (
                      <a className="lt-button lt-button-secondary" href={itemHref(row.resumeItemSlug ?? row.firstItemSlug)}>
                        {row.resumeItemSlug ? t('myContinue') : t('myStartCourse')}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
