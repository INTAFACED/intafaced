import { z } from 'zod';
import { academyPublicCourseCardSchema, academyPublicCourseSchema, academyPublicHubSchema } from '@intafaced/contracts/academy-catalogue';
import { academyCourseLearnerViewSchema, type AcademyOutlineItemKind } from '@intafaced/contracts/academy-courses';
import { safeReturnTo } from '../../app/navigation';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { ServiceOffNotice } from '../../shared/service-off';
import { EmptyState, Loading, Panel } from '../../shared/ui';
import { t as copyText } from './copy';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref, academyCourseSignInHref } from './academy-lms';
import { AcademyRefusal, kindLabel, pathLabel } from './AcademyLmsParts';
import { AcademyCourseEnrol } from './AcademyCourseEnrol';
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
            <span className="academy-lms-meta">
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
                  <span className="academy-lms-meta">
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
 * The course page route: a private link (`#key=`) opens a course's unlisted page; otherwise it is the public course page.
 * The key sits after `#`, which the browser never sends to a server.
 */
export function AcademyCoursePage({ slug, signedIn }: { slug: string | undefined; signedIn: boolean }) {
  const key = new URLSearchParams(window.location.hash.slice(1)).get('key');
  return key ? (
    <AcademyLinkedCourse slug={slug ?? ''} linkKey={key} signedIn={signedIn} />
  ) : (
    <AcademyCourse slug={slug} signedIn={signedIn} />
  );
}

const LOCKS = { enrol: 'lockEnrol', enrolment_closed: 'lockClosed', not_released: 'lockNotReleased' } as const;

const OUTLINE_KINDS = {
  lesson: 'outlineLesson',
  video: 'outlineVideo',
  file: 'outlineFile',
  quiz: 'outlineQuiz',
  assignment: 'outlineAssignment',
  discussion: 'outlineDiscussion',
  link: 'outlineLink',
} as const satisfies Record<Exclude<AcademyOutlineItemKind, 'subheader'>, string>;

/**
 * A course's unlisted page through a private link (AC-catalogue-03): the stored course and its real syllabus, each item
 * with its lock, the same signed in and signed out. Reading it writes nothing. An unknown or revoked link shows the
 * course-not-found refusal, the same as a course that does not exist.
 */
export function AcademyLinkedCourse({ slug, linkKey, signedIn }: { slug: string; linkKey: string; signedIn: boolean }) {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const course = useResource(
    // A POST, so the key travels in the body and never in a URL a server logs. Reading the page writes nothing.
    (signal) => api.mutate('academy', 'publicCourseByLink', { slug, key: linkKey }, academyCourseLearnerViewSchema, { signal }),
    `linked-course:${slug}:${linkKey}`,
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
  return (
    <div className="more-columns" data-academy-linked-course={data.slug}>
      <Panel title={data.title}>
        <div className="academy-lms-stack">
          <nav className="academy-lms-crumbs" aria-label={t('breadcrumb')}>
            {back}
          </nav>
          <p className="muted" role="note">
            {t('linkedNote')}
          </p>
          <section aria-label={t('courseSummary')}>
            <h3>{t('courseSummary')}</h3>
            <p className="muted" lang="und">
              {data.summary ?? t('courseNoSummary')}
            </p>
          </section>
          <section aria-label={t('courseSyllabus')}>
            <h3>{t('courseSyllabus')}</h3>
            {data.sections.length === 0 ? (
              <p className="muted">{t('outlineEmpty')}</p>
            ) : (
              <ol className="academy-public-cards">
                {data.sections.map((section, si) => (
                  <li key={si} className="academy-lms-card">
                    <strong lang="und">{section.title}</strong>
                    <ul className="academy-lms-stack">
                      {section.items.map((item, ii) =>
                        item.kind === 'subheader' ? (
                          <li key={ii} lang="und">
                            <em>{item.title}</em>
                          </li>
                        ) : (
                          <li key={ii} data-lock={item.lock ?? 'none'} style={{ marginInlineStart: `${item.indent * 1.5}rem` }}>
                            <span lang="und">{item.title}</span>
                            <span className="academy-lms-meta">
                              <span>{t(OUTLINE_KINDS[item.kind])}</span>
                              {item.lock && <span>{t(LOCKS[item.lock])}</span>}
                            </span>
                          </li>
                        ),
                      )}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </Panel>
      <Panel title={t('courseEnrol')}>
        <div className="academy-lms-stack">
          <p>
            {data.pricing === 'free'
              ? t('linkedPriceFree')
              : data.price && data.priceAsset
                ? t('linkedPrice', { price: data.price, asset: data.priceAsset })
                : t('linkedPriceUnset')}
          </p>
          <LinkedCourseEnrol slug={data.slug} state={data.state} signedIn={signedIn} />
        </div>
      </Panel>
    </div>
  );
}

/** One card per course with published items, above the item catalogue. */
export function AcademyCourseCards() {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const cards = useResource(
    (signal) => api.query('academy', 'publicCourses', undefined, z.array(academyPublicCourseCardSchema), { signal }),
    'public-courses',
  );
  if (cards.resource.status === 'loading') return <Loading />;
  if (cards.resource.status === 'failed') return <AcademyRefusal failure={cards.resource.failure} retry={cards.reload} />;
  if (cards.resource.data.length === 0) return <EmptyState title={t('publicNothingPublished')} />;
  return (
    <ul className="academy-public-cards" aria-label={t('publicCourses')}>
      {cards.resource.data.map((card) => (
        <li key={card.slug} className="academy-lms-card">
          <a className="academy-learning-link" href={academyCourseHref(card.slug)}>
            {pathLabel(t, card.slug)}
          </a>
          <span className="academy-lms-meta">
            <Copy k="courseItems" params={{ count: card.items, minutes: card.estimatedMinutes }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Enrolment on a linked course's page. Sign-in returns to the plain course address: the private link's `#key=` never
 * rides into the redirect, which a server would see and log.
 */
export function LinkedCourseEnrol({ slug, state, signedIn }: { slug: string; state: string; signedIn: boolean }) {
  const { t, Copy } = copy.useCopy();
  if (state !== 'published') return <p className="muted">{t('linkedNotPublished')}</p>;
  if (signedIn) return null;
  return (
    <a className="button button--primary" href={academyCourseSignInHref(slug)}>
      <Copy k="courseSignInToEnrol" />
    </a>
  );
}
