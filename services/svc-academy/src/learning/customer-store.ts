import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { AcademyError } from '../errors.js';
import { CURRICULUM_PATHS, hasCurriculumSlug, listCurriculum, type CurriculumPath } from '../curriculum/catalog.js';
import {
  PROGRAMME_CATALOG,
  programmeBySlug,
  unmetPrerequisites,
  type ProgrammeDefinition,
  type ProgrammeSlug,
} from '../curriculum/programmes.js';
import { getVideoSpineItem, listVideoSpine, type VideoSpineEntry } from '../video/catalog.js';
import { emptyScene, parseScene } from '../spatial/scene.js';
import { sceneFingerprint } from '../spatial/edit-policy.js';
import { sessionCalendarText } from './calendar.js';
import { assertCustomerListLimit, assertTouchSeconds, OPS_METRICS_MAX_DAYS } from './limits.js';
import { metricFromCount, parseUtcDay, utcDaysInclusive, type MetricCell } from './metrics.js';

const PATHS = new Set<ProgrammeSlug>(['foundations', 'markets', 'builder', 'sovereign']);

export type CompletionRow = { itemSlug: string; completedAt: Date };
export type CompletionPage = { items: CompletionRow[]; nextCursor: string | null };

export type EnrollmentRow = { userId: string; pathSlug: string; enrolledAt: Date; leftAt: Date | null };

export type LearningStateRow = {
  lastItemSlug: string | null;
  lastOpenedAt: Date | null;
  secondsRead: number;
  activeDays: number;
};

export type CohortRow = {
  slug: string;
  startsAt: Date | null;
  endsAt: Date | null;
  capacity: number | null;
  entryRules: string | null;
  seatsLeft: number | null;
};

export type VideoProgressRow = { videoSlug: string; positionSeconds: number | null };

export type CallerSeat = {
  sessionId: string;
  roomId: string;
  role: 'host' | 'speaker' | 'attendee';
};

export type UpcomingSession = {
  id: string;
  roomId: string;
  title: string;
  hostId: string;
  status: 'scheduled' | 'live' | 'ended' | 'cancelled';
  startsAt: Date;
  endsAt: Date | null;
  streamProvider: string | null;
  scene: Record<string, unknown>;
  sceneFingerprint: string;
  seated: true;
  role: 'host' | 'speaker' | 'attendee';
};

export type GrantAuditRow = {
  accountId: string;
  certificateId: string;
  grantedAt: Date;
  status: 'granted';
  reference: string;
};

export type GrantAuditPage = { items: GrantAuditRow[]; nextCursor: string | null };

export type OpsDay = {
  date: string;
  lessonsRead: MetricCell;
  completions: MetricCell;
  grants: MetricCell;
};

export type EnrolmentCounts = {
  from: string;
  to: string;
  total: number;
  paths: Array<{ pathSlug: string; count: number }>;
};

export type CompletionsByItem = {
  from: string;
  to: string;
  pathSlug: string | null;
  items: Array<{ itemSlug: string; pathSlug: string | null; count: number }>;
};

type UtcWindow = { fromIso: string; toIso: string; start: Date; endExclusive: Date };

function utcWindow(label: string, from: string, to: string): UtcWindow {
  let fromDay: ReturnType<typeof parseUtcDay>;
  let toDay: ReturnType<typeof parseUtcDay>;
  try {
    fromDay = parseUtcDay(from);
    toDay = parseUtcDay(to);
  } catch {
    throw new AcademyError(`${label} from and to must be UTC days YYYY-MM-DD`, 'academy.metrics_range_invalid');
  }
  const fromUtc = Date.UTC(fromDay.y, fromDay.m - 1, fromDay.d);
  const toUtc = Date.UTC(toDay.y, toDay.m - 1, toDay.d);
  if (fromUtc > toUtc) {
    throw new AcademyError(`${label} from is after to`, 'academy.metrics_range_invalid');
  }
  const span = Math.floor((toUtc - fromUtc) / 86_400_000) + 1;
  if (span > OPS_METRICS_MAX_DAYS) {
    throw new AcademyError(
      `${label} range is ${span} days; OPS_METRICS_MAX_DAYS is ${OPS_METRICS_MAX_DAYS}`,
      'academy.metrics_range_invalid',
    );
  }
  return { fromIso: fromDay.iso, toIso: toDay.iso, start: new Date(fromUtc), endExclusive: new Date(toUtc + 86_400_000) };
}

