/** Postgres store for incident templates (SP-status-02), on the table of 0029_notify_incident_templates.sql. */
import type { Sql } from 'postgres';
import type { IncidentImpact } from '../notices/board.js';
import type { IncidentTemplate, TemplateStore } from './templates.js';

type TemplateRow = {
  id: string;
  name: string;
  group_name: string | null;
  title: string;
  body: string;
  impact: IncidentImpact | null;
  components: string[];
  defined_by: string;
  defined_at: Date;
};

const COLUMNS = 'id, name, group_name, title, body, impact, components, defined_by, defined_at';

const fromRow = (row: TemplateRow): IncidentTemplate => ({
  id: row.id,
  name: row.name,
  group: row.group_name,
  title: row.title,
  body: row.body,
  impact: row.impact,
  components: row.components,
  definedBy: row.defined_by,
  definedAt: row.defined_at.toISOString(),
});

export class SqlTemplateStore implements TemplateStore {
  constructor(private readonly sql: Sql) {}

  async list(): Promise<readonly IncidentTemplate[]> {
    const rows = await this.sql<TemplateRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.status_incident_templates
       WHERE retired_at IS NULL
       ORDER BY coalesce(group_name, '') ASC, name ASC, id ASC
    `;
    return rows.map(fromRow);
  }

  async find(id: string): Promise<IncidentTemplate | null> {
    const [row] = await this.sql<TemplateRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.status_incident_templates WHERE id = ${id} AND retired_at IS NULL
    `;
    return row ? fromRow(row) : null;
  }

  async put(t: IncidentTemplate, max: number): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      // One writer at a time, so two founders defining at once cannot both pass the cap.
      await tx`SELECT pg_advisory_xact_lock(hashtext('notify.status_incident_templates'))`;
      const [count] = await tx<{ active: number }[]>`
        SELECT count(*)::int AS active FROM notify.status_incident_templates WHERE retired_at IS NULL AND id <> ${t.id}
      `;
      if ((count?.active ?? 0) >= max) return false;
      await tx`
        INSERT INTO notify.status_incident_templates (id, name, group_name, title, body, impact, components, defined_by, defined_at)
        VALUES (${t.id}, ${t.name}, ${t.group}, ${t.title}, ${t.body}, ${t.impact}, ${t.components as string[]}, ${t.definedBy}, ${t.definedAt})
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, group_name = EXCLUDED.group_name, title = EXCLUDED.title, body = EXCLUDED.body,
          impact = EXCLUDED.impact, components = EXCLUDED.components, defined_by = EXCLUDED.defined_by,
          defined_at = EXCLUDED.defined_at, retired_by = NULL, retired_at = NULL
      `;
      return true;
    }) as Promise<boolean>;
  }

  async retire(id: string, by: string, at: Date): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE notify.status_incident_templates SET retired_by = ${by}, retired_at = ${at}
       WHERE id = ${id} AND retired_at IS NULL
       RETURNING id
    `;
    return rows.length > 0;
  }
}
