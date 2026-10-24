import type { Sql, TransactionSql } from 'postgres';
import { BANNER_CONFLICT, windowsOverlap, type Announcement, type AnnouncementAction } from '@intafaced/contracts';
import { OpsError } from '../codes.js';

/**
 * An announcement as stored: the wire shape, the business key it was saved under, and the start the founder asked for.
 * `startsAt` is when it shows from: a published window never starts before it was published.
 */
export interface StoredAnnouncement extends Announcement {
  readonly key: string;
  readonly requestedStartsAt: string;
}

export interface AnnouncementLogEntry {
  readonly op: 'save' | 'publish' | 'withdraw';
  readonly outcome: 'created' | 'changed' | 'noop';
  readonly actorId: string;
  readonly at: string;
}

export type AnnouncementPatch =
  | { readonly status: 'published'; readonly by: string; readonly at: string; readonly startsAt: string }
  | { readonly status: 'withdrawn'; readonly by: string; readonly at: string };

/** The announcements inside one change: no other change runs until this one returns. */
export interface LockedAnnouncements {
  byKey(key: string): Promise<StoredAnnouncement | null>;
  byId(id: string): Promise<StoredAnnouncement | null>;
  /** Published announcements whose window overlaps this one, other than `exceptId`. */
  publishedOverlapping(window: Pick<Announcement, 'startsAt' | 'endsAt'>, exceptId: string | null): Promise<Announcement[]>;
  insert(row: StoredAnnouncement, log: AnnouncementLogEntry): Promise<void>;
  update(id: string, patch: AnnouncementPatch, log: AnnouncementLogEntry): Promise<StoredAnnouncement>;
  /** A no-op is logged too, so the log shows every attempt. */
  logNoop(id: string, statusAfter: Announcement['status'], log: AnnouncementLogEntry): Promise<void>;
}

export interface AnnouncementStore {
  /** Newest first. */
  list(limit: number): Promise<Announcement[]>;
  /** The published announcement whose window is open at `at`: at most one, by construction. */
  activeAt(at: string): Promise<Announcement | null>;
  change<T>(fn: (locked: LockedAnnouncements) => Promise<T>): Promise<T>;
}

export const strip = ({ key: _key, requestedStartsAt: _asked, ...a }: StoredAnnouncement): Announcement => a;

const applyPatch = (row: StoredAnnouncement, patch: AnnouncementPatch): StoredAnnouncement =>
  patch.status === 'published'
    ? { ...row, status: 'published', startsAt: patch.startsAt, publishedBy: patch.by, publishedAt: patch.at }
    : { ...row, status: 'withdrawn', withdrawnBy: patch.by, withdrawnAt: patch.at };

const conflict = (other: Pick<Announcement, 'id' | 'startsAt' | 'endsAt'> | null) =>
  new OpsError(
    BANNER_CONFLICT,
    other
      ? `announcement ${other.id} is published for ${other.startsAt} to ${other.endsAt}, which overlaps this window: only one shows at a time`
      : 'another published announcement overlaps this window: only one shows at a time',
  );

