import type { Sql } from 'postgres';
import type { ComplianceCase, ComplianceInbox, ComplianceInboxFilter } from '@intafaced/contracts';
import { COMPLIANCE_QUEUE_NAME_TAKEN, OpsError } from '../codes.js';

export interface OutboxEntry {
  readonly event: 'coreOpsComplianceCaseCreated' | 'coreOpsComplianceInboxUpdated';
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface CaseCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface CaseQuery {
  readonly inboxId: string;
  readonly filter: ComplianceInboxFilter;
  /** Read once by the caller, outside any transaction: snooze compares against it. */
  readonly now: string;
  readonly limit: number;
  readonly after?: CaseCursor;
}

export interface CaseGroups {
  readonly green: number;
  readonly yellow: number;
  readonly red: number;
  readonly unset: number;
}

export interface CaseList {
  readonly rows: readonly ComplianceCase[];
  readonly total: number;
  readonly groups: CaseGroups;
}

export interface ComplianceStore {
  /** Stores a definition under its business key. The same key and definition returns the stored inbox; the same name and version with a different definition refuses `compliance.queue_name_taken`. */
  defineInbox(inbox: ComplianceInbox, actor: string): Promise<ComplianceInbox>;
  getInbox(id: string): Promise<ComplianceInbox | null>;
  /** Inboxes the operator is a member of, or owns, in name order, with the favourite flag. */
  inboxesFor(operator: string): Promise<readonly { inbox: ComplianceInbox; favourite: boolean }[]>;
  setFavourite(operator: string, inboxId: string, favourite: boolean, at: string): Promise<void>;
  /** The case id is the business key: a repeat returns the stored case and writes nothing. */
  openCase(c: ComplianceCase, actor: string): Promise<{ case: ComplianceCase; created: boolean }>;
  getCase(id: string): Promise<ComplianceCase | null>;
  list(q: CaseQuery): Promise<CaseList>;
  /** The oldest open, unassigned, awake case of the inbox; null when none. */
  nextUnassigned(inboxId: string, filter: ComplianceInboxFilter, now: string): Promise<ComplianceCase | null>;
  openCount(inboxId: string, now: string): Promise<number>;
}

/** The inbox's own filter and the request's filter both apply. The request's single values win; tags must all be present. */
export function mergeFilter(base: ComplianceInboxFilter, req: ComplianceInboxFilter): ComplianceInboxFilter {
  const tags = [...new Set([...(base.tags ?? []), ...(req.tags ?? [])])];
  return {
    ...base,
    ...Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined)),
    ...(tags.length ? { tags } : {}),
  };
}

const CLOSED = new Set(['cleared', 'rejected', 'partner_cleared']);

export function matchesCase(c: ComplianceCase, inboxId: string, f: ComplianceInboxFilter, now: string): boolean {
  if (c.inboxId !== inboxId) return false;
  if (f.closedOnly ? !CLOSED.has(c.status) : c.status !== 'pending') return false;
  if (f.assignee !== undefined && c.assignee !== f.assignee) return false;
  if (f.unassignedOnly && c.assignee !== null) return false;
  if (!f.includeSnoozed && c.snoozedUntil !== null && Date.parse(c.snoozedUntil) > Date.parse(now)) return false;
  if (f.reviewLevels && (c.reviewLevel === null || !f.reviewLevels.includes(c.reviewLevel))) return false;
  if (f.tags && !f.tags.every((t) => c.tags.includes(t))) return false;
  if (f.createdFrom !== undefined && Date.parse(c.createdAt) < Date.parse(f.createdFrom)) return false;
  if (f.createdTo !== undefined && Date.parse(c.createdAt) > Date.parse(f.createdTo)) return false;
  return true;
}

const newestFirst = (a: ComplianceCase, b: ComplianceCase): number =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const oldestFirst = (a: ComplianceCase, b: ComplianceCase): number => -newestFirst(a, b);

const sameDefinition = (a: ComplianceInbox, b: ComplianceInbox): boolean =>
  a.entityType === b.entityType &&
  a.workflow === b.workflow &&
  JSON.stringify(a.filter) === JSON.stringify(b.filter) &&
  JSON.stringify([...a.members].sort()) === JSON.stringify([...b.members].sort());

const nameTaken = () =>
  new OpsError(
    COMPLIANCE_QUEUE_NAME_TAKEN,
    'A queue with this name and version already exists with a different definition. Use a new version.',
  );

