import { createHash } from 'node:crypto';
import {
  ANNOUNCEMENT_LIST_LIMIT,
  ANNOUNCEMENT_NOT_FOUND,
  ANNOUNCEMENT_STORAGE_UNCONFIGURED,
  ANNOUNCEMENT_WITHDRAWN,
  BANNER_WINDOW_INVALID,
  announcementWindowProblem,
  type Announcement,
  type AnnouncementAction,
  type AnnouncementActive,
  type AnnouncementChangeInput,
  type AnnouncementSaveInput,
  type AnnouncementWriteOutput,
  type AnnouncementsList,
} from '@intafaced/contracts';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError } from '../codes.js';
import { announcementConflict, strip, type AnnouncementStore, type StoredAnnouncement } from './store.js';

export interface AnnouncementDeskDeps {
  readonly store: AnnouncementStore | undefined;
  readonly now: () => string;
}

/** The row id follows from the business key, so a save sent twice can only ever name one row. */
export function announcementIdFor(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const iso = (v: string) => new Date(v).toISOString();

/** The action with its keys in one order: jsonb hands them back reordered. */
const actionText = (action: AnnouncementAction) =>
  JSON.stringify(Object.fromEntries(Object.entries(action).sort(([a], [b]) => a.localeCompare(b))));

/** What a save asked for, in one comparable form: a replay must ask for the same thing (the start the founder typed). */
const asked = (a: Pick<Announcement, 'kind' | 'title' | 'body' | 'action' | 'endsAt'>, startsAt: string) =>
  JSON.stringify([a.kind, a.title, a.body, actionText(a.action), iso(startsAt), iso(a.endsAt)]);

/** A published window shows from when it was published at the earliest, so it never holds time that has already gone. */
const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * The console's announcement banner (OPS-admin-access-08, admin-access-035). A founder saves an announcement as a draft or
 * published at once, and publishes or withdraws it later. Only one shows at a time: publishing one whose window overlaps
 * another published one refuses `ops.banner_conflict` (the store's lock and the table's exclusion constraint hold the same
 * rule). A window that ends before it starts, or (to publish) has already ended, refuses `ops.banner_window_invalid`. A
 * window published with a start already past shows from the moment it was published: an announcement that has ended never
 * blocks a new one over time it can no longer show.
 * No money moves; nothing here reads or writes the posting freeze, an account or svc-notify's public notice board.
 */
export class AnnouncementDesk {
  constructor(private readonly deps: AnnouncementDeskDeps) {}

  private store(): AnnouncementStore {
    if (!this.deps.store)
      throw new OpsError(
        ANNOUNCEMENT_STORAGE_UNCONFIGURED,
        'No durable storage is configured for console announcements, so none can be saved and none shows.',
      );
    return this.deps.store;
  }

  async list(): Promise<AnnouncementsList> {
    const store = this.store();
    const asOf = this.deps.now();
    const [items, active] = await Promise.all([store.list(ANNOUNCEMENT_LIST_LIMIT), store.activeAt(asOf)]);
    return { items, active, asOf };
  }

  async active(): Promise<AnnouncementActive> {
    const asOf = this.deps.now();
    return { active: await this.store().activeAt(asOf), asOf };
  }

  async save(actorId: string, input: AnnouncementSaveInput): Promise<AnnouncementWriteOutput> {
    const now = this.deps.now();
    const content = {
      kind: input.kind,
      title: input.title,
      body: input.body,
      action: input.action,
      startsAt: iso(input.startsAt),
      endsAt: iso(input.endsAt),
    };
    return this.store().change(async (locked) => {
      const stored = await locked.byKey(input.key);
      if (stored) {
        if (asked(stored, stored.requestedStartsAt) !== asked(content, content.startsAt))
          throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'this key was already used for an announcement with other content');
        return { announcement: strip(stored), outcome: 'replayed' as const };
      }
      const problem = announcementWindowProblem(content.startsAt, content.endsAt, now, input.publish);
      if (problem) throw new OpsError(BANNER_WINDOW_INVALID, problem);
      const startsAt = input.publish ? later(content.startsAt, now) : content.startsAt;
      if (input.publish) {
        const [other] = await locked.publishedOverlapping({ startsAt, endsAt: content.endsAt }, null);
        if (other) throw announcementConflict(other);
      }
      const row: StoredAnnouncement = {
        id: announcementIdFor(input.key),
        key: input.key,
        ...content,
        requestedStartsAt: content.startsAt,
        startsAt,
        status: input.publish ? 'published' : 'draft',
        createdBy: actorId,
        createdAt: now,
        publishedBy: input.publish ? actorId : null,
        publishedAt: input.publish ? now : null,
        withdrawnBy: null,
        withdrawnAt: null,
      };
      await locked.insert(row, { op: 'save', outcome: 'created', actorId, at: now });
      return { announcement: strip(row), outcome: 'created' as const };
    });
  }

  /** Publish a draft, or withdraw one (draft or published). Doing either again is a logged no-op. */
  async change(actorId: string, input: AnnouncementChangeInput): Promise<AnnouncementWriteOutput> {
    const now = this.deps.now();
    return this.store().change(async (locked) => {
      const row = await locked.byId(input.id);
      if (!row) throw new OpsError(ANNOUNCEMENT_NOT_FOUND, `no announcement ${input.id}`);
      const entry = { op: input.op, actorId, at: now } as const;
      if (input.op === 'withdraw') {
        if (row.status === 'withdrawn') {
          await locked.logNoop(row.id, row.status, { ...entry, outcome: 'noop' });
          return { announcement: strip(row), outcome: 'noop' as const };
        }
        const next = await locked.update(row.id, { status: 'withdrawn', by: actorId, at: now }, { ...entry, outcome: 'changed' });
        return { announcement: strip(next), outcome: 'changed' as const };
      }
      if (row.status === 'withdrawn')
        throw new OpsError(ANNOUNCEMENT_WITHDRAWN, 'a withdrawn announcement stays withdrawn: write a new one');
      if (row.status === 'published') {
        await locked.logNoop(row.id, row.status, { ...entry, outcome: 'noop' });
        return { announcement: strip(row), outcome: 'noop' as const };
      }
      const problem = announcementWindowProblem(row.startsAt, row.endsAt, now, true);
      if (problem) throw new OpsError(BANNER_WINDOW_INVALID, problem);
      const startsAt = later(row.startsAt, now);
      const [other] = await locked.publishedOverlapping({ startsAt, endsAt: row.endsAt }, row.id);
      if (other) throw announcementConflict(other);
      const next = await locked.update(row.id, { status: 'published', by: actorId, at: now, startsAt }, { ...entry, outcome: 'changed' });
      return { announcement: strip(next), outcome: 'changed' as const };
    });
  }
}
