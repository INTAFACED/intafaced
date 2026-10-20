import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';

/**
 * Notification persistence — interface + memory + postgres.
 *
 * Tests run against `MemoryNotifyStore` so the suite does not require Postgres.
 * Production boots with `PostgresNotifyStore` against the notify schema.
 */

export type Severity = 'info' | 'action' | 'critical';

export interface Notification {
  id: string;
  userId: string;
  kind: string;
  titleKey: string;
  bodyKey: string;
  params: Record<string, unknown>;
  href: string | null;
  severity: Severity;
  readAt: Date | null;
  sourceSubject: string;
  sourceIdempotencyKey: string;
  createdAt: Date;
}

export interface InsertNotificationInput {
  userId: string;
  kind: string;
  titleKey: string;
  bodyKey: string;
  params?: Record<string, unknown>;
  href?: string | null;
  severity?: Severity;
  sourceSubject: string;
  sourceIdempotencyKey: string;
}

export interface ListQuery {
  userId: string;
  cursor?: string | null;
  limit: number;
  unreadOnly: boolean;
}

export interface ListResult {
  items: Notification[];
  nextCursor: string | null;
}

export interface NotifyStore {
  insert(input: InsertNotificationInput): Promise<{ inserted: boolean; notification: Notification | null }>;
  /**
   * The row a redelivered event would have inserted.
   *
   * Needed because a crash between "inbox row written" and "email sent" must not
   * lose the email: on redelivery the insert is a no-op, and without this the
   * dispatcher would have nothing to fan out. Looking it up by the same natural
   * key the insert deduped on is what makes the two halves independently
   * recoverable — which is the entire reason they are two halves.
   */
  findBySource(userId: string, sourceSubject: string, sourceIdempotencyKey: string): Promise<Notification | null>;
  /** Self-only by construction: the caller's id is part of the query, not a filter applied after. */
  findById(userId: string, id: string): Promise<Notification | null>;
  list(query: ListQuery): Promise<ListResult>;
  unreadCount(userId: string): Promise<number>;
  markRead(userId: string, ids: readonly string[]): Promise<number>;
  markAllRead(userId: string): Promise<number>;
  /**
   * One audience-all notice (a posting freeze). Every user's `list`, `findById`,
   * `unreadCount`, `markRead` and `markAllRead` include it, with a read mark per
   * user, so a platform-wide event is one write and not one write per account.
   * Deduped on `(sourceSubject, sourceIdempotencyKey)`.
   */
  insertSystemNotice(input: SystemNoticeInput): Promise<{ inserted: boolean }>;
}

export type SystemNoticeInput = Omit<InsertNotificationInput, 'userId'>;

function dedupeKey(userId: string, sourceSubject: string, sourceIdempotencyKey: string): string {
  return `${userId}\0${sourceSubject}\0${sourceIdempotencyKey}`;
}

/**
 * In-memory store for unit tests — same dedupe / self-only semantics as Postgres.
 *
 * That sentence is now checked rather than asserted: `store.conformance.test.ts`
 * runs one set of assertions against both engines, memory always and Postgres
 * whenever one is reachable. It was written because the claim had already
 * stopped being true in two branches of `list`, both reachable with a valid UUID.
 */
export class MemoryNotifyStore implements NotifyStore {
  private readonly byId = new Map<string, Notification>();
  private readonly byDedupe = new Map<string, string>();
  private readonly systemNotices = new Map<string, Notification>();
  private readonly systemDedupe = new Set<string>();
  private readonly systemReads = new Map<string, Date>();

  async insertSystemNotice(input: SystemNoticeInput): Promise<{ inserted: boolean }> {
    const key = `${input.sourceSubject}\0${input.sourceIdempotencyKey}`;
    if (this.systemDedupe.has(key)) return { inserted: false };
    this.systemDedupe.add(key);
    const id = randomUUID();
    this.systemNotices.set(id, {
      id,
      userId: '',
      kind: input.kind,
      titleKey: input.titleKey,
      bodyKey: input.bodyKey,
      params: input.params ?? {},
      href: input.href ?? null,
      severity: input.severity ?? 'info',
      readAt: null,
      sourceSubject: input.sourceSubject,
      sourceIdempotencyKey: input.sourceIdempotencyKey,
      createdAt: new Date(),
    });
    return { inserted: true };
  }

