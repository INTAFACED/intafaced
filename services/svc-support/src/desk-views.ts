/**
 * SP-desk-01 — saved views, filters and sort for the agent queue.
 *
 * Personal and shared caps are owner values. A null cap refuses `support.view_cap_unset` and names the setting.
 * No reference cap (10, 100) is filled in. A save is keyed by owner, view name and the revision it read.
 * That key replays only while its view row still exists. A later delete starts a new key named by the deleted view.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import {
  SUPPORT_VIEW_PERSONAL_CAP_KEY,
  SUPPORT_VIEW_SHARED_CAP_KEY,
  supportTicketCategorySchema,
  type SupportTicket,
  type SupportTicketPriority,
  type SupportTicketType,
  type SupportView,
  type SupportViewSort,
  type SupportWaitingOn,
} from '@intafaced/contracts';
import { ticketQueueScore } from './operator-queue.js';

export const VIEW_CAP_UNSET = 'support.view_cap_unset' as const;
export const VIEW_CAP_REACHED = 'support.view_cap_reached' as const;
export const FILTER_INVALID = 'support.filter_invalid' as const;
export const SORT_INVALID = 'support.sort_invalid' as const;
export const VIEW_NOT_OWNER = 'support.view_not_owner' as const;
export const VIEW_REVISION_STALE = 'support.view_revision_stale' as const;
export const VIEW_CONFLICT = 'support.idempotency_conflict' as const;

/** Transport bound on one filter tree. Not an owner limit and never shown as one. */
const MAX_FILTER_NODES = 32;

const SORT_KEYS = ['created', 'updated', 'subject', 'status', 'priority', 'score'] as const;
const STATUSES = new Set(['open', 'pending', 'on_hold', 'resolved', 'closed']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const TYPES = new Set(['question', 'problem', 'incident']);
const WAITING = new Set(['team', 'customer']);
const CATEGORIES = new Set<string>(supportTicketCategorySchema.options);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const LAYOUT_RE = /^[a-z0-9_-]{1,40}$/;

const PRIORITY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
const STATUS_RANK: Record<string, number> = { open: 0, pending: 1, on_hold: 2, resolved: 3, closed: 4 };

export class ViewError extends Error {
  constructor(
    readonly code: string,
    readonly missingKey?: string,
  ) {
    super(code);
    this.name = 'ViewError';
  }
}

export interface ViewCaps {
  readonly personal: number | null;
  readonly shared: number | null;
}

export interface DeskFact {
  readonly ticket: SupportTicket;
  readonly priority: SupportTicketPriority | null;
  readonly ticketType: SupportTicketType | null;
  readonly labels: readonly string[];
  readonly groupId: string | null;
  readonly waitingOn: SupportWaitingOn | null;
}

export type DeskFilter =
  | { readonly all: readonly DeskFilter[] }
  | { readonly any: readonly DeskFilter[] }
  | { readonly field: string; readonly op: string; readonly value: string | null };

export interface ViewSave {
  readonly viewId?: string;
  readonly name: string;
  readonly ownerId: string;
  readonly expectedRevision: number;
  readonly shared: boolean;
  readonly filter: DeskFilter;
  readonly sort: SupportViewSort | null;
  readonly layout: string | null;
  readonly favourite: boolean;
  readonly reason: string;
  readonly at: string;
}

export interface ViewBook {
  readonly caps: ViewCaps;
  get(viewId: string): Promise<SupportView | null>;
  listVisible(viewerId: string): Promise<SupportView[]>;
  save(input: ViewSave): Promise<SupportView>;
  remove(input: { viewId: string; actorId: string; reason: string; at: string }): Promise<SupportView>;
  /** The view this actor already deleted with this reason, so a retried delete answers like the first one. */
  deleted(input: { viewId: string; actorId: string; reason: string }): Promise<SupportView | null>;
}

export function viewCapWire(cap: number | null, missing: typeof SUPPORT_VIEW_PERSONAL_CAP_KEY | typeof SUPPORT_VIEW_SHARED_CAP_KEY) {
  return cap === null ? { cap: null, missing } : { cap, missing: null };
}

export function parseDeskFilter(raw: unknown): DeskFilter {
  return parseNode(raw, { n: 0 });
}

export function parseDeskSort(raw: unknown): SupportViewSort | null {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ViewError(SORT_INVALID);
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'dir,key') throw new ViewError(SORT_INVALID);
  if (typeof o.key !== 'string' || !(SORT_KEYS as readonly string[]).includes(o.key)) throw new ViewError(SORT_INVALID);
  if (o.dir !== 'asc' && o.dir !== 'desc') throw new ViewError(SORT_INVALID);
  return { key: o.key as SupportViewSort['key'], dir: o.dir };
}

