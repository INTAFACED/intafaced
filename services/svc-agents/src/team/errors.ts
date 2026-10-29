/**
 * The business team's typed refusals (AG-governance-01). Each code reaches the client as `data.cause.code`; the team
 * room's own copy says it in words. Kept beside the team module so it carries its own codes.
 */
export type TeamErrorCode =
  | 'agents.membership_unavailable'
  | 'agents.role_not_member'
  | 'agents.role_admin_only'
  | 'agents.role_invalid'
  | 'agents.team_change_stale'
  | 'agents.business_shut'
  | 'agents.pool_limit_unset'
  | 'agents.pool_limit_invalid'
  | 'agents.pool_allocation_invalid'
  | 'agents.pool_unset'
  | 'agents.project_name_unset'
  | 'agents.project_limit_unset'
  | 'agents.project_limit_invalid'
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
