import { z } from 'zod';
import { academyCertIssueSchema } from '@intafaced/contracts/academy-certificates';

/**
 * Academy learning-management logic. Pure functions only: everything here is derived from what
 * svc-academy returns (curriculum, certDefinitions, certProgress, myCerts, myCompletions). Nothing is
 * invented, scored or inferred beyond those answers.
 *
 * A lesson is recorded when Academy lists it among this account's completions (myCompletions) or a
 * certificate's progress counts it. It is pending when a certificate requires it and it is not
 * recorded, and open otherwise.
 *
 * svc-academy also keeps a reading position (`learningState`, `touchLesson`), but this app does not read it. "Resume"
 * uses the lesson this browser last opened, kept only on this device.
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

/** The XP Academy publishes to the rank ladder per certificate (`certXpPlane`). Only the fields the sheet reads. */
export const certXpPlaneRow = z.object({
  emitEnabled: z.boolean(),
  policies: z.array(z.object({ certId: ref, xpDelta: z.number().int().safe() })),
});
export type CertXpPlaneRow = z.infer<typeof certXpPlaneRow>;

/**
 * What a certificate is worth on the holder's rank: the XP Academy publishes for it, the same XP while publishing is
 * switched off (so the rank has not moved), or none when no XP value is published for it.
 */
export function certificateXp(plane: CertXpPlaneRow, certId: string): { kind: 'worth' | 'off'; xp: number } | { kind: 'none' } {
  const policy = plane.policies.find((row) => row.certId === certId);
  if (!policy || policy.xpDelta <= 0) return { kind: 'none' };
  return { kind: plane.emitEnabled ? 'worth' : 'off', xp: policy.xpDelta };
}

export const certDefinition = z.object({
  id: ref,
  title: ref,
  requiredItemSlugs: z.array(ref),
});
export type CertDefinition = z.infer<typeof certDefinition>;
/** One learning path with its published certificate, or Academy's refusal for a path with no published design. */
export const certPathRow = z.object({
  path: z.enum(academyPaths),
  certId: ref.nullable(),
  refusal: z.literal('academy.certificate_unpublished').nullable(),
});
export type CertPathRow = z.infer<typeof certPathRow>;
export const certProgressRow = z.object({
  userId: z.string().guid(),
  certId: ref,
  title: ref,
  requiredCount: z.number().int().safe().nonnegative(),
  completedCount: z.number().int().safe().nonnegative(),
  ratio: z.string(),
  missingItemSlugs: z.array(ref),
  complete: z.boolean(),
  granted: z.boolean(),
  grantIdempotencyKey: ref.nullable(),
  /** How the certificate is issued (AC-certificates-02); absent from an older service, read as the learner claiming it. */
  issue: academyCertIssueSchema.optional(),
});
export type CertProgressRow = z.infer<typeof certProgressRow>;
/** The code anyone can paste into the public check: 32 lowercase hex characters, the same rule the service applies. */
export const publicCertCode = z.string().regex(/^[0-9a-f]{32}$/);
export const certGrant = z.object({
  userId: z.string().guid(),
  certId: ref,
  grantedAt: z.string().datetime({ offset: true }),
  idempotencyKey: ref,
  /** Absent when the service did not send one; the certificate is then shown without a verification code. */
  publicId: publicCertCode.optional(),
  /** `revoked` once Academy revoked it: no sheet, no XP line, and the public check says revoked. */
  status: z.enum(['valid', 'revoked']).optional(),
});
export type CertGrant = z.infer<typeof certGrant>;

/** One lesson completion Academy lists for this account. */
export const completionRow = z.object({ itemSlug: ref, completedAt: z.string().datetime({ offset: true }) });
export const completionPage = z.object({ items: z.array(completionRow).max(200), nextCursor: z.string().min(1).nullable() });
export type CompletionRow = z.infer<typeof completionRow>;

/** What the service tells us about this account's lesson completions. */
export type Tracking = {
  /** Completed on this account: listed by myCompletions, or counted by a certificate's progress. */
  recorded: ReadonlySet<string>;
  /** Required by some certificate and not recorded. */
  pending: ReadonlySet<string>;
  /** Certificates the account holds. */
  grants: readonly CertGrant[];
  definitions: readonly CertDefinition[];
  progress: readonly CertProgressRow[];
};
export const emptyTracking: Tracking = { recorded: new Set(), pending: new Set(), grants: [], definitions: [], progress: [] };

