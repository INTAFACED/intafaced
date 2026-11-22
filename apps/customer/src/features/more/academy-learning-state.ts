/**
 * The learning path and the lesson reader, without their drawing: the certificate chosen, its progress, the library,
 * the lesson read in the learner's language, the lesson completion staged for review, and the original completion
 * left behind. The hub's Learning tab (AcademyLearning.tsx) draws it with the old parts; the lesson reader
 * (academy-reader/) draws the same reads with the kit's. The reads are one.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { academyItemCompletionSchema, type AcademyCurriculumSummary } from '@intafaced/contracts/academy-catalogue';
import {
  ACADEMY_CERT_DEFINITIONS,
  ACADEMY_CERT_PROGRESS,
  ACADEMY_CURRICULUM,
  ACADEMY_CURRICULUM_ITEM_LOCALIZED,
  ACADEMY_MARK_CURRICULUM_COMPLETE,
  ACADEMY_TOUCH_LESSON,
  type AcademyCertDefinition,
  type AcademyCertProgress,
  type AcademyLocalizedItem,
} from '@intafaced/contracts/academy-learner-procedures';
import type { ProcedureInput } from '@intafaced/contracts/procedure';
import { useApi, useSession } from '../session';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { presentActionFailure } from './action-state';
import type { ActionControls } from './common';
import { academyLearningCopy as copy } from './academy-learning-copy';
import { rememberLastLesson } from './academy-lms';
import { useAcademyTracking } from './academy-tracking';

const ref = z.string().min(1);
const unique = (values: string[]) => new Set(values).size === values.length;
type Summary = AcademyCurriculumSummary;
/** The certificate screens' own check over `certDefinitions`: no certificate twice, and none needs an item twice. */
export const definitionsHold = (rows: AcademyCertDefinition[]) =>
  unique(rows.map((row) => row.id)) && rows.every((row) => unique(row.requiredItemSlugs));
type CurriculumAsk = NonNullable<ProcedureInput<typeof ACADEMY_CURRICULUM>>;
/**
 * The progress belongs to this learner and this certificate, adds up, and names only the items the certificate needs, in
 * its order, each once. The certificate screens' own check over `certProgress`.
 */
export function progressFits(owner: string | null | undefined, certId: string, required: readonly string[]) {
  return (p: AcademyCertProgress) =>
    p.userId === owner &&
    p.certId === certId &&
    p.requiredCount > 0 &&
    unique(p.missingItemSlugs) &&
    p.completedCount <= p.requiredCount &&
    p.missingItemSlugs.length === p.requiredCount - p.completedCount &&
    p.complete === (p.missingItemSlugs.length === 0) &&
    p.ratio === (p.requiredCount ? p.completedCount / p.requiredCount : 0).toFixed(4) &&
    (p.granted ? p.grantIdempotencyKey === `cert:${owner}:${certId}` : p.grantIdempotencyKey === null) &&
    p.requiredCount === required.length &&
    p.missingItemSlugs.every((s) => required.includes(s)) &&
    p.missingItemSlugs.join('|') === required.filter((s) => p.missingItemSlugs.includes(s)).join('|');
}
type Context = { owner: string; certId: string; slug: string };
const contextSchema = z.object({ owner: z.string().guid(), certId: z.string(), slug: ref });
const selectionKey = (owner: string) => `intafaced:academy:certificate:${owner}`;
const originalKey = (owner: string) => `intafaced:academy:original-completion:${owner}`;
export function selectedCertificate(owner: string | null | undefined) {
  const requested = new URLSearchParams(window.location.search).get('cert');
  if (requested) return requested;
  if (!owner) return '';
  try {
    return localStorage.getItem(selectionKey(owner)) ?? '';
  } catch {
    return '';
  }
}
export function rememberCertificate(owner: string | null | undefined, certId: string) {
  if (!owner) return;
  try {
    localStorage.setItem(selectionKey(owner), certId);
  } catch {
    /* Reading remains available without persistence. */
  }
}
export function lessonHref(slug: string, certId: string, path?: string) {
  const params = new URLSearchParams();
  if (certId) params.set('cert', certId);
  if (path) params.set('path', path);
  return `/academy/${encodeURIComponent(slug)}${params.size ? '?' + params : ''}`;
}
function originalPending(owner: string | null | undefined): Context | null {
  if (!owner) return null;
  try {
    const raw = localStorage.getItem(originalKey(owner)),
      marker = localStorage.getItem(`intafaced:more:pending:${owner}:academy`);
    if (!raw || !marker) return null;
    const parsed = contextSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.owner === owner && JSON.parse(marker).reference === `curriculum:${parsed.data.slug}`)
      return parsed.data;
  } catch {
    /* A damaged context cannot prove the original request. Shared recovery remains blocked. */
  }
  return null;
}