export function parseLayout(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !LAYOUT_RE.test(raw)) throw new ViewError(FILTER_INVALID);
  return raw;
}

export function filterMatches(filter: DeskFilter, fact: DeskFact): boolean {
  if ('all' in filter) return filter.all.every((child) => filterMatches(child, fact));
  if ('any' in filter) return filter.any.some((child) => filterMatches(child, fact));
  return clauseMatches(filter, fact);
}

/** Subject, body and the requester id. Nothing else, and only rows the caller already may see. */
export function searchHits(ticket: SupportTicket, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  return (
    ticket.subject.toLowerCase().includes(needle) ||
    ticket.body.toLowerCase().includes(needle) ||
    ticket.userId.toLowerCase().includes(needle)
  );
}

export function orderFacts(facts: readonly DeskFact[], sort: SupportViewSort | null, now: Date): DeskFact[] {
  return [...facts].sort((a, b) => {
    const primary = sort ? compareOne(a, b, sort, now) : b.ticket.createdAt.localeCompare(a.ticket.createdAt);
    if (primary !== 0) return primary;
    const created = a.ticket.createdAt.localeCompare(b.ticket.createdAt);
    if (created !== 0) return created;
    return a.ticket.id.localeCompare(b.ticket.id);
  });
}

/** `afterViewId` is the deleted view this save follows. The first save of a name omits it. */
export function viewLogKey(ownerId: string, name: string, expectedRevision: number, afterViewId?: string): string {
  const base = `view:${ownerId}:${name}:r${expectedRevision}`;
  return afterViewId === undefined ? base : `${base}:after:${afterViewId}`;
}

function viewDeleteKey(viewId: string, revision: number): string {
  return `view-delete:${viewId}:r${revision}`;
}

export function viewFingerprint(input: Pick<ViewSave, 'shared' | 'filter' | 'sort' | 'layout' | 'favourite' | 'reason'>): string {
  return createHash('sha256')
    .update(
      canonical({
        shared: input.shared,
        filter: input.filter,
        sort: input.sort,
        layout: input.layout,
        favourite: input.favourite,
        reason: input.reason,
      }),
    )
    .digest('hex');
}

function parseNode(raw: unknown, budget: { n: number }): DeskFilter {
  budget.n += 1;
  if (budget.n > MAX_FILTER_NODES) throw new ViewError(FILTER_INVALID);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ViewError(FILTER_INVALID);
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys === 'all' || keys === 'any') {
    const kids = o[keys === 'all' ? 'all' : 'any'];
    if (!Array.isArray(kids)) throw new ViewError(FILTER_INVALID);
    const children = kids.map((kid) => parseNode(kid, budget));
    return keys === 'all' ? { all: children } : { any: children };
  }
  if (keys !== 'field,op,value') throw new ViewError(FILTER_INVALID);
  return parseClause(o);
}

function parseClause(o: Record<string, unknown>): DeskFilter {
  const field = o.field;
  const op = o.op;
  const value = o.value;
  if (typeof field !== 'string' || typeof op !== 'string') throw new ViewError(FILTER_INVALID);
  if (value !== null && typeof value !== 'string') throw new ViewError(FILTER_INVALID);
  const text = value === null ? null : value;
  if (field === 'labels') {
    if (text === null || !LABEL_RE.test(text) || (op !== 'eq' && op !== 'neq')) throw new ViewError(FILTER_INVALID);
    return { field, op, value: text };
  }
  if (field === 'created' || field === 'updated') {
    if (text === null || !TIME_RE.test(text) || !Number.isFinite(Date.parse(text)) || (op !== 'before' && op !== 'after' && op !== 'eq')) {
      throw new ViewError(FILTER_INVALID);
    }
    return { field, op, value: text };
  }
  if (op !== 'eq' && op !== 'neq') throw new ViewError(FILTER_INVALID);
  if (field === 'status') return enumClause(field, op, text, STATUSES, false);
  if (field === 'category') return enumClause(field, op, text, CATEGORIES, false);
  if (field === 'priority') return enumClause(field, op, text, PRIORITIES, true);
  if (field === 'type') return enumClause(field, op, text, TYPES, true);
  if (field === 'waiting_on') return enumClause(field, op, text, WAITING, true);
  if (field === 'assignee' || field === 'group' || field === 'requester') {
    if (text === null) {
      if (field === 'requester') throw new ViewError(FILTER_INVALID);
      return { field, op, value: null };
    }
    if (!UUID_RE.test(text)) throw new ViewError(FILTER_INVALID);
    return { field, op, value: text.toLowerCase() };
  }
  throw new ViewError(FILTER_INVALID);
}