export const isMember = (inbox: ComplianceInbox, operator: string): boolean => inbox.owner === operator || inbox.members.includes(operator);

function groupsOf(rows: readonly ComplianceCase[]): CaseGroups {
  const g = { green: 0, yellow: 0, red: 0, unset: 0 };
  for (const r of rows) g[r.reviewLevel ?? 'unset'] += 1;
  return g;
}

/** For tests that need a store without PostgreSQL. A running service uses the durable store. */
export function createMemoryComplianceStore(outbox?: { enqueue(entry: OutboxEntry): void }): ComplianceStore {
  const inboxes = new Map<string, ComplianceInbox>();
  const favourites = new Set<string>();
  const cases = new Map<string, ComplianceCase>();
  return {
    async defineInbox(inbox, actor) {
      const stored = inboxes.get(inbox.id) ?? [...inboxes.values()].find((i) => i.name === inbox.name && i.version === inbox.version);
      if (stored) {
        if (!sameDefinition(stored, inbox)) throw nameTaken();
        return stored;
      }
      inboxes.set(inbox.id, inbox);
      outbox?.enqueue(inboxEvent(inbox, 'defined', actor, inbox.createdAt));
      return inbox;
    },
    async getInbox(id) {
      return inboxes.get(id) ?? null;
    },
    async inboxesFor(operator) {
      return [...inboxes.values()]
        .filter((i) => isMember(i, operator))
        .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version - b.version)
        .map((inbox) => ({ inbox, favourite: favourites.has(`${operator}|${inbox.id}`) }));
    },
    async setFavourite(operator, inboxId, favourite, at) {
      const key = `${operator}|${inboxId}`;
      if (favourite === favourites.has(key)) return;
      if (favourite) favourites.add(key);
      else favourites.delete(key);
      const inbox = inboxes.get(inboxId);
      if (inbox) outbox?.enqueue(inboxEvent(inbox, favourite ? 'favourited' : 'unfavourited', operator, at));
    },
    async openCase(c) {
      const stored = cases.get(c.id);
      if (stored) return { case: stored, created: false };
      cases.set(c.id, c);
      outbox?.enqueue(caseEvent(c));
      return { case: c, created: true };
    },
    async getCase(id) {
      return cases.get(id) ?? null;
    },
    async list(q) {
      const all = [...cases.values()].filter((c) => matchesCase(c, q.inboxId, q.filter, q.now)).sort(newestFirst);
      const after = q.after;
      const page = after ? all.filter((c) => newestFirst(c, { ...c, createdAt: after.createdAt, id: after.id }) > 0) : all;
      return { rows: page.slice(0, q.limit), total: all.length, groups: groupsOf(all) };
    },
    async nextUnassigned(inboxId, filter, now) {
      const f = { ...filter, unassignedOnly: true };
      return [...cases.values()].filter((c) => matchesCase(c, inboxId, f, now)).sort(oldestFirst)[0] ?? null;
    },
    async openCount(inboxId, now) {
      return [...cases.values()].filter((c) => matchesCase(c, inboxId, {}, now)).length;
    },
  };
}

function inboxEvent(inbox: ComplianceInbox, change: 'defined' | 'favourited' | 'unfavourited', actor: string, at: string): OutboxEntry {
  return {
    event: 'coreOpsComplianceInboxUpdated',
    // A favourite toggles back and forth, so its key carries the time; a definition is keyed by its name and version.
    idempotencyKey:
      change === 'defined' ? `compliance:queue:${inbox.name}:${inbox.version}` : `compliance:inbox:${inbox.id}:${change}:${actor}:${at}`,
    payload: { inboxId: inbox.id, version: inbox.version, change, actor, changedAt: at },
    createdAt: at,
  };
}

function caseEvent(c: ComplianceCase): OutboxEntry {
  return {
    event: 'coreOpsComplianceCaseCreated',
    idempotencyKey: `compliance:case:${c.id}`,
    payload: { caseId: c.id, inboxId: c.inboxId, kind: c.kind, subjectId: c.subjectId, createdAt: c.createdAt },
    createdAt: c.createdAt,
  };
}

interface InboxRow {
  id: string;
  name: string;
  version: number;
  entity_type: ComplianceInbox['entityType'];
  workflow: string;
  filter: ComplianceInboxFilter;
  owner: string;
  members: string[];
  created_at: Date;
}

