import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  OWN_AGENT_DELETE_CONFIRMATION,
  OWN_AGENT_SURFACES,
  type OwnAgentCoOwner,
  type OwnAgentPublication,
  type OwnAgentShared,
  type OwnAgentSurface,
  type OwnAgentVersion,
} from '@intafaced/contracts/agents-own';
import { OwnAgentRefusal, protectionFindings, type OwnRefusalCode } from './catalog.js';

/**
 * PUBLISHING, SHARING AND DELETING A PERSON'S OWN AGENT (AG-builder-03; J-agents-03 #7, #8).
 *
 * Publishing copies the agent as it stands into `own_agent_versions`, which nothing changes after (the table refuses an
 * UPDATE), and points each chosen surface at that version; a surface not chosen keeps the version it carried. Saving a
 * published agent makes the next version, a draft. A session keeps the version it opened on (`agent_sessions`
 * `guardrail_version`), and a run reads that version's instructions. A surface the policy forbids for a person's own
 * agent is listed with its reason and refused. Nothing here moves value.
 */

/**
 * Which surfaces a person's own agent may be published to. The public catalogue lists only product agents the
 * platform has reviewed; a person's agent is not reviewed, so it is refused there with that reason.
 */
export const OWN_SURFACE_POLICY: Readonly<Record<OwnAgentSurface, { readonly forbiddenCode: OwnRefusalCode | null }>> = {
  my_agents: { forbiddenCode: null },
  chat: { forbiddenCode: null },
  public_catalogue: { forbiddenCode: 'agents.own.surface_not_reviewed' },
};

/** A co-owner names one person. These prefixes name a group of people, which can never co-own an agent. */
const GROUP_REFERENCE = /^(group|team|business|org|organisation|organization):/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every table that holds rows of one own agent, in the order a delete removes them (children first). */
export const OWN_AGENT_CHILD_TABLES = [
  'own_agent_tokens',
  'own_agent_session_versions',
  'own_agent_surfaces',
  'own_agent_versions',
  'own_agent_co_owners',
  'own_agent_limits',
  'own_agent_usage_alerts',
  'own_agent_usage_limits',
  // A review may name the approval request its call became, so reviews go first.
  'own_agent_reviews',
  'own_agent_reviewer_settings',
  'own_agent_approval_requests',
  'own_agent_rules',
  'own_agent_consents',
  'own_agent_test_runs',
  'own_agent_eval_runs',
  'own_agent_eval_cases',
  'own_agent_background_runs',
] as const;

/** Whether an account exists and is active, as identity answers; unread is any answer that is not a clear one. */
export interface OwnAccountDirectory {
  readAccount(userId: string): Promise<{ status: 'ok'; account: { status: string } } | { status: 'unread' | 'unreachable' }>;
}

type VersionRow = {
  version: number;
  name: string;
  instructions: string;
  tools: string[];
  per_session_cap: string | null;
  published_at: Date;
};

const versionView = (row: VersionRow): OwnAgentVersion => ({
  version: row.version,
  name: row.name,
  instructions: row.instructions,
  tools: row.tools,
  perSessionCap: row.per_session_cap === null ? null : formatAmount(parseAmount(row.per_session_cap)),
  publishedAt: row.published_at.toISOString(),
});

/** The surfaces a publish names, checked against the policy: unknown or forbidden refuses, and nothing is published. */
export function checkSurfaces(names: readonly string[]): OwnAgentSurface[] {
  const chosen: OwnAgentSurface[] = [];
  for (const name of names) {
    const surface = OWN_AGENT_SURFACES.find((known) => known === name);
    if (!surface) throw new OwnAgentRefusal('agents.own.surface_unknown', { surface: name });
    const forbidden = OWN_SURFACE_POLICY[surface].forbiddenCode;
    if (forbidden) throw new OwnAgentRefusal(forbidden, { surface });
    if (!chosen.includes(surface)) chosen.push(surface);
  }
  return chosen;
}

/** A co-owner reference as the person typed it: one person's account id, or a refusal with its reason. */
export function checkCoOwner(ownerId: string, reference: string): string {
  const text = reference.trim();
  if (GROUP_REFERENCE.test(text)) throw new OwnAgentRefusal('agents.own.co_owner_group');
  if (!UUID_RE.test(text)) throw new OwnAgentRefusal('agents.own.co_owner_invalid');
  const userId = text.toLowerCase();
  if (userId === ownerId.toLowerCase()) throw new OwnAgentRefusal('agents.own.co_owner_self');
  return userId;
}

type AgentLock = { id: string; version: number; state: 'draft' | 'published' };