function encodeCursor(at: Date, key: string): string {
  return Buffer.from(`${at.toISOString()}\n${key}`, 'utf8').toString('base64url');
}

function encodeGrantCursor(at: Date, certId: string, accountId: string): string {
  return Buffer.from(`${at.toISOString()}\n${certId}\n${accountId}`, 'utf8').toString('base64url');
}

function decodeGrantCursor(cursor: string): { at: Date; certId: string; accountId: string } {
  const decoded = decodeCursor(cursor);
  const nl = decoded.key.indexOf('\n');
  if (nl < 1) throw new AcademyError('cursor is not valid', 'academy.cert_invalid');
  return { at: decoded.at, certId: decoded.key.slice(0, nl), accountId: decoded.key.slice(nl + 1) };
}

function decodeCursor(cursor: string): { at: Date; key: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new AcademyError('cursor is not valid', 'academy.cert_invalid');
  }
  const nl = raw.indexOf('\n');
  if (nl < 1) throw new AcademyError('cursor is not valid', 'academy.cert_invalid');
  const at = new Date(raw.slice(0, nl));
  const key = raw.slice(nl + 1);
  if (Number.isNaN(at.getTime()) || key.length === 0) {
    throw new AcademyError('cursor is not valid', 'academy.cert_invalid');
  }
  return { at, key };
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function sceneOf(raw: unknown): { scene: Record<string, unknown>; sceneFingerprint: string } {
  const parsed = parseScene(raw);
  const scene = parsed.ok ? parsed.scene : emptyScene();
  return { scene: raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}, sceneFingerprint: sceneFingerprint(scene) };
}

type EnrollmentSql = {
  user_id: string;
  path_slug: string;
  enrolled_at: Date;
  left_at: Date | null;
};

function mapEnrollment(row: EnrollmentSql): EnrollmentRow {
  return { userId: row.user_id, pathSlug: row.path_slug, enrolledAt: row.enrolled_at, leftAt: row.left_at };
}

export class AcademyCustomerStore {
  constructor(private readonly sql: Sql) {}

