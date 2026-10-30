/**
 * The business team's typed refusals (AG-governance-01). Each code reaches the client as `data.cause.code`; the team
 * room's own copy says it in words. Kept beside the team module so it carries its own codes.
 */
export type TeamErrorCode =
  | 'agents.membership_unavailable'
  /** svc-bank says the asking person is not on that business (or there is no such business): one answer. */
  | 'agents.team_not_member'
  /** svc-bank says the business is not active: no team call runs on it. */
  | 'agents.business_closed'
  /** The member a change names is not on the business. */
  | 'agents.role_not_member'
  /** Only a business admin (or non-signing admin) changes the team's roles and limits. */
  | 'agents.role_admin_only'
  | 'agents.role_invalid'
  /** The asking member does not hold, or is denied, the team role this call needs. */
  | 'agents.team_role_required'
  | 'agents.team_change_stale'
  | 'agents.pool_limit_unset'
  | 'agents.pool_limit_invalid'
  | 'agents.pool_allocation_invalid'
  /** The allocations together pass the pool's limit. */
  | 'agents.pool_over_limit'
  | 'agents.pool_unset'
  | 'agents.project_name_unset'
  | 'agents.project_limit_unset'
  | 'agents.project_limit_invalid'
  /** The agent named is not one the asking member built. */
  | 'agents.team_agent_not_found'
  /** The tool named is not one of that agent's tools. */
  | 'agents.team_tool_not_declared'
  | 'agents.team_action_not_found'
  /** The held action was already approved by someone else. */
  | 'agents.team_action_closed'
  /** Four eyes: the person who built the agent never approves its own held action. */
  | 'agents.team_four_eyes'
  | 'agents.team_session_not_found'
  | 'agents.fee_asset_unset'
  | 'agents.capability_unavailable';

export class TeamError extends Error {
  constructor(
    message: string,
    readonly code: TeamErrorCode,
  ) {
    super(message);
    this.name = 'TeamError';
  }
}