export class MemoryAnnouncementStore implements AnnouncementStore {
  private readonly rows: StoredAnnouncement[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  readonly log: (AnnouncementLogEntry & { id: string })[] = [];

  async list(limit: number): Promise<Announcement[]> {
    return [...this.rows]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(strip);
  }

  async activeAt(at: string): Promise<Announcement | null> {
    const now = Date.parse(at);
    const row = this.rows.find((r) => r.status === 'published' && Date.parse(r.startsAt) <= now && now < Date.parse(r.endsAt));
    return row ? strip(row) : null;
  }

  change<T>(fn: (locked: LockedAnnouncements) => Promise<T>): Promise<T> {
    const locked: LockedAnnouncements = {
      byKey: async (key) => this.rows.find((r) => r.key === key) ?? null,
      byId: async (id) => this.rows.find((r) => r.id === id) ?? null,
      publishedOverlapping: async (window, exceptId) =>
        this.rows.filter((r) => r.status === 'published' && r.id !== exceptId && windowsOverlap(r, window)).map(strip),
      insert: async (row, log) => {
        // The same guard the exclusion constraint gives the SQL store.
        if (row.status === 'published' && this.rows.some((r) => r.status === 'published' && windowsOverlap(r, row))) throw conflict(null);
        this.rows.push(row);
        this.log.push({ ...log, id: row.id });
      },
      update: async (id, patch, log) => {
        const i = this.rows.findIndex((r) => r.id === id);
        const next = applyPatch(this.rows[i]!, patch);
        if (next.status === 'published' && this.rows.some((r) => r.id !== id && r.status === 'published' && windowsOverlap(r, next)))
          throw conflict(null);
        this.rows[i] = next;
        this.log.push({ ...log, id });
        return next;
      },
      logNoop: async (id, _statusAfter, log) => {
        this.log.push({ ...log, id });
      },
    };
    const run = this.queue.then(() => fn(locked));
    this.queue = run.catch(() => undefined);
    return run;
  }
}

type Row = {
  id: string;
  key: string;
  kind: Announcement['kind'];
  title: string;
  body: string;
  action: AnnouncementAction;
  requested_starts_at: Date | string;
  starts_at: Date | string;
  ends_at: Date | string;
  status: Announcement['status'];
  created_by: string;
  created_at: Date | string;
  published_by: string | null;
  published_at: Date | string | null;
  withdrawn_by: string | null;
  withdrawn_at: Date | string | null;
};

const at = (v: Date | string) => new Date(v).toISOString();
const atOrNull = (v: Date | string | null) => (v === null ? null : at(v));

const fromRow = (r: Row): StoredAnnouncement => ({
  id: r.id,
  key: r.key,
  kind: r.kind,
  title: r.title,
  body: r.body,
  action: r.action,
  requestedStartsAt: at(r.requested_starts_at),
  startsAt: at(r.starts_at),
  endsAt: at(r.ends_at),
  status: r.status,
  createdBy: r.created_by,
  createdAt: at(r.created_at),
  publishedBy: r.published_by,
  publishedAt: atOrNull(r.published_at),
  withdrawnBy: r.withdrawn_by,
  withdrawnAt: atOrNull(r.withdrawn_at),
});

const COLUMNS =
  'id, key, kind, title, body, action, requested_starts_at, starts_at, ends_at, status, created_by, created_at, published_by, published_at, withdrawn_by, withdrawn_at';

/** The exclusion constraint's refusal (two published windows overlap) is the same typed conflict the desk names. */
const isOverlap = (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23P01';

export class SqlAnnouncementStore implements AnnouncementStore {
  constructor(private readonly sql: Sql) {}

  async list(limit: number): Promise<Announcement[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM ops.console_announcements ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    return rows.map((r) => strip(fromRow(r)));
  }

  async activeAt(when: string): Promise<Announcement | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM ops.console_announcements
      WHERE status = 'published' AND starts_at <= ${when} AND ends_at > ${when}
      ORDER BY starts_at LIMIT 1
    `;
    return rows[0] ? strip(fromRow(rows[0])) : null;
  }

  async change<T>(fn: (locked: LockedAnnouncements) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx: TransactionSql) => {
      // One change at a time: the overlap check and the write see the same published set.
      await tx`SELECT pg_advisory_xact_lock(hashtext('ops.console_announcements'))`;
      const one = async (rows: Row[]) => (rows[0] ? fromRow(rows[0]) : null);
      const log = (id: string, entry: AnnouncementLogEntry, statusAfter: string) => tx`
        INSERT INTO ops.console_announcement_log (announcement_id, op, outcome, status_after, actor_id, logged_at)
        VALUES (${id}, ${entry.op}, ${entry.outcome}, ${statusAfter}, ${entry.actorId}, ${entry.at})
      `;
      return fn({
        byKey: async (key) => one(await tx<Row[]>`SELECT ${tx.unsafe(COLUMNS)} FROM ops.console_announcements WHERE key = ${key}`),
        byId: async (id) => one(await tx<Row[]>`SELECT ${tx.unsafe(COLUMNS)} FROM ops.console_announcements WHERE id = ${id}`),
        publishedOverlapping: async (window, exceptId) => {
          const rows = await tx<Row[]>`
            SELECT ${tx.unsafe(COLUMNS)} FROM ops.console_announcements
            WHERE status = 'published' AND starts_at < ${window.endsAt} AND ends_at > ${window.startsAt}
              AND (${exceptId}::uuid IS NULL OR id <> ${exceptId}::uuid)
            ORDER BY starts_at
          `;
          return rows.map((r) => strip(fromRow(r)));
        },
        insert: async (row, entry) => {
          try {
            await tx`
              INSERT INTO ops.console_announcements
                (id, key, kind, title, body, action, requested_starts_at, starts_at, ends_at, status, created_by, created_at,
                 published_by, published_at)
              VALUES (${row.id}, ${row.key}, ${row.kind}, ${row.title}, ${row.body}, ${tx.json(row.action)}, ${row.requestedStartsAt},
                ${row.startsAt}, ${row.endsAt},
                ${row.status}, ${row.createdBy}, ${row.createdAt}, ${row.publishedBy}, ${row.publishedAt})
            `;
          } catch (err) {
            if (isOverlap(err)) throw conflict(null);
            throw err;
          }
          await log(row.id, entry, row.status);
        },
        update: async (id, patch, entry) => {
          let rows: Row[];
          try {
            rows =
              patch.status === 'published'
                ? await tx<Row[]>`
                    UPDATE ops.console_announcements SET status = 'published', starts_at = ${patch.startsAt}, published_by = ${patch.by},
                      published_at = ${patch.at}
                    WHERE id = ${id} RETURNING ${tx.unsafe(COLUMNS)}
                  `
                : await tx<Row[]>`
                    UPDATE ops.console_announcements SET status = 'withdrawn', withdrawn_by = ${patch.by}, withdrawn_at = ${patch.at}
                    WHERE id = ${id} RETURNING ${tx.unsafe(COLUMNS)}
                  `;
          } catch (err) {
            if (isOverlap(err)) throw conflict(null);
            throw err;
          }
          await log(id, entry, patch.status);
          return fromRow(rows[0]!);
        },
        logNoop: async (id, statusAfter, entry) => {
          await log(id, entry, statusAfter);
        },
      });
    }) as Promise<T>;
  }
}

export { conflict as announcementConflict };