/**
 * Every read the learning path and the reader make, and the completion review. `reviewContent` draws what the review
 * shows for a lesson, so each drawing keeps its own parts.
 */
export function useLearningState({
  slug,
  initialPath,
  certId,
  action,
}: {
  slug?: string;
  initialPath?: string;
  certId: string;
  action: ActionControls;
}) {
  const api = useApi(),
    { userId } = useSession(),
    { language } = usePreferences();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [path, setPath] = useState(['foundations', 'markets', 'builder', 'sovereign'].includes(initialPath ?? '') ? initialPath! : 'all');
  const [kind, setKind] = useState('all'),
    [limit, setLimit] = useState(50);
  const context = useRef({ owner: userId, slug, certId });
  context.current = { owner: userId, slug, certId };
  const matches = (expected: typeof context.current) =>
    mounted.current &&
    action.isCurrent() &&
    api.canWrite() &&
    context.current.owner === expected.owner &&
    context.current.slug === expected.slug &&
    context.current.certId === expected.certId;
  const localFailure = (key: 'changed' | 'lessonChanged' | 'contextStorage') =>
    presentActionFailure(
      { ok: false as const, reason: key === 'contextStorage' ? ('error' as const) : ('aborted' as const), message: copy.t(key) },
      (locale) => {
        const presented = copy.forLocale(locale);
        return { message: presented.t(key), language: presented.languageFor(key) };
      },
    );
  const definitions = useResource(
    (signal) => api.call(ACADEMY_CERT_DEFINITIONS, undefined, { signal, accept: definitionsHold }),
    `academy-learning-definitions:${userId}`,
  );
  const selected = definitions.resource.status === 'ready' ? definitions.resource.data.find((c) => c.id === certId) : undefined;
  const progress = useResource(
    (signal) =>
      selected
        ? api.call(ACADEMY_CERT_PROGRESS, { certId }, { signal, accept: progressFits(userId, certId, selected.requiredItemSlugs) })
        : Promise.resolve({ ok: true as const, data: null }),
    `academy-learning-progress:${userId}:${certId}:${selected?.requiredItemSlugs.join('|') ?? ''}`,
  );
  const list = useResource(
    (signal) =>
      api.call(
        ACADEMY_CURRICULUM,
        {
          limit,
          ...(path !== 'all' ? { path: path as CurriculumAsk['path'] } : {}),
          ...(kind !== 'all' ? { kind: kind as CurriculumAsk['kind'] } : {}),
        },
        {
          signal,
          accept: (rows) =>
            rows.length <= limit &&
            unique(rows.map((r) => r.slug)) &&
            rows.every((r) => (path === 'all' || r.path === path) && (kind === 'all' || r.kind === kind)),
        },
      ),
    `academy-learning-library:${userId}:${path}:${kind}:${limit}`,
  );
  const reader = useResource(
    (signal) =>
      slug
        ? api.call(ACADEMY_CURRICULUM_ITEM_LOCALIZED, { slug, locale: language }, { signal, accept: (lesson) => lesson.slug === slug })
        : Promise.resolve({ ok: true as const, data: null }),
    `academy-learning-reader:${userId}:${slug}:${language}`,
  );
  // Required lesson titles come from the actual unfiltered curriculum, independently of the reader/library filters.
  const pathItems = useResource(
    (signal) =>
      certId
        ? api.call(ACADEMY_CURRICULUM, { limit: 200 }, { signal, accept: (rows) => rows.length <= 200 && unique(rows.map((r) => r.slug)) })
        : Promise.resolve({ ok: true as const, data: [] as Summary[] }),
    `academy-learning-path-items:${userId}:${certId}`,
  );
  const overview = useAcademyTracking();
  const openedLesson = reader.resource.status === 'ready' ? reader.resource.data?.slug : undefined;
  // One reader on screen is one visit: the key is this reader's mount, so an effect run twice for the same lesson
  // (a remount check, a session refresh) is one opening, and opening the lesson again later is another.
  const visit = useRef(`${Date.now().toString(36)}`);
  useEffect(() => {
    if (!openedLesson) return;
    rememberLastLesson(userId, openedLesson);
    // Academy keeps where this account last read, so Continue opens the same item on any device. A failed write leaves
    // the lesson readable and Continue where it was; it is not worth a notice on the lesson.
    void api.call(ACADEMY_TOUCH_LESSON, { slug: openedLesson, clientRequestId: `open:${openedLesson}:${visit.current}` });
  }, [userId, openedLesson]);
  const pending = originalPending(userId);
  const receipt = action.result?.ok ? academyItemCompletionSchema.safeParse(action.result.data) : null;
  const receiptMatches = receipt?.success && receipt.data.userId === userId && receipt.data.itemSlug === slug;
  const certificateLink = `/academy/certificates${certId ? `?${new URLSearchParams({ cert: certId })}` : ''}`;
  function review(lesson: AcademyLocalizedItem, reviewContent: (lesson: AcademyLocalizedItem, certId: string) => ReactNode) {
    const expected = { ...context.current },
      originalLocale = language;
    action.stage({
      title: () => copy.t('reviewCompletion'),
      confirm: () => copy.t('recordCompletion'),
      success: () => copy.t('completionRecorded'),
      reference: `curriculum:${lesson.slug}`,
      content: () => reviewContent(lesson, expected.certId),
      run: async (canDispatch) => {
        if (!canDispatch() || !matches(expected)) return localFailure('changed');
        try {
          localStorage.setItem(
            originalKey(expected.owner!),
            JSON.stringify({ owner: expected.owner, certId: expected.certId, slug: lesson.slug }),
          );
        } catch {
          return localFailure('contextStorage');
        }
        const fresh = await api.call(
          ACADEMY_CURRICULUM_ITEM_LOCALIZED,
          { slug: lesson.slug, locale: originalLocale },
          { accept: (r) => r.slug === lesson.slug },
        );
        if (!canDispatch() || !matches(expected)) return localFailure('changed');
        if (!fresh.ok) return fresh;
        if (
          fresh.data.title !== lesson.title ||
          fresh.data.body !== lesson.body ||
          fresh.data.kind !== lesson.kind ||
          fresh.data.path !== lesson.path
        )
          return localFailure('lessonChanged');
        if (!canDispatch() || !matches(expected)) return localFailure('changed');
        return api.call(
          ACADEMY_MARK_CURRICULUM_COMPLETE,
          { itemSlug: lesson.slug },
          { accept: (r) => r.userId === expected.owner && r.itemSlug === lesson.slug },
        );
      },
      done: () => {
        if (matches(expected)) progress.reload();
      },
    });
  }
  return {
    path,
    setPath,
    kind,
    setKind,
    limit,
    setLimit,
    definitions,
    selected,
    progress,
    list,
    reader,
    pathItems,
    overview,
    pending,
    receipt,
    receiptMatches,
    certificateLink,
    review,
  };
}
export type LearningState = ReturnType<typeof useLearningState>;