interface CaseRow {
  id: string;
  name: string;
  kind: ComplianceCase['kind'];
  type: ComplianceCase['type'];
  subject_id: string;
  entity_type: ComplianceCase['entityType'];
  inbox_id: string;
  status: ComplianceCase['status'];
  review_level: ComplianceCase['reviewLevel'];
  assignee: string | null;
  tags: string[];
  snoozed_until: Date | null;
  due_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const toInbox = (r: InboxRow): ComplianceInbox => ({
  id: r.id,
  name: r.name,
  version: r.version,
  entityType: r.entity_type,
  workflow: r.workflow,
  filter: r.filter,
  owner: r.owner,
  members: r.members,
  createdAt: r.created_at.toISOString(),
});

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const toCase = (r: CaseRow): ComplianceCase => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  type: r.type,
  subjectId: r.subject_id,
  entityType: r.entity_type,
  inboxId: r.inbox_id,
  status: r.status,
  reviewLevel: r.review_level,
  assignee: r.assignee,
  tags: r.tags,
  snoozedUntil: iso(r.snoozed_until),
  dueAt: iso(r.due_at),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export function createPgComplianceStore(sql: Sql): ComplianceStore {
  /** The same rules as `matchesCase`, as SQL over the cases of one inbox. */
  const where = (inboxId: string, f: ComplianceInboxFilter, now: string) => sql`
    inbox_id = ${inboxId}
    AND (${f.closedOnly === true}::boolean AND status <> 'pending' OR NOT ${f.closedOnly === true}::boolean AND status = 'pending')
    AND (${f.assignee ?? null}::text IS NULL OR assignee = ${f.assignee ?? null})
    AND (NOT ${f.unassignedOnly === true}::boolean OR assignee IS NULL)
    AND (${f.includeSnoozed === true}::boolean OR snoozed_until IS NULL OR snoozed_until <= ${now}::timestamptz)
    AND (${f.reviewLevels ?? null}::text[] IS NULL OR review_level = ANY(${f.reviewLevels ?? null}::text[]))
    AND (${f.tags ?? null}::text[] IS NULL OR tags @> ${f.tags ?? null}::text[])
    AND (${f.createdFrom ?? null}::timestamptz IS NULL OR created_at >= ${f.createdFrom ?? null}::timestamptz)
    AND (${f.createdTo ?? null}::timestamptz IS NULL OR created_at <= ${f.createdTo ?? null}::timestamptz)`;
  const getInbox = async (id: string): Promise<ComplianceInbox | null> => {
    const [row] = await sql<InboxRow[]>`SELECT * FROM ops.compliance_inboxes WHERE id=${id}`;
    return row ? toInbox(row) : null;
  };
  const enqueue = (tx: Sql, e: OutboxEntry) =>
    tx`INSERT INTO ops.compliance_outbox (event,idempotency_key,payload,created_at)
      VALUES (${e.event},${e.idempotencyKey},${tx.json(e.payload as never)},${e.createdAt})
      ON CONFLICT (idempotency_key) DO NOTHING`;
  return {
    getInbox,
    async defineInbox(inbox, actor) {
      return sql.begin(async (tx) => {
        const [prior] = await tx<
          InboxRow[]
        >`SELECT * FROM ops.compliance_inboxes WHERE name=${inbox.name} AND version=${inbox.version} FOR UPDATE`;
        if (prior) {
          const stored = toInbox(prior);
          if (!sameDefinition(stored, inbox)) throw nameTaken();
          return stored;
        }
        await tx`INSERT INTO ops.compliance_inboxes (id,name,version,entity_type,workflow,filter,owner,members,created_at)
          VALUES (${inbox.id},${inbox.name},${inbox.version},${inbox.entityType},${inbox.workflow},${tx.json(inbox.filter as never)},
          ${inbox.owner},${inbox.members as string[]},${inbox.createdAt})
          ON CONFLICT (name, version) DO NOTHING`;
        // A racing define of the same key committed between the read and the insert: answer with the stored row.
        const [row] = await tx<InboxRow[]>`SELECT * FROM ops.compliance_inboxes WHERE name=${inbox.name} AND version=${inbox.version}`;
        const stored = toInbox(row as InboxRow);
        if (!sameDefinition(stored, inbox)) throw nameTaken();
        await enqueue(tx as unknown as Sql, inboxEvent(stored, 'defined', actor, stored.createdAt));
        return stored;
      });
    },
    async inboxesFor(operator) {
      const rows = await sql<(InboxRow & { favourite: boolean })[]>`SELECT i.*, (f.operator IS NOT NULL) AS favourite
        FROM ops.compliance_inboxes i
        LEFT JOIN ops.compliance_inbox_favourites f ON f.inbox_id = i.id AND f.operator = ${operator}
        WHERE i.owner = ${operator} OR ${operator} = ANY(i.members)
        ORDER BY i.name, i.version`;
      return rows.map((r) => ({ inbox: toInbox(r), favourite: r.favourite }));
    },
    async setFavourite(operator, inboxId, favourite, at) {
      await sql.begin(async (tx) => {
        const changed = favourite
          ? await tx`INSERT INTO ops.compliance_inbox_favourites (operator,inbox_id) VALUES (${operator},${inboxId}) ON CONFLICT DO NOTHING`
          : await tx`DELETE FROM ops.compliance_inbox_favourites WHERE operator=${operator} AND inbox_id=${inboxId}`;
        if (changed.count === 0) return;
        const [row] = await tx<InboxRow[]>`SELECT * FROM ops.compliance_inboxes WHERE id=${inboxId}`;
        if (row) await enqueue(tx as unknown as Sql, inboxEvent(toInbox(row), favourite ? 'favourited' : 'unfavourited', operator, at));
      });
    },
    async openCase(c, actor) {
      return sql.begin(async (tx) => {
        const inserted =
          await tx`INSERT INTO ops.compliance_cases (id,name,kind,type,subject_id,entity_type,inbox_id,status,review_level,assignee,tags,
          snoozed_until,due_at,created_at,updated_at)
          VALUES (${c.id},${c.name},${c.kind},${c.type},${c.subjectId},${c.entityType},${c.inboxId},${c.status},${c.reviewLevel},${c.assignee},
          ${c.tags as string[]},${c.snoozedUntil},${c.dueAt},${c.createdAt},${c.updatedAt})
          ON CONFLICT (id) DO NOTHING`;
        if (inserted.count === 0) {
          const [row] = await tx<CaseRow[]>`SELECT * FROM ops.compliance_cases WHERE id=${c.id}`;
          return { case: toCase(row as CaseRow), created: false };
        }
        await tx`INSERT INTO ops.compliance_case_events (case_id,seq,action,actor,detail,at)
          VALUES (${c.id},1,'opened',${actor},${tx.json({ kind: c.kind, inboxId: c.inboxId } as never)},${c.createdAt})`;
        await enqueue(tx as unknown as Sql, caseEvent(c));
        return { case: c, created: true };
      });
    },
    async getCase(id) {
      const [row] = await sql<CaseRow[]>`SELECT * FROM ops.compliance_cases WHERE id=${id}`;
      return row ? toCase(row) : null;
    },
    async list(q) {
      const w = where(q.inboxId, q.filter, q.now);
      const after = q.after;
      const rows = await sql<CaseRow[]>`SELECT * FROM ops.compliance_cases WHERE ${w}
        AND (${after?.createdAt ?? null}::timestamptz IS NULL OR (created_at, id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? ''}))
        ORDER BY created_at DESC, id DESC LIMIT ${q.limit}`;
      const [count] = await sql<{ total: string; green: string; yellow: string; red: string; unset: string }[]>`SELECT count(*) AS total,
        count(*) FILTER (WHERE review_level='green') AS green, count(*) FILTER (WHERE review_level='yellow') AS yellow,
        count(*) FILTER (WHERE review_level='red') AS red, count(*) FILTER (WHERE review_level IS NULL) AS unset
        FROM ops.compliance_cases WHERE ${w}`;
      const c = count as NonNullable<typeof count>;
      return {
        rows: rows.map(toCase),
        total: Number(c.total),
        groups: { green: Number(c.green), yellow: Number(c.yellow), red: Number(c.red), unset: Number(c.unset) },
      };
    },
    async nextUnassigned(inboxId, filter, now) {
      const w = where(inboxId, { ...filter, unassignedOnly: true }, now);
      const [row] = await sql<CaseRow[]>`SELECT * FROM ops.compliance_cases WHERE ${w} ORDER BY created_at ASC, id ASC LIMIT 1`;
      return row ? toCase(row) : null;
    },
    async openCount(inboxId, now) {
      const [row] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM ops.compliance_cases WHERE ${where(inboxId, {}, now)}`;
      return Number(row?.n ?? 0);
    },
  };
}
