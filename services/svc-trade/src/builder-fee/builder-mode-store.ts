import type { Sql } from 'postgres';
import type { BuilderModeAlert, BuilderModeAlertStore } from './builder-mode.js';

/**
 * The builder-mode alerts (`trade.builder_mode_alerts`, drizzle/20261120161629_builder_mode_alerts.sql): one open alert per
 * venue and builder address, held by its partial unique index, so a retry or a concurrent check opens nothing twice.
 */

interface Row {
  id: string;
  venue_id: string;
  builder: string;
  mode_seen: string;
  required_mode: string;
  contact: string;
  opened_at: Date;
  cleared_at: Date | null;
  cleared_mode: string | null;
}

const alertOf = (r: Row): BuilderModeAlert => ({
  id: String(r.id),
  venueId: r.venue_id,
  builder: r.builder,
  modeSeen: r.mode_seen,
  requiredMode: r.required_mode,
  contact: r.contact,
  openedAt: r.opened_at,
  clearedAt: r.cleared_at,
  clearedMode: r.cleared_mode,
});

export class SqlBuilderModeAlertStore implements BuilderModeAlertStore {
  constructor(private readonly sql: Sql) {}

  async open(a: Parameters<BuilderModeAlertStore['open']>[0]): Promise<BuilderModeAlert | null> {
    const rows = await this.sql<Row[]>`
      INSERT INTO trade.builder_mode_alerts (venue_id, builder, mode_seen, required_mode, contact, opened_at)
      VALUES (${a.venueId}, ${a.builder}, ${a.modeSeen}, ${a.requiredMode}, ${a.contact}, ${a.at})
      ON CONFLICT (venue_id, builder) WHERE cleared_at IS NULL DO NOTHING
      RETURNING id::text, venue_id, builder, mode_seen, required_mode, contact, opened_at, cleared_at, cleared_mode`;
    return rows[0] ? alertOf(rows[0]) : null;
  }

  async clear(a: Parameters<BuilderModeAlertStore['clear']>[0]): Promise<BuilderModeAlert | null> {
    const rows = await this.sql<Row[]>`
      UPDATE trade.builder_mode_alerts
         SET cleared_at = ${a.at}, cleared_mode = ${a.mode}, updated_at = now()
       WHERE venue_id = ${a.venueId} AND builder = ${a.builder} AND cleared_at IS NULL
      RETURNING id::text, venue_id, builder, mode_seen, required_mode, contact, opened_at, cleared_at, cleared_mode`;
    return rows[0] ? alertOf(rows[0]) : null;
  }

  async recent(limit: number): Promise<readonly BuilderModeAlert[]> {
    const rows = await this.sql<Row[]>`
      SELECT id::text, venue_id, builder, mode_seen, required_mode, contact, opened_at, cleared_at, cleared_mode
        FROM trade.builder_mode_alerts
       ORDER BY opened_at DESC, id DESC
       LIMIT ${limit}`;
    return rows.map(alertOf);
  }
}

/** The same contract in memory, for the check's own tests: one open alert per venue and address. */
export class MemoryBuilderModeAlertStore implements BuilderModeAlertStore {
  readonly rows: BuilderModeAlert[] = [];

  async open(a: Parameters<BuilderModeAlertStore['open']>[0]): Promise<BuilderModeAlert | null> {
    if (this.rows.some((r) => r.venueId === a.venueId && r.builder === a.builder && r.clearedAt === null)) return null;
    const row: BuilderModeAlert = {
      id: String(this.rows.length + 1),
      venueId: a.venueId,
      builder: a.builder,
      modeSeen: a.modeSeen,
      requiredMode: a.requiredMode,
      contact: a.contact,
      openedAt: a.at,
      clearedAt: null,
      clearedMode: null,
    };
    this.rows.push(row);
    return row;
  }

  async clear(a: Parameters<BuilderModeAlertStore['clear']>[0]): Promise<BuilderModeAlert | null> {
    const i = this.rows.findIndex((r) => r.venueId === a.venueId && r.builder === a.builder && r.clearedAt === null);
    if (i < 0) return null;
    const cleared = { ...this.rows[i]!, clearedAt: a.at, clearedMode: a.mode };
    this.rows[i] = cleared;
    return cleared;
  }

  async recent(limit: number): Promise<readonly BuilderModeAlert[]> {
    return [...this.rows].sort((x, y) => y.openedAt.getTime() - x.openedAt.getTime() || Number(y.id) - Number(x.id)).slice(0, limit);
  }
}
