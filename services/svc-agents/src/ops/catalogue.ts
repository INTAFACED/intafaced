/**
 * Customer-readable catalogue. Name and purpose are stored columns.
 * Null stays null — this file does not compose a sentence from the guardrail.
 */

import type { Sql } from 'postgres';

export type CatalogueRow = {
  readonly agentId: string;
  readonly name: string | null;
  readonly purpose: string | null;
  readonly enabled: boolean;
  readonly version: number;
};

export async function listCatalogue(sql: Sql): Promise<CatalogueRow[]> {
  const rows = await sql<Array<{ agent_id: string; name: string | null; purpose: string | null; enabled: boolean; version: number }>>`
    SELECT agent_id, name, purpose, enabled, version
      FROM agents.agent_definitions
     ORDER BY agent_id ASC
  `;
  return rows.map((row) => ({
    agentId: row.agent_id,
    name: row.name,
    purpose: row.purpose,
    enabled: row.enabled,
    version: row.version,
  }));
}