  /** The caller's own rows plus every system notice, each carrying the caller's read mark. */
  private inboxRows(userId: string): Notification[] {
    const own = [...this.byId.values()].filter((r) => r.userId === userId);
    const shared = [...this.systemNotices.values()].map((n) => ({
      ...n,
      userId,
      readAt: this.systemReads.get(`${n.id}\0${userId}`) ?? null,
    }));
    return [...own, ...shared];
  }

  async insert(input: InsertNotificationInput): Promise<{ inserted: boolean; notification: Notification | null }> {
    const key = dedupeKey(input.userId, input.sourceSubject, input.sourceIdempotencyKey);
    if (this.byDedupe.has(key)) {
      return { inserted: false, notification: null };
    }
    const row: Notification = {
      id: randomUUID(),
      userId: input.userId,
      kind: input.kind,
      titleKey: input.titleKey,
      bodyKey: input.bodyKey,
      params: input.params ?? {},
      href: input.href ?? null,
      severity: input.severity ?? 'info',
      readAt: null,
      sourceSubject: input.sourceSubject,
      sourceIdempotencyKey: input.sourceIdempotencyKey,
      createdAt: new Date(),
    };
    this.byId.set(row.id, row);
    this.byDedupe.set(key, row.id);
    return { inserted: true, notification: row };
  }

  async findBySource(userId: string, sourceSubject: string, sourceIdempotencyKey: string): Promise<Notification | null> {
    const id = this.byDedupe.get(dedupeKey(userId, sourceSubject, sourceIdempotencyKey));
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async findById(userId: string, id: string): Promise<Notification | null> {
    const row = this.byId.get(id);
    if (row) return row.userId === userId ? row : null;
    return this.inboxRows(userId).find((r) => r.id === id) ?? null;
  }

  async list(query: ListQuery): Promise<ListResult> {
    let rows = this.inboxRows(query.userId);
    if (query.unreadOnly) rows = rows.filter((r) => r.readAt === null);
    // Plain ordinal comparison on the tiebreak, matching `ORDER BY id DESC` on a
    // uuid column. `localeCompare` is locale-dependent, and the filter below has
    // always used `<` — two orderings deciding one page is how a row gets served
    // twice or never.
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

    if (query.cursor) {
      // Looked up WITH the caller's id, and an unresolvable cursor ends the walk
      // — both matching the Postgres engine, which has always done this.
      //
      // Ignoring the cursor instead (the old behaviour) returned PAGE ONE, so a
      // client whose cursor row had been deleted would page forever. And because
      // `byId` is not scoped by user, a foreign notification id sliced the
      // caller's own list at a stranger's timestamp — passing guessed ids and
      // watching the page move answers "does this id exist, and roughly when was
      // it made". The router validates that a cursor is a UUID, not whose it is.
      const cursor = this.inboxRows(query.userId).find((r) => r.id === query.cursor);
      if (!cursor) return { items: [], nextCursor: null };
      rows = rows.filter(
        (r) =>
          r.createdAt.getTime() < cursor.createdAt.getTime() || (r.createdAt.getTime() === cursor.createdAt.getTime() && r.id < cursor.id),
      );
    }

    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null;
    return { items: page, nextCursor };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.inboxRows(userId).filter((r) => r.readAt === null).length;
  }

  async markRead(userId: string, ids: readonly string[]): Promise<number> {
    let n = 0;
    const now = new Date();
    for (const id of ids) {
      if (this.systemNotices.has(id)) {
        const k = `${id}\0${userId}`;
        if (!this.systemReads.has(k)) {
          this.systemReads.set(k, now);
          n += 1;
        }
        continue;
      }
      const row = this.byId.get(id);
      if (!row || row.userId !== userId) continue;
      if (row.readAt === null) {
        row.readAt = now;
        n += 1;
      }
    }
    return n;
  }

  async markAllRead(userId: string): Promise<number> {
    let n = 0;
    const now = new Date();
    for (const row of this.byId.values()) {
      if (row.userId !== userId || row.readAt !== null) continue;
      row.readAt = now;
      n += 1;
    }
    for (const id of this.systemNotices.keys()) {
      const k = `${id}\0${userId}`;
      if (this.systemReads.has(k)) continue;
      this.systemReads.set(k, now);
      n += 1;
    }
    return n;
  }
}

type PgRow = {
  id: string;
  user_id: string;
  kind: string;
  title_key: string;
  body_key: string;
  params: Record<string, unknown> | string | null;
  href: string | null;
  severity: Severity;
  read_at: Date | null;
  source_subject: string;
  source_idempotency_key: string;
  created_at: Date;
};

/** Rows written before the `::text::jsonb` fix hold the object as a JSON string; read both shapes. */
function paramsFromPg(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value ?? {};
}

function fromPg(row: PgRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    titleKey: row.title_key,
    bodyKey: row.body_key,
    params: paramsFromPg(row.params),
    href: row.href,
    severity: row.severity,
    readAt: row.read_at,
    sourceSubject: row.source_subject,
    sourceIdempotencyKey: row.source_idempotency_key,
    createdAt: row.created_at,
  };
}

