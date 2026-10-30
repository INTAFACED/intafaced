/**
 * The action names and fields two founders approve for governance (MC-token-02). Kept free of imports so the founder
 * console's hash test pins against this exact code.
 */

/** The governance roles, in rank order. `controller`, `admin` and `moderator` may cancel a proposal; `author` may not. */
export const GOVERNANCE_ROLES = ['controller', 'admin', 'moderator', 'author'] as const;

/** Two founders write the governance voting delay and period (MC-token-02). */
export const GOVERNANCE_SETTINGS_ACTION = 'token.governance.settings.set';
/** Two founders grant, change or revoke one account's governance role (MC-token-02). */
export const GOVERNANCE_ROLE_ACTION = 'token.governance.role.set';

/** The fields the founders' settings approval binds. A blank setting is the empty string. */
export function governanceSettingsPayload(input: {
  votingDelayMs: string | null;
  votingPeriodMs: string | null;
  expectedRevision: number;
}): Record<string, string> {
  return {
    votingDelayMs: input.votingDelayMs ?? '',
    votingPeriodMs: input.votingPeriodMs ?? '',
    expectedRevision: String(input.expectedRevision),
  };
}

/** The fields the founders' role approval binds. A revoke is the empty role. */
export function governanceRolePayload(input: { userId: string; role: string | null; expectedRevision: number }): Record<string, string> {
  return { userId: input.userId, role: input.role ?? '', expectedRevision: String(input.expectedRevision) };
}
