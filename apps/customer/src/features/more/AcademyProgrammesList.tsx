import { type AcademyProgramme, type AcademyProgrammeCourseState } from '@intafaced/contracts/academy-programmes';
import { useApi, useSession } from '../session';
import { useResource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref, academyProgrammeHref, formatDay } from './academy-lms';
import { pathLabel } from './academy-labels';
import { AcademyRefusal } from './academy-refusal';
import { Section, Waiting } from './volt-parts';
import { ACADEMY_PROGRAMMES } from '@intafaced/contracts/academy-programmes-procedures';
import { ACADEMY_PROGRAMME } from '@intafaced/contracts/academy-programme-procedures';

/**
 * Course programmes (AC-programmes-01), drawn with the kit (intafaced issue 9566): ordered sets of published courses that
 * staff make. The Programmes tab lists them with the reader's three counts, and each programme has its own page with Start
 * on any course. The Certificates tab's programme section is AcademyCourseProgrammes.tsx. Every count is read from
 * Academy; nothing is kept here.
 */

/** The page size the programme list asks for. */
const PROGRAMMES_PAGE = 50;

const COURSE_STATES = {
  completed: 'programmeCourseCompleted',
  enrolled: 'programmeCourseEnrolled',
  not_enrolled: 'programmeCourseNotEnrolled',
} as const satisfies Record<AcademyProgrammeCourseState, string>;
const COURSE_ACTIONS = {
  completed: 'programmeReview',
  enrolled: 'programmeContinue',
  not_enrolled: 'programmeStart',
} as const satisfies Record<AcademyProgrammeCourseState, string>;

/** The programmes, newest first; `mine` keeps the ones the reader started a course in or earned. */
export function useProgrammes(limit: number, mine = false) {
  const api = useApi();
  const { userId } = useSession();
  return useResource((signal) => api.call(ACADEMY_PROGRAMMES, { limit, mine }, { signal }), `programmes:${userId}:${limit}:${mine}`);
}

function Counts({ programme }: { programme: AcademyProgramme }) {
  const { Copy } = copy.useCopy();
  if (programme.courses.length === 0)
    return (
      <p className="lt-hint" data-testid="programme-empty">
        <Copy k="programmeEmpty" />
      </p>
    );
  return (
    <p data-testid="programme-counts">
      <Copy k="programmeCounts" params={programme.counts} />
    </p>
  );
}

/** The Programmes tab's list: one card per programme, newest first. */
export function AcademyCourseProgrammes() {
  const { t, Copy } = copy.useCopy();
  const list = useProgrammes(PROGRAMMES_PAGE);
  return (
    <Section title={t('programmeListTitle')} className="lt-stack">
      <div className="lt-stack" data-programmes="list">
        <p className="lt-hint">
          <Copy k="programmeListIntro" />
        </p>
        {list.resource.status === 'loading' && <Waiting />}
        {list.resource.status === 'failed' && <AcademyRefusal failure={list.resource.failure} retry={list.reload} />}
        {list.resource.status === 'ready' &&
          (list.resource.data.length === 0 ? (
            <p role="status">
              <Copy k="programmeListNone" />
            </p>
          ) : (
            <div className="lt-stack">
              {list.resource.data.map((programme) => (
                <article key={programme.slug} className="lt-stack" data-programme={programme.slug}>
                  <h3 lang="und">{programme.title}</h3>
                  {programme.summary && (
                    <p className="lt-hint" lang="und">
                      {programme.summary}
                    </p>
                  )}
                  <Counts programme={programme} />
                  <a className="lt-link lt-link-alone" href={academyProgrammeHref(programme.slug)}>
                    <Copy k="programmeOpen" />
                  </a>
                </article>
              ))}
            </div>
          ))}
      </div>
    </Section>
  );
}

/** `/academy/programmes/:slug`: the courses in order with the reader's state on each, the counts and the certificate. */
export function AcademyProgrammePage({ slug }: { slug: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const answer = useResource((signal) => api.call(ACADEMY_PROGRAMME, { slug }, { signal }), `programme:${userId}:${slug}`);
  return (
    <div className="lt-stack">
      <a className="lt-link" href="/academy/programmes">
        <Copy k="programmeAll" />
      </a>
      {answer.resource.status === 'loading' && <Waiting />}
      {answer.resource.status === 'failed' && <AcademyRefusal failure={answer.resource.failure} retry={answer.reload} />}
      {answer.resource.status === 'ready' && (
        <div className="lt-stack" data-programme-page={answer.resource.data.slug}>
          <Section title={<span lang="und">{answer.resource.data.title}</span>} className="lt-stack">
            {answer.resource.data.summary && (
              <p className="lt-hint" lang="und">
                {answer.resource.data.summary}
              </p>
            )}
            <Counts programme={answer.resource.data} />
          </Section>
          {answer.resource.data.courses.length > 0 && (
            <>
              <Section title={t('programmeCoursesTitle')}>
                <ol className="lt-stack" aria-label={t('programmeCoursesTitle')}>
                  {answer.resource.data.courses.map((course, index) => (
                    <li key={course.slug} className="lt-actions" data-programme-course={course.slug} data-state={course.state}>
                      <span>{index + 1}</span>
                      <div className="lt-stack">
                        <strong>{pathLabel(t, course.slug)}</strong>
                        <div data-testid="academy-lms-meta" className="lt-actions lt-hint">
                          <span className="lt-chip" data-status={course.state === 'not_enrolled' ? 'open' : 'recorded'}>
                            <span className="lt-chip-mark" aria-hidden="true" />
                            <Copy k={COURSE_STATES[course.state]} />
                          </span>
                          <span>
                            <Copy k="programmeCourseItems" params={{ completed: course.completed, items: course.items }} />
                          </span>
                        </div>
                      </div>
                      <a className="lt-link lt-link-alone" href={academyCourseHref(course.slug)}>
                        <Copy k={COURSE_ACTIONS[course.state]} />
                      </a>
                    </li>
                  ))}
                </ol>
              </Section>
              <ProgrammeCertificate programme={answer.resource.data} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ProgrammeCertificate({ programme }: { programme: AcademyProgramme }) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  const cert = programme.certificate;
  return (
    <Section title={t('programmeCertTitle')}>
      <div className="lt-stack" data-testid="programme-certificate" data-state={cert.state}>
        {cert.state === 'earned' ? (
          <>
            <p role="status">
              {cert.status === 'revoked' ? (
                <Copy k="programmeCertRevoked" />
              ) : (
                <Copy k="programmeCertEarned" params={{ date: formatDay(cert.grantedAt, language) }} />
              )}
            </p>
            <a className="lt-link lt-link-alone" href="/academy/certificates">
              <Copy k="programmeCertLink" />
            </a>
          </>
        ) : (
          <p>
            <Copy k="programmeCertPending" params={{ count: programme.courses.length }} />
          </p>
        )}
      </div>
    </Section>
  );
}
