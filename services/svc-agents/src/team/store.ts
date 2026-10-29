import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { AGENTS_TEAM_ROLES, type AgentsTeamBusinessRole, type AgentsTeamMember, type AgentsTeamRole } from '@intafaced/contracts';
import { TeamError } from './errors.js';
import type { TeamMembershipPort } from './membership.js';

/**
 * A business team's agent roles, pool and project limits (AG-governance-01, AG-usage-03).
 *
 * Who is a member is read from svc-pay at every call and never stored, so a grant, allocation or project limit of a
 * person who left stops applying at the next read: their rows stay in the tables but no view or check reads them.
 * Nothing here is a balance and no value moves: a pool is a limit on what members' runs may spend.
 */

export const TEAM_ROLES = AGENTS_TEAM_ROLES;
export type TeamRole = AgentsTeamRole;

/** Only the business's owner or admin changes its team's agent roles and limits. */
const MANAGERS: readonly AgentsTeamBusinessRole[] = ['owner', 'admin'];

export interface TeamGrantView {
  readonly role: TeamRole;
  readonly allow: boolean;
  readonly deny: boolean;
  /** The grant's change count; the next change is `version + 1`. */
  readonly version: number;
}

export interface TeamMemberView {
  readonly userId: string;
  readonly label: string | null;
  readonly businessRole: AgentsTeamBusinessRole;
  readonly grants: TeamGrantView[];
  /** Roles allowed and not denied: deny wins. */
  readonly effective: TeamRole[];
  /** The member's pool allocation, or null when the pool gives them none. */
  readonly allocation: string | null;
}

export interface TeamPoolView {
  readonly assetId: string;
  readonly limit: string;
  readonly allocated: string;
  readonly version: number;
}

export interface TeamProjectView {
  readonly id: string;
  readonly name: string;
  readonly assetId: string;
  readonly limit: string;
  /** Current members the limit applies to; a person who left the business is not listed. */
  readonly memberUserIds: string[];
}

export interface TeamView {
  readonly businessId: string;
  readonly myRole: AgentsTeamBusinessRole;
  readonly canManage: boolean;
  readonly members: TeamMemberView[];
  readonly pool: TeamPoolView | null;
  readonly projects: TeamProjectView[];
  /** The number the next new project takes in its business key. */
  readonly nextProjectSeq: number;
}

export type PoolSetResult =
  | { readonly ok: true; readonly pool: TeamPoolView; readonly replayed: boolean }
  | { readonly ok: false; readonly code: 'agents.pool_allocation_unset'; readonly memberUserIds: string[] };

interface Team {
  readonly businessId: string;
  readonly myRole: AgentsTeamBusinessRole;
  readonly members: AgentsTeamMember[];
}

interface GrantRow {
  member_user_id: string;
  role: TeamRole;
  allow: boolean;
  deny: boolean;
  version: number;
  idempotency_key: string;
  digest: string;
}

const blank = (v: string | null | undefined): boolean => v == null || v.trim() === '';
const digestOf = (parts: readonly string[]): string => createHash('sha256').update(parts.join('\n')).digest('hex');
const canonical = (raw: string): string => formatAmount(parseAmount(raw));

function positiveAmount(
  raw: string,
  code: 'agents.pool_limit_invalid' | 'agents.project_limit_invalid' | 'agents.pool_allocation_invalid',
  zeroOk = false,
): Amount {
  let value: Amount;
  try {
    value = parseAmount(raw.trim());
  } catch {
    throw new TeamError(`Amount ${JSON.stringify(raw)} is not a decimal`, code);
  }
  if (value < 0n || (!zeroOk && value === 0n)) throw new TeamError('Amount must be above zero', code);
  return value;
}

function stale(): TeamError {
  return new TeamError('The team changed since this was read; read it again', 'agents.team_change_stale');
}

