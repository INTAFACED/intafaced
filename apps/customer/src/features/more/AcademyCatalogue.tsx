import { useSession } from '../session/session';
import { Panel } from '../../shared/ui';
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
import { ProgressBar, StatusChip, pathLabel } from './AcademyLmsParts';

type Props = { lessons: readonly LessonSummary[]; tracking: Tracking; certId: string; selectedPath: AcademyPath | null };

const resumeKeys = {
  unfinished: 'resumeUnfinished',
  'after-last': 'resumeAfterLast',
  required: 'resumeRequired',
  start: 'resumeStart',
} as const;

/** The Learning home: where to carry on, every path with its real progress, and the selected path in order. */
export function AcademyCatalogue({ lessons, tracking, certId, selectedPath }: Props) {
  const { userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const paths = groupByPath(lessons);
  const resume = resumeTarget(readLastLesson(userId), lessons, tracking);
  const selected = selectedPath ? paths.find((p) => p.path === selectedPath) : undefined;
  if (paths.length === 0) return null;
  return (
    <div className="academy-lms-stack">
      {resume && (
        <section className="academy-lms-card academy-lms-card--resume" aria-label={t('resumeTitle')}>
          <h2>
            <Copy k="resumeTitle" />
          </h2>
          <p>
            <Copy k={resumeKeys[resume.reason]} />
          </p>
          <strong lang="und">{resume.lesson.title}</strong>
          <div data-testid="academy-lms-meta" className="academy-lms-meta">
            <span>{pathLabel(t, resume.lesson.path)}</span>
            <span>
              <Copy k="minutes" params={{ minutes: resume.lesson.estimatedMinutes }} />
            </span>
            <StatusChip status={lessonStatus(resume.lesson.slug, tracking)} />
          </div>
          <div>
            <a className="academy-learning-link" href={lessonHrefFor(resume.lesson.slug, certId, resume.lesson.path)}>
              <Copy k={resume.reason === 'start' ? 'startLesson' : 'continueLesson'} />
            </a>
          </div>
        </section>
      )}
      <Panel title={t('catalogueTitle')}>
        <div className="academy-lms-stack">
          <p className="muted">
            <Copy k="catalogueIntro" />
          </p>
          <div className="academy-lms-grid">
            {paths.map((path) => (
              <PathCard key={path.path} path={path} tracking={tracking} active={path.path === selectedPath} />
            ))}
          </div>
          <p className="muted">
            <Copy k="trackingSource" />
          </p>
        </div>
      </Panel>
      {selected && <PathDetail path={selected} tracking={tracking} certId={certId} />}
    </div>
  );
}

function PathCard({ path, tracking, active }: { path: PathSummary; tracking: Tracking; active: boolean }) {
  const { t, Copy } = copy.useCopy();
  const progress = pathProgress(path.lessons, tracking);
  return (
    <article className="academy-lms-card" aria-current={active ? 'page' : undefined}>
      <h3>{pathLabel(t, path.path)}</h3>
      <div data-testid="academy-lms-meta" className="academy-lms-meta">
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
          <ProgressBar percent={progress.percent} label={t('progressLabel', { path: pathLabel(t, path.path) })} />
          <p>
            <Copy k="completedOfTotal" params={{ recorded: progress.recorded, total: progress.total }} />
          </p>
        </>
      )}
      <div>
        <a className="academy-learning-link" href={`/academy?${new URLSearchParams({ path: path.path })}`}>
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
    <Panel title={pathLabel(t, path.path)}>
      <div className="academy-lms-stack">
        <div className="academy-lms-crumbs">
          <a className="text-link" href="/academy">
            <Copy k="allPaths" />
          </a>
        </div>
        {progress.percent !== null && (
          <>
            <ProgressBar percent={progress.percent} label={t('progressLabel', { path: pathLabel(t, path.path) })} />
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
              <a className="academy-learning-link" href={lessonHrefFor(next.slug, certId, path.path)}>
                <Copy k="continuePath" />
              </a>
            </div>
          )
        )}
        <ol className="academy-lms-rows" aria-label={t('lessonsInPath')}>
          {path.lessons.map((lesson, index) => (
            <li key={lesson.slug}>
              <span>{index + 1}</span>
              <div>
                <strong lang="und">{lesson.title}</strong>
                <div data-testid="academy-lms-meta" className="academy-lms-meta">
                  <span lang="zxx">{lesson.kind}</span>
                  <span>
                    <Copy k="minutes" params={{ minutes: lesson.estimatedMinutes }} />
                  </span>
                  <StatusChip status={lessonStatus(lesson.slug, tracking)} />
                </div>
              </div>
              <a className="academy-learning-link" href={lessonHrefFor(lesson.slug, certId, path.path)}>
                <Copy k="readLesson" />
              </a>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
