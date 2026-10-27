import { z } from 'zod';
import {
  ACADEMY_PROGRAMMES_LIST_MAX,
  academyProgrammeSchema,
  type AcademyProgramme,
  type AcademyProgrammeCourseState,
} from '@intafaced/contracts/academy-programmes';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Loading, Panel } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref, academyProgrammeHref, academyVerifyHref, formatDay } from './academy-lms';
import { AcademyRefusal, pathLabel } from './AcademyLmsParts';

/**
 * Course programmes (AC-programmes-01): ordered sets of published courses that staff make. The Programmes tab lists them
 * with the reader's three counts, each programme has its own page with Start on any course, and the Certificates tab shows
 * the programme certificates apart from the course ones. Every count is read from Academy; nothing is kept here.
 */

/** The page size the programme list asks for. */
const PROGRAMMES_PAGE = 50;
/** The most programmes the Certificates tab lists: the reader's own, which is every one they started. */
const MINE_PAGE = ACADEMY_PROGRAMMES_LIST_MAX;

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

function useProgrammes(limit: number, mine = false) {
  const api = useApi();
  const { userId } = useSession();
  return useResource(
    (signal) => api.query('academy', 'programmes', { limit, mine }, z.array(academyProgrammeSchema), { signal }),
    `programmes:${userId}:${limit}:${mine}`,
  );
}

function Counts({ programme }: { programme: AcademyProgramme }) {
  const { Copy } = copy.useCopy();
  if (programme.courses.length === 0)
    return (
      <p className="muted" data-testid="programme-empty">
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
    <Panel title={t('programmeListTitle')}>
      <div className="academy-lms-stack" data-programmes="list">
        <p className="muted">
          <Copy k="programmeListIntro" />
        </p>
        {list.resource.status === 'loading' && <Loading />}
        {list.resource.status === 'failed' && <AcademyRefusal failure={list.resource.failure} retry={list.reload} />}
        {list.resource.status === 'ready' &&
          (list.resource.data.length === 0 ? (
            <p role="status">
              <Copy k="programmeListNone" />
            </p>
          ) : (
            <div className="academy-lms-grid">
              {list.resource.data.map((programme) => (
                <article key={programme.slug} className="academy-lms-card" data-programme={programme.slug}>
                  <h3 lang="und">{programme.title}</h3>
                  {programme.summary && (
                    <p className="muted" lang="und">
                      {programme.summary}
                    </p>
                  )}
                  <Counts programme={programme} />
                  <a className="academy-learning-link" href={academyProgrammeHref(programme.slug)}>
                    <Copy k="programmeOpen" />
                  </a>
                </article>
              ))}
            </div>
          ))}
      </div>
    </Panel>
  );
}