function enumClause(field: string, op: string, value: string | null, allowed: Set<string>, nullable: boolean): DeskFilter {
  if (value === null) {
    if (!nullable) throw new ViewError(FILTER_INVALID);
    return { field, op, value: null };
  }
  if (!allowed.has(value)) throw new ViewError(FILTER_INVALID);
  return { field, op, value };
}

function clauseMatches(clause: { field: string; op: string; value: string | null }, fact: DeskFact): boolean {
  if (clause.field === 'labels') {
    const has = fact.labels.includes(clause.value ?? '');
    return clause.op === 'eq' ? has : !has;
  }
  const actual = readField(fact, clause.field);
  if (clause.field === 'created' || clause.field === 'updated') {
    const left = Date.parse(actual ?? '');
    const right = Date.parse(clause.value ?? '');
    if (clause.op === 'before') return left < right;
    if (clause.op === 'after') return left > right;
    return left === right;
  }
  const same = norm(actual) === norm(clause.value);
  return clause.op === 'eq' ? same : !same;
}

function readField(fact: DeskFact, field: string): string | null {
  switch (field) {
    case 'status':
      return fact.ticket.status;
    case 'category':
      return fact.ticket.category;
    case 'priority':
      return fact.priority;
    case 'type':
      return fact.ticketType;
    case 'assignee':
      return fact.ticket.assigneeId;
    case 'group':
      return fact.groupId;
    case 'requester':
      return fact.ticket.userId;
    case 'waiting_on':
      return fact.waitingOn;
    case 'created':
      return fact.ticket.createdAt;
    case 'updated':
      return fact.ticket.updatedAt;
    default:
      return null;
  }
}

function norm(value: string | null): string | null {
  return value === null ? null : UUID_RE.test(value) ? value.toLowerCase() : value;
}

function compareOne(a: DeskFact, b: DeskFact, sort: SupportViewSort, now: Date): number {
  if (sort.key === 'score') {
    const delta = ticketQueueScore(a.ticket, now) - ticketQueueScore(b.ticket, now);
    return sort.dir === 'asc' ? delta : -delta;
  }
  if (sort.key === 'subject') {
    const delta = a.ticket.subject.localeCompare(b.ticket.subject);
    return sort.dir === 'asc' ? delta : -delta;
  }
  if (sort.key === 'created' || sort.key === 'updated') {
    const left = sort.key === 'created' ? a.ticket.createdAt : a.ticket.updatedAt;
    const right = sort.key === 'created' ? b.ticket.createdAt : b.ticket.updatedAt;
    const delta = left.localeCompare(right);
    return sort.dir === 'asc' ? delta : -delta;
  }
  const left =
    sort.key === 'status' ? (STATUS_RANK[a.ticket.status] ?? null) : a.priority === null ? null : (PRIORITY_RANK[a.priority] ?? null);
  const right =
    sort.key === 'status' ? (STATUS_RANK[b.ticket.status] ?? null) : b.priority === null ? null : (PRIORITY_RANK[b.priority] ?? null);
  return cmpRank(left, right, sort.dir);
}

