import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  INCIDENT_ALREADY_RESOLVED,
  INCIDENT_ASSIGNEE_NOT_PARTICIPANT,
  INCIDENT_NOT_FOUND,
  INCIDENT_REQUEST_KEY_REUSED,
  type Incident,
  type IncidentDetail,
  type IncidentMetrics,
  type IncidentSeverity,
  type IncidentTimelineEntry,
} from '@intafaced/contracts';
import { isModuleId, type ModuleId } from '@intafaced/config';
import { OpsError } from '../codes.js';

/**
 * Staff incidents in Postgres (OPS-oncall-02). Every read and change is as one viewer: a private incident exists only for its
 * participants, so anyone else gets `ops.incident_not_found` and never sees it listed or counted.
 *
 * Every change is keyed by the console's request key. The same key with the same body is the same request: its reply is read
 * back and nothing is applied again. The same key with another body refuses `ops.incident_request_key_reused`.
 */

export interface DeclareValues {
  readonly requestKey: string;
  readonly title: string;
  readonly module: ModuleId | null;
  readonly severity: IncidentSeverity;
  readonly private: boolean;
}

export type IncidentChange =
  | { readonly kind: 'note'; readonly body: string }
  | { readonly kind: 'participant'; readonly userId: string }
  | { readonly kind: 'task'; readonly title: string; readonly assigneeId: string }
  | { readonly kind: 'resolved' };

export interface IncidentStore {
  declare(values: DeclareValues, actorId: string, at: string): Promise<IncidentDetail>;
  list(viewerId: string, filter: { status?: Incident['status']; module?: ModuleId; limit: number }): Promise<Incident[]>;
  /** Null when there is no such incident or the viewer may not see it. */
  get(viewerId: string, incidentId: string, at: string): Promise<IncidentDetail | null>;
  change(viewerId: string, incidentId: string, requestKey: string, change: IncidentChange, at: string): Promise<IncidentDetail>;
  metrics(viewerId: string, at: string): Promise<IncidentMetrics>;
}

type IncidentRow = {
  id: string;
  number: string | number;
  title: string;
  module: string | null;
  severity: IncidentSeverity;
  status: Incident['status'];
  private: boolean;
  declared_by: string;
  started_at: Date | string;
  ended_at: Date | string | null;
};

const isoOf = (v: Date | string) => new Date(v).toISOString();

const incidentOf = (r: IncidentRow): Incident => ({
  id: r.id,
  number: Number(r.number),
  title: r.title,
  module: r.module !== null && isModuleId(r.module) ? r.module : null,
  severity: r.severity,
  status: r.status,
  private: r.private,
  declaredBy: r.declared_by,
  startedAt: isoOf(r.started_at),
  endedAt: r.ended_at === null ? null : isoOf(r.ended_at),
});

const hashOf = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

const notFound = (incidentId: string) => new OpsError(INCIDENT_NOT_FOUND, `no incident ${incidentId} that you can see`);

const COLUMNS = 'id, number, title, module, severity, status, private, declared_by, started_at, ended_at';

/** Rows the viewer may see: every incident that is not private, and private ones they take part in. */
const VISIBLE = `(NOT i.private OR EXISTS (SELECT 1 FROM ops.incident_participants p WHERE p.incident_id = i.id AND p.user_id = $1))`;

export class SqlIncidentStore implements IncidentStore {
  constructor(private readonly sql: Sql) {}

