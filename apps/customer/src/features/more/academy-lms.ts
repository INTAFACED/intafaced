import { z } from 'zod';

/**
 * Academy learning-management logic. Pure functions only: everything here is derived from what
 * svc-academy returns (curriculum, certDefinitions, certProgress, myCerts). Nothing is invented,
 * scored or inferred beyond those answers.
 *
 * Honest limits of the service today (see academy-BACKEND-NEEDS.md):
 * - There is no "list my completed lessons" procedure. A lesson's recorded state is only known when
 *   a certificate requires it (certProgress.missingItemSlugs). Every other lesson is "untracked".
 * - There is no time spent, streak or last-position record. "Resume" uses the lesson this browser
 *   last opened, kept only on this device.
 */

export const academyPaths = ['foundations', 'markets', 'builder', 'sovereign'] as const;
export type AcademyPath = (typeof academyPaths)[number];
export const isAcademyPath = (value: unknown): value is AcademyPath => academyPaths.includes(value as AcademyPath);

const ref = z.string().min(1);
export const lessonSummary = z.object({
  slug: ref,
  title: ref,
  kind: z.enum(['playbook', 'workbook', 'lesson']),
  path: z.enum(academyPaths),
  order: z.number().int().safe(),
  summary: z.string(),
  estimatedMinutes: z.number().int().safe().positive(),
});
export type LessonSummary = z.infer<typeof lessonSummary>;
export const lessonCatalogue = z.array(lessonSummary).max(200);

export const certDefinition = z.object({ id: ref, title: ref, requiredItemSlugs: z.array(ref) });
export type CertDefinition = z.infer<typeof certDefinition>;
export const certProgressRow = z.object({
  userId: z.string().uuid(),
  certId: ref,
  title: ref,
  requiredCount: z.number().int().safe().nonnegative(),
  completedCount: z.number().int().safe().nonnegative(),
  ratio: z.string(),
  missingItemSlugs: z.array(ref),
  complete: z.boolean(),
  granted: z.boolean(),
  grantIdempotencyKey: ref.nullable(),
});
export type CertProgressRow = z.infer<typeof certProgressRow>;
export const certGrant = z.object({
  userId: z.string().uuid(),
  certId: ref,
  grantedAt: z.string().datetime({ offset: true }),
  idempotencyKey: ref,
});
export type CertGrant = z.infer<typeof certGrant>;

/** What the service lets us know about this account's lesson completions. */
export type Tracking = {
  /** Required by some certificate and recorded for this account. */
  recorded: ReadonlySet<string>;
  /** Required by some certificate and not yet recorded. */
  pending: ReadonlySet<string>;
  /** Certificates the account holds. */
  grants: readonly CertGrant[];
  definitions: readonly CertDefinition[];
  progress: readonly CertProgressRow[];
};
export const emptyTracking: Tracking = { recorded: new Set(), pending: new Set(), grants: [], definitions: [], progress: [] };

export type LessonStatus = 'recorded' | 'pending' | 'untracked';

export function buildTracking(
  definitions: readonly CertDefinition[],
  progress: readonly CertProgressRow[],
  grants: readonly CertGrant[],
): Tracking {
  const recorded = new Set<string>();
  const pending = new Set<string>();
  for (const definition of definitions) {
    const row = progress.find((p) => p.certId === definition.id);
    if (!row) continue;
    for (const slug of definition.requiredItemSlugs) {
      if (row.missingItemSlugs.includes(slug)) pending.add(slug);
      else recorded.add(slug);
    }
  }
  // A lesson missing for one certificate but recorded for another is recorded: the completion is per account.
  for (const slug of recorded) pending.delete(slug);
  return { recorded, pending, grants, definitions, progress };
}

export function lessonStatus(slug: string, tracking: Tracking): LessonStatus {
  if (tracking.recorded.has(slug)) return 'recorded';
  if (tracking.pending.has(slug)) return 'pending';
  return 'untracked';
}

export const byOrder = (a: LessonSummary, b: LessonSummary) => a.order - b.order || a.slug.localeCompare(b.slug);

