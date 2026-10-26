import { z } from 'zod';
import {
  ACADEMY_CURRICULUM_PATHS,
  academyPublicCourseCardSchema,
  academyPublicCourseSchema,
  academyPublicHubSchema,
} from '@intafaced/contracts/academy-catalogue';
import { safeReturnTo } from '../../app/navigation';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { ServiceOffNotice } from '../../shared/service-off';
import { EmptyState, Loading, Panel } from '../../shared/ui';
import { t as copyText } from './copy';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref } from './academy-lms';
import { AcademyRefusal, kindLabel, pathLabel } from './AcademyLmsParts';
import { AcademyCourseEnrol } from './AcademyCourseEnrol';
import { AcademyAuthoredCourse, AcademyAuthoredCourseCards, AcademyLinkedCourse } from './AcademyAuthoredCourse';
import './academy-public.css';

/**
 * The hub above the five tabs on `/academy` (AC-articles-01): the featured slot holds only what staff chose, and says
 * nothing is featured otherwise; the news block needs a news data feed and shows that notice, never a headline.
 */
export function AcademyHub() {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const hub = useResource((signal) => api.query('academy', 'publicHub', undefined, academyPublicHubSchema, { signal }), 'public-hub');
  const featured = hub.resource.status === 'ready' ? hub.resource.data.featured : null;
  return (
    <div className="more-columns" data-academy-hub="true">
      <Panel title={t('hubFeatured')}>
        {hub.resource.status === 'loading' ? (
          <Loading />
        ) : hub.resource.status === 'failed' ? (
          <AcademyRefusal failure={hub.resource.failure} retry={hub.reload} />
        ) : featured ? (
          <article className="academy-lms-card">
            <a className="academy-learning-link" href={`/academy/${encodeURIComponent(featured.slug)}`} lang="und">
              {featured.title}
            </a>
            <span data-testid="academy-lms-meta" className="academy-lms-meta">
              <span>{pathLabel(t, featured.path)}</span>
              <span>{kindLabel(t, featured.kind)}</span>
              <span>
                <Copy k="minutes" params={{ minutes: featured.estimatedMinutes }} />
              </span>
            </span>
            {featured.summary && (
              <p className="muted" lang="und">
                {featured.summary}
              </p>
            )}
          </article>
        ) : (
          <EmptyState title={t('hubNothingFeatured')} />
        )}
      </Panel>
      <Panel title={t('hubNews')}>
        <ServiceOffNotice code="feed.news" action={t('hubNewsAction')} role="status" />
      </Panel>
    </div>
  );
}

/**
 * The public course page (AC-catalogue-03), the same signed in and signed out. Summary and instructor show their
 * absence in words; the outcomes are the lessons' own objectives. Signed in, Enrol now sits here (AC-enrolment-01).
 */
export function AcademyCourse({ slug, signedIn }: { slug: string | undefined; signedIn: boolean }) {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const course = useResource(
    (signal) => api.query('academy', 'publicCourse', { slug: slug ?? '' }, academyPublicCourseSchema, { signal }),
    `public-course:${slug ?? ''}`,
  );
  const back = (
    <a className="text-link" href="/academy/learning">
      <Copy k="courseBack" />
    </a>
  );
  if (course.resource.status === 'loading') return <Loading />;
  if (course.resource.status === 'failed')
    return (
      <Panel title={copyText('academy.learning')}>
        <AcademyRefusal failure={course.resource.failure} retry={course.reload} />
        {back}
      </Panel>
    );
  const data = course.resource.data;
  const here = safeReturnTo(academyCourseHref(data.slug));
  return (
    <div className="more-columns" data-academy-course={data.slug}>
      <Panel title={pathLabel(t, data.slug)}>
        <div className="academy-lms-stack">
          <nav className="academy-lms-crumbs" aria-label={t('breadcrumb')}>
            {back}
          </nav>
          <section aria-label={t('courseSummary')}>
            <h3>{t('courseSummary')}</h3>
            <p className="muted">{data.summary ?? t('courseNoSummary')}</p>
          </section>
          <section aria-label={t('courseOutcomes')}>
            <h3>{t('courseOutcomes')}</h3>
            <ul className="academy-course-outcomes">
              {data.outcomes.map((outcome) => (
                <li key={outcome} lang="und">
                  {outcome}
                </li>
              ))}
            </ul>
          </section>
          <section aria-label={t('courseSyllabus')}>
            <h3>{t('courseSyllabus')}</h3>
            <ol className="academy-public-cards">
              {data.syllabus.map((row) => (
                <li key={row.slug} className="academy-lms-card">
                  <a className="academy-learning-link" href={`/academy/${encodeURIComponent(row.slug)}`} lang="und">
                    {row.title}
                  </a>
                  <span data-testid="academy-lms-meta" className="academy-lms-meta">
                    <span>{kindLabel(t, row.kind)}</span>
                    <span>
                      <Copy k="minutes" params={{ minutes: row.estimatedMinutes }} />
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </Panel>
      <div>
        <Panel title={t('courseInstructor')}>
          <div className="academy-lms-stack">
            <p className="muted">{data.instructor ?? t('courseNoInstructor')}</p>
            <p>{data.certificate ? t('courseCertificate', { title: data.certificate }) : t('courseNoCertificate')}</p>
            {!signedIn && (
              <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(here)}`}>
                <Copy k="courseSignInToEnrol" />
              </a>
            )}
          </div>
        </Panel>
        {signedIn && (
          <Panel title={t('courseEnrol')}>
            <AcademyCourseEnrol slug={data.slug} />
          </Panel>
        )}
      </div>
    </div>
  );
}

/**
 * The course page route: a private link (`#key=`) opens a course's unlisted page; a curriculum path is its own course
 * page; any other address is a course staff made. The key sits after `#`, which the browser never sends to a server.
 */
export function AcademyCoursePage({ slug, signedIn }: { slug: string | undefined; signedIn: boolean }) {
  const key = new URLSearchParams(window.location.hash.slice(1)).get('key');
  if (key) return <AcademyLinkedCourse slug={slug ?? ''} linkKey={key} />;
  if (!slug || (ACADEMY_CURRICULUM_PATHS as readonly string[]).includes(slug)) return <AcademyCourse slug={slug} signedIn={signedIn} />;
  return <AcademyAuthoredCourse slug={slug} signedIn={signedIn} />;
}

/** One card per course with published items, then the published courses staff made, above the item catalogue. */
export function AcademyCourseCards() {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const cards = useResource(
    (signal) => api.query('academy', 'publicCourses', undefined, z.array(academyPublicCourseCardSchema), { signal }),
    'public-courses',
  );
  if (cards.resource.status === 'loading') return <Loading />;
  if (cards.resource.status === 'failed') return <AcademyRefusal failure={cards.resource.failure} retry={cards.reload} />;
  if (cards.resource.data.length === 0)
    // Nothing is published only when no course staff made is either.
    return <AcademyAuthoredCourseCards whenEmpty={<EmptyState title={t('publicNothingPublished')} />} />;
  return (
    <>
      <ul className="academy-public-cards" aria-label={t('publicCourses')}>
        {cards.resource.data.map((card) => (
          <li key={card.slug} className="academy-lms-card">
            <a className="academy-learning-link" href={academyCourseHref(card.slug)}>
              {pathLabel(t, card.slug)}
            </a>
            <span data-testid="academy-lms-meta" className="academy-lms-meta">
              <Copy k="courseItems" params={{ count: card.items, minutes: card.estimatedMinutes }} />
            </span>
          </li>
        ))}
      </ul>
      <AcademyAuthoredCourseCards />
    </>
  );
}
