import type { Sql } from 'postgres';
import { z } from 'zod';
import type { BuilderModeAlert, BuilderModeAlertStore } from './builder-mode.js';

/**
 * The builder-mode alerts (`trade.builder_mode_alerts`, drizzle/20261120161629_builder_mode_alerts.sql): one open alert per
 * venue and builder address, held by its partial unique index, so a retry or a concurrent check opens nothing twice.
 */

const AlertRow = z.object({
  id: z.string(),
  venue_id: z.string(),
  builder: z.string(),
  mode_seen: z.string(),
  required_mode: z.string(),
  contact: z.string(),
  opened_at: z.date(),
  cleared_at: z.date().nullable(),
  cleared_mode: z.string().nullable(),
});
type AlertRow = z.infer<typeof AlertRow>;

const alertOf = (r: AlertRow): BuilderModeAlert => ({
  id: r.id,
  venueId: r.venue_id,
  builder: r.builder,
  modeSeen: r.mode_seen,
  requiredMode: r.required_mode,
  contact: r.contact,
  openedAt: r.opened_at,
  clearedAt: r.cleared_at,
  clearedMode: r.cleared_mode,
});
const firstAlert = (rows: unknown): BuilderModeAlert | null => {
  const [row] = AlertRow.array().parse(rows);
  return row ? alertOf(row) : null;
};

export class SqlBuilderModeAlertStore implements BuilderModeAlertStore {
  constructor(private readonly sql: Sql) {}

  async open(a: Parameters<BuilderModeAlertStore['open']>[0]): Promise<BuilderModeAlert | null> {
    const rows = await this.sql`
      INSERT INTO trade.builder_mode_alerts (venue_id, builder, mode_seen, required_mode, contact, opened_at)
      VALUES (${a.venueId}, ${a.builder}, ${a.modeSeen}, ${a.requiredMode}, ${a.contact}, ${a.at})
      ON CONFLICT (venue_id, builder) WHERE cleared_at IS NULL DO NOTHING
      RETURNING id::text, venue_id, builder, mode_seen, required_mode, contact, opened_at, cleared_at, cleared_mode`;
    return firstAlert(rows);
  }

  async clear(a: Parameters<BuilderModeAlertStore['clear']>[0]): Promise<BuilderModeAlert | null> {
    const rows = await this.sql`
      UPDATE trade.builder_mode_alerts
         SET cleared_at = ${a.at}, cleared_mode = ${a.mode}, updated_at = now()
       WHERE venue_id = ${a.venueId} AND builder = ${a.builder} AND cleared_at IS NULL
      RETURNING id::text, venue_id, builder, mode_seen, required_mode, contact, opened_at, cleared_at, cleared_mode`;
    return firstAlert(rows);
  }

  async recent(limit: number): Promise<readonly BuilderModeAlert[]> {
    const rows = await this.sql`
      SELECT id::text, venue_id, builder, mode_seen, required_mode, contact, opened_at, cleared_at, cleared_mode
        FROM trade.builder_mode_alerts
       ORDER BY opened_at DESC, id DESC
       LIMIT ${limit}`;
    return AlertRow.array().parse(rows).map(alertOf);
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
    const open = this.rows[i];
    if (open === undefined) return null;
    const cleared = { ...open, clearedAt: a.at, clearedMode: a.mode };
    this.rows[i] = cleared;
    return cleared;
  }

  async recent(limit: number): Promise<readonly BuilderModeAlert[]> {
    return [...this.rows].sort((x, y) => y.openedAt.getTime() - x.openedAt.getTime() || Number(y.id) - Number(x.id)).slice(0, limit);
  }
}