  async declare(values: DeclareValues, actorId: string, at: string): Promise<IncidentDetail> {
    const hash = hashOf(values);
    const id = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.incidents:declare:${values.requestKey}`}))`;
      const prior = await tx<{ id: string; request_hash: string }[]>`
        SELECT i.id, t.request_hash FROM ops.incidents i
        JOIN ops.incident_timeline t ON t.incident_id = i.id AND t.kind = 'declared'
        WHERE i.declare_key = ${values.requestKey}`;
      if (prior[0]) {
        if (prior[0].request_hash !== hash)
          throw new OpsError(INCIDENT_REQUEST_KEY_REUSED, 'this request key declared a different incident; nothing was changed');
        return prior[0].id;
      }
      const incidentId = randomUUID();
      await tx`
        INSERT INTO ops.incidents (id, title, module, severity, status, private, declared_by, declare_key, started_at)
        VALUES (${incidentId}, ${values.title}, ${values.module}, ${values.severity}, 'active', ${values.private}, ${actorId},
          ${values.requestKey}, ${at})`;
      await tx`INSERT INTO ops.incident_participants (incident_id, user_id, added_by, added_at) VALUES (${incidentId}, ${actorId}, ${actorId}, ${at})`;
      await tx`
        INSERT INTO ops.incident_timeline (id, incident_id, kind, body, actor_id, at, request_key, request_hash)
        VALUES (${randomUUID()}, ${incidentId}, 'declared', ${`Declared: ${values.title} (severity ${values.severity})`}, ${actorId}, ${at},
          ${values.requestKey}, ${hash})`;
      return incidentId;
    });
    const detail = await this.get(actorId, id as string, at);
    if (!detail) throw notFound(id as string);
    return detail;
  }

  async list(viewerId: string, filter: { status?: Incident['status']; module?: ModuleId; limit: number }): Promise<Incident[]> {
    const rows = await this.sql.unsafe<IncidentRow[]>(
      `SELECT ${COLUMNS} FROM ops.incidents i WHERE ${VISIBLE}
         AND ($2::text IS NULL OR i.status = $2) AND ($3::text IS NULL OR i.module = $3)
       ORDER BY i.number DESC LIMIT $4`,
      [viewerId, filter.status ?? null, filter.module ?? null, filter.limit],
    );
    return rows.map(incidentOf);
  }

  async get(viewerId: string, incidentId: string, at: string): Promise<IncidentDetail | null> {
    const rows = await this.sql.unsafe<IncidentRow[]>(`SELECT ${COLUMNS} FROM ops.incidents i WHERE i.id = $2 AND ${VISIBLE}`, [
      viewerId,
      incidentId,
    ]);
    if (!rows[0]) return null;
    const [participants, timeline, tasks] = await Promise.all([
      this.sql<{ user_id: string; added_by: string; added_at: Date }[]>`
        SELECT user_id, added_by, added_at FROM ops.incident_participants WHERE incident_id = ${incidentId} ORDER BY added_at, user_id`,
      this.sql<{ id: string; kind: IncidentTimelineEntry['kind']; body: string; actor_id: string; at: Date }[]>`
        SELECT id, kind, body, actor_id, at FROM ops.incident_timeline WHERE incident_id = ${incidentId} ORDER BY at, id`,
      this.sql<{ id: string; title: string; assignee_id: string; status: 'open' | 'done'; created_by: string; created_at: Date }[]>`
        SELECT id, title, assignee_id, status, created_by, created_at FROM ops.incident_tasks WHERE incident_id = ${incidentId}
        ORDER BY created_at, id`,
    ]);
    return {
      incident: incidentOf(rows[0]),
      participants: participants.map((p) => ({ userId: p.user_id, addedBy: p.added_by, addedAt: isoOf(p.added_at) })),
      timeline: timeline.map((t) => ({ id: t.id, kind: t.kind, body: t.body, actorId: t.actor_id, at: isoOf(t.at) })),
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        assigneeId: t.assignee_id,
        status: t.status,
        createdBy: t.created_by,
        createdAt: isoOf(t.created_at),
      })),
      asOf: at,
    };
  }

  async change(viewerId: string, incidentId: string, requestKey: string, change: IncidentChange, at: string): Promise<IncidentDetail> {
    const hash = hashOf(change);
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.incidents:${incidentId}`}))`;
      const seen = await tx.unsafe<IncidentRow[]>(`SELECT ${COLUMNS} FROM ops.incidents i WHERE i.id = $2 AND ${VISIBLE}`, [
        viewerId,
        incidentId,
      ]);
      const incident = seen[0];
      if (!incident) throw notFound(incidentId);
      const prior = await tx<{ request_hash: string }[]>`
        SELECT request_hash FROM ops.incident_timeline WHERE incident_id = ${incidentId} AND request_key = ${requestKey}`;
      if (prior[0]) {
        if (prior[0].request_hash !== hash)
          throw new OpsError(INCIDENT_REQUEST_KEY_REUSED, 'this request key made a different change; nothing was changed');
        return;
      }
      let body: string;
      switch (change.kind) {
        case 'note':
          body = change.body;
          break;
        case 'participant':
          await tx`
            INSERT INTO ops.incident_participants (incident_id, user_id, added_by, added_at)
            VALUES (${incidentId}, ${change.userId}, ${viewerId}, ${at}) ON CONFLICT DO NOTHING`;
          body = `Invited ${change.userId}`;
          break;
        case 'task': {
          const member = await tx`
            SELECT 1 FROM ops.incident_participants WHERE incident_id = ${incidentId} AND user_id = ${change.assigneeId}`;
          if (!member.length)
            throw new OpsError(
              INCIDENT_ASSIGNEE_NOT_PARTICIPANT,
              `${change.assigneeId} does not take part in this incident: invite them first, then give them the task`,
            );
          await tx`
            INSERT INTO ops.incident_tasks (id, incident_id, title, assignee_id, status, created_by, created_at)
            VALUES (${randomUUID()}, ${incidentId}, ${change.title}, ${change.assigneeId}, 'open', ${viewerId}, ${at})`;
          body = `Task for ${change.assigneeId}: ${change.title}`;
          break;
        }
        case 'resolved':
          if (incident.status === 'resolved')
            throw new OpsError(INCIDENT_ALREADY_RESOLVED, `incident ${incident.number} was resolved at ${isoOf(incident.ended_at!)}`);
          await tx`UPDATE ops.incidents SET status = 'resolved', ended_at = ${at} WHERE id = ${incidentId}`;
          body = 'Resolved';
          break;
      }
      await tx`
        INSERT INTO ops.incident_timeline (id, incident_id, kind, body, actor_id, at, request_key, request_hash)
        VALUES (${randomUUID()}, ${incidentId}, ${change.kind}, ${body}, ${viewerId}, ${at}, ${requestKey}, ${hash})`;
    });
    const detail = await this.get(viewerId, incidentId, at);
    if (!detail) throw notFound(incidentId);
    return detail;
  }

  async metrics(viewerId: string, at: string): Promise<IncidentMetrics> {
    const [byStatus, bySeverity, resolved] = await Promise.all([
      this.sql.unsafe<{ status: Incident['status']; count: string }[]>(
        `SELECT i.status, count(*) AS count FROM ops.incidents i WHERE ${VISIBLE} GROUP BY i.status ORDER BY i.status`,
        [viewerId],
      ),
      this.sql.unsafe<{ severity: IncidentSeverity; count: string }[]>(
        `SELECT i.severity, count(*) AS count FROM ops.incidents i WHERE ${VISIBLE} GROUP BY i.severity ORDER BY i.severity`,
        [viewerId],
      ),
      // Whole seconds between the two stored times; never a clock read.
      this.sql.unsafe<{ count: string; mean: string | null }[]>(
        `SELECT count(*) AS count, floor(avg(extract(epoch FROM (i.ended_at - i.started_at))))::bigint AS mean
         FROM ops.incidents i WHERE i.status = 'resolved' AND ${VISIBLE}`,
        [viewerId],
      ),
    ]);
    return {
      byStatus: byStatus.map((r) => ({ status: r.status, count: Number(r.count) })),
      bySeverity: bySeverity.map((r) => ({ severity: r.severity, count: Number(r.count) })),
      resolvedCount: Number(resolved[0]?.count ?? 0),
      meanSecondsToResolve: resolved[0]?.mean === null || resolved[0]?.mean === undefined ? null : Number(resolved[0].mean),
      asOf: at,
    };
  }
}
