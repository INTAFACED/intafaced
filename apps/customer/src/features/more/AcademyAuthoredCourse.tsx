import { useEffect, useState, type ReactNode } from 'react';
import {
  academyCourseLearnerViewSchema,
  academyPublishedCourseListSchema,
  type AcademyCourseLearnerView,
  type AcademyOutlineItemKind,
  type AcademyPublishedCourseCard,
} from '@intafaced/contracts/academy-courses';
import { useApi } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Loading, Panel } from '../../shared/ui';
import { t as copyText } from './copy';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyAssignmentHref, academyCourseHref, academyCourseSignInHref } from './academy-lms';
import { AcademyRefusal } from './AcademyLmsParts';
import { AcademyCourseEnrol } from './AcademyCourseEnrol';
import { CourseTeamContact } from './AcademyCourseMessages';

/**
 * Courses staff made on the founder console, on the learner side (AC-catalogue-03, AC-enrolment-01): the catalogue
 * cards, the public course page, and the unlisted page a private link opens. Every figure is the stored course; a lock
 * says why an item is shut. Signed in, the page carries Enrol now on the free track, and the reader's enrolment opens
 * what is released.
 */

/** The page size the catalogue asks for. */
const CARDS_PAGE = 50;

const LOCKS = {
  enrol: 'lockEnrol',
  enrolment_closed: 'lockClosed',
  not_released: 'lockNotReleased',
  scheduled: 'lockScheduled',
} as const;

/** An instant in the reader's own time zone and language. */
const localTime = (iso: string, language: string) => {
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
};

/** When a scheduled section opens for this reader (AC-release-access-01): a clock with the local instant, or the days. */
function SectionRelease({ release }: { release: AcademyCourseLearnerView['sections'][number]['release'] }) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  if (release === null) return null;
  const text =
    release.at === null
      ? t('releaseAfterEnrolment', { days: String(release.afterEnrolmentDays ?? '') })
      : t(release.open ? 'releaseOpen' : 'releaseAt', { date: localTime(release.at, language) });
  return (
    <p className="academy-lms-meta" data-testid="section-release" data-open={release.open ? 'yes' : 'no'}>
      <span aria-hidden="true">🕒</span> {release.at !== null && <time dateTime={release.at}>{text}</time>}
      {release.at === null && text}
    </p>
  );
}
const OUTLINE_KINDS = {
  lesson: 'outlineLesson',
  video: 'outlineVideo',
  file: 'outlineFile',
  quiz: 'outlineQuiz',
  assignment: 'outlineAssignment',
  discussion: 'outlineDiscussion',
  link: 'outlineLink',
} as const satisfies Record<Exclude<AcademyOutlineItemKind, 'subheader'>, string>;

function Back() {
  const { Copy } = copy.useCopy();
  return (
    <a className="text-link" href="/academy/learning">
      <Copy k="courseBack" />
    </a>
  );
}

/** The stored price in words: free, the owner-set figure, or that none is set. */
function priceText(t: (typeof copy)['t'], course: Pick<AcademyPublishedCourseCard, 'pricing' | 'price' | 'priceAsset'>): string {
  if (course.pricing === 'free') return t('linkedPriceFree');
  return course.price && course.priceAsset ? t('linkedPrice', { price: course.price, asset: course.priceAsset }) : t('linkedPriceUnset');
}

function PriceLine({ data }: { data: AcademyCourseLearnerView }) {
  const { t } = copy.useCopy();
  return <p>{priceText(t, data)}</p>;
}