export class PostgresNotifyStore implements NotifyStore {
  constructor(private readonly sql: Sql) {}

  async insert(input: InsertNotificationInput): Promise<{ inserted: boolean; notification: Notification | null }> {
    // `::text::jsonb`: postgres.js already JSON-encodes a parameter the server types as jsonb, so a bare
    // `::jsonb` stored the string twice (a JSON string, not an object) and notify.list failed output validation.
    const params = JSON.stringify(input.params ?? {});
    const severity = input.severity ?? 'info';
    const href = input.href ?? null;

    const rows = await this.sql<PgRow[]>`
      INSERT INTO notify.notifications (
        user_id, kind, title_key, body_key, params, href, severity,
        source_subject, source_idempotency_key
      ) VALUES (
        ${input.userId},
        ${input.kind},
        ${input.titleKey},
        ${input.bodyKey},
        ${params}::text::jsonb,
        ${href},
        ${severity},
        ${input.sourceSubject},
        ${input.sourceIdempotencyKey}
      )
      ON CONFLICT (user_id, source_subject, source_idempotency_key) DO NOTHING
      RETURNING
        id, user_id, kind, title_key, body_key, params, href, severity,
        read_at, source_subject, source_idempotency_key, created_at
    `;

    if (rows.length === 0) return { inserted: false, notification: null };
    return { inserted: true, notification: fromPg(rows[0]!) };
  }

  async findBySource(userId: string, sourceSubject: string, sourceIdempotencyKey: string): Promise<Notification | null> {
    const rows = await this.sql<PgRow[]>`
      SELECT id, user_id, kind, title_key, body_key, params, href, severity,
             read_at, source_subject, source_idempotency_key, created_at
      FROM notify.notifications
      WHERE user_id = ${userId}
        AND source_subject = ${sourceSubject}
        AND source_idempotency_key = ${sourceIdempotencyKey}
      LIMIT 1
    `;
    return rows[0] ? fromPg(rows[0]) : null;
  }

  /**
   * The caller's inbox: their own rows plus every audience-all system notice, the
   * notice carrying THIS caller's read mark. Same column list as `notifications`,
   * so one `PgRow` shape reads both.
   */
  private inbox(userId: string) {
    return this.sql`
      SELECT id, user_id, kind, title_key, body_key, params, href, severity,
             read_at, source_subject, source_idempotency_key, created_at
        FROM notify.notifications
       WHERE user_id = ${userId}
      UNION ALL
      SELECT s.id, ${userId}::text AS user_id, s.kind, s.title_key, s.body_key, s.params, s.href, s.severity,
             r.read_at, s.source_subject, s.source_idempotency_key, s.created_at
        FROM notify.system_notices s
        LEFT JOIN notify.system_notice_reads r ON r.notice_id = s.id AND r.user_id = ${userId}
    `;
  }