async function lockBusiness(tx: Sql, businessId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`agents.team:${businessId}`}, 0))`;
}

export class TeamStore {
  constructor(
    private readonly sql: Sql,
    private readonly membership: TeamMembershipPort,
    private readonly feeAssetId: string | undefined,
  ) {}

  /** The asking person's business team. A person on no business, or a removed member, is refused by name. */
  private async team(userId: string): Promise<Team> {
    let answer;
    try {
      answer = await this.membership.read(userId);
    } catch (err) {
      if (err instanceof TeamError) throw err;
      throw new TeamError('Business team could not be read', 'agents.membership_unavailable');
    }
    if (!answer.ok) {
      if (answer.reason === 'business_shut') throw new TeamError('The business is suspended or closed', 'agents.business_shut');
      throw new TeamError('The person is a member of no business', 'agents.role_not_member');
    }
    return { businessId: answer.businessId, myRole: answer.role, members: answer.members };
  }

  private async manager(userId: string): Promise<Team> {
    const team = await this.team(userId);
    if (!MANAGERS.includes(team.myRole))
      throw new TeamError('Only the business owner or an admin changes team roles', 'agents.role_admin_only');
    return team;
  }

  private static assertMember(team: Team, memberUserId: string): void {
    if (!team.members.some((m) => m.userId === memberUserId)) {
      throw new TeamError('That account is not a member of this business', 'agents.role_not_member');
    }
  }

  async view(userId: string): Promise<TeamView> {
    const team = await this.team(userId);
    const ids = team.members.map((m) => m.userId);
    const grants = await this.sql<GrantRow[]>`
      SELECT member_user_id, role, allow, deny, version, idempotency_key, digest
        FROM agents.team_role_grants
       WHERE business_id = ${team.businessId} AND member_user_id = ANY(${ids})
    `;
    const [pool] = await this.sql<Array<{ asset_id: string; pool_limit: string; version: number }>>`
      SELECT asset_id, pool_limit::text, version FROM agents.team_pools WHERE business_id = ${team.businessId}
    `;
    const allocations = pool
      ? await this.sql<Array<{ member_user_id: string; amount: string }>>`
          SELECT member_user_id, amount::text FROM agents.team_pool_allocations
           WHERE business_id = ${team.businessId} AND member_user_id = ANY(${ids})
        `
      : [];
    const projects = await this.sql<Array<{ id: string; name: string; asset_id: string; project_limit: string; seq: number }>>`
      SELECT id::text, name, asset_id, project_limit::text, seq FROM agents.team_projects
       WHERE business_id = ${team.businessId} ORDER BY seq
    `;
    const projectMembers = projects.length
      ? await this.sql<Array<{ project_id: string; member_user_id: string }>>`
          SELECT project_id::text, member_user_id FROM agents.team_project_members
           WHERE project_id = ANY(${projects.map((p) => p.id)}::uuid[]) AND member_user_id = ANY(${ids})
        `
      : [];

    const allocationOf = new Map(allocations.map((a) => [a.member_user_id, canonical(a.amount)]));
    let allocated = 0n;
    for (const a of allocations) allocated += parseAmount(a.amount);

    return {
      businessId: team.businessId,
      myRole: team.myRole,
      canManage: MANAGERS.includes(team.myRole),
      members: team.members.map((m) => {
        const mine = grants.filter((g) => g.member_user_id === m.userId);
        const grantViews = TEAM_ROLES.map((role) => {
          const g = mine.find((row) => row.role === role);
          return { role, allow: g?.allow ?? false, deny: g?.deny ?? false, version: g?.version ?? 0 };
        });
        return {
          userId: m.userId,
          label: m.label,
          businessRole: m.role,
          grants: grantViews,
          effective: grantViews.filter((g) => g.allow && !g.deny).map((g) => g.role),
          allocation: allocationOf.get(m.userId) ?? null,
        };
      }),
      pool: pool
        ? { assetId: pool.asset_id, limit: canonical(pool.pool_limit), allocated: formatAmount(allocated), version: pool.version }
        : null,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        assetId: p.asset_id,
        limit: canonical(p.project_limit),
        memberUserIds: projectMembers.filter((pm) => pm.project_id === p.id).map((pm) => pm.member_user_id),
      })),
      nextProjectSeq: (projects.at(-1)?.seq ?? 0) + 1,
    };
  }

  /**
   * Sets one member's allow and deny for one role, as change `revision` of that grant
   * (`agents:role:<business>:<member>:<role>:<revision>`). The same change again is a replay; any other change with a
   * used or skipped number refuses stale.
   */
  async setGrant(input: {
    actorUserId: string;
    memberUserId: string;
    role: string;
    allow: boolean;
    deny: boolean;
    revision: number;
  }): Promise<{ readonly grant: TeamGrantView; readonly replayed: boolean }> {
    if (!(TEAM_ROLES as readonly string[]).includes(input.role))
      throw new TeamError(`Unknown team role ${input.role}`, 'agents.role_invalid');
    const role = input.role as TeamRole;
    const team = await this.manager(input.actorUserId);
    TeamStore.assertMember(team, input.memberUserId);
    const key = `agents:role:${team.businessId}:${input.memberUserId}:${role}:${input.revision}`;
    const digest = digestOf([String(input.allow), String(input.deny)]);
    return transaction(this.sql, async (tx) => {
      await lockBusiness(tx, team.businessId);
      const [row] = await tx<GrantRow[]>`
        SELECT member_user_id, role, allow, deny, version, idempotency_key, digest FROM agents.team_role_grants
         WHERE business_id = ${team.businessId} AND member_user_id = ${input.memberUserId} AND role = ${role}
      `;
      const current = row?.version ?? 0;
      if (row && row.idempotency_key === key) {
        if (row.digest !== digest) throw stale();
        return { grant: { role, allow: row.allow, deny: row.deny, version: row.version }, replayed: true };
      }
      if (input.revision !== current + 1) throw stale();
      await tx`
        INSERT INTO agents.team_role_grants
          (business_id, member_user_id, role, allow, deny, version, idempotency_key, digest, granted_by)
        VALUES (${team.businessId}, ${input.memberUserId}, ${role}, ${input.allow}, ${input.deny}, ${input.revision}, ${key}, ${digest}, ${input.actorUserId})
        ON CONFLICT (business_id, member_user_id, role) DO UPDATE
          SET allow = EXCLUDED.allow, deny = EXCLUDED.deny, version = EXCLUDED.version,
              idempotency_key = EXCLUDED.idempotency_key, digest = EXCLUDED.digest,
              granted_by = EXCLUDED.granted_by, updated_at = now()
      `;
      return { grant: { role, allow: input.allow, deny: input.deny, version: input.revision }, replayed: false };
    });
  }

  /**
   * Sets the business pool's limit and every member's allocation, as change `revision` (`agents:pool:<business>:<n>`).
   * A blank limit refuses; a blank allocation refuses naming each member left blank, and nothing is saved.
   */
  async setPool(input: {
    actorUserId: string;
    limit?: string | null;
    allocations: ReadonlyArray<{ memberUserId: string; amount?: string | null }>;
    revision: number;
  }): Promise<PoolSetResult> {
    const team = await this.manager(input.actorUserId);
    if (blank(this.feeAssetId)) throw new TeamError('Agents fee asset is unset', 'agents.fee_asset_unset');
    const assetId = this.feeAssetId!.trim();
    if (blank(input.limit)) throw new TeamError('Pool limit is unset — refusing rather than inventing one', 'agents.pool_limit_unset');
    const limit = positiveAmount(input.limit!, 'agents.pool_limit_invalid');
    const seen = new Set<string>();
    for (const a of input.allocations) {
      TeamStore.assertMember(team, a.memberUserId);
      if (seen.has(a.memberUserId)) throw new TeamError('A member is allocated twice', 'agents.pool_allocation_invalid');
      seen.add(a.memberUserId);
    }
    const unset = input.allocations.filter((a) => blank(a.amount)).map((a) => a.memberUserId);
    if (unset.length > 0) return { ok: false, code: 'agents.pool_allocation_unset', memberUserIds: unset };
    const allocations = input.allocations
      .map((a) => {
        const amount = positiveAmount(a.amount!, 'agents.pool_allocation_invalid', true);
        if (amount > limit) throw new TeamError('An allocation is above the pool limit', 'agents.pool_allocation_invalid');
        return { memberUserId: a.memberUserId, amount };
      })
      .sort((x, y) => (x.memberUserId < y.memberUserId ? -1 : 1));
    const key = `agents:pool:${team.businessId}:${input.revision}`;
    const digest = digestOf([assetId, formatAmount(limit), ...allocations.map((a) => `${a.memberUserId}=${formatAmount(a.amount)}`)]);
    return transaction(this.sql, async (tx) => {
      await lockBusiness(tx, team.businessId);
      const [row] = await tx<Array<{ version: number; idempotency_key: string; digest: string }>>`
        SELECT version, idempotency_key, digest FROM agents.team_pools WHERE business_id = ${team.businessId}
      `;
      const allocated = allocations.reduce((sum, a) => sum + a.amount, 0n);
      const pool = { assetId, limit: formatAmount(limit), allocated: formatAmount(allocated), version: input.revision };
      if (row && row.idempotency_key === key) {
        if (row.digest !== digest) throw stale();
        return { ok: true, pool, replayed: true } as const;
      }
      if (input.revision !== (row?.version ?? 0) + 1) throw stale();
      await tx`
        INSERT INTO agents.team_pools (business_id, asset_id, pool_limit, version, idempotency_key, digest, set_by)
        VALUES (${team.businessId}, ${assetId}, ${formatAmount(limit)}::numeric, ${input.revision}, ${key}, ${digest}, ${input.actorUserId})
        ON CONFLICT (business_id) DO UPDATE
          SET asset_id = EXCLUDED.asset_id, pool_limit = EXCLUDED.pool_limit, version = EXCLUDED.version,
              idempotency_key = EXCLUDED.idempotency_key, digest = EXCLUDED.digest, set_by = EXCLUDED.set_by, updated_at = now()
      `;
      await tx`DELETE FROM agents.team_pool_allocations WHERE business_id = ${team.businessId}`;
      for (const a of allocations) {
        await tx`
          INSERT INTO agents.team_pool_allocations (business_id, member_user_id, amount)
          VALUES (${team.businessId}, ${a.memberUserId}, ${formatAmount(a.amount)}::numeric)
        `;
      }
      return { ok: true, pool, replayed: false } as const;
    });
  }

  /** Creates the business's project number `seq` (`agents:project:<business>:<seq>`) with a limit for the members named. */
  async createProject(input: {
    actorUserId: string;
    name?: string | null;
    limit?: string | null;
    memberUserIds: string[];
    seq: number;
  }): Promise<{ readonly project: TeamProjectView; readonly replayed: boolean }> {
    const team = await this.manager(input.actorUserId);
    if (blank(this.feeAssetId)) throw new TeamError('Agents fee asset is unset', 'agents.fee_asset_unset');
    const assetId = this.feeAssetId!.trim();
    if (blank(input.name)) throw new TeamError('Project name is unset', 'agents.project_name_unset');
    if (blank(input.limit))
      throw new TeamError('Project limit is unset — refusing rather than inventing one', 'agents.project_limit_unset');
    const name = input.name!.trim();
    const limit = positiveAmount(input.limit!, 'agents.project_limit_invalid');
    const members = [...new Set(input.memberUserIds)].sort();
    for (const m of members) TeamStore.assertMember(team, m);
    const key = `agents:project:${team.businessId}:${input.seq}`;
    const digest = digestOf([name, assetId, formatAmount(limit), ...members]);
    return transaction(this.sql, async (tx) => {
      await lockBusiness(tx, team.businessId);
      const [same] = await tx<Array<{ id: string; digest: string }>>`
        SELECT id::text, digest FROM agents.team_projects WHERE idempotency_key = ${key}
      `;
      if (same) {
        if (same.digest !== digest) throw stale();
        return { project: { id: same.id, name, assetId, limit: formatAmount(limit), memberUserIds: members }, replayed: true };
      }
      const [last] = await tx<Array<{ seq: number }>>`
        SELECT COALESCE(MAX(seq), 0)::int AS seq FROM agents.team_projects WHERE business_id = ${team.businessId}
      `;
      if (input.seq !== (last?.seq ?? 0) + 1) throw stale();
      const [row] = await tx<Array<{ id: string }>>`
        INSERT INTO agents.team_projects (id, business_id, name, asset_id, project_limit, seq, idempotency_key, digest, created_by)
        VALUES (gen_random_uuid(), ${team.businessId}, ${name}, ${assetId}, ${formatAmount(limit)}::numeric, ${input.seq}, ${key}, ${digest}, ${input.actorUserId})
        RETURNING id::text
      `;
      for (const m of members) {
        await tx`INSERT INTO agents.team_project_members (project_id, member_user_id) VALUES (${row!.id}::uuid, ${m})`;
      }
      return { project: { id: row!.id, name, assetId, limit: formatAmount(limit), memberUserIds: members }, replayed: false };
    });
  }
}