/** `/academy/programmes/:slug`: the courses in order with the reader's state on each, the counts and the certificate. */
export function AcademyProgrammePage({ slug }: { slug: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const answer = useResource(
    (signal) => api.query('academy', 'programme', { slug }, academyProgrammeSchema, { signal }),
    `programme:${userId}:${slug}`,
  );
  return (
    <div className="academy-lms-stack">
      <a className="text-link" href="/academy/programmes">
        <Copy k="programmeAll" />
      </a>
      {answer.resource.status === 'loading' && <Loading />}
      {answer.resource.status === 'failed' && <AcademyRefusal failure={answer.resource.failure} retry={answer.reload} />}
      {answer.resource.status === 'ready' && (
        <div className="academy-lms-stack" data-programme-page={answer.resource.data.slug}>
          <Panel title={<span lang="und">{answer.resource.data.title}</span>}>
            <div className="academy-lms-stack">
              {answer.resource.data.summary && (
                <p className="muted" lang="und">
                  {answer.resource.data.summary}
                </p>
              )}
              <Counts programme={answer.resource.data} />
            </div>
          </Panel>
          {answer.resource.data.courses.length > 0 && (
            <>
              <Panel title={t('programmeCoursesTitle')}>
                <ol className="academy-lms-rows" aria-label={t('programmeCoursesTitle')}>
                  {answer.resource.data.courses.map((course, index) => (
                    <li key={course.slug} data-programme-course={course.slug} data-state={course.state}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{pathLabel(t, course.slug)}</strong>
                        <div data-testid="academy-lms-meta" className="academy-lms-meta">
                          <span className="academy-lms-chip" data-status={course.state === 'not_enrolled' ? 'open' : 'recorded'}>
                            <Copy k={COURSE_STATES[course.state]} />
                          </span>
                          <span>
                            <Copy k="programmeCourseItems" params={{ completed: course.completed, items: course.items }} />
                          </span>
                        </div>
                      </div>
                      <a className="academy-learning-link" href={academyCourseHref(course.slug)}>
                        <Copy k={COURSE_ACTIONS[course.state]} />
                      </a>
                    </li>
                  ))}
                </ol>
              </Panel>
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
    <Panel title={t('programmeCertTitle')}>
      <div className="academy-lms-stack" data-testid="programme-certificate" data-state={cert.state}>
        {cert.state === 'earned' ? (
          <>
            <p role="status">
              {cert.status === 'revoked' ? (
                <Copy k="programmeCertRevoked" />
              ) : (
                <Copy k="programmeCertEarned" params={{ date: formatDay(cert.grantedAt.toISOString(), language) }} />
              )}
            </p>
            <a className="academy-learning-link" href="/academy/certificates">
              <Copy k="programmeCertLink" />
            </a>
          </>
        ) : (
          <p>
            <Copy k="programmeCertPending" params={{ count: programme.courses.length }} />
          </p>
        )}
      </div>
    </Panel>
  );
}

/**
 * The Certificates tab's programme section: the programmes the reader has started a course in or earned, each with its
 * certificate state. With none published, or none started, it says which.
 */
export function ProgrammeCertificates() {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  // Whether any programme is published, and the reader's own: an older programme's certificate is never paged out.
  const any = useProgrammes(1);
  const mine = useProgrammes(MINE_PAGE, true);
  for (const read of [any, mine]) {
    if (read.resource.status === 'loading') return <Loading />;
    if (read.resource.status === 'failed') return <AcademyRefusal failure={read.resource.failure} retry={read.reload} />;
  }
  if (any.resource.status !== 'ready' || mine.resource.status !== 'ready') return null;
  if (any.resource.data.length === 0)
    return (
      <p className="muted">
        <Copy k="programmesNone" />
      </p>
    );
  const started = mine.resource.data;
  if (started.length === 0)
    return (
      <p className="muted">
        <Copy k="programmesStartedNone" />
      </p>
    );
  return (
    <div className="academy-lms-grid">
      {started.map((programme) => {
        const cert = programme.certificate;
        const state = cert.state === 'earned' ? (cert.status === 'revoked' ? 'revoked' : 'earned') : 'in_progress';
        return (
          <article key={programme.slug} className="academy-lms-card" data-certificate={cert.certId} data-state={state}>
            <h4 lang="und">{programme.title}</h4>
            <Counts programme={programme} />
            {cert.state === 'earned' ? (
              <>
                <p role="status">
                  {cert.status === 'revoked' ? (
                    <Copy k="programmeCertRevoked" />
                  ) : (
                    <Copy k="programmeCertEarned" params={{ date: formatDay(cert.grantedAt.toISOString(), language) }} />
                  )}
                </p>
                <p data-testid="programme-certificate-serial">
                  {t('sheetSerial')} <code lang="zxx">{cert.publicId}</code>
                </p>
                <a className="academy-learning-link" href={academyVerifyHref(cert.publicId)}>
                  <Copy k="programmeCertCheck" />
                </a>
              </>
            ) : (
              <p>
                <Copy k="programmeCertPending" params={{ count: programme.courses.length }} />
              </p>
            )}
            <a className="academy-learning-link" href={academyProgrammeHref(programme.slug)}>
              <Copy k="programmeOpen" />
            </a>
          </article>
        );
      })}
    </div>
  );
}
