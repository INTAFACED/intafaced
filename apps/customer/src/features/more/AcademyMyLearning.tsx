import { z } from 'zod';
import {
  academyAccessGrantSchema,
  academyMyCourseSchema,
  type AcademyAccessGrant,
  type AcademyMyCourse,
} from '@intafaced/contracts/academy-catalogue';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { EmptyState, Loading, Panel } from '../../shared/ui';
import { useApi, useSession } from '../session/session';
import { Details } from './common';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref, formatDay } from './academy-lms';
import { AcademyRefusal, ProgressBar, pathLabel } from './AcademyLmsParts';

const itemHref = (slug: string) => `/academy/${encodeURIComponent(slug)}`;
const SECTIONS = [
  ['in_progress', 'myInProgress', 'myNothingInProgress'],
  ['completed', 'myCompleted', 'myNothingCompleted'],
  ['future_start', 'myFutureStart', 'myNothingFuture'],
] as const;

/** My learning on the Learning tab (AC-catalogue-02): the caller's enrolled courses, by state, with real progress. */
export function AcademyMyLearning() {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const mine = useResource(
    (signal) => api.query('academy', 'myLearning', undefined, z.array(academyMyCourseSchema), { signal }),
    `my-learning:${userId}`,
  );
  return (
    <Panel title={t('myLearning')}>
      {mine.resource.status === 'loading' ? (
        <Loading />
      ) : mine.resource.status === 'failed' ? (
        <AcademyRefusal failure={mine.resource.failure} retry={mine.reload} />
      ) : (
        <MyLearningView courses={mine.resource.data} />
      )}
    </Panel>
  );
}

/** Pure: the sections as data says them. Continue appears only once something in the course was opened or completed. */
export function MyLearningView({ courses }: { courses: readonly AcademyMyCourse[] }) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  if (courses.length === 0) return <EmptyState title={t('myNoCourses')} />;
  return (
    <div className="academy-lms-stack" data-academy-my-learning="true">
      {SECTIONS.map(([status, title, empty]) => {
        const rows = courses.filter((row) => row.status === status);
        return (
          <section key={status} aria-label={t(title)} data-my-learning-section={status}>
            <h3>{t(title)}</h3>
            {rows.length === 0 ? (
              <p className="muted">{t(empty)}</p>
            ) : (
              <ul className="academy-public-cards">
                {rows.map((row) => (
                  <li key={row.slug} className="academy-lms-card" data-my-course={row.slug}>
                    <a className="academy-learning-link" href={academyCourseHref(row.slug)}>
                      {pathLabel(t, row.slug)}
                    </a>
                    <span data-testid="academy-lms-meta" className="academy-lms-meta">
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
                    <ProgressBar
                      percent={(row.completed / row.items) * 100}
                      label={t('myProgress', { completed: row.completed, items: row.items })}
                    />
                    {row.status !== 'future_start' && (
                      <a className="button button--secondary" href={itemHref(row.resumeItemSlug ?? row.firstItemSlug)}>
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

const SOURCE_KEYS = {
  free: 'accessSourceFree',
  purchase: 'accessSourcePurchase',
  staff: 'accessSourceStaff',
  invitation: 'accessSourceInvitation',
} as const satisfies Record<AcademyAccessGrant['source'], string>;

/** The access records on /academy/progress (AC-access-grants-01): one per course, with source and expiry. */
export function AcademyAccessGrants() {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const grants = useResource(
    (signal) => api.query('academy', 'myAccessGrants', undefined, z.array(academyAccessGrantSchema), { signal }),
    `access-grants:${userId}`,
  );
  return (
    <Panel title={t('accessTitle')}>
      {grants.resource.status === 'loading' ? (
        <Loading />
      ) : grants.resource.status === 'failed' ? (
        <AcademyRefusal failure={grants.resource.failure} retry={grants.reload} />
      ) : (
        <AccessGrantsView grants={grants.resource.data} />
      )}
    </Panel>
  );
}

export function AccessGrantsView({ grants }: { grants: readonly AcademyAccessGrant[] }) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  if (grants.length === 0) return <EmptyState title={t('accessNone')} />;
  return (
    <ul className="academy-public-cards" data-academy-access="true">
      {grants.map((row) => (
        <li key={row.slug} className="academy-lms-card" data-access-grant={row.slug}>
          <a className="academy-learning-link" href={academyCourseHref(row.slug)}>
            {pathLabel(t, row.slug)}
          </a>
          <Details
            items={[
              [t('accessSource'), t(SOURCE_KEYS[row.source])],
              [t('accessGranted'), <time dateTime={row.grantedAt}>{formatDay(row.grantedAt, language)}</time>],
              [
                t('accessExpires'),
                row.expiresAt ? <time dateTime={row.expiresAt}>{formatDay(row.expiresAt, language)}</time> : t('accessNoExpiry'),
              ],
            ]}
          />
        </li>
      ))}
    </ul>
  );
}
