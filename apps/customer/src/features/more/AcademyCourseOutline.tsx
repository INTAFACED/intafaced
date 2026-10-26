import { useEffect, useId, useRef, useState } from 'react';
import {
  academyCourseOutlineSchema,
  academyItemCompletionSchema,
  academyUndoCompletionSchema,
  type AcademyCourseOutline,
  type AcademyCourseOutlineItem,
} from '@intafaced/contracts/academy-catalogue';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button, Loading, Panel } from '../../shared/ui';
import { navigate } from '../../app/location';
import { useApi, useSession } from '../session/session';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref, formatDay } from './academy-lms';
import { AcademyRefusal, GuardedButton, kindLabel, pathLabel } from './AcademyLmsParts';

type Failure = Extract<ApiResult<never>, { ok: false }>;

const itemHref = (slug: string) => `/academy/${encodeURIComponent(slug)}`;
const opens = (row: AcademyCourseOutlineItem) => row.lock === null;

/** Previous and Next from the open item: the nearest item each way the learner may open, and how many locked ones lie between. */
export function outlineNeighbours(items: readonly AcademyCourseOutlineItem[], current: string) {
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
export function AcademyCourseOutline({ itemSlug, refresh, progress = 0 }: { itemSlug: string; refresh?: unknown; progress?: number }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const outline = useResource(
    (signal) => api.query('academy', 'courseOutline', { itemSlug }, academyCourseOutlineSchema, { signal }),
    `course-outline:${userId}:${itemSlug}`,
  );
  // A completion recorded in the reader beside it can unlock items, and a finished quiz can meet a rule: read the outline again.
  // `reload` is a new function each render, so the effect follows only the completion it is told about.
  const reload = useRef(outline.reload);
  reload.current = outline.reload;
  useEffect(() => {
    if (refresh || progress) reload.current();
  }, [refresh, progress]);
  const completion = useItemCompletion(itemSlug, () => reload.current());
  return (
    <Panel title={t('outlineTitle')}>
      {outline.resource.status === 'loading' ? (
        <Loading />
      ) : outline.resource.status === 'failed' ? (
        <AcademyRefusal failure={outline.resource.failure} retry={outline.reload} />
      ) : (
        <>
          <ItemCompletionView outline={outline.resource.data} current={itemSlug} {...completion} />
          <CourseOutlineView outline={outline.resource.data} current={itemSlug} />
        </>
      )}
    </Panel>
  );
}

/**
 * Complete and continue, and Undo, on the open item (AC-progress-01). One press sends one request; Academy records a
 * completion once however often it is asked. The next item is read from a fresh outline, since this completion may be
 * what unlocks it. A lost reply is settled by that same read: if Academy recorded the completion, the learner moves on.
 * The state lives with the outline panel, so it outlasts the outline's own reload after each press.
 */
function useItemCompletion(current: string, reload: () => void) {
  const api = useApi();
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [undone, setUndone] = useState(false);
  const send = async (request: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    setUndone(false);
    try {
      await request();
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  const complete = () =>
    send(async () => {
      const sent = await api.mutate('academy', 'markCurriculumComplete', { itemSlug: current }, academyItemCompletionSchema);
      const fresh = await api.query('academy', 'courseOutline', { itemSlug: current }, academyCourseOutlineSchema);
      const recorded = fresh.ok && fresh.data.items.some((row) => row.slug === current && row.state === 'completed');
      if (!recorded) {
        if (!sent.ok) setFailure(sent);
        else if (!fresh.ok) setFailure(fresh);
        reload();
        return;
      }
      const next = outlineNeighbours(fresh.data.items, current).next.item;
      if (next) navigate(itemHref(next.slug));
      else reload();
    });
  const undo = (completedAt: string) =>
    send(async () => {
      // The key names this one completion, so a replay after a lost reply undoes it once and a later completion is new.
      const sent = await api.mutate(
        'academy',
        'undoCurriculumComplete',
        { itemSlug: current, completedAt, clientRequestId: `undo:${current}:${completedAt}` },
        academyUndoCompletionSchema,
      );
      if (!sent.ok) setFailure(sent);
      else setUndone(true);
      reload();
    });
  return { sending, failure, undone, onComplete: complete, onUndo: undo };
}

/** Pure: the completion controls for the open item, as the outline says it stands. A locked item has none. */
export function ItemCompletionView({
  outline,
  current,
  sending,
  failure,
  undone,
  onComplete,
  onUndo,
}: {
  outline: AcademyCourseOutline;
  current: string;
  sending: boolean;
  failure: Failure | null;
  undone: boolean;
  onComplete: () => void;
  onUndo: (completedAt: string) => void;
}) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  const reasonId = useId();
  const row = outline.items.find((item) => item.slug === current);
  if (!row || row.lock !== null) return null;
  const rule = row.ruleMet ? null : row.rule === 'score' ? t('ruleScore') : row.rule === 'watch' ? t('ruleWatch') : null;
  return (
    <div className="academy-lms-stack" data-item-completion={row.slug} data-item-state={row.state}>
      {row.state === 'completed' && row.completedAt ? (
        <div className="academy-outline-nav">
          <span role="status">{t('completedOn', { date: formatDay(row.completedAt, language) })}</span>
          <Button variant="secondary" disabled={sending} onClick={() => onUndo(row.completedAt!)}>
            {t('undoCompletion')}
          </Button>
        </div>
      ) : rule !== null ? (
        <GuardedButton reason={rule} reasonId={reasonId}>
          {t('completeContinue')}
        </GuardedButton>
      ) : (
        <Button disabled={sending} onClick={onComplete}>
          {t('completeContinue')}
        </Button>
      )}
      {undone && row.state !== 'completed' && <p role="status">{t('completionUndone')}</p>}
      {failure && <AcademyRefusal failure={failure} />}
    </div>
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
  const { previous, next } = outlineNeighbours(outline.items, current);
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
              <span data-testid="academy-lms-meta" className="academy-lms-meta">
                <span>{kindLabel(t, row.kind)}</span>
                {why && <span>{why}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {outline.items.length > 0 && outline.items.every((row) => row.state === 'completed') && (
        <p role="status" data-testid="course-complete">
          {t('courseComplete')}
        </p>
      )}
      <div className="academy-outline-nav">
        {outline.items.some(opens) ? (
          <>
            {navLink(previous, 'outlinePrevious', 'outlineNoPrevious')}
            {navLink(next, 'outlineNext', 'outlineNoNext')}
          </>
        ) : (
          <span className="muted">{t('outlineNoneOpen')}</span>
        )}
      </div>
    </nav>
  );
}