/** The course's summary and syllabus, each item with its lock. Pure: the course arrives as props. */
export function AuthoredCourseBody({ data, note }: { data: AcademyCourseLearnerView; note?: string }) {
  const { t } = copy.useCopy();
  return (
    <div className="academy-lms-stack">
      <nav className="academy-lms-crumbs" aria-label={t('breadcrumb')}>
        <Back />
      </nav>
      {note && (
        <p className="muted" role="note">
          {note}
        </p>
      )}
      <section aria-label={t('courseSummary')}>
        <h3>{t('courseSummary')}</h3>
        <p className="muted" lang="und">
          {data.summary ?? t('courseNoSummary')}
        </p>
      </section>
      <section aria-label={t('courseSyllabus')}>
        <h3>{t('courseSyllabus')}</h3>
        {data.pacing && (
          <p className="muted" data-testid="course-pacing">
            {t(data.pacing === 'self_paced' ? 'pacingSelf' : 'pacingInstructor')}
          </p>
        )}
        {data.sections.length === 0 ? (
          <p className="muted">{t('outlineEmpty')}</p>
        ) : (
          <ol className="academy-public-cards">
            {data.sections.map((section, si) => (
              <li key={si} className="academy-lms-card">
                <strong lang="und">{section.title}</strong>
                <SectionRelease release={section.release} />
                <ul className="academy-lms-stack">
                  {section.items.map((item, ii) =>
                    item.kind === 'subheader' ? (
                      <li key={ii} lang="und">
                        <em>{item.title}</em>
                      </li>
                    ) : (
                      <li key={ii} data-lock={item.lock ?? 'none'} style={{ marginInlineStart: `${item.indent * 1.5}rem` }}>
                        {item.kind === 'assignment' && item.lock === null ? (
                          <a className="academy-learning-link" href={academyAssignmentHref(data.slug, item.id)} lang="und">
                            {item.title}
                          </a>
                        ) : (
                          <span lang="und">{item.title}</span>
                        )}
                        <span data-testid="academy-lms-meta" className="academy-lms-meta">
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
  );
}

function Failed({ failure, retry }: { failure: Parameters<typeof AcademyRefusal>[0]['failure']; retry: () => void }) {
  return (
    <Panel title={copyText('academy.learning')}>
      <AcademyRefusal failure={failure} retry={retry} />
      <Back />
    </Panel>
  );
}

/**
 * The public page of a published course staff made. Signed out it shows Sign in to enrol; signed in it reads the course
 * as the caller sees it and carries Enrol now, and re-reads the course once an enrolment settles.
 */
export function AcademyAuthoredCourse({ slug, signedIn }: { slug: string; signedIn: boolean }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const course = useResource(
    (signal) =>
      signedIn
        ? api.query('academy', 'authoredCourse', { slug }, academyCourseLearnerViewSchema, { signal })
        : api.query('academy', 'publicAuthoredCourse', { slug }, academyCourseLearnerViewSchema, { signal }),
    `authored-course:${signedIn ? 'in' : 'out'}:${slug}`,
  );
  // A re-read after an enrolment keeps the page (and its enrol block) on screen until the new read lands.
  const [last, setLast] = useState<AcademyCourseLearnerView | null>(null);
  const ready = course.resource.status === 'ready' ? course.resource.data : null;
  useEffect(() => {
    if (ready) setLast(ready);
  }, [ready]);
  if (course.resource.status === 'failed') return <Failed failure={course.resource.failure} retry={course.reload} />;
  const data = ready ?? last;
  if (!data) return <Loading />;
  return (
    <div className="more-columns" data-academy-authored-course={data.slug}>
      <Panel title={data.title}>
        <AuthoredCourseBody data={data} />
      </Panel>
      <Panel title={t('courseEnrol')}>
        <div className="academy-lms-stack">
          <PriceLine data={data} />
          {signedIn ? (
            <AcademyCourseEnrol slug={data.slug} source="authored" onSettled={course.reload} />
          ) : (
            <a className="button button--primary" href={academyCourseSignInHref(data.slug)}>
              {t('courseSignInToEnrol')}
            </a>
          )}
        </div>
      </Panel>
      {signedIn && <CourseTeamContact courseSlug={data.slug} />}
    </div>
  );
}

/**
 * A course's unlisted page through a private link (AC-catalogue-03): the stored course and its real syllabus, the same
 * signed in and signed out. Reading it writes nothing. An unknown or revoked link shows the course-not-found refusal,
 * the same as a course that does not exist. Once the course is published, enrolling happens on its public page.
 */
export function AcademyLinkedCourse({ slug, linkKey }: { slug: string; linkKey: string }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const course = useResource(
    // A POST, so the key travels in the body and never in a URL a server logs. Reading the page writes nothing.
    (signal) => api.mutate('academy', 'publicCourseByLink', { slug, key: linkKey }, academyCourseLearnerViewSchema, { signal }),
    `linked-course:${slug}:${linkKey}`,
  );
  if (course.resource.status === 'loading') return <Loading />;
  if (course.resource.status === 'failed') return <Failed failure={course.resource.failure} retry={course.reload} />;
  const data = course.resource.data;
  return (
    <div className="more-columns" data-academy-linked-course={data.slug}>
      <Panel title={data.title}>
        <AuthoredCourseBody data={data} note={t('linkedNote')} />
      </Panel>
      <Panel title={t('courseEnrol')}>
        <div className="academy-lms-stack">
          <PriceLine data={data} />
          <LinkedCourseEnrol slug={data.slug} state={data.state} />
        </div>
      </Panel>
    </div>
  );
}

/**
 * Enrolment on a linked course's page: a published course enrols on its public page, reached by its plain address, so
 * the private link's `#key=` never rides into a URL a server would see and log.
 */
export function LinkedCourseEnrol({ slug, state }: { slug: string; state: string }) {
  const { t } = copy.useCopy();
  if (state !== 'published') return <p className="muted">{t('linkedNotPublished')}</p>;
  return (
    <a className="button button--primary" href={academyCourseHref(slug)}>
      {t('linkedOpenPublic')}
    </a>
  );
}

/** One card per published course staff made, most recently published first; `whenEmpty` shows when there is none. */
export function AcademyAuthoredCourseCards({ whenEmpty = null }: { whenEmpty?: ReactNode }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const cards = useResource(
    (signal) => api.query('academy', 'publicAuthoredCourses', { limit: CARDS_PAGE }, academyPublishedCourseListSchema, { signal }),
    'public-authored-courses',
  );
  if (cards.resource.status === 'loading') return <Loading />;
  if (cards.resource.status === 'failed') return <AcademyRefusal failure={cards.resource.failure} retry={cards.reload} />;
  if (cards.resource.data.length === 0) return <>{whenEmpty}</>;
  return (
    <ul className="academy-public-cards" aria-label={t('publicAuthoredCourses')} data-academy-authored-cards="true">
      {cards.resource.data.map((card) => (
        <li key={card.slug} className="academy-lms-card">
          <a className="academy-learning-link" href={academyCourseHref(card.slug)} lang="und">
            {card.title}
          </a>
          <span data-testid="academy-lms-meta" className="academy-lms-meta">
            <span>{t('authoredItems', { count: card.items })}</span>
            <span>{priceText(t, card)}</span>
          </span>
          {card.summary && (
            <p className="muted" lang="und">
              {card.summary}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
