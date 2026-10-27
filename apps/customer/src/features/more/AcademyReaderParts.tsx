import { z } from 'zod';
import { useResource } from '../../shared/resource';
import { useApi, useSession } from '../session/session';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { lessonHrefFor, lessonStatus, neighbours, pathProgress, type AcademyPath, type LessonSummary, type Tracking } from './academy-lms';
import { ProgressBar, StatusChip, pathLabel } from './AcademyLmsParts';

/** Where this lesson sits: breadcrumb, position in its path, real progress and its recorded state. */
export function ReaderHeader({
  slug,
  path,
  lessons,
  tracking,
}: {
  slug: string;
  path: AcademyPath;
  lessons: readonly LessonSummary[];
  tracking: Tracking;
}) {
  const { t, Copy } = copy.useCopy();
  const inPath = lessons.filter((l) => l.path === path);
  const place = neighbours(inPath, slug);
  const progress = pathProgress(inPath, tracking);
  return (
    <div className="academy-lms-stack">
      <nav className="academy-lms-crumbs" aria-label={t('breadcrumb')}>
        <a className="text-link" href="/academy">
          <Copy k="crumbAcademy" />
        </a>
        <span aria-hidden="true">/</span>
        <a className="text-link" href={`/academy?${new URLSearchParams({ path })}`}>
          {pathLabel(t, path)}
        </a>
      </nav>
      <div className="academy-lms-meta">
        {place.position > 0 && (
          <span>
            <Copy k="lessonPosition" params={{ position: place.position, total: place.total }} />
          </span>
        )}
        <StatusChip status={lessonStatus(slug, tracking)} />
      </div>
      {progress.percent !== null && (
        <>
          <ProgressBar percent={progress.percent} label={t('progressLabel', { path: pathLabel(t, path) })} />
          <small className="muted">
            <Copy k="completedOfTotal" params={{ recorded: progress.recorded, total: progress.total }} />
          </small>
        </>
      )}
    </div>
  );
}

/** Previous and next lesson within the same path, in the service's order. */
export function ReaderPager({
  slug,
  path,
  lessons,
  certId,
}: {
  slug: string;
  path: AcademyPath;
  lessons: readonly LessonSummary[];
  certId: string;
}) {
  const { Copy } = copy.useCopy();
  const { previous, next } = neighbours(
    lessons.filter((l) => l.path === path),
    slug,
  );
  return (
    <nav className="academy-lms-pager" aria-label={copy.t('pagerLabel')}>
      {previous ? (
        <a className="academy-learning-link" href={lessonHrefFor(previous.slug, certId, path)} rel="prev">
          <Copy k="previousLesson" />
          <span lang="und">: {previous.title}</span>
        </a>
      ) : (
        <span />
      )}
      {next ? (
        <a className="academy-learning-link" href={lessonHrefFor(next.slug, certId, path)} rel="next">
          <Copy k="nextLessonInPath" />
          <span lang="und">: {next.title}</span>
        </a>
      ) : (
        <a className="academy-learning-link" href={`/academy?${new URLSearchParams({ path })}`}>
          <Copy k="endOfPath" />
        </a>
      )}
    </nav>
  );
}

const videoList = z.array(z.object({ slug: z.string(), title: z.string(), path: z.string() }));
/** Shown only when the video library lists a recording for this exact lesson. A library that cannot be read adds nothing here. */
export function LessonVideoLink({ slug }: { slug: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { Copy } = copy.useCopy();
  const videos = useResource((signal) => api.query('academy', 'videos', undefined, videoList, { signal }), `lesson-video:${userId}`);
  if (videos.resource.status !== 'ready' || !videos.resource.data.some((v) => v.slug === slug)) return null;
  return (
    <div>
      <a className="academy-learning-link" href={`/academy/videos?${new URLSearchParams({ video: slug })}`}>
        <Copy k="watchVideo" />
      </a>
    </div>
  );
}

/**
 * A lesson whose prerequisite is unmet (AC-release-access-02): Academy refused before sending its body, and this names
 * the earlier items with a link to each. Titles come from the published catalogue; an unknown slug is shown as itself.
 */
export function LockedItemNotice({ missing, lessons }: { missing: readonly string[]; lessons: readonly LessonSummary[] }) {
  const { t } = copy.useCopy();
  return (
    <section data-testid="failure" className="failure" role="status" data-locked-item="prerequisite">
      <h3>{t('lockedItemTitle')}</h3>
      {missing.length > 0 ? (
        <>
          <p>{t('lockedItemBody')}</p>
          <ul>
            {missing.map((slug) => {
              const title = lessons.find((lesson) => lesson.slug === slug)?.title;
              return (
                <li key={slug}>
                  <a className="text-link" href={`/academy/${encodeURIComponent(slug)}`} lang={title ? 'und' : 'zxx'}>
                    {title ?? slug}
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p>{t('lockedItemUnnamed')}</p>
      )}
    </section>
  );
}
