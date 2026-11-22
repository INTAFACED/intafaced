import { ACADEMY_PROGRAMMES_LIST_MAX, type AcademyProgramme } from '@intafaced/contracts/academy-programmes';
import { Loading } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyProgrammeHref, academyVerifyHref, formatDay } from './academy-lms';
import { AcademyRefusal } from './AcademyLmsParts';
import { useProgrammes } from './AcademyProgrammesList';

/**
 * Course programmes (AC-programmes-01) on the Certificates tab: the programme certificates apart from the course ones. The
 * Programmes tab's list and each programme's page are AcademyProgrammesList.tsx. Every count is read from Academy.
 */

/** The most programmes the Certificates tab lists: the reader's own, which is every one they started. */
const MINE_PAGE = ACADEMY_PROGRAMMES_LIST_MAX;

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
                    <Copy k="programmeCertEarned" params={{ date: formatDay(cert.grantedAt, language) }} />
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