/** Recorded: completed on this account. Pending: a certificate requires it and it is not recorded. Open: neither. */
export type LessonStatus = 'recorded' | 'pending' | 'open';

export function buildTracking(
  definitions: readonly CertDefinition[],
  progress: readonly CertProgressRow[],
  grants: readonly CertGrant[],
  completions: readonly CompletionRow[] = [],
): Tracking {
  const recorded = new Set<string>(completions.map((row) => row.itemSlug));
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
  return 'open';
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
  recorded: number;
  pending: number;
  open: number;
  /** Whole percent of the path's lessons recorded. Null only for a path with no lessons: no bar is drawn from nothing. */
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
  return {
    total: lessons.length,
    recorded,
    pending,
    open: lessons.length - recorded - pending,
    percent: lessons.length === 0 ? null : Math.floor((recorded / lessons.length) * 100),
  };
}

export function neighbours(lessons: readonly LessonSummary[], slug: string) {
  const ordered = [...lessons].sort(byOrder);
  const index = ordered.findIndex((l) => l.slug === slug);
  if (index < 0) return { previous: null, next: null, position: 0, total: ordered.length };
  return { previous: ordered[index - 1] ?? null, next: ordered[index + 1] ?? null, position: index + 1, total: ordered.length };
}

/** First lesson the account still owes, in path order; falls back to the first lesson not yet completed. */
export function nextUp(lessons: readonly LessonSummary[], tracking: Tracking): LessonSummary | null {
  const ordered = [...lessons].sort(byOrder);
  return (
    ordered.find((l) => lessonStatus(l.slug, tracking) === 'pending') ??
    ordered.find((l) => lessonStatus(l.slug, tracking) === 'open') ??
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

export type CertificateState = 'earned' | 'revoked' | 'ready' | 'issuing' | 'in-progress' | 'not-started';

export function certificateState(progress: CertProgressRow | undefined, grant: CertGrant | undefined): CertificateState {
  if (grant?.status === 'revoked') return 'revoked';
  if (grant || progress?.granted) return 'earned';
  if (!progress) return 'not-started';
  if (progress.complete && progress.issue?.issuesAt) return 'issuing';
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
    /** The code anyone can check on the public verify box; null when the service sent none. */
    code: card.grant.publicId ?? null,
    requirements: card.definition.requiredItemSlugs.length,
  };
}

/**
 * What was typed into the verify box. A verification code is 32 hex characters (letter case does not matter, the service
 * reads lowercase). A grant reference, `cert:<account>:<certificate>`, is a private record key and is not a code.
 */
export function parseVerifyCode(raw: string): { kind: 'code'; code: string } | { kind: 'grant-reference' } | { kind: 'invalid' } {
  const trimmed = raw.trim();
  const code = trimmed.toLowerCase();
  if (publicCertCode.safeParse(code).success) return { kind: 'code', code };
  return parseVerifyReference(trimmed).ok ? { kind: 'grant-reference' } : { kind: 'invalid' };
}

/** A grant reference as it appears on a certificate: `cert:<account>:<certificate>`. */
export function parseVerifyReference(raw: string): { ok: true; certId: string } | { ok: false } {
  const match = /^cert:([0-9a-f-]{36}):([a-z0-9][a-z0-9-]{0,63})$/i.exec(raw.trim());
  return match ? { ok: true, certId: match[2]! } : { ok: false };
}

/** The wait of a delayed issue rule in its largest whole unit: days, hours, or minutes. */
export function issueWait(delayMinutes: number): { unit: 'waitDays' | 'waitHours' | 'waitMinutes'; n: number } {
  if (delayMinutes % 1440 === 0) return { unit: 'waitDays', n: delayMinutes / 1440 };
  if (delayMinutes % 60 === 0) return { unit: 'waitHours', n: delayMinutes / 60 };
  return { unit: 'waitMinutes', n: delayMinutes };
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

/** A date and time in UTC, for records that can repeat within a day, such as assessment attempts. */
export function formatMoment(iso: string, locale: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC';
  } catch {
    return iso.slice(0, 16).replace('T', ' ') + ' UTC';
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

export type AcademyTab = 'Learning' | 'Certificates' | 'Rooms' | 'Videos' | 'Programmes';
/** The five hub tabs and their addresses (IA-SPEC 2.9). Each segment, and `progress`, is reserved: never a lesson slug. */
export const academyTabs: readonly (readonly [AcademyTab, string])[] = [
  ['Learning', 'learning'],
  ['Certificates', 'certificates'],
  ['Rooms', 'rooms'],
  ['Videos', 'videos'],
  ['Programmes', 'programmes'],
];
export const academyTabHref = (tab: AcademyTab) => `/academy/${academyTabs.find(([name]) => name === tab)![1]}`;

export type AcademyRoute =
  | { kind: 'tab'; tab: AcademyTab; hub?: true }
  | { kind: 'progress' }
  | { kind: 'reader'; slug: string | undefined }
  | { kind: 'course'; slug: string | undefined }
  | { kind: 'assignment'; slug: string | undefined; itemId: string | undefined }
  | { kind: 'verify'; code: string | undefined }
  | { kind: 'programme'; slug: string }
  | { kind: 'discussion'; courseSlug: string; postId: string | undefined }
  | { kind: 'messages'; conversationId: string | undefined };
/** The public course page (AC-catalogue-03). Until courses are rows a course is one curriculum path. */
export const academyCourseHref = (slug: string) => `/academy/learning/course/${encodeURIComponent(slug)}`;
/** An assignment's page in a course staff made (AC-assignments-01). */
export const academyAssignmentHref = (slug: string, itemId: string) =>
  `${academyCourseHref(slug)}/assignment/${encodeURIComponent(itemId)}`;
/** A course programme's page (AC-programmes-01). */
export const academyProgrammeHref = (slug: string) => `/academy/programmes/${encodeURIComponent(slug)}`;
/** A course's discussion, and one post in it (AC-rooms-01). */
export const academyDiscussionHref = (courseSlug: string, postId?: string) =>
  `/academy/rooms/discussion/${encodeURIComponent(courseSlug)}${postId ? `/${encodeURIComponent(postId)}` : ''}`;
/** The reader's conversations with course teams, and one of them (AC-rooms-04). */
export const academyMessagesHref = (conversationId?: string) =>
  `/academy/rooms/messages${conversationId ? `/${encodeURIComponent(conversationId)}` : ''}`;
/** The public check of one certificate (AC-certificates-01): the link a learner shares. Open to anyone, signed in or not. */
export const academyVerifyHref = (code: string) => `/academy/certificates/verify/${encodeURIComponent(code)}`;
/** Sign in from a course page and come back to its plain address: a private link's `#key=` never rides in a URL. */
export const academyCourseSignInHref = (slug: string) => `/login?redirect=${encodeURIComponent(academyCourseHref(slug))}`;
const decoded = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};
/** What an `/academy` address opens: a tab, the progress page, or the reader. A tab segment always wins over a lesson. */
export function academyRoute(pathname: string): AcademyRoute {
  const [, , segment, part, course, child, itemId] = pathname.split('/');
  if (!segment) return { kind: 'tab', tab: 'Learning', hub: true };
  if (segment === 'learning' && part === 'course' && child === 'assignment')
    return { kind: 'assignment', slug: course ? decoded(course) : undefined, itemId: itemId ? decoded(itemId) : undefined };
  if (segment === 'learning' && part === 'course') return { kind: 'course', slug: course ? decoded(course) : undefined };
  if (segment === 'certificates' && part === 'verify') return { kind: 'verify', code: course ? decoded(course) : undefined };
  if (segment === 'rooms' && part === 'discussion' && course)
    return { kind: 'discussion', courseSlug: decoded(course) ?? course, postId: child ? decoded(child) : undefined };
  if (segment === 'rooms' && part === 'messages') return { kind: 'messages', conversationId: course ? decoded(course) : undefined };
  if (segment === 'programmes' && part) return { kind: 'programme', slug: decoded(part) ?? part };
  const tab = academyTabs.find(([, slug]) => slug === segment);
  if (tab) return { kind: 'tab', tab: tab[0] };
  if (segment === 'progress') return { kind: 'progress' };
  return { kind: 'reader', slug: decoded(segment) };
}

/** The old `/academy?section=videos` link lands on `/academy/videos`, keeping its other parameters. Anything else stays put. */
export function academySectionRedirect(pathname: string, search: string): string | undefined {
  if (pathname !== '/academy') return undefined;
  const query = new URLSearchParams(search);
  const section = query.get('section');
  const known = section === 'progress' || academyTabs.some(([, slug]) => slug === section);
  if (!section || !known) return undefined;
  query.delete('section');
  return `/academy/${section}${query.size ? `?${query}` : ''}`;
}