  async myCompletions(input: { userId: string; limit: number | null | undefined; cursor?: string | null }): Promise<CompletionPage> {
    const limit = assertCustomerListLimit(input.limit, 'academy.my_completions_list_limit_unset', 'Completions');
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await this.sql<Array<{ item_slug: string; completed_at: Date }>>`
      SELECT item_slug, completed_at
        FROM academy.cert_item_completions
       WHERE user_id = ${input.userId}
         AND (
           ${cursor?.at ?? null}::timestamptz IS NULL
           OR (completed_at, item_slug) < (${cursor?.at ?? null}::timestamptz, ${cursor?.key ?? ''})
         )
       ORDER BY completed_at DESC, item_slug DESC
       LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ itemSlug: r.item_slug, completedAt: r.completed_at })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.completed_at, last.item_slug) : null,
    };
  }

  async activePathSlugs(userId: string): Promise<Set<string>> {
    const rows = await this.sql<Array<{ path_slug: string }>>`
      SELECT path_slug FROM academy.cert_enrollments
       WHERE user_id = ${userId} AND left_at IS NULL
    `;
    return new Set(rows.map((r) => r.path_slug));
  }

  async enrollCertPath(input: { userId: string; pathSlug: string; catalog?: readonly ProgrammeDefinition[] }): Promise<EnrollmentRow> {
    const pathSlug = input.pathSlug.trim().toLowerCase();
    if (!PATHS.has(pathSlug as ProgrammeSlug)) {
      throw new AcademyError('pathSlug must be one of foundations | markets | builder | sovereign', 'academy.cert_invalid');
    }
    const catalog = input.catalog ?? PROGRAMME_CATALOG;
    const def = programmeBySlug(catalog, pathSlug);
    if (!def) {
      throw new AcademyError(`programme ${pathSlug} is not in the catalog`, 'academy.cert_invalid');
    }
    const missing = unmetPrerequisites(def, await this.activePathSlugs(input.userId));
    if (missing.length > 0) {
      throw new AcademyError(`academy.prerequisite_unmet missing=${missing.join(',')}`, 'academy.prerequisite_unmet');
    }
    const rows = await this.sql<EnrollmentSql[]>`
      INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at)
      VALUES (${input.userId}, ${pathSlug}, now())
      ON CONFLICT (user_id, path_slug) WHERE left_at IS NULL
      DO UPDATE SET path_slug = EXCLUDED.path_slug
      RETURNING user_id, path_slug, enrolled_at, left_at
    `;
    return mapEnrollment(rows[0]!);
  }

  async myEnrollments(userId: string): Promise<EnrollmentRow[]> {
    const rows = await this.sql<EnrollmentSql[]>`
      SELECT user_id, path_slug, enrolled_at, left_at
        FROM academy.cert_enrollments
       WHERE user_id = ${userId} AND left_at IS NULL
       ORDER BY enrolled_at ASC, path_slug ASC
    `;
    return rows.map(mapEnrollment);
  }

  async leaveCertPath(input: { userId: string; pathSlug: string; clientRequestId: string }): Promise<EnrollmentRow> {
    const pathSlug = input.pathSlug.trim().toLowerCase();
    const clientRequestId = input.clientRequestId.trim();
    if (!PATHS.has(pathSlug as ProgrammeSlug)) {
      throw new AcademyError('pathSlug must be one of foundations | markets | builder | sovereign', 'academy.cert_invalid');
    }
    if (!clientRequestId) throw new AcademyError('clientRequestId is required', 'academy.cert_invalid');
    return transaction(this.sql, async (tx) => {
      const replay = await tx<EnrollmentSql[]>`
        SELECT user_id, path_slug, enrolled_at, left_at
          FROM academy.cert_enrollments
         WHERE user_id = ${input.userId} AND leave_request_id = ${clientRequestId}
      `;
      if (replay[0]) return mapEnrollment(replay[0]);
      const active = await tx<Array<EnrollmentSql & { id: string }>>`
        SELECT id, user_id, path_slug, enrolled_at, left_at
          FROM academy.cert_enrollments
         WHERE user_id = ${input.userId} AND path_slug = ${pathSlug} AND left_at IS NULL
         FOR UPDATE
      `;
      if (!active[0]) {
        const prior = await tx<EnrollmentSql[]>`
          SELECT user_id, path_slug, enrolled_at, left_at
            FROM academy.cert_enrollments
           WHERE user_id = ${input.userId} AND path_slug = ${pathSlug} AND left_at IS NOT NULL
           ORDER BY left_at DESC
           LIMIT 1
        `;
        if (prior[0]) return mapEnrollment(prior[0]);
        throw new AcademyError('No enrolment to leave', 'academy.enrollment_not_found');
      }
      const left = await tx<EnrollmentSql[]>`
        UPDATE academy.cert_enrollments
           SET left_at = now(), leave_request_id = ${clientRequestId}
         WHERE id = ${active[0].id} AND left_at IS NULL
        RETURNING user_id, path_slug, enrolled_at, left_at
      `;
      return mapEnrollment(left[0]!);
    });
  }

  async learningState(userId: string): Promise<LearningStateRow> {
    const rows = await this.sql<Array<{ last_item_slug: string; last_opened_at: Date; seconds_read: number }>>`
      SELECT last_item_slug, last_opened_at, seconds_read
        FROM academy.learning_state WHERE user_id = ${userId}
    `;
    const days = await this.sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM academy.learning_active_days WHERE user_id = ${userId}
    `;
    const row = rows[0];
    if (!row) return { lastItemSlug: null, lastOpenedAt: null, secondsRead: 0, activeDays: 0 };
    return {
      lastItemSlug: row.last_item_slug,
      lastOpenedAt: row.last_opened_at,
      secondsRead: row.seconds_read,
      activeDays: days[0]?.n ?? 0,
    };
  }

  async touchLesson(input: {
    userId: string;
    slug: string;
    secondsRead?: number | null;
    clientRequestId: string;
    now?: Date;
  }): Promise<LearningStateRow> {
    const slug = input.slug.trim();
    const clientRequestId = input.clientRequestId.trim();
    if (!clientRequestId) throw new AcademyError('clientRequestId is required', 'academy.cert_invalid');
    if (!hasCurriculumSlug(slug)) throw new AcademyError('Unknown curriculum item', 'academy.curriculum_not_found');
    const seconds = assertTouchSeconds(input.secondsRead);
    const now = input.now ?? new Date();
    const day = utcDay(now);
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:touch`}, 0))`;
      const replay = await tx<Array<{ last_item_slug: string; last_opened_at: Date; seconds_read: number; active_days: number }>>`
        SELECT last_item_slug, last_opened_at, seconds_read, active_days
          FROM academy.learning_touches
         WHERE user_id = ${input.userId} AND client_request_id = ${clientRequestId}
      `;
      if (replay[0]) {
        return {
          lastItemSlug: replay[0].last_item_slug,
          lastOpenedAt: replay[0].last_opened_at,
          secondsRead: replay[0].seconds_read,
          activeDays: replay[0].active_days,
        };
      }
      const updated = await tx<Array<{ last_item_slug: string; last_opened_at: Date; seconds_read: number }>>`
        INSERT INTO academy.learning_state (user_id, last_item_slug, last_opened_at, seconds_read)
        VALUES (${input.userId}, ${slug}, ${now}, ${seconds})
        ON CONFLICT (user_id) DO UPDATE SET
          last_item_slug = EXCLUDED.last_item_slug,
          last_opened_at = EXCLUDED.last_opened_at,
          seconds_read = academy.learning_state.seconds_read + EXCLUDED.seconds_read
        RETURNING last_item_slug, last_opened_at, seconds_read
      `;
      await tx`
        INSERT INTO academy.learning_active_days (user_id, active_on)
        VALUES (${input.userId}, ${day}::date)
        ON CONFLICT (user_id, active_on) DO NOTHING
      `;
      const days = await tx<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM academy.learning_active_days WHERE user_id = ${input.userId}
      `;
      const state = updated[0]!;
      const activeDays = days[0]?.n ?? 0;
      await tx`
        INSERT INTO academy.learning_touches (
          user_id, client_request_id, item_slug, seconds_added, touched_at,
          last_item_slug, last_opened_at, seconds_read, active_days
        ) VALUES (
          ${input.userId}, ${clientRequestId}, ${slug}, ${seconds}, ${now},
          ${state.last_item_slug}, ${state.last_opened_at}, ${state.seconds_read}, ${activeDays}
        )
      `;
      return {
        lastItemSlug: state.last_item_slug,
        lastOpenedAt: state.last_opened_at,
        secondsRead: state.seconds_read,
        activeDays,
      };
    });
  }

  async residencyCohorts(limit: number | null | undefined): Promise<CohortRow[]> {
    const n = assertCustomerListLimit(limit, 'academy.residency_cohorts_list_limit_unset', 'Residency cohorts');
    const rows = await this.sql<
      Array<{
        slug: string;
        starts_at: Date | null;
        ends_at: Date | null;
        capacity: number | null;
        entry_rules: string | null;
        seats_left: number | null;
      }>
    >`
      SELECT c.slug, c.starts_at, c.ends_at, c.capacity, c.entry_rules,
             CASE
               WHEN c.capacity IS NULL THEN NULL
               ELSE c.capacity - (
                 SELECT COUNT(*)::int FROM academy.residency_applications a
                  WHERE a.cohort_slug = c.slug AND a.status IN ('applied', 'accepted')
               )
             END AS seats_left
        FROM academy.residency_cohorts c
       WHERE c.status = 'open' AND c.published = true
       ORDER BY c.slug ASC
       LIMIT ${n}
    `;
    return rows.map((r) => ({
      slug: r.slug,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      capacity: r.capacity === null ? null : Number(r.capacity),
      entryRules: r.entry_rules,
      seatsLeft: r.seats_left === null ? null : Number(r.seats_left),
    }));
  }

  async setVideoProgress(input: {
    userId: string;
    videoSlug: string;
    positionSeconds: number;
    clientRequestId: string;
    spine?: readonly VideoSpineEntry[];
    now?: Date;
  }): Promise<VideoProgressRow> {
    const clientRequestId = input.clientRequestId.trim();
    if (!clientRequestId) throw new AcademyError('clientRequestId is required', 'academy.cert_invalid');
    const spine = input.spine ?? listVideoSpine();
    const item = spine.find((v) => v.slug === input.videoSlug) ?? getVideoSpineItem(input.videoSlug);
    if (!item || !spine.some((v) => v.slug === input.videoSlug)) {
      throw new AcademyError(`Video "${input.videoSlug}" is not on the named spine`, 'academy.video_not_found');
    }
    const position = input.positionSeconds;
    if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) {
      throw new AcademyError('positionSeconds must be a non-negative integer', 'academy.video_position_out_of_range');
    }
    const duration = item.durationSeconds;
    if (duration != null && position > duration) {
      throw new AcademyError(`positionSeconds ${position} exceeds durationSeconds ${duration}`, 'academy.video_position_out_of_range');
    }
    const now = input.now ?? new Date();
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:video`}, 0))`;
      const replay = await tx<Array<{ video_slug: string; position_seconds: number }>>`
        SELECT video_slug, position_seconds FROM academy.video_progress_requests
         WHERE user_id = ${input.userId} AND client_request_id = ${clientRequestId}
      `;
      if (replay[0]) return { videoSlug: replay[0].video_slug, positionSeconds: replay[0].position_seconds };
      await tx`
        INSERT INTO academy.video_progress (user_id, video_slug, position_seconds, updated_at)
        VALUES (${input.userId}, ${input.videoSlug}, ${position}, ${now})
        ON CONFLICT (user_id, video_slug) DO UPDATE SET
          position_seconds = EXCLUDED.position_seconds,
          updated_at = EXCLUDED.updated_at
      `;
      await tx`
        INSERT INTO academy.video_progress_requests (user_id, client_request_id, video_slug, position_seconds)
        VALUES (${input.userId}, ${clientRequestId}, ${input.videoSlug}, ${position})
      `;
      return { videoSlug: input.videoSlug, positionSeconds: position };
    });
  }

  async getVideoProgress(input: { userId: string; videoSlug: string; spine?: readonly VideoSpineEntry[] }): Promise<VideoProgressRow> {
    const spine = input.spine ?? listVideoSpine();
    if (!spine.some((v) => v.slug === input.videoSlug)) {
      throw new AcademyError(`Video "${input.videoSlug}" is not on the named spine`, 'academy.video_not_found');
    }
    const rows = await this.sql<Array<{ position_seconds: number }>>`
      SELECT position_seconds FROM academy.video_progress
       WHERE user_id = ${input.userId} AND video_slug = ${input.videoSlug}
    `;
    return { videoSlug: input.videoSlug, positionSeconds: rows[0]?.position_seconds ?? null };
  }

  async callerLiveSeats(userId: string): Promise<CallerSeat[]> {
    const rows = await this.sql<Array<{ session_id: string; room_id: string; role: CallerSeat['role'] }>>`
      SELECT a.session_id, s.room_id, a.role
        FROM academy.session_attendees a
        JOIN academy.sessions s ON s.id = a.session_id
       WHERE a.user_id = ${userId} AND a.left_at IS NULL
       ORDER BY a.joined_at DESC
    `;
    return rows.map((r) => ({ sessionId: r.session_id, roomId: r.room_id, role: r.role }));
  }

  async myUpcomingSessions(input: { userId: string; limit: number | null | undefined }): Promise<UpcomingSession[]> {
    const limit = assertCustomerListLimit(input.limit, 'academy.my_upcoming_sessions_list_limit_unset', 'Upcoming sessions');
    const rows = await this.sql<
      Array<{
        id: string;
        room_id: string;
        title: string;
        host_id: string;
        status: UpcomingSession['status'];
        starts_at: Date;
        ends_at: Date | null;
        stream_provider: string | null;
        scene: unknown;
        role: CallerSeat['role'];
      }>
    >`
      SELECT s.id, s.room_id, s.title, s.host_id, s.status, s.starts_at, s.ends_at, s.stream_provider, s.scene, a.role
        FROM academy.sessions s
        JOIN academy.session_attendees a
          ON a.session_id = s.id AND a.user_id = ${input.userId} AND a.left_at IS NULL
       WHERE s.status IN ('scheduled', 'live')
       ORDER BY s.starts_at ASC, s.id ASC
       LIMIT ${limit}
    `;
    return rows.map((r) => {
      const scene = sceneOf(r.scene);
      return {
        id: r.id,
        roomId: r.room_id,
        title: r.title,
        hostId: r.host_id,
        status: r.status,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        streamProvider: r.stream_provider,
        scene: scene.scene,
        sceneFingerprint: scene.sceneFingerprint,
        seated: true as const,
        role: r.role,
      };
    });
  }

  async sessionCalendar(input: { userId: string; sessionId: string; now?: Date }): Promise<string> {
    const rows = await this.sql<Array<{ id: string; title: string; starts_at: Date; ends_at: Date | null }>>`
      SELECT s.id, s.title, s.starts_at, s.ends_at
        FROM academy.sessions s
        JOIN academy.session_attendees a
          ON a.session_id = s.id AND a.user_id = ${input.userId} AND a.left_at IS NULL
       WHERE s.id = ${input.sessionId}
    `;
    const row = rows[0];
    if (!row) throw new AcademyError('Session not found', 'academy.session_not_found');
    return sessionCalendarText({
      sessionId: row.id,
      title: row.title,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      ...(input.now ? { now: input.now } : {}),
    });
  }

  async grantAudit(input: {
    limit: number | null | undefined;
    cursor?: string | null;
    certificateId?: string | null;
  }): Promise<GrantAuditPage> {
    const limit = assertCustomerListLimit(input.limit, 'academy.grant_audit_list_limit_unset', 'Grant audit');
    const cursor = input.cursor ? decodeGrantCursor(input.cursor) : null;
    const certificateId = input.certificateId?.trim() || null;
    const rows = cursor
      ? await this.sql<Array<{ user_id: string; cert_id: string; granted_at: Date; idempotency_key: string }>>`
          SELECT user_id, cert_id, granted_at, idempotency_key
            FROM academy.cert_grants
           WHERE (${certificateId}::text IS NULL OR cert_id = ${certificateId})
             AND (granted_at, cert_id, user_id) < (
               ${cursor.at}::timestamptz,
               ${cursor.certId},
               ${cursor.accountId}::uuid
             )
           ORDER BY granted_at DESC, cert_id DESC, user_id DESC
           LIMIT ${limit + 1}
        `
      : await this.sql<Array<{ user_id: string; cert_id: string; granted_at: Date; idempotency_key: string }>>`
          SELECT user_id, cert_id, granted_at, idempotency_key
            FROM academy.cert_grants
           WHERE (${certificateId}::text IS NULL OR cert_id = ${certificateId})
           ORDER BY granted_at DESC, cert_id DESC, user_id DESC
           LIMIT ${limit + 1}
        `;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        accountId: r.user_id,
        certificateId: r.cert_id,
        grantedAt: r.granted_at,
        status: 'granted' as const,
        reference: r.idempotency_key,
      })),
      nextCursor: rows.length > limit && last ? encodeGrantCursor(last.granted_at, last.cert_id, last.user_id) : null,
    };
  }

  async enrolments(input: { from: string; to: string }): Promise<EnrolmentCounts> {
    const window = utcWindow('enrolments', input.from, input.to);
    const rows = await this.sql<Array<{ path_slug: string; n: number }>>`
      SELECT path_slug, COUNT(*)::int AS n
        FROM academy.cert_enrollments
       WHERE enrolled_at >= ${window.start} AND enrolled_at < ${window.endExclusive}
       GROUP BY path_slug
       ORDER BY path_slug
    `;
    const paths = rows.map((row) => ({ pathSlug: row.path_slug, count: row.n }));
    return {
      from: window.fromIso,
      to: window.toIso,
      total: paths.reduce((sum, row) => sum + row.count, 0),
      paths,
    };
  }

  async completionsByItem(input: { from: string; to: string; pathSlug?: string | null }): Promise<CompletionsByItem> {
    const window = utcWindow('completionsByItem', input.from, input.to);
    const requested = input.pathSlug?.trim().toLowerCase() ?? '';
    let path: CurriculumPath | null = null;
    if (requested) {
      if (!(CURRICULUM_PATHS as readonly string[]).includes(requested)) {
        throw new AcademyError(`Path ${requested} is not in the curriculum catalogue`, 'academy.path_not_found');
      }
      path = requested as CurriculumPath;
    }
    const rows = await this.sql<Array<{ item_slug: string; n: number }>>`
      SELECT item_slug, COUNT(*)::int AS n
        FROM academy.cert_item_completions
       WHERE completed_at >= ${window.start} AND completed_at < ${window.endExclusive}
       GROUP BY item_slug
    `;
    const counts = new Map(rows.map((row) => [row.item_slug, row.n]));
    const catalogue = listCurriculum(path ? { path } : {});
    const seen = new Set(catalogue.map((item) => item.slug));
    const items: CompletionsByItem['items'] = catalogue.map((item) => ({
      itemSlug: item.slug,
      pathSlug: item.path,
      count: counts.get(item.slug) ?? 0,
    }));
    if (!path) {
      for (const [slug, count] of counts) {
        if (!seen.has(slug)) items.push({ itemSlug: slug, pathSlug: null, count });
      }
    }
    items.sort((a, b) => {
      const byPath = (a.pathSlug ?? '\uffff').localeCompare(b.pathSlug ?? '\uffff');
      return byPath !== 0 ? byPath : a.itemSlug.localeCompare(b.itemSlug);
    });
    return { from: window.fromIso, to: window.toIso, pathSlug: path, items };
  }

  async opsMetrics(input: { from: string; to: string }): Promise<{ from: string; to: string; days: OpsDay[] }> {
    const window = utcWindow('opsMetrics', input.from, input.to);
    const { start, endExclusive } = window;
    const [lessonRows, completionRows, grantRows] = await Promise.all([
      this.sql<Array<{ day: string; n: number }>>`
        SELECT to_char(touched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
          FROM academy.learning_touches
         WHERE touched_at >= ${start} AND touched_at < ${endExclusive}
         GROUP BY 1
      `,
      this.sql<Array<{ day: string; n: number }>>`
        SELECT to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
          FROM academy.cert_item_completions
         WHERE completed_at >= ${start} AND completed_at < ${endExclusive}
         GROUP BY 1
      `,
      this.sql<Array<{ day: string; n: number }>>`
        SELECT to_char(granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
          FROM academy.cert_grants
         WHERE granted_at >= ${start} AND granted_at < ${endExclusive}
         GROUP BY 1
      `,
    ]);
    const lessons = new Map(lessonRows.map((r) => [r.day, r.n]));
    const completions = new Map(completionRows.map((r) => [r.day, r.n]));
    const grants = new Map(grantRows.map((r) => [r.day, r.n]));
    const days = utcDaysInclusive(window.fromIso, window.toIso).map((date) => ({
      date,
      lessonsRead: metricFromCount(lessons.get(date), true),
      completions: metricFromCount(completions.get(date), true),
      grants: metricFromCount(grants.get(date), true),
    }));
    return { from: window.fromIso, to: window.toIso, days };
  }
}
