import { useResource } from '../../shared/resource';
import { useApi, useSession } from '../session';
import { academyLmsCopy as copy } from './academy-lms-copy';
import {
  lessonHrefFor,
  lessonStatus,
  neighbours,
  pathProgress,
  type AcademyPath,
  type LessonStatus,
  type LessonSummary,
  type Tracking,
} from './academy-lms';
import { StatusChip } from '@intafaced/ui/lit/templates';
import { pathLabel } from './academy-labels';
import { ACADEMY_VIDEOS } from '@intafaced/contracts/academy-videos-procedures';

const chipStatus = { recorded: 'done', pending: 'pending', open: 'unknown' } as const;
const chipWords = { recorded: 'statusRecorded', pending: 'statusPending', open: 'statusOpen' } as const;

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
    <div className="lt-stack">
      <nav className="lt-actions" aria-label={t('breadcrumb')}>
        <a className="lt-link lt-link-alone" href="/academy">
          <Copy k="crumbAcademy" />
        </a>
        <span aria-hidden="true">/</span>
        <a className="lt-link lt-link-alone" href={`/academy?${new URLSearchParams({ path })}`}>
          {pathLabel(t, path)}
        </a>
      </nav>
      <div data-testid="academy-lms-meta" className="lt-actions lt-hint">
        {place.position > 0 && (
          <span>
            <Copy k="lessonPosition" params={{ position: place.position, total: place.total }} />
          </span>
        )}
        <LessonChip status={lessonStatus(slug, tracking)} />
      </div>
      {progress.percent !== null && (
        <>
          <ProgressMeter percent={progress.percent} label={t('progressLabel', { path: pathLabel(t, path) })} />
          <small className="lt-hint">
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
    <nav className="lt-actions" aria-label={copy.t('pagerLabel')}>
      {previous ? (
        <a className="lt-link lt-link-alone" href={lessonHrefFor(previous.slug, certId, path)} rel="prev">
          <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> <Copy k="previousLesson" />
          <span lang="und">: {previous.title}</span>
        </a>
      ) : (
        <span />
      )}
      {next ? (
        <a className="lt-link lt-link-alone" href={lessonHrefFor(next.slug, certId, path)} rel="next">
          <Copy k="nextLessonInPath" />
          <span lang="und">: {next.title}</span> <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
        </a>
      ) : (
        <a className="lt-link lt-link-alone" href={`/academy?${new URLSearchParams({ path })}`}>
          <Copy k="endOfPath" />
        </a>
      )}
    </nav>
  );
}

/** Shown only when the video library lists a recording for this exact lesson. A library that cannot be read adds nothing here. */
export function LessonVideoLink({ slug }: { slug: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { Copy } = copy.useCopy();
  const videos = useResource((signal) => api.call(ACADEMY_VIDEOS, undefined, { signal }), `lesson-video:${userId}`);
  if (videos.resource.status !== 'ready' || !videos.resource.data.some((v) => v.slug === slug)) return null;
  return (
    <div>
      <a className="lt-link lt-link-alone" href={`/academy/videos?${new URLSearchParams({ video: slug })}`}>
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
    <section data-testid="failure" className="lt-refusal" role="status" data-locked-item="prerequisite">
      <h3 className="lt-refusal-title">{t('lockedItemTitle')}</h3>
      {missing.length > 0 ? (
        <>
          <p className="lt-refusal-body">{t('lockedItemBody')}</p>
          <ul className="lt-stack">
            {missing.map((slug) => {
              const title = lessons.find((lesson) => lesson.slug === slug)?.title;
              return (
                <li key={slug}>
                  <a className="lt-link lt-link-alone" href={`/academy/${encodeURIComponent(slug)}`} lang={title ? 'und' : 'zxx'}>
                    {title ?? slug}
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="lt-refusal-body">{t('lockedItemUnnamed')}</p>
      )}
    </section>
  );
}

/** A lesson's recorded state, in words with the kit's mark. */
function LessonChip({ status }: { status: LessonStatus }) {
  const { t } = copy.useCopy();
  return <StatusChip status={chipStatus[status]} label={t(chipWords[status])} />;
}

/**
 * A bar drawn only from a real ratio, as a meter (a settled measure of lessons recorded), not a progressbar: a progressbar
 * announces work still in flight, so assistive tech would read a finished 4-of-7 bar as a read that never ends.
 */
function ProgressMeter({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return <meter min={0} max={100} value={value} aria-valuetext={`${value}%`} aria-label={label} />;
}
