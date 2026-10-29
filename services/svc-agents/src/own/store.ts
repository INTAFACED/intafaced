import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  OWN_TEMPLATES,
  OwnAgentRefusal,
  protectionFindings,
  validateDraft,
  type DraftInput,
  type Finding,
  type OwnTemplate,
} from './catalog.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string;
  template: OwnTemplate;
  name: string;
  instructions: string;
  tools: string[];
  per_session_cap: string | null;
  version: number;
  state: 'draft' | 'published';
  created_at: Date;
  updated_at: Date;
}

export type OwnAgentView = {
  readonly id: string;
  readonly template: OwnTemplate;
  readonly name: string;
  readonly instructions: string;
  readonly tools: string[];
  readonly perSessionCap: string | null;
  readonly version: number;
  readonly state: 'draft' | 'published';
  readonly findings: Finding[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

function view(row: Row): OwnAgentView {
  const perSessionCap = row.per_session_cap === null ? null : formatAmount(parseAmount(row.per_session_cap));
  return {
    id: row.id,
    template: row.template,
    name: row.name,
    instructions: row.instructions,
    tools: row.tools,
    perSessionCap,
    version: row.version,
    state: row.state,
    findings: protectionFindings({ name: row.name, perSessionCap }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const COLUMNS = 'id, template, name, instructions, tools, per_session_cap::text, version, state, created_at, updated_at';

/**
 * A person's own agents. Every read and write is scoped to the owner, so an id
 * that belongs to someone else reads as not found. Nothing here moves value.
 */
export class OwnAgentStore {
  constructor(private readonly sql: Sql) {}

  /** One draft per create key: a retried create returns the draft the first one made. */
  async create(ownerId: string, template: OwnTemplate, createKey: string): Promise<OwnAgentView> {
    const tools = OWN_TEMPLATES[template].tools;
    const inserted = await this.sql<Row[]>`
      INSERT INTO agents.own_agents (owner_id, template, tools, create_key)
      VALUES (${ownerId}, ${template}, ${this.sql.json([...tools])}, ${createKey})
      ON CONFLICT (owner_id, create_key) DO NOTHING
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    if (inserted[0]) return view(inserted[0]);
    const existing = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM agents.own_agents WHERE owner_id = ${ownerId} AND create_key = ${createKey}
    `;
    if (!existing[0]) throw new Error('own agent create key conflicted but no row was found');
    return view(existing[0]);
  }

  async save(ownerId: string, id: string, input: DraftInput): Promise<OwnAgentView> {
    const fields = validateDraft(input);
    if (!UUID_RE.test(id)) throw new OwnAgentRefusal('agents.own.not_found');
    const rows = await this.sql<Row[]>`
      UPDATE agents.own_agents
         SET name = ${fields.name},
             instructions = ${fields.instructions},
             tools = ${this.sql.json(fields.tools)},
             per_session_cap = ${fields.perSessionCap},
             updated_at = now()
       WHERE owner_id = ${ownerId} AND id = ${id}
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    if (!rows[0]) throw new OwnAgentRefusal('agents.own.not_found');
    return view(rows[0]);
  }

  async get(ownerId: string, id: string): Promise<OwnAgentView> {
    if (!UUID_RE.test(id)) throw new OwnAgentRefusal('agents.own.not_found');
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM agents.own_agents WHERE owner_id = ${ownerId} AND id = ${id}
    `;
    if (!rows[0]) throw new OwnAgentRefusal('agents.own.not_found');
    return view(rows[0]);
  }

  /** Newest first; `limit` is the caller's page size. */
  async list(ownerId: string, limit: number): Promise<OwnAgentView[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM agents.own_agents
       WHERE owner_id = ${ownerId}
       ORDER BY created_at DESC, id
       LIMIT ${limit}
    `;
    return rows.map(view);
  }
}