export class OwnPublishingStore {
  constructor(private readonly sql: Sql) {}

  /** The agent's published versions, the version each surface carries and the version each open session runs on. */
  async publication(ownerId: string, agentId: string, sessionAgentId: string): Promise<OwnAgentPublication> {
    const agents = await this.sql<AgentLock[]>`
      SELECT id, version, state FROM agents.own_agents WHERE owner_id = ${ownerId} AND id = ${agentId}
    `;
    const agent = agents[0];
    if (!agent) throw new OwnAgentRefusal('agents.own.not_found');
    const [versions, surfaces, sessions] = await Promise.all([
      this.sql<VersionRow[]>`
        SELECT version, name, instructions, tools, per_session_cap::text, published_at
          FROM agents.own_agent_versions WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
         ORDER BY version
      `,
      this.sql<{ surface: OwnAgentSurface; version: number }[]>`
        SELECT surface, version FROM agents.own_agent_surfaces WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
      `,
      this.sql<{ id: string; guardrail_version: number }[]>`
        SELECT id::text, guardrail_version FROM agents.agent_sessions
         WHERE user_id = ${ownerId} AND agent_id = ${sessionAgentId} AND status = 'open'
         ORDER BY opened_at, id
      `,
    ]);
    return {
      id: agent.id,
      version: agent.version,
      state: agent.state,
      versions: versions.map(versionView),
      surfaces: OWN_AGENT_SURFACES.map((surface) => ({
        surface,
        allowed: OWN_SURFACE_POLICY[surface].forbiddenCode === null,
        forbiddenCode: OWN_SURFACE_POLICY[surface].forbiddenCode,
        version: surfaces.find((row) => row.surface === surface)?.version ?? null,
      })),
      openSessions: sessions.map((row) => ({ sessionId: row.id, version: row.guardrail_version })),
    };
  }

  /**
   * Publishes the agent's current version to the chosen surfaces. A draft is copied as its version first; a version
   * already published is only pointed at by more surfaces. Only the chosen surfaces move. A finding that blocks
   * publishing, read from the locked row so a save in between cannot slip past it, refuses with nothing published.
   */
  async publish(ownerId: string, agentId: string, surfaces: readonly OwnAgentSurface[]): Promise<void> {
    if (!UUID_RE.test(agentId)) throw new OwnAgentRefusal('agents.own.not_found');
    await this.sql.begin(async (tx) => {
      // The agent's row is locked, so a save cannot change it between its copy and the surfaces moving.
      const rows = await tx<(AgentLock & { name: string; per_session_cap: string | null })[]>`
        SELECT id, version, state, name, per_session_cap::text FROM agents.own_agents
         WHERE owner_id = ${ownerId} AND id = ${agentId} FOR UPDATE
      `;
      const agent = rows[0];
      if (!agent) throw new OwnAgentRefusal('agents.own.not_found');
      const blocking = protectionFindings({ name: agent.name, perSessionCap: agent.per_session_cap }).find((f) => f.blocksPublishing);
      if (blocking) throw new OwnAgentRefusal(blocking.code);
      if (agent.state === 'draft') {
        await tx`
          INSERT INTO agents.own_agent_versions (agent_id, owner_id, version, name, instructions, tools, per_session_cap)
          SELECT id, owner_id, version, name, instructions, tools, per_session_cap
            FROM agents.own_agents WHERE owner_id = ${ownerId} AND id = ${agentId}
        `;
        await tx`UPDATE agents.own_agents SET state = 'published', updated_at = now() WHERE owner_id = ${ownerId} AND id = ${agentId}`;
      }
      for (const surface of surfaces) {
        await tx`
          INSERT INTO agents.own_agent_surfaces (agent_id, owner_id, surface, version)
          VALUES (${agentId}, ${ownerId}, ${surface}, ${agent.version})
          ON CONFLICT (agent_id, surface) DO UPDATE SET version = EXCLUDED.version, updated_at = now()
        `;
      }
    });
  }

  /** Keeps what a session opened on: the agent's version and its instructions as they stand now. */
  async pinSession(ownerId: string, agentId: string, sessionId: string, version: number, instructions: string): Promise<void> {
    await this.sql`
      INSERT INTO agents.own_agent_session_versions (session_id, agent_id, owner_id, version, instructions)
      VALUES (${sessionId}, ${agentId}, ${ownerId}, ${version}, ${instructions})
      ON CONFLICT (session_id) DO NOTHING
    `;
  }

