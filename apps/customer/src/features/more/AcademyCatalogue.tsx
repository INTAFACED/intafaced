import { useSession } from '../session';
import { academyLmsCopy as copy } from './academy-lms-copy';
import {
  groupByPath,
  lessonHrefFor,
  lessonStatus,
  nextUp,
  pathProgress,
  readLastLesson,
  resumeTarget,
  type AcademyPath,
  type LessonSummary,
  type PathSummary,
  type Tracking,
} from './academy-lms';
import { pathLabel } from './academy-labels';
import { LessonStatusChip, ProgressMeter } from './academy-kit-parts';
import { Section } from './volt-parts';

type Props = { lessons: readonly LessonSummary[]; tracking: Tracking; certId: string; selectedPath: AcademyPath | null };

const resumeKeys = {
  unfinished: 'resumeUnfinished',
  'after-last': 'resumeAfterLast',
  required: 'resumeRequired',
  start: 'resumeStart',
} as const;

/** The Learning home, drawn with the kit: where to carry on, every path with its real progress, and the selected path in order. */
export function AcademyCatalogue({ lessons, tracking, certId, selectedPath }: Props) {
  const { userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const paths = groupByPath(lessons);
  const resume = resumeTarget(readLastLesson(userId), lessons, tracking);
  const selected = selectedPath ? paths.find((p) => p.path === selectedPath) : undefined;
  if (paths.length === 0) return null;
  return (
    <div className="lt-stack">
      {resume && (
        <section className="lt-stack" aria-label={t('resumeTitle')}>
          <h2>
            <Copy k="resumeTitle" />
          </h2>
          <p>
            <Copy k={resumeKeys[resume.reason]} />
          </p>
          <strong lang="und">{resume.lesson.title}</strong>
          <div data-testid="academy-lms-meta" className="lt-actions lt-hint">
            <span>{pathLabel(t, resume.lesson.path)}</span>
            <span>
              <Copy k="minutes" params={{ minutes: resume.lesson.estimatedMinutes }} />
            </span>
            <LessonStatusChip status={lessonStatus(resume.lesson.slug, tracking)} />
          </div>
          <div>
            <a className="lt-link lt-link-alone" href={lessonHrefFor(resume.lesson.slug, certId, resume.lesson.path)}>
              <Copy k={resume.reason === 'start' ? 'startLesson' : 'continueLesson'} />
            </a>
          </div>
        </section>
      )}
      <Section title={t('catalogueTitle')} className="lt-stack">
        <p className="lt-hint">
          <Copy k="catalogueIntro" />
        </p>
        <div className="lt-stack">
          {paths.map((path) => (
            <PathCard key={path.path} path={path} tracking={tracking} active={path.path === selectedPath} />
          ))}
        </div>
        <p className="lt-hint">
          <Copy k="trackingSource" />
        </p>
      </Section>
      {selected && <PathDetail path={selected} tracking={tracking} certId={certId} />}
    </div>
  );
}

function PathCard({ path, tracking, active }: { path: PathSummary; tracking: Tracking; active: boolean }) {
  const { t, Copy } = copy.useCopy();
  const progress = pathProgress(path.lessons, tracking);
  return (
    <article className="lt-stack" aria-current={active ? 'page' : undefined}>
      <h3>{pathLabel(t, path.path)}</h3>
      <div data-testid="academy-lms-meta" className="lt-actions lt-hint">
        <span>
          {path.lessons.length === 1 ? <Copy k="lessonCountOne" /> : <Copy k="lessonCount" params={{ count: path.lessons.length }} />}
        </span>
        <span>
          <Copy k="minutes" params={{ minutes: path.minutes }} />
        </span>
        {path.playbooks > 0 && (
          <span>
            {path.playbooks === 1 ? <Copy k="playbookCountOne" /> : <Copy k="playbookCount" params={{ count: path.playbooks }} />}
          </span>
        )}
        {path.workbooks > 0 && (
          <span>
            {path.workbooks === 1 ? <Copy k="workbookCountOne" /> : <Copy k="workbookCount" params={{ count: path.workbooks }} />}
          </span>
        )}
      </div>
      {progress.percent !== null && (
        <>
          <ProgressMeter percent={progress.percent} label={t('progressLabel', { path: pathLabel(t, path.path) })} />
          <p>
            <Copy k="completedOfTotal" params={{ recorded: progress.recorded, total: progress.total }} />
          </p>
        </>
      )}
      <div>
        <a className="lt-link lt-link-alone" href={`/academy?${new URLSearchParams({ path: path.path })}`}>
          <Copy k="openPath" />
        </a>
      </div>
    </article>
  );
}

function PathDetail({ path, tracking, certId }: { path: PathSummary; tracking: Tracking; certId: string }) {
  const { t, Copy } = copy.useCopy();
  const progress = pathProgress(path.lessons, tracking);
  const next = nextUp(path.lessons, tracking);
  return (
    <Section title={pathLabel(t, path.path)} className="lt-stack">
      <div>
        <a className="lt-link" href="/academy">
          <Copy k="allPaths" />
        </a>
      </div>
      {progress.percent !== null && (
        <>
          <ProgressMeter percent={progress.percent} label={t('progressLabel', { path: pathLabel(t, path.path) })} />
          <p role="status">
            <Copy k="completedOfTotal" params={{ recorded: progress.recorded, total: progress.total }} />
          </p>
        </>
      )}
      {progress.percent === 100 ? (
        <p>
          <Copy k="pathAllRecorded" />
        </p>
      ) : (
        next && (
          <div>
            <a className="lt-link lt-link-alone" href={lessonHrefFor(next.slug, certId, path.path)}>
              <Copy k="continuePath" />
            </a>
          </div>
        )
      )}
      <ol className="lt-stack" aria-label={t('lessonsInPath')}>
        {path.lessons.map((lesson, index) => (
          <li key={lesson.slug} className="lt-actions">
            <span>{index + 1}</span>
            <div className="lt-stack">
              <strong lang="und">{lesson.title}</strong>
              <div data-testid="academy-lms-meta" className="lt-actions lt-hint">
                <span lang="zxx">{lesson.kind}</span>
                <span>
                  <Copy k="minutes" params={{ minutes: lesson.estimatedMinutes }} />
                </span>
                <LessonStatusChip status={lessonStatus(lesson.slug, tracking)} />
              </div>
            </div>
            <a className="lt-link lt-link-alone" href={lessonHrefFor(lesson.slug, certId, path.path)}>
              <Copy k="readLesson" />
            </a>
          </li>
        ))}
      </ol>
    </Section>
  );
}