function cmpRank(a: number | null, b: number | null, dir: 'asc' | 'desc'): number {
  if (a === null || b === null) {
    if (a === b) return 0;
    return a === null ? 1 : -1;
  }
  return dir === 'asc' ? a - b : b - a;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(o[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

type SaveLog = { readonly viewId: string; readonly fingerprint: string; readonly after: SupportView };

type StoredLog = { readonly action: 'save' | 'delete'; readonly fingerprint: string; readonly after: SupportView };

/** `live` still has its row. `deleted` has a later delete log and no row. `absent` has neither. */
type SavedViewState = 'live' | 'deleted' | 'absent';

/**
 * Walk past save keys whose view was deleted. The next key names that view id, so a replay of the
 * new create hits the same row and a different payload still conflicts.
 */
async function resolveSaveKey(
  ownerId: string,
  name: string,
  expectedRevision: number,
  readSave: (key: string) => Promise<SaveLog | undefined>,
  stateOf: (viewId: string) => Promise<SavedViewState>,
): Promise<{ readonly key: string; readonly log: SaveLog | undefined; readonly rowPresent: boolean }> {
  let afterViewId: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const key = viewLogKey(ownerId, name, expectedRevision, afterViewId);
    const log = await readSave(key);
    if (!log) return { key, log: undefined, rowPresent: false };
    if (seen.has(log.viewId)) throw new ViewError(VIEW_CONFLICT);
    seen.add(log.viewId);
    const state = await stateOf(log.viewId);
    if (state === 'deleted') {
      afterViewId = log.viewId;
      continue;
    }
    return { key, log, rowPresent: state === 'live' };
  }
}

/** Replay only while this key's view row remains and the fingerprint matches. A missing row with no delete is a conflict. */
function replayLoggedSave(log: SaveLog | undefined, rowPresent: boolean, fingerprint: string): SupportView | undefined {
  if (!log) return undefined;
  if (!rowPresent || log.fingerprint !== fingerprint) throw new ViewError(VIEW_CONFLICT);
  return log.after;
}

function viewDeleteFingerprint(viewId: string, reason: string): string {
  return createHash('sha256')
    .update(canonical({ id: viewId, reason }))
    .digest('hex');
}

function assertCap(caps: ViewCaps, input: ViewSave, views: readonly SupportView[], current: SupportView | undefined): void {
  const cap = input.shared ? caps.shared : caps.personal;
  const missing = input.shared ? SUPPORT_VIEW_SHARED_CAP_KEY : SUPPORT_VIEW_PERSONAL_CAP_KEY;
  if (cap === null) throw new ViewError(VIEW_CAP_UNSET, missing);
  const slotChanges = !current || current.shared !== input.shared;
  if (!slotChanges) return;
  const used = views.filter(
    (view) => view.id !== current?.id && view.shared === input.shared && (input.shared || view.ownerId === input.ownerId),
  ).length;
  if (used >= cap) throw new ViewError(VIEW_CAP_REACHED);
}

export class MemoryViewBook implements ViewBook {
  private readonly views = new Map<string, SupportView>();
  private readonly logs = new Map<string, StoredLog>();

  constructor(readonly caps: ViewCaps) {}

  async get(viewId: string): Promise<SupportView | null> {
    return this.views.get(viewId) ?? null;
  }

  async listVisible(viewerId: string): Promise<SupportView[]> {
    return [...this.views.values()]
      .filter((view) => view.shared || view.ownerId === viewerId)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async save(input: ViewSave): Promise<SupportView> {
    const fingerprint = viewFingerprint(input);
    const resolved = await resolveSaveKey(
      input.ownerId,
      input.name,
      input.expectedRevision,
      async (key) => this.readSave(key),
      async (viewId) => this.viewState(viewId),
    );
    const current = input.viewId
      ? this.views.get(input.viewId)
      : [...this.views.values()].find((view) => view.ownerId === input.ownerId && view.name === input.name);
    if (input.viewId && !current) throw new ViewError('support.not_found');
    if (current && current.ownerId !== input.ownerId) throw new ViewError(current.shared ? VIEW_NOT_OWNER : 'support.not_found');
    if (current && current.name !== input.name) throw new ViewError(FILTER_INVALID);
    const replay = replayLoggedSave(resolved.log, resolved.rowPresent, fingerprint);
    if (replay) return replay;
    if (current && current.revision !== input.expectedRevision) throw new ViewError(VIEW_REVISION_STALE);
    if (!current && input.expectedRevision !== 0) throw new ViewError(VIEW_REVISION_STALE);
    assertCap(this.caps, input, [...this.views.values()], current);
    const next: SupportView = {
      id: current?.id ?? randomUUID(),
      name: input.name,
      ownerId: input.ownerId,
      shared: input.shared,
      filter: input.filter,
      sort: input.sort,
      layout: input.layout,
      favourite: input.favourite,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: input.at,
    };
    this.views.set(next.id, next);
    this.logs.set(resolved.key, { action: 'save', fingerprint, after: next });
    return next;
  }

  async remove(input: { viewId: string; actorId: string; reason: string; at: string }): Promise<SupportView> {
    const current = this.views.get(input.viewId);
    if (!current) throw new ViewError('support.not_found');
    if (current.ownerId !== input.actorId) throw new ViewError(current.shared ? VIEW_NOT_OWNER : 'support.not_found');
    this.logs.set(viewDeleteKey(current.id, current.revision), {
      action: 'delete',
      fingerprint: viewDeleteFingerprint(current.id, input.reason),
      after: current,
    });
    this.views.delete(current.id);
    return current;
  }

  async deleted(input: { viewId: string; actorId: string; reason: string }): Promise<SupportView | null> {
    const fingerprint = viewDeleteFingerprint(input.viewId, input.reason);
    for (const log of this.logs.values()) {
      if (
        log.action === 'delete' &&
        log.after.id === input.viewId &&
        log.after.ownerId === input.actorId &&
        log.fingerprint === fingerprint
      ) {
        return log.after;
      }
    }
    return null;
  }

  private readSave(key: string): SaveLog | undefined {
    const hit = this.logs.get(key);
    if (!hit || hit.action !== 'save') return undefined;
    return { viewId: hit.after.id, fingerprint: hit.fingerprint, after: hit.after };
  }

  private viewState(viewId: string): SavedViewState {
    if (this.views.has(viewId)) return 'live';
    for (const log of this.logs.values()) {
      if (log.action === 'delete' && log.after.id === viewId) return 'deleted';
    }
    return 'absent';
  }
}

type PgView = {
  id: string;
  owner_id: string;
  name: string;
  shared: boolean;
  filter: DeskFilter;
  sort: SupportViewSort | null;
  layout: string | null;
  favourite: boolean;
  revision: number;
  updated_at: Date | string;
};

type PgLog = { view_id: string; fingerprint: string; after: SupportView; action: string };

function fromRow(row: PgView): SupportView {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    shared: row.shared,
    filter: parseDeskFilter(row.filter),
    sort: parseDeskSort(row.sort),
    layout: row.layout,
    favourite: row.favourite,
    revision: row.revision,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const VIEW_COLUMNS = `id, owner_id, name, shared, filter, sort, layout, favourite, revision, updated_at`;

export class SqlViewBook implements ViewBook {
  constructor(
    private readonly sql: Sql,
    readonly caps: ViewCaps,
  ) {}

  async get(viewId: string): Promise<SupportView | null> {
    const rows = await this.sql<PgView[]>`SELECT ${this.sql.unsafe(VIEW_COLUMNS)} FROM support.desk_views WHERE id = ${viewId}`;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listVisible(viewerId: string): Promise<SupportView[]> {
    const rows = await this.sql<PgView[]>`
      SELECT ${this.sql.unsafe(VIEW_COLUMNS)} FROM support.desk_views
      WHERE shared OR owner_id = ${viewerId}
      ORDER BY name ASC, id ASC
    `;
    return rows.map(fromRow);
  }

  async save(input: ViewSave): Promise<SupportView> {
    const fingerprint = viewFingerprint(input);
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('support.desk_views'))`;
      const current = await lockedView(tx, input);
      const resolved = await resolveSaveKey(
        input.ownerId,
        input.name,
        input.expectedRevision,
        (key) => readSqlSave(tx, key),
        (viewId) => sqlViewState(tx, viewId),
      );
      const replay = replayLoggedSave(resolved.log, resolved.rowPresent, fingerprint);
      if (replay) return replay;
      if (current && current.revision !== input.expectedRevision) throw new ViewError(VIEW_REVISION_STALE);
      if (!current && input.expectedRevision !== 0) throw new ViewError(VIEW_REVISION_STALE);
      const all = await tx<PgView[]>`SELECT ${tx.unsafe(VIEW_COLUMNS)} FROM support.desk_views`;
      assertCap(this.caps, input, all.map(fromRow), current ? fromRow(current) : undefined);
      const next: SupportView = {
        id: current?.id ?? randomUUID(),
        name: input.name,
        ownerId: input.ownerId,
        shared: input.shared,
        filter: input.filter,
        sort: input.sort,
        layout: input.layout,
        favourite: input.favourite,
        revision: (current?.revision ?? 0) + 1,
        updatedAt: input.at,
      };
      if (!current) {
        await tx`
          INSERT INTO support.desk_views (id, owner_id, name, shared, filter, sort, layout, favourite, revision, updated_by, updated_at)
          VALUES (
            ${next.id}, ${next.ownerId}, ${next.name}, ${next.shared}, ${tx.json(next.filter as never)},
            ${next.sort === null ? null : tx.json(next.sort as never)}, ${next.layout}, ${next.favourite},
            ${next.revision}, ${input.ownerId}, ${input.at}
          )
        `;
      } else {
        await tx`
          UPDATE support.desk_views
          SET shared = ${next.shared}, filter = ${tx.json(next.filter as never)},
              sort = ${next.sort === null ? null : tx.json(next.sort as never)}, layout = ${next.layout},
              favourite = ${next.favourite}, revision = ${next.revision}, updated_by = ${input.ownerId}, updated_at = ${input.at}
          WHERE id = ${next.id}
        `;
      }
      await tx`
        INSERT INTO support.desk_view_log (key, view_id, fingerprint, revision_after, action, after, set_by, reason, set_at)
        VALUES (${resolved.key}, ${next.id}, ${fingerprint}, ${next.revision}, 'save', ${tx.json(next as never)}, ${input.ownerId}, ${input.reason}, ${input.at})
      `;
      return next;
    }) as Promise<SupportView>;
  }

  async remove(input: { viewId: string; actorId: string; reason: string; at: string }): Promise<SupportView> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('support.desk_views'))`;
      const rows = await tx<PgView[]>`SELECT ${tx.unsafe(VIEW_COLUMNS)} FROM support.desk_views WHERE id = ${input.viewId} FOR UPDATE`;
      const current = rows[0];
      if (!current) throw new ViewError('support.not_found');
      if (current.owner_id !== input.actorId) throw new ViewError(current.shared ? VIEW_NOT_OWNER : 'support.not_found');
      const view = fromRow(current);
      const key = viewDeleteKey(view.id, view.revision);
      const fingerprint = viewDeleteFingerprint(view.id, input.reason);
      await tx`
        INSERT INTO support.desk_view_log (key, view_id, fingerprint, revision_after, action, after, set_by, reason, set_at)
        VALUES (${key}, ${view.id}, ${fingerprint}, ${view.revision}, 'delete', ${tx.json(view as never)}, ${input.actorId}, ${input.reason}, ${input.at})
      `;
      await tx`DELETE FROM support.desk_views WHERE id = ${view.id}`;
      return view;
    }) as Promise<SupportView>;
  }

  async deleted(input: { viewId: string; actorId: string; reason: string }): Promise<SupportView | null> {
    const rows = await this.sql<{ after: SupportView }[]>`
      SELECT after FROM support.desk_view_log
      WHERE view_id = ${input.viewId} AND action = 'delete' AND set_by = ${input.actorId}
        AND fingerprint = ${viewDeleteFingerprint(input.viewId, input.reason)}
      ORDER BY set_at DESC LIMIT 1
    `;
    return rows[0]?.after ?? null;
  }
}

async function readSqlSave(tx: TransactionSql, key: string): Promise<SaveLog | undefined> {
  const rows = await tx<PgLog[]>`SELECT view_id, fingerprint, after, action FROM support.desk_view_log WHERE key = ${key}`;
  const row = rows[0];
  if (!row || row.action !== 'save') return undefined;
  return { viewId: row.view_id, fingerprint: row.fingerprint, after: row.after };
}

async function sqlViewState(tx: TransactionSql, viewId: string): Promise<SavedViewState> {
  const live = await tx<{ id: string }[]>`SELECT id FROM support.desk_views WHERE id = ${viewId}`;
  if (live.length > 0) return 'live';
  const deleted = await tx<{ key: string }[]>`
    SELECT key FROM support.desk_view_log WHERE view_id = ${viewId} AND action = 'delete' LIMIT 1
  `;
  return deleted.length > 0 ? 'deleted' : 'absent';
}

async function lockedView(tx: TransactionSql, input: ViewSave): Promise<PgView | undefined> {
  if (input.viewId) {
    const rows = await tx<PgView[]>`SELECT ${tx.unsafe(VIEW_COLUMNS)} FROM support.desk_views WHERE id = ${input.viewId} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new ViewError('support.not_found');
    if (row.owner_id !== input.ownerId) throw new ViewError(row.shared ? VIEW_NOT_OWNER : 'support.not_found');
    if (row.name !== input.name) throw new ViewError(FILTER_INVALID);
    return row;
  }
  const rows = await tx<PgView[]>`
    SELECT ${tx.unsafe(VIEW_COLUMNS)} FROM support.desk_views WHERE owner_id = ${input.ownerId} AND name = ${input.name} FOR UPDATE
  `;
  return rows[0];
}