  /** The instructions a session opened on, or null for a session opened before sessions were pinned. */
  async sessionInstructions(ownerId: string, sessionId: string): Promise<string | null> {
    const rows = await this.sql<{ instructions: string }[]>`
      SELECT instructions FROM agents.own_agent_session_versions WHERE owner_id = ${ownerId} AND session_id = ${sessionId}
    `;
    return rows[0]?.instructions ?? null;
  }

  /**
   * Whether an id is a group svc-agents knows: a business or one of its projects (AG-governance-01). A group never
   * co-owns an agent, whether it is named with a prefix or by its bare id.
   */
  async isGroup(id: string): Promise<boolean> {
    const rows = await this.sql<{ hit: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM agents.team_pools WHERE business_id = ${id}::uuid)
          OR EXISTS (SELECT 1 FROM agents.team_role_grants WHERE business_id = ${id}::uuid)
          OR EXISTS (SELECT 1 FROM agents.team_projects WHERE id = ${id}::uuid OR business_id = ${id}::uuid) AS hit
    `;
    return rows[0]?.hit === true;
  }

  async coOwners(ownerId: string, agentId: string): Promise<OwnAgentCoOwner[]> {
    const rows = await this.sql<{ co_owner_id: string; created_at: Date }[]>`
      SELECT co_owner_id, created_at FROM agents.own_agent_co_owners
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY created_at, co_owner_id
    `;
    return rows.map((row) => ({ userId: row.co_owner_id, addedAt: row.created_at.toISOString() }));
  }

  /** Adds one person as a co-owner, once: the same person again is the row already held. */
  async addCoOwner(ownerId: string, agentId: string, coOwnerId: string): Promise<void> {
    await this.sql`
      INSERT INTO agents.own_agent_co_owners (agent_id, owner_id, co_owner_id)
      VALUES (${agentId}, ${ownerId}, ${coOwnerId})
      ON CONFLICT (agent_id, co_owner_id) DO NOTHING
    `;
  }

  async removeCoOwner(ownerId: string, agentId: string, coOwnerId: string): Promise<void> {
    await this.sql`
      DELETE FROM agents.own_agent_co_owners WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND co_owner_id = ${coOwnerId}
    `;
  }

  /** Other people's agents this person co-owns, newest first: read only. */
  async sharedWith(userId: string, limit: number): Promise<OwnAgentShared[]> {
    const rows = await this.sql<{ id: string; owner_id: string; name: string; version: number; state: 'draft' | 'published' }[]>`
      SELECT a.id, a.owner_id, a.name, a.version, a.state
        FROM agents.own_agent_co_owners c
        JOIN agents.own_agents a ON a.id = c.agent_id AND a.owner_id = c.owner_id
       WHERE c.co_owner_id = ${userId.toLowerCase()}
       ORDER BY c.created_at DESC, a.id
       LIMIT ${limit}
    `;
    return rows.map((row) => ({ id: row.id, ownerId: row.owner_id, name: row.name, version: row.version, state: row.state }));
  }

  /**
   * Deletes a draft for good, only with the person's confirmation (the client sends it once they confirm). A published agent, or one that has opened a
   * session (its usage and runs are part of the person's history), is refused and kept whole.
   */
  async deleteDraft(ownerId: string, agentId: string, sessionAgentId: string, confirm: string): Promise<void> {
    if (confirm !== OWN_AGENT_DELETE_CONFIRMATION) throw new OwnAgentRefusal('agents.own.delete_unconfirmed');
    if (!UUID_RE.test(agentId)) throw new OwnAgentRefusal('agents.own.not_found');
    await this.sql.begin(async (tx) => {
      const rows = await tx<AgentLock[]>`
        SELECT id, version, state FROM agents.own_agents WHERE owner_id = ${ownerId} AND id = ${agentId} FOR UPDATE
      `;
      const agent = rows[0];
      if (!agent) throw new OwnAgentRefusal('agents.own.not_found');
      const published = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM agents.own_agent_versions WHERE agent_id = ${agentId}
      `;
      if (agent.state === 'published' || published[0]!.n > 0) throw new OwnAgentRefusal('agents.own.delete_published');
      const sessions = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM agents.agent_sessions WHERE user_id = ${ownerId} AND agent_id = ${sessionAgentId}
      `;
      if (sessions[0]!.n > 0) throw new OwnAgentRefusal('agents.own.delete_has_sessions');
      for (const table of OWN_AGENT_CHILD_TABLES) {
        await tx`DELETE FROM ${tx('agents')}.${tx(table)} WHERE agent_id = ${agentId}`;
      }
      await tx`DELETE FROM agents.own_agents WHERE owner_id = ${ownerId} AND id = ${agentId}`;
    });
  }
}