  async insertSystemNotice(input: SystemNoticeInput): Promise<{ inserted: boolean }> {
    const params = JSON.stringify(input.params ?? {});
    const rows = await this.sql<Array<{ id: string }>>`
      INSERT INTO notify.system_notices (
        kind, title_key, body_key, params, href, severity, source_subject, source_idempotency_key
      ) VALUES (
        ${input.kind}, ${input.titleKey}, ${input.bodyKey}, ${params}::text::jsonb,
        ${input.href ?? null}, ${input.severity ?? 'info'}, ${input.sourceSubject}, ${input.sourceIdempotencyKey}
      )
      ON CONFLICT (source_subject, source_idempotency_key) DO NOTHING
      RETURNING id
    `;
    return { inserted: rows.length > 0 };
  }

  async findById(userId: string, id: string): Promise<Notification | null> {
    const rows = await this.sql<PgRow[]>`
      WITH inbox AS (${this.inbox(userId)})
      SELECT * FROM inbox WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ? fromPg(rows[0]) : null;
  }

  async list(query: ListQuery): Promise<ListResult> {
    const limit = query.limit;

    /**
     * THE CURSOR IS COMPARED INSIDE POSTGRES, AND THAT IS THE WHOLE POINT.
     *
     * `timestamptz` keeps MICROseconds; a JS `Date` keeps milliseconds. Reading the
     * cursor row into JS and sending its `created_at` back truncated it, so the
     * keyset step excluded every row inside that millisecond, and a fan-out burst
     * (rows sharing `now()`) paged once and never saw the rest. A scalar subquery
     * keeps the value in the database at full precision. A cursor naming a row the
     * caller's inbox does not hold makes the subquery empty, the comparison NULL,
     * and the page empty.
     *
     * The inbox CTE is the caller's own rows plus the audience-all notices, so a
     * cursor on a system notice pages the same way.
     */
    const unread = query.unreadOnly ? this.sql`AND read_at IS NULL` : this.sql``;
    const after = query.cursor
      ? this.sql`AND (created_at, id) < (SELECT created_at, id FROM inbox WHERE id = ${query.cursor})`
      : this.sql``;
    const rows = await this.sql<PgRow[]>`
      WITH inbox AS (${this.inbox(query.userId)})
      SELECT id, user_id, kind, title_key, body_key, params, href, severity,
             read_at, source_subject, source_idempotency_key, created_at
        FROM inbox
       WHERE true ${unread} ${after}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(fromPg);
    return { items: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
  }

  async unreadCount(userId: string): Promise<number> {
    const rows = await this.sql<Array<{ n: string }>>`
      WITH inbox AS (${this.inbox(userId)})
      SELECT count(*)::text AS n FROM inbox WHERE read_at IS NULL
    `;
    return Number(rows[0]?.n ?? 0);
  }

  async markRead(userId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const list = ids as unknown as string[];
    // Self-only: the WHERE binds user_id so another principal's ids are no-ops.
    const own = await this.sql<Array<{ id: string }>>`
      UPDATE notify.notifications
      SET read_at = now()
      WHERE user_id = ${userId}
        AND id = ANY(${list}::uuid[])
        AND read_at IS NULL
      RETURNING id
    `;
    // A system notice is read per user: one mark, never a change to the shared row.
    const shared = await this.sql<Array<{ notice_id: string }>>`
      INSERT INTO notify.system_notice_reads (notice_id, user_id)
      SELECT id, ${userId} FROM notify.system_notices WHERE id = ANY(${list}::uuid[])
      ON CONFLICT (notice_id, user_id) DO NOTHING
      RETURNING notice_id
    `;
    return own.length + shared.length;
  }

  async markAllRead(userId: string): Promise<number> {
    const own = await this.sql<Array<{ id: string }>>`
      UPDATE notify.notifications
      SET read_at = now()
      WHERE user_id = ${userId}
        AND read_at IS NULL
      RETURNING id
    `;
    const shared = await this.sql<Array<{ notice_id: string }>>`
      INSERT INTO notify.system_notice_reads (notice_id, user_id)
      SELECT id, ${userId} FROM notify.system_notices
      ON CONFLICT (notice_id, user_id) DO NOTHING
      RETURNING notice_id
    `;
    return own.length + shared.length;
  }
}
