import type { Sql } from 'postgres';
import { SERVICE_RECORD_STALE, unsetServiceRecord, type ServiceRecord, type ServiceRecordValues } from '@intafaced/contracts';
import { isModuleId, type ModuleId } from '@intafaced/config';
import { OpsError } from '../codes.js';

export interface ServiceRecordStore {
  /** Every module that has a record. A module with none is absent, never a seeded row. */
  list(): Promise<ServiceRecord[]>;
  get(module: ModuleId): Promise<ServiceRecord>;
  /**
   * Replace one module's record from the revision the founder read, and log before and after; returns the record as
   * stored. Another revision refuses `ops.service_record_stale` and changes nothing.
   */
  set(module: ModuleId, expectedRevision: number, values: ServiceRecordValues, actorId: string, at: string): Promise<ServiceRecord>;
}

const valuesOf = (r: ServiceRecord): ServiceRecordValues => ({ ownerTeam: r.ownerTeam, dependencies: r.dependencies, runbook: r.runbook });

const stale = (module: ModuleId, found: number, expected: number) =>
  new OpsError(SERVICE_RECORD_STALE, `the ${module} record is at revision ${found}, not ${expected}: read it again before saving`);

export class MemoryServiceRecordStore implements ServiceRecordStore {
  private readonly rows = new Map<ModuleId, ServiceRecord>();
  readonly log: { module: ModuleId; before: ServiceRecordValues; after: ServiceRecordValues; actorId: string }[] = [];

  async list(): Promise<ServiceRecord[]> {
    return [...this.rows.values()].sort((a, b) => (a.module < b.module ? -1 : 1));
  }

  async get(module: ModuleId): Promise<ServiceRecord> {
    return this.rows.get(module) ?? unsetServiceRecord(module);
  }

  async set(module: ModuleId, expectedRevision: number, values: ServiceRecordValues, actorId: string, at: string): Promise<ServiceRecord> {
    const prior = await this.get(module);
    if (prior.revision !== expectedRevision) throw stale(module, prior.revision, expectedRevision);
    const next: ServiceRecord = { module, ...values, revision: prior.revision + 1, updatedBy: actorId, updatedAt: at };
    this.rows.set(module, next);
    this.log.push({ module, before: valuesOf(prior), after: values, actorId });
    return next;
  }
}

type Row = {
  module: string;
  owner_team: string | null;
  dependencies: string[];
  runbook: string | null;
  revision: number;
  updated_by: string;
  updated_at: Date | string;
};

/** A dependency the module registry no longer names is dropped on read, so one renamed module never breaks the page. */
const fromRow = (r: Row): ServiceRecord => ({
  // Every caller has checked the module: get and set by their argument, list by the filter above it.
  module: r.module as ModuleId,
  ownerTeam: r.owner_team,
  dependencies: r.dependencies.filter(isModuleId),
  runbook: r.runbook,
  revision: r.revision,
  updatedBy: r.updated_by,
  updatedAt: new Date(r.updated_at).toISOString(),
});

export class SqlServiceRecordStore implements ServiceRecordStore {
  constructor(private readonly sql: Sql) {}

  async list(): Promise<ServiceRecord[]> {
    const rows = await this.sql<Row[]>`
      SELECT module, owner_team, dependencies, runbook, revision, updated_by, updated_at FROM ops.service_records ORDER BY module
    `;
    // A module the registry no longer names has no page; its row stays in the table and its log.
    return rows.filter((r) => isModuleId(r.module)).map(fromRow);
  }

  async get(module: ModuleId): Promise<ServiceRecord> {
    const rows = await this.sql<Row[]>`
      SELECT module, owner_team, dependencies, runbook, revision, updated_by, updated_at FROM ops.service_records WHERE module = ${module}
    `;
    return rows[0] ? fromRow(rows[0]) : unsetServiceRecord(module);
  }

  async set(module: ModuleId, expectedRevision: number, values: ServiceRecordValues, actorId: string, at: string): Promise<ServiceRecord> {
    return this.sql.begin(async (tx) => {
      // One save per module at a time, the first one too (before the row exists, a row lock would hold nothing).
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.service_records:${module}`}))`;
      const found = await tx<Row[]>`
        SELECT module, owner_team, dependencies, runbook, revision, updated_by, updated_at FROM ops.service_records WHERE module = ${module}
      `;
      const prior = found[0] ? fromRow(found[0]) : unsetServiceRecord(module);
      if (prior.revision !== expectedRevision) throw stale(module, prior.revision, expectedRevision);
      const rows = await tx<Row[]>`
        INSERT INTO ops.service_records (module, owner_team, dependencies, runbook, revision, updated_by, updated_at)
        VALUES (${module}, ${values.ownerTeam}, ${tx.array(values.dependencies)}, ${values.runbook}, ${prior.revision + 1}, ${actorId}, ${at})
        ON CONFLICT (module) DO UPDATE SET owner_team = EXCLUDED.owner_team, dependencies = EXCLUDED.dependencies,
          runbook = EXCLUDED.runbook, revision = EXCLUDED.revision, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
        RETURNING module, owner_team, dependencies, runbook, revision, updated_by, updated_at
      `;
      await tx`
        INSERT INTO ops.service_record_log (module, before, after, actor_id, logged_at)
        VALUES (${module}, ${tx.json(valuesOf(prior))}, ${tx.json(values)}, ${actorId}, ${at})
      `;
      return fromRow(rows[0]!);
    }) as Promise<ServiceRecord>;
  }
}
