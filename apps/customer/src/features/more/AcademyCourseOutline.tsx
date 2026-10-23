import {
  academyCourseOutlineSchema,
  type AcademyCourseOutline,
  type AcademyCourseOutlineItem,
} from '@intafaced/contracts/academy-catalogue';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Loading, Panel } from '../../shared/ui';
import { useApi, useSession } from '../session/session';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref, formatDay } from './academy-lms';
import { AcademyRefusal, kindLabel, pathLabel } from './AcademyLmsParts';

const itemHref = (slug: string) => `/academy/${encodeURIComponent(slug)}`;
const opens = (row: AcademyCourseOutlineItem) => row.lock === null;

/** Previous and Next from the open item: the nearest item each way the learner may open, and how many locked ones lie between. */
export function neighbours(items: readonly AcademyCourseOutlineItem[], current: string) {
  const at = items.findIndex((row) => row.slug === current);
  const step = (dir: -1 | 1) => {
    let skipped = 0;
    for (let i = at + dir; i >= 0 && i < items.length; i += dir) {
      if (opens(items[i]!)) return { item: items[i]!, skipped };
      skipped += 1;
    }
    return { item: null, skipped };
  };
  return at < 0 ? { previous: { item: null, skipped: 0 }, next: { item: null, skipped: 0 } } : { previous: step(-1), next: step(1) };
}

/** The outline beside an open item (AC-course-structure-02), signed in: typed items, locks with their reason, Previous and Next. */
export function AcademyCourseOutline({ itemSlug }: { itemSlug: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const outline = useResource(
    (signal) => api.query('academy', 'courseOutline', { itemSlug }, academyCourseOutlineSchema, { signal }),
    `course-outline:${userId}:${itemSlug}`,
  );
  return (
    <Panel title={t('outlineTitle')}>
      {outline.resource.status === 'loading' ? (
        <Loading />
      ) : outline.resource.status === 'failed' ? (
        <AcademyRefusal failure={outline.resource.failure} retry={outline.reload} />
      ) : (
        <CourseOutlineView outline={outline.resource.data} current={itemSlug} />
      )}
    </Panel>
  );
}

/** Pure: the outline as data says it. A locked item is text, never a link. */
export function CourseOutlineView({ outline, current }: { outline: AcademyCourseOutline; current: string }) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  const titles = new Map(outline.items.map((row) => [row.slug, row.title]));
  const reason = (row: AcademyCourseOutlineItem) =>
    row.lock === 'prerequisite'
      ? t('outlineLockedPrerequisite', { items: row.missing.map((slug) => titles.get(slug) ?? slug).join(', ') })
      : row.lock === 'window'
        ? row.opensAt
          ? t('outlineLockedOpens', { date: formatDay(row.opensAt, language) })
          : t('outlineLockedClosed')
        : row.state === 'completed'
          ? t('outlineCompleted')
          : null;
  const { previous, next } = neighbours(outline.items, current);
  const navLink = (side: typeof previous, label: 'outlinePrevious' | 'outlineNext', none: 'outlineNoPrevious' | 'outlineNoNext') => (
    <div>
      {side.item ? (
        <a className="button button--secondary" href={itemHref(side.item.slug)} rel={label === 'outlineNext' ? 'next' : 'prev'}>
          {t(label)}
        </a>
      ) : (
        <span className="muted">{t(none)}</span>
      )}
      {side.skipped > 0 && (
        <small className="muted">
          {' '}
          <Copy k="outlineSkipped" params={{ count: side.skipped }} />
        </small>
      )}
    </div>
  );
  return (
    <nav className="academy-lms-stack" aria-label={t('outlineTitle')} data-academy-outline={outline.slug}>
      <a className="academy-learning-link" href={academyCourseHref(outline.slug)}>
        {pathLabel(t, outline.slug)}
      </a>
      <ol className="academy-outline">
        {outline.items.map((row) => {
          const why = reason(row);
          return (
            <li key={row.slug} data-outline-item={row.slug} data-outline-state={row.state}>
              {row.lock !== null ? (
                <span lang="und">{row.title}</span>
              ) : (
                <a href={itemHref(row.slug)} aria-current={row.slug === current ? 'page' : undefined} lang="und">
                  {row.title}
                </a>
              )}
              <span className="academy-lms-meta">
                <span>{kindLabel(t, row.kind)}</span>
                {why && <span>{why}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="academy-outline-nav">
        {navLink(previous, 'outlinePrevious', 'outlineNoPrevious')}
        {navLink(next, 'outlineNext', 'outlineNoNext')}
      </div>
    </nav>
  );
}
