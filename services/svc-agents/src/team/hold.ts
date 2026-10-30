import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import { lockBusiness } from './store.js';

/**
 * A team run's hold, checked against the business (AG-usage-03). Called by the spend store under the member's own
 * spend lock, before the hold is written; it then takes the business lock, so two members' runs at once cannot both
 * count one allocation, project limit or pool. Every hold on the business's team sessions counts, held ones at their
 * worst case and committed ones at what they cost.
 *
 * An allocation, a project limit and the pool are limits on what members' team runs may spend in all, never a balance:
 * each run is charged to the member's own account at its usage window's seal.
 */

/** A team session's holds carry this prefix: only the team run route, which reads membership first, makes them. */
export const TEAM_RUN_KEY_PREFIX = 'team:';

function exceeded(scope: 'allocation' | 'project' | 'pool', cap: Amount, assetId: string): AgentError {
  const code =
    scope === 'allocation'
      ? 'agents.team.allocation_exceeded'
      : scope === 'project'
        ? 'agents.team.project_limit_exceeded'
        : 'agents.team.pool_exceeded';
  return new AgentError(`Team ${scope} limit ${formatAmount(cap)} ${assetId} would be passed`, code, 'agents.refused.spend_cap', {
    limit: formatAmount(cap),
    asset: assetId,
    scope,
  });
}

/** Held and committed holds on the business's team sessions, of the members named (all of them when null). The team
 * page shows the same sum, so what it reads as used is what the next hold is checked against. */
export async function used(tx: Sql, businessId: string, memberUserIds: readonly string[] | null): Promise<Amount> {
  const rows = await tx<Array<{ total: string }>>`
    SELECT COALESCE(SUM(CASE WHEN r.status = 'held' THEN r.amount ELSE r.committed_amount END), 0::numeric)::text AS total
      FROM agents.spend_reservations r
      JOIN agents.team_sessions t ON t.session_id = r.session_id AND t.member_user_id = r.user_id
     WHERE t.business_id = ${businessId}
       AND r.status IN ('held', 'committed')
       ${memberUserIds === null ? tx`` : tx`AND t.member_user_id = ANY(${memberUserIds as string[]})`}
  `;
  return parseAmount(rows[0]?.total ?? '0');
}

/**
 * Refuses a hold on a team session that would pass the member's allocation, a project limit of a project they are in,
 * or the pool's limit. No allocation (or no pool) refuses `agents.team.allocation_unset`: nothing on a team session
 * runs unlimited. A session that is not a team session is not this check's.
 */
export async function holdAgainstTeam(
  tx: Sql,
  input: { userId: string; sessionId: string; reservationKey: string; assetId: string; amount: Amount; teamRun: boolean },
): Promise<void> {
  const [session] = await tx<Array<{ business_id: string; member_user_id: string }>>`
    SELECT business_id::text, member_user_id FROM agents.team_sessions WHERE session_id = ${input.sessionId}
  `;
  if (!session) return;
  if (session.member_user_id !== input.userId || !input.teamRun || !input.reservationKey.startsWith(TEAM_RUN_KEY_PREFIX)) {
    // Not made by the team run route, so membership and role were not read for it: this session takes no other run,
    // whatever request id another route sends.
    throw new AgentError(`No session ${input.sessionId}`, 'agents.session_not_found', 'agents.refused.session_closed');
  }
  const businessId = session.business_id;
  await lockBusiness(tx, businessId);
  const [pool] = await tx<Array<{ asset_id: string; pool_limit: string }>>`
    SELECT asset_id, pool_limit::text FROM agents.team_pools WHERE business_id = ${businessId}
  `;
  const [allocation] = pool
    ? await tx<Array<{ amount: string }>>`
        SELECT amount::text FROM agents.team_pool_allocations WHERE business_id = ${businessId} AND member_user_id = ${input.userId}
      `
    : [];
  if (!pool || !allocation || pool.asset_id !== input.assetId) {
    throw new AgentError('Team allocation is unset', 'agents.team.allocation_unset', 'agents.refused.spend_limit_unset');
  }

  const cap = parseAmount(allocation.amount);
  if ((await used(tx, businessId, [input.userId])) + input.amount > cap) throw exceeded('allocation', cap, input.assetId);

  const projects = await tx<Array<{ id: string; project_limit: string }>>`
    SELECT p.id::text, p.project_limit::text
      FROM agents.team_projects p
      JOIN agents.team_project_members m ON m.project_id = p.id
     WHERE p.business_id = ${businessId} AND m.member_user_id = ${input.userId}
     ORDER BY p.seq
  `;
  for (const project of projects) {
    const members = await tx<Array<{ member_user_id: string }>>`
      SELECT member_user_id FROM agents.team_project_members WHERE project_id = ${project.id}::uuid
    `;
    const limit = parseAmount(project.project_limit);
    const spent = await used(
      tx,
      businessId,
      members.map((m) => m.member_user_id),
    );
    if (spent + input.amount > limit) throw exceeded('project', limit, input.assetId);
  }

  const poolLimit = parseAmount(pool.pool_limit);
  if ((await used(tx, businessId, null)) + input.amount > poolLimit) throw exceeded('pool', poolLimit, input.assetId);
}