export type PathSummary = {
  path: AcademyPath;
  lessons: LessonSummary[];
  minutes: number;
  playbooks: number;
  workbooks: number;
  readings: number;
};

/** Group the published curriculum into its paths, in the service's own order. Empty paths are kept out. */
export function groupByPath(lessons: readonly LessonSummary[]): PathSummary[] {
  return academyPaths
    .map((path) => {
      const inPath = lessons.filter((l) => l.path === path).sort(byOrder);
      return {
        path,
        lessons: inPath,
        minutes: inPath.reduce((sum, l) => sum + l.estimatedMinutes, 0),
        playbooks: inPath.filter((l) => l.kind === 'playbook').length,
        workbooks: inPath.filter((l) => l.kind === 'workbook').length,
        readings: inPath.filter((l) => l.kind === 'lesson').length,
      };
    })
    .filter((p) => p.lessons.length > 0);
}

export type PathProgress = {
  total: number;
  tracked: number;
  recorded: number;
  pending: number;
  untracked: number;
  /** Whole percent of tracked lessons recorded. Null when nothing in the path is tracked: no bar is drawn from nothing. */
  percent: number | null;
};

export function pathProgress(lessons: readonly LessonSummary[], tracking: Tracking): PathProgress {
  let recorded = 0;
  let pending = 0;
  for (const lesson of lessons) {
    const status = lessonStatus(lesson.slug, tracking);
    if (status === 'recorded') recorded++;
    else if (status === 'pending') pending++;
  }
  const tracked = recorded + pending;
  return {
    total: lessons.length,
    tracked,
    recorded,
    pending,
    untracked: lessons.length - tracked,
    percent: tracked === 0 ? null : Math.floor((recorded / tracked) * 100),
  };
}

export function neighbours(lessons: readonly LessonSummary[], slug: string) {
  const ordered = [...lessons].sort(byOrder);
  const index = ordered.findIndex((l) => l.slug === slug);
  if (index < 0) return { previous: null, next: null, position: 0, total: ordered.length };
  return { previous: ordered[index - 1] ?? null, next: ordered[index + 1] ?? null, position: index + 1, total: ordered.length };
}

/** First lesson the account still owes, in path order; falls back to the first untracked lesson. */
export function nextUp(lessons: readonly LessonSummary[], tracking: Tracking): LessonSummary | null {
  const ordered = [...lessons].sort(byOrder);
  return (
    ordered.find((l) => lessonStatus(l.slug, tracking) === 'pending') ??
    ordered.find((l) => lessonStatus(l.slug, tracking) === 'untracked') ??
    null
  );
}

export type ResumeTarget = { lesson: LessonSummary; reason: 'unfinished' | 'after-last' | 'required' | 'start' };

/**
 * "Continue where you left off". Order of truth:
 * 1. the lesson this browser opened last, if it is still published and not yet recorded;
 * 2. the lesson after it in its path, if it is recorded;
 * 3. the next required lesson of any certificate;
 * 4. the first lesson of the first path.
 */
export function resumeTarget(lastSlug: string | null, all: readonly LessonSummary[], tracking: Tracking): ResumeTarget | null {
  const last = lastSlug ? all.find((l) => l.slug === lastSlug) : undefined;
  if (last) {
    if (lessonStatus(last.slug, tracking) !== 'recorded') return { lesson: last, reason: 'unfinished' };
    const after = neighbours(
      all.filter((l) => l.path === last.path),
      last.slug,
    ).next;
    if (after) return { lesson: after, reason: 'after-last' };
  }
  const required = [...all]
    .sort((a, b) => academyPaths.indexOf(a.path) - academyPaths.indexOf(b.path) || byOrder(a, b))
    .find((l) => tracking.pending.has(l.slug));
  if (required) return { lesson: required, reason: 'required' };
  const first = groupByPath(all)[0]?.lessons[0];
  return first ? { lesson: first, reason: 'start' } : null;
}

