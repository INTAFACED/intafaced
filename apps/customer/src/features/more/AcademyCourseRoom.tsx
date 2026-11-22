import { ACADEMY_CURRICULUM_PATHS } from '@intafaced/contracts/academy-catalogue';
import { ACADEMY_PUBLIC_COURSE } from '@intafaced/contracts/academy-public-course-procedures';
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { safeReturnTo } from '../../app/navigation';
import { useResource } from '../../shared/resource';
import { useApi } from '../session';
import { t as copyText } from './copy';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref } from './academy-lms';
import { kindLabel, pathLabel } from './academy-labels';
import { AcademyRefusal } from './academy-refusal';
import { AcademySections } from './academy-sections';
import { AcademyCourseEnrol } from './AcademyCourseEnrol';
import { AcademyAuthoredCourse, AcademyLinkedCourse } from './AcademyAuthoredCourse';
import { Section, Waiting } from './volt-parts';

/**
 * /academy/learning/course/:slug on the reading template (intafaced issue 9568): a course's page, the same signed in and
 * signed out, under the Academy's sections. Signed out it is the visitor's Academy, so it keeps that marker.
 */
export function AcademyCourseRoom({ slug, signedIn }: { slug: string | undefined; signedIn: boolean }) {
  return (
    <div data-academy-visitor={signedIn ? undefined : 'true'}>
      <ReadingTemplate
        title={copyText('moreroutes.academy')}
        description={copyText('moreroutes.learn.practise.and.join.hosted.sessions')}
        state={{ kind: 'ready' }}
        meta={<AcademySections current="Learning" />}
        body={<AcademyCoursePage slug={slug} signedIn={signedIn} />}
      />
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

/**
 * The public course page (AC-catalogue-03), the same signed in and signed out. Summary and instructor show their
 * absence in words; the outcomes are the lessons' own objectives. Signed in, Enrol now sits here (AC-enrolment-01).
 */
export function AcademyCourse({ slug, signedIn }: { slug: string | undefined; signedIn: boolean }) {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const course = useResource((signal) => api.call(ACADEMY_PUBLIC_COURSE, { slug: slug ?? '' }, { signal }), `public-course:${slug ?? ''}`);
  const back = (
    <a className="lt-link lt-link-alone" href="/academy/learning">
      <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> <Copy k="courseBack" />
    </a>
  );
  if (course.resource.status === 'loading') return <Waiting />;
  if (course.resource.status === 'failed')
    return (
      <Section title={copyText('academy.learning')}>
        <AcademyRefusal failure={course.resource.failure} retry={course.reload} />
        {back}
      </Section>
    );
  const data = course.resource.data;
  const here = safeReturnTo(academyCourseHref(data.slug));
  return (
    <div className="lt-stack" data-academy-course={data.slug}>
      <Section title={pathLabel(t, data.slug)}>
        <div className="lt-stack">
          <nav aria-label={t('breadcrumb')}>{back}</nav>
          <section aria-label={t('courseSummary')}>
            <h3>{t('courseSummary')}</h3>
            <p className="lt-hint">{data.summary ?? t('courseNoSummary')}</p>
          </section>
          <section aria-label={t('courseOutcomes')}>
            <h3>{t('courseOutcomes')}</h3>
            <ul className="lt-stack">
              {data.outcomes.map((outcome) => (
                <li key={outcome} lang="und">
                  {outcome}
                </li>
              ))}
            </ul>
          </section>
          <section aria-label={t('courseSyllabus')}>
            <h3>{t('courseSyllabus')}</h3>
            <ol className="lt-stack">
              {data.syllabus.map((row) => (
                <li key={row.slug} className="lt-stack">
                  <a className="lt-link lt-link-alone" href={`/academy/${encodeURIComponent(row.slug)}`} lang="und">
                    {row.title}
                  </a>
                  <span data-testid="academy-lms-meta" className="lt-actions lt-hint">
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
      </Section>
      <Section title={t('courseInstructor')}>
        <div className="lt-stack">
          <p className="lt-hint">{data.instructor ?? t('courseNoInstructor')}</p>
          <p>{data.certificate ? t('courseCertificate', { title: data.certificate }) : t('courseNoCertificate')}</p>
          {!signedIn && (
            <a className="lt-button lt-button-primary" href={`/login?redirect=${encodeURIComponent(here)}`}>
              <Copy k="courseSignInToEnrol" />
            </a>
          )}
        </div>
      </Section>
      {signedIn && (
        <Section title={t('courseEnrol')}>
          <AcademyCourseEnrol slug={data.slug} />
        </Section>
      )}
    </div>
  );
}
