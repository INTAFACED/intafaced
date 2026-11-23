import { useEffect, useState } from 'react';
import { type AcademyCourseLearnerView, type AcademyOutlineItemKind } from '@intafaced/contracts/academy-courses';
import { useApi } from '../session';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { t as copyText } from './copy';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyAssignmentHref, academyCourseHref, academyCourseSignInHref } from './academy-lms';
import { AcademyRefusal } from './academy-refusal';
import { priceText } from './academy-course-words';
import { Section, Waiting } from './volt-parts';
import { AcademyCourseEnrol } from './AcademyCourseEnrol';
import { AcademyCoursePurchase } from './AcademyCoursePurchase';
import { CourseTeamContact } from './AcademyCourseMessages';
import { ACADEMY_AUTHORED_COURSE } from '@intafaced/contracts/academy-authored-course-procedures';
import { ACADEMY_PUBLIC_AUTHORED_COURSE } from '@intafaced/contracts/academy-public-authored-course-procedures';
import { ACADEMY_PUBLIC_COURSE_BY_LINK } from '@intafaced/contracts/academy-public-course-by-link-procedures';

/**
 * Courses staff made on the founder console, on the learner side (AC-catalogue-03, AC-enrolment-01): the catalogue
 * cards, the public course page, and the unlisted page a private link opens. Every figure is the stored course; a lock
 * says why an item is shut. Signed in, the page carries Enrol now on the free track, and the reader's enrolment opens
 * what is released.
 */

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
    <p className="lt-hint" data-testid="section-release" data-open={release.open ? 'yes' : 'no'}>
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
    <a className="lt-link lt-link-alone" href="/academy/learning">
      <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> <Copy k="courseBack" />
    </a>
  );
}

function PriceLine({ data }: { data: AcademyCourseLearnerView }) {
  const { t } = copy.useCopy();
  return <p>{priceText(t, data)}</p>;
}

/** The course's summary and syllabus, each item with its lock. Pure: the course arrives as props. */
export function AuthoredCourseBody({ data, note }: { data: AcademyCourseLearnerView; note?: string }) {
  const { t } = copy.useCopy();
  return (
    <div className="lt-stack">
      <nav aria-label={t('breadcrumb')}>
        <Back />
      </nav>
      {note && (
        <p className="lt-hint" role="note">
          {note}
        </p>
      )}
      <section aria-label={t('courseSummary')}>
        <h3>{t('courseSummary')}</h3>
        <p className="lt-hint" lang="und">
          {data.summary ?? t('courseNoSummary')}
        </p>
      </section>
      <section aria-label={t('courseSyllabus')}>
        <h3>{t('courseSyllabus')}</h3>
        {data.pacing && (
          <p className="lt-hint" data-testid="course-pacing">
            {t(data.pacing === 'self_paced' ? 'pacingSelf' : 'pacingInstructor')}
          </p>
        )}
        {data.sections.length === 0 ? (
          <p className="lt-hint">{t('outlineEmpty')}</p>
        ) : (
          <ol className="lt-stack">
            {data.sections.map((section, si) => (
              <li key={si} className="lt-stack">
                <strong lang="und">{section.title}</strong>
                <SectionRelease release={section.release} />
                <ul className="lt-stack">
                  {section.items.map((item, ii) =>
                    item.kind === 'subheader' ? (
                      <li key={ii} lang="und">
                        <em>{item.title}</em>
                      </li>
                    ) : (
                      <li key={ii} className="lt-stack lt-indent" data-indent={item.indent} data-lock={item.lock ?? 'none'}>
                        {item.kind === 'assignment' && item.lock === null ? (
                          <a className="lt-link" href={academyAssignmentHref(data.slug, item.id)} lang="und">
                            {item.title}
                          </a>
                        ) : (
                          <span lang="und">{item.title}</span>
                        )}
                        <span data-testid="academy-lms-meta" className="lt-actions lt-hint">
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
    <Section title={copyText('academy.learning')}>
      <AcademyRefusal failure={failure} retry={retry} />
      <Back />
    </Section>
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
      signedIn ? api.call(ACADEMY_AUTHORED_COURSE, { slug }, { signal }) : api.call(ACADEMY_PUBLIC_AUTHORED_COURSE, { slug }, { signal }),
    `authored-course:${signedIn ? 'in' : 'out'}:${slug}`,
  );
  // A re-read after an enrolment keeps the page (and its enrol block) on screen until the new read lands.
  const [last, setLast] = useState<AcademyCourseLearnerView | null>(null);
  // A purchase that settles (granted or refunded) changes what Enrol allows: the enrol block reads its terms again.
  const [purchases, setPurchases] = useState(0);
  const settlePurchase = () => {
    setPurchases((n) => n + 1);
    course.reload();
  };
  const ready = course.resource.status === 'ready' ? course.resource.data : null;
  useEffect(() => {
    if (ready) setLast(ready);
  }, [ready]);
  if (course.resource.status === 'failed') return <Failed failure={course.resource.failure} retry={course.reload} />;
  const data = ready ?? last;
  if (!data) return <Waiting />;
  return (
    <div className="lt-stack" data-academy-authored-course={data.slug}>
      <Section title={data.title}>
        <AuthoredCourseBody data={data} />
      </Section>
      <Section title={t('courseEnrol')}>
        <div className="lt-stack">
          <PriceLine data={data} />
          {signedIn ? (
            <AcademyCourseEnrol key={`enrol:${purchases}`} slug={data.slug} source="authored" onSettled={course.reload} />
          ) : (
            <a className="lt-button lt-button-primary" href={academyCourseSignInHref(data.slug)}>
              {t('courseSignInToEnrol')}
            </a>
          )}
        </div>
      </Section>
      {signedIn && data.pricing === 'paid' && <AcademyCoursePurchase slug={data.slug} onSettled={settlePurchase} />}
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
    (signal) => api.call(ACADEMY_PUBLIC_COURSE_BY_LINK, { slug, key: linkKey }, { signal }),
    `linked-course:${slug}:${linkKey}`,
  );
  if (course.resource.status === 'loading') return <Waiting />;
  if (course.resource.status === 'failed') return <Failed failure={course.resource.failure} retry={course.reload} />;
  const data = course.resource.data;
  return (
    <div className="lt-stack" data-academy-linked-course={data.slug}>
      <Section title={data.title}>
        <AuthoredCourseBody data={data} note={t('linkedNote')} />
      </Section>
      <Section title={t('courseEnrol')}>
        <div className="lt-stack">
          <PriceLine data={data} />
          <LinkedCourseEnrol slug={data.slug} state={data.state} />
        </div>
      </Section>
    </div>
  );
}

/**
 * Enrolment on a linked course's page: a published course enrols on its public page, reached by its plain address, so
 * the private link's `#key=` never rides into a URL a server would see and log.
 */
export function LinkedCourseEnrol({ slug, state }: { slug: string; state: string }) {
  const { t } = copy.useCopy();
  if (state !== 'published') return <p className="lt-hint">{t('linkedNotPublished')}</p>;
  return (
    <a className="lt-button lt-button-primary" href={academyCourseHref(slug)}>
      {t('linkedOpenPublic')}
    </a>
  );
}