const lastKey = (owner: string) => `intafaced:academy:last-lesson:${owner}`;
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
export function readLastLesson(owner: string | null | undefined, store: Store | null = defaultStore()): string | null {
  if (!owner || !store) return null;
  try {
    const value = store.getItem(lastKey(owner));
    return value && value.length <= 120 ? value : null;
  } catch {
    return null;
  }
}
export function rememberLastLesson(owner: string | null | undefined, slug: string, store: Store | null = defaultStore()) {
  if (!owner || !store) return;
  try {
    store.setItem(lastKey(owner), slug);
  } catch {
    /* Resume is a convenience; reading stays available without it. */
  }
}

export type CertificateState = 'earned' | 'ready' | 'in-progress' | 'not-started';

export function certificateState(progress: CertProgressRow | undefined, grant: CertGrant | undefined): CertificateState {
  if (grant || progress?.granted) return 'earned';
  if (!progress) return 'not-started';
  if (progress.complete) return 'ready';
  return progress.completedCount > 0 ? 'in-progress' : 'not-started';
}

export type CertificateCard = {
  definition: CertDefinition;
  state: CertificateState;
  progress: CertProgressRow | undefined;
  grant: CertGrant | undefined;
  percent: number;
};

/** One card per published certificate definition, in the service's order. */
export function certificateCards(tracking: Tracking): CertificateCard[] {
  return tracking.definitions.map((definition) => {
    const progress = tracking.progress.find((p) => p.certId === definition.id);
    const grant = tracking.grants.find((g) => g.certId === definition.id);
    const required = progress?.requiredCount ?? definition.requiredItemSlugs.length;
    return {
      definition,
      progress,
      grant,
      state: certificateState(progress, grant),
      percent: required === 0 || !progress ? 0 : Math.floor((progress.completedCount / required) * 100),
    };
  });
}

/** Lessons of a certificate with their recorded state, in the certificate's own order. */
export function certificateLessons(card: CertificateCard, lessons: readonly LessonSummary[]) {
  return card.definition.requiredItemSlugs.map((slug) => ({
    slug,
    lesson: lessons.find((l) => l.slug === slug),
    recorded: card.progress ? !card.progress.missingItemSlugs.includes(slug) : false,
  }));
}

/**
 * The certificate document. Every field is a service fact; the holder is shown as the account
 * reference because Academy does not return a display name, and the issue date is the grant date.
 */
export function certificateDocument(card: CertificateCard, owner: string) {
  if (!card.grant || card.state !== 'earned') return null;
  return {
    title: card.definition.title,
    certId: card.definition.id,
    holder: owner,
    issuedAt: card.grant.grantedAt,
    reference: card.grant.idempotencyKey,
    requirements: card.definition.requiredItemSlugs.length,
  };
}

/** A reference typed into the verify box. The grant reference is `cert:<account>:<certificate>`. */
export function parseVerifyReference(raw: string): { ok: true; certId: string } | { ok: false } {
  const match = /^cert:([0-9a-f-]{36}):([a-z0-9][a-z0-9-]{0,63})$/i.exec(raw.trim());
  return match ? { ok: true, certId: match[2]! } : { ok: false };
}

export function formatDay(iso: string, locale: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
  } catch {
    return iso.slice(0, 10);
  }
}

export const lessonHrefFor = (slug: string, certId?: string, path?: string) => {
  const params = new URLSearchParams();
  if (certId) params.set('cert', certId);
  if (path) params.set('path', path);
  return `/academy/${encodeURIComponent(slug)}${params.size ? '?' + params : ''}`;
};

/** Live and upcoming sessions in a room, counted from the sessions the service returned. */
export function roomSummary(sessions: readonly { status: 'scheduled' | 'live' | 'ended' | 'cancelled' }[]) {
  return {
    live: sessions.filter((s) => s.status === 'live').length,
    scheduled: sessions.filter((s) => s.status === 'scheduled').length,
  };
}

const sectionTabs: Record<string, string> = {
  certificates: 'Certificates',
  rooms: 'Rooms',
  videos: 'Videos',
  programmes: 'Programmes',
};
/** The tab a `?section=` link opens. Unknown or missing sections open Learning. */
export const tabForSection = (section: string | null) =>
  section && Object.hasOwn(sectionTabs, section) ? sectionTabs[section]! : 'Learning';
